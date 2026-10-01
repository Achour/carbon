import { execFile as execFileCb } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ProviderInstallProgress } from '@shared/types'
import { managedAntigravityDir } from './providerCli.ts'

const execFile = promisify(execFileCb)

/**
 * Installs Google's Antigravity ACP server into Carbon's own data folder.
 *
 * This is the one provider Carbon installs rather than finds, and it is a
 * narrow exception to "Carbon ships no CLI": nothing is bundled with the app,
 * the download happens only when the user presses Install, and it comes from
 * the ACP registry's own entry — the same archive Zed fetches — so an update is
 * the registry moving, not a Carbon release. Google publishes no installer or
 * package for it, which is the whole reason the exception exists.
 */

/** The registry entry. Its `distribution.binary` maps platforms to archives. */
const REGISTRY_URL =
  'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json'

/**
 * The entry as of 1.2.1, for when the registry can't be reached. Only the
 * platforms whose archive Carbon has actually unpacked and run are pinned.
 */
const FALLBACK = {
  version: '1.2.1',
  archives: {
    'darwin-aarch64':
      'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip',
    'darwin-x86_64':
      'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-x86_64.zip',
    'linux-x86_64':
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip',
    'linux-aarch64':
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-arm64.zip',
    'windows-x86_64':
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip',
    'windows-aarch64':
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-arm64.zip'
  } as Record<string, string>
}

/** The registry's platform key for this machine (`darwin-aarch64`, …). */
export function registryPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${os}-${cpu}`
}

/**
 * Only an archive on Google's own download host is accepted, whatever the
 * registry says — the registry is a GitHub repository, and this is what keeps
 * a bad commit to it from pointing Carbon at a binary from anywhere else.
 */
export function trustedArchiveUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'dl.google.com'
  } catch {
    return false
  }
}

export interface AntigravityRelease {
  version: string
  url: string
}

/** Pick this machine's archive out of a registry entry. */
export function releaseFromRegistry(
  entry: unknown,
  platform = registryPlatform()
): AntigravityRelease | null {
  const record = entry as {
    version?: unknown
    distribution?: { binary?: Record<string, { archive?: unknown }> }
  }
  const version = typeof record?.version === 'string' ? record.version : null
  const url = record?.distribution?.binary?.[platform]?.archive
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !trustedArchiveUrl(url)) return null
  return { version, url }
}

async function latestRelease(): Promise<AntigravityRelease> {
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) {
      const release = releaseFromRegistry(await response.json())
      if (release) return release
    }
  } catch {
    // Offline or rate-limited: the pinned entry below still installs.
  }
  const url = FALLBACK.archives[registryPlatform()]
  if (!url) throw new Error(`Antigravity has no build for ${registryPlatform()}.`)
  return { version: FALLBACK.version, url }
}

/** One install at a time; a second press joins the first. */
let running: Promise<void> | null = null

export function installAntigravity(
  onProgress: (progress: ProviderInstallProgress) => void
): Promise<void> {
  running ??= install(onProgress).finally(() => {
    running = null
  })
  return running
}

async function install(onProgress: (progress: ProviderInstallProgress) => void): Promise<void> {
  const root = managedAntigravityDir()
  if (!root) throw new Error('Carbon has no data folder to install into.')
  const report = (patch: Omit<ProviderInstallProgress, 'provider'>): void =>
    onProgress({ provider: 'antigravity', ...patch })
  try {
    const release = await latestRelease()
    await mkdir(root, { recursive: true })
    const target = join(root, release.version)
    // Unpacked beside its final name and renamed into place, so a crash or a
    // cancelled download can never leave a half-written binary that
    // resolution would find and spawn.
    const staging = `${target}.partial`
    const archive = `${staging}.zip`
    await rm(staging, { recursive: true, force: true })

    const response = await fetch(release.url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText}).`)
    }
    const total = Number(response.headers.get('content-length')) || 0
    let received = 0
    let lastReport = 0
    report({ phase: 'download', received, total })
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      // A progress event per chunk is thousands of IPC messages for one bar.
      const now = Date.now()
      if (now - lastReport > 150) {
        lastReport = now
        report({ phase: 'download', received, total })
      }
    })
    await pipeline(body, createWriteStream(archive))

    report({ phase: 'extract', received, total })
    await mkdir(staging, { recursive: true })
    // The system's own unzip (bsdtar on Windows 10+): a zip library would be a
    // dependency for one call, and these handle the archive's 100+ MB members
    // without holding them in memory.
    if (process.platform === 'win32') {
      await execFile('tar', ['-xf', archive, '-C', staging], {
        windowsHide: true
      })
    } else {
      await execFile('unzip', ['-o', '-q', archive, '-d', staging])
    }
    for (const name of await readdir(staging)) {
      const path = join(staging, name)
      if ((await stat(path)).isFile()) await chmod(path, 0o755)
    }
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    await rm(archive, { force: true })
    // Older versions: nothing resolves to them once the new one is in place.
    for (const entry of await readdir(root)) {
      if (entry === release.version) continue
      // A running session may hold the old binary open; Windows refuses to
      // delete it, and it goes at the next install instead.
      await rm(join(root, entry), { recursive: true, force: true }).catch(() => {})
    }
    report({ phase: 'done', received, total })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report({ phase: 'error', received: 0, total: 0, error: message })
    throw error
  }
}

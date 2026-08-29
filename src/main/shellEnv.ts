import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const ENV_MARKER = '\0KARBUN_ENV_START\0'

/** Merge PATH strings without changing their precedence or keeping duplicates. */
export function mergePaths(...values: Array<string | undefined>): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const value of values) {
    for (const entry of value?.split(delimiter) ?? []) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(delimiter)
}

/** Extract PATH from the NUL-delimited payload printed after shell startup. */
export function parseShellPath(output: Buffer): string | undefined {
  const marker = Buffer.from(ENV_MARKER)
  const markerAt = output.indexOf(marker)
  if (markerAt < 0) return undefined
  const payload = output.subarray(markerAt + marker.length).toString('utf8')
  for (const entry of payload.split('\0')) {
    if (entry.startsWith('PATH=')) return entry.slice('PATH='.length)
  }
  return undefined
}

function commonToolPaths(home: string): string {
  return [
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
    .filter(existsSync)
    .join(delimiter)
}

/** The shell that would be asked, spelled the same way for cache key and spawn. */
function loginShell(): string {
  return process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/zsh'
}

/** Arguments and environment for the probe — one definition, two call sites. */
const PROBE_ARGS = ['-ilc', `printf '\\0KARBUN_ENV_START\\0'; /usr/bin/env -0`]
function probeOptions(): { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number } {
  return {
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024
  }
}

/** Last launch's answer, so this one need not wait for a shell to start. */
interface ShellPathCache {
  /** The shell it was read from — switching shells has to invalidate it. */
  shell: string
  /** PATH as the shell reported it, *before* any merging. */
  path: string
}

function cacheFile(dir: string): string {
  return join(dir, 'shell-path.json')
}

function readCache(dir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as Partial<ShellPathCache>
    if (typeof raw.path !== 'string' || !raw.path) return undefined
    return raw.shell === loginShell() ? raw.path : undefined
  } catch {
    return undefined
  }
}

function writeCache(dir: string, path: string): void {
  try {
    const data: ShellPathCache = { shell: loginShell(), path }
    writeFileSync(cacheFile(dir), `${JSON.stringify(data)}\n`)
  } catch {
    // A cache that cannot be written costs a slow launch, never a broken one.
  }
}

/**
 * Finder/Dock apps on macOS do not inherit ~/.zprofile or ~/.zshrc. Read the
 * user's interactive login-shell PATH, merge stable tool locations as a
 * fallback, and update process.env before either agent SDK is constructed.
 *
 * **The read is a full interactive shell startup, and it used to block the
 * window.** This runs inside `app.whenReady()` ahead of `createWindow()`, so
 * every millisecond `zsh -ilc` spends sourcing nvm, oh-my-zsh, conda and the
 * rest is a millisecond with no window on screen — 0.12 s on a bare config and
 * routinely 0.5–2 s on a real one. Reordering it behind `createWindow()` is not
 * the fix: the managers constructed in between resolve provider binaries
 * through this PATH, and `registerIpc()` has to be in place before the renderer
 * can call anything.
 *
 * So the answer is remembered. `cacheDir` (userData) holds the previous
 * launch's PATH, which is used *immediately* — the shell is then re-read in the
 * background, both to rewrite the cache for next time and to pick up anything
 * installed since, via `onUpdate`. Only a first-ever launch pays the spawn.
 *
 * Staleness is bounded by construction: every launch refreshes, so the cache is
 * never more than one launch behind, and this launch heals itself a moment
 * after opening rather than at the next one. Omitting `cacheDir` keeps the old
 * synchronous behaviour, which is what the non-darwin path and tests want.
 */
export function hydrateShellPath(
  cacheDir?: string,
  onUpdate?: (path: string) => void
): string {
  const inherited = process.env.PATH
  const apply = (shellPath: string | undefined): string => {
    const resolved = mergePaths(shellPath, commonToolPaths(homedir()), inherited)
    process.env.PATH = resolved
    return resolved
  }

  if (process.platform !== 'darwin') return apply(undefined)

  const cached = cacheDir ? readCache(cacheDir) : undefined
  if (cached) {
    const resolved = apply(cached)
    void refreshShellPath(cacheDir!, inherited, resolved, onUpdate)
    return resolved
  }

  let shellPath: string | undefined
  try {
    shellPath = parseShellPath(
      execFileSync(loginShell(), PROBE_ARGS, {
        ...probeOptions(),
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
  } catch {
    // A slow or unusual shell config must never prevent the app from opening.
  }
  if (cacheDir && shellPath) writeCache(cacheDir, shellPath)
  return apply(shellPath)
}

/**
 * Re-read the shell without blocking anything, rewrite the cache, and report a
 * PATH that actually changed. `onUpdate` fires only on a real change because
 * its job is to invalidate caches keyed on PATH (provider CLI resolution), and
 * doing that on every launch would throw away correct answers for nothing.
 */
async function refreshShellPath(
  cacheDir: string,
  inherited: string | undefined,
  current: string,
  onUpdate?: (path: string) => void
): Promise<void> {
  let shellPath: string | undefined
  try {
    const { stdout } = await execFile(loginShell(), PROBE_ARGS, {
      ...probeOptions(),
      encoding: 'buffer'
    })
    shellPath = parseShellPath(stdout)
  } catch {
    return
  }
  if (!shellPath) return
  writeCache(cacheDir, shellPath)
  const resolved = mergePaths(shellPath, commonToolPaths(homedir()), inherited)
  if (resolved === current) return
  process.env.PATH = resolved
  onUpdate?.(resolved)
}

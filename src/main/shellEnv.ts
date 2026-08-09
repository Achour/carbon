import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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
    // Where OpenCode's own installer puts its binary. Usually already on the
    // login-shell PATH; this is the fallback for when that read fails, and
    // without it a Finder-launched Carbon can't find an installed OpenCode.
    join(home, '.opencode', 'bin'),
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

/**
 * Finder/Dock apps on macOS do not inherit ~/.zprofile or ~/.zshrc. Read the
 * user's interactive login-shell PATH once, merge stable tool locations as a
 * fallback, and update process.env before either agent SDK is constructed.
 */
export function hydrateShellPath(): string {
  const inherited = process.env.PATH
  let shellPath: string | undefined

  if (process.platform === 'darwin') {
    const shell = process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/zsh'
    try {
      const output = execFileSync(
        shell,
        ['-ilc', `printf '\\0KARBUN_ENV_START\\0'; /usr/bin/env -0`],
        {
          env: {
            ...process.env,
            DISABLE_AUTO_UPDATE: 'true',
            ZSH_DISABLE_COMPFIX: 'true'
          },
          encoding: 'buffer',
          timeout: 5_000,
          maxBuffer: 2 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore']
        }
      )
      shellPath = parseShellPath(output)
    } catch {
      // A slow or unusual shell config must never prevent the app from opening.
    }
  }

  const resolved = mergePaths(shellPath, commonToolPaths(homedir()), inherited)
  process.env.PATH = resolved
  return resolved
}

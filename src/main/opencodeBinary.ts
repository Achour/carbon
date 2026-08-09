import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Locating the OpenCode CLI.
 *
 * Unlike Claude and Codex — whose binaries ship inside their npm SDKs — OpenCode
 * is the user's own install, found on PATH. That is the point rather than a
 * compromise: the whole reason to support it is that the user is already logged
 * in to it, and a bundled copy would carry its own (empty) auth and go stale
 * between Carbon releases against a CLI that ships most days.
 *
 * Note the binary is `opencode`, never `opencode2`. The v2 beta installs
 * alongside v1 under that separate name and speaks a revised server API; picking
 * it up by accident would fail in ways that look like our bugs.
 */

/** Where the installer puts it. `hydrateShellPath` usually has this covered
 *  already, but only when the login-shell read succeeded. */
export const OPENCODE_FALLBACK_DIRS = ['.opencode/bin']

export interface OpencodeProbe {
  installed: boolean
  /** Reported version ('1.18.15'), when it could be parsed. */
  version?: string
}

/**
 * First version-shaped token in `opencode --version` output.
 *
 * Unanchored on the left because the CLI prints bare `1.18.15` but the v2 build
 * prints `opencode2 v0.0.0-next-17055` — a leading `\b` would sit inside `v0`
 * and never match.
 */
export function parseOpencodeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1]
}

/**
 * Whether the CLI is on PATH, as data rather than an exception — every failure
 * mode here (absent, unreadable, too slow, wrong arch) means the same thing to
 * the caller, and none of them should propagate across IPC.
 */
export async function probeOpencode(timeout = 5000, bin = 'opencode'): Promise<OpencodeProbe> {
  try {
    const { stdout } = await run(bin, ['--version'], { timeout })
    return { installed: true, version: parseOpencodeVersion(stdout) }
  } catch {
    return { installed: false }
  }
}

/**
 * Thrown from the session constructor so `ChatManager.deliver` persists it as
 * the chat's error — the one place a user sees why nothing happened.
 */
export function missingBinaryError(): Error {
  return new Error(
    'OpenCode is not installed, or not on this app’s PATH. Install it with ' +
      '`brew install sst/tap/opencode` or `npm i -g opencode-ai`, sign in with ' +
      '`opencode auth login`, then restart Carbon.'
  )
}

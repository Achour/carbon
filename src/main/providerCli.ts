import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
// Relative and .ts-extensioned, like store.ts: these are *runtime* imports, and
// keeping them resolvable without a bundler is what lets `node --test` run the
// resolution tests against this file directly.
import { PROVIDER_LABELS, PROVIDERS } from '../shared/types.ts'
import type { Provider, ProviderCli, ProviderCliConfig } from '@shared/types'

const execFile = promisify(execFileCb)

/**
 * Carbon drives the providers' real CLIs, and it uses the ones the user
 * installed rather than shipping copies of them.
 *
 * The two SDKs each carry a vendored binary as an optional dependency
 * (~300 MB apiece), and taking them would mean shipping a second, *stale* copy
 * of a tool the user already keeps up to date — a Carbon release would pin the
 * agent's version, so a CLI fix would wait on an app release to reach anyone.
 * `pathToClaudeCodeExecutable` and this module's Codex equivalent are what opt
 * out; `electron-builder.yml` then drops the vendored packages from the app.
 *
 * The cost of that choice is this file: resolution, a version floor, and an
 * honest "not installed" answer, which is what Settings → Providers renders.
 */

/** Binary name to look for on PATH, per provider. */
const BINARY: Record<Provider, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok'
}

/**
 * Env override, per provider. `CARBON_GROK_PATH` predates the other two and is
 * kept spelled exactly as it was.
 */
const ENV_OVERRIDE: Record<Provider, string> = {
  claude: 'CARBON_CLAUDE_PATH',
  codex: 'CARBON_CODEX_PATH',
  grok: 'CARBON_GROK_PATH'
}

/**
 * Where each CLI's own installer puts it. Consulted *after* PATH, so a user who
 * manages versions with a shim (mise, asdf, volta) gets the one their terminal
 * would run; this list only answers when PATH doesn't, which is the common case
 * for a Dock-launched app whose PATH hydration found nothing.
 */
function knownLocations(provider: Provider, home: string): string[] {
  const name = BINARY[provider]
  const perProvider: Record<Provider, string[]> = {
    claude: [join(home, '.local', 'bin', name), join(home, '.claude', 'local', name)],
    codex: [join(home, '.local', 'bin', name), join(home, '.codex', 'bin', name)],
    grok: [join(home, '.grok', 'bin', name), join(home, '.local', 'bin', name)]
  }
  return [...perProvider[provider], `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
}

/**
 * Lowest CLI version each adapter's assumptions hold for. These are floors, not
 * the versions Carbon was built against: below them a protocol Carbon relies on
 * is missing outright, so the answer is a clear warning rather than a turn that
 * fails in an unreadable way. Being *above* them is normal and expected — the
 * whole point of using the user's install is that it moves faster than Carbon.
 */
export const MIN_CLI_VERSION: Record<Provider, string> = {
  claude: '2.0.0',
  codex: '0.140.0',
  grok: '1.0.0'
}

/**
 * How each CLI is installed, shown on a provider row that resolved to nothing.
 * Each provider publishes other install routes (a shell installer, Homebrew);
 * npm is the one that is the same sentence on every platform, and the row is a
 * nudge toward the docs rather than an installer of its own.
 */
export const INSTALL_COMMAND: Record<Provider, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  // `@xai-official/grok` — not `@vibe-kit/grok-cli`, an unrelated third-party
  // package whose name reads like the official one.
  grok: 'npm install -g @xai-official/grok'
}

/** User settings, injected at startup so this module never imports the store. */
let config: Partial<Record<Provider, ProviderCliConfig>> = {}

/** Resolution is a few `stat`s per provider; cached per run. */
let cache: Partial<Record<Provider, ProviderCli>> = {}

export function configureProviderClis(next: Partial<Record<Provider, ProviderCliConfig>>): void {
  config = next ?? {}
  cache = {}
}

/** A provider the user switched off is treated exactly like one not installed. */
export function providerEnabled(provider: Provider): boolean {
  return config[provider]?.enabled !== false
}

/**
 * Exported because binary discovery is shared with `lsp.ts`, which resolves
 * language servers the same way. One implementation: the day a Windows `.cmd`
 * suffix or a symlink tweak lands, it must not reach only half the app.
 */
export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First executable match for `name` on PATH. */
export function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * An env override is returned even when nothing is there, so the row can say
 * *that* rather than quietly falling back to a different binary — an override
 * that silently stops applying is worse than one that reports a problem.
 */
function resolve(
  provider: Provider,
  env: NodeJS.ProcessEnv
): { path: string | null; source: ProviderCli['source'] } {
  const configured = env[ENV_OVERRIDE[provider]]?.trim()
  if (configured) return { path: configured, source: 'configured' }
  const found = onPath(BINARY[provider], env)
  if (found) return { path: found, source: 'path' }
  for (const candidate of knownLocations(provider, env.HOME ?? homedir())) {
    if (isExecutable(candidate)) return { path: candidate, source: 'known' }
  }
  return { path: null, source: null }
}

/** The `x.y.z` in whatever shape a CLI prints for `--version`. */
export function parseVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null
}

/** Numeric compare of two dotted versions; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/**
 * Versions, keyed by the binary they were read from rather than by provider —
 * two providers resolving to one path (or one provider re-resolving to the same
 * path) is then a cache hit rather than a second spawn.
 *
 * Kept apart from `cache` because the two are answered at completely different
 * costs: resolution is a handful of `stat`s, a version is a *process*. Folding
 * them together is what made every `cliPath` call — which wants the path and
 * nothing else — able to block the main process behind `claude --version`.
 */
const versions = new Map<string, string | null>()

/**
 * Ask a CLI its version. Asynchronous on purpose: this used to be
 * `execFileSync`, and while it ran nothing else in main could run either —
 * including the `chat:event` channel feeding the transcript. It is reached
 * lazily (the first `cliPath`, the Settings page), so the stall did not land at
 * launch; it landed at whatever moment the first turn started, which is worse.
 */
async function readVersion(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(path, ['--version'], {
      encoding: 'utf8',
      timeout: 8_000
    })
    return parseVersion(stdout)
  } catch {
    return null
  }
}

/**
 * Full status for one provider.
 *
 * `path` is the candidate that *would* be spawned and `installed` says whether
 * it is really there — kept apart because a pinned path that no longer exists
 * has to be reported as itself, and reducing it to null would render as "not
 * installed" with no hint that a setting is the reason.
 *
 * Cached per run, and only for the real environment: the `env` parameter exists
 * so callers can resolve against a constructed one (tests, a session carrying
 * its own), and caching those would poison the shared answer.
 */
export function providerCli(provider: Provider, env: NodeJS.ProcessEnv = process.env): ProviderCli {
  const cacheable = env === process.env
  const hit = cacheable ? cache[provider] : undefined
  if (hit) return hit
  const { path, source } = resolve(provider, env)
  const installed = !!path && isExecutable(path)
  const minVersion = MIN_CLI_VERSION[provider]
  // Whatever `providerClis` has read so far. `undefined` (never asked) and a
  // failed read both mean null here: nothing user-facing distinguishes them,
  // and the one surface that reports a version awaits it first.
  const version = installed && path ? (versions.get(path) ?? null) : null
  const info: ProviderCli = {
    provider,
    enabled: config[provider]?.enabled !== false,
    path,
    installed,
    version,
    source,
    outdated: !!version && compareVersions(version, minVersion) < 0,
    minVersion,
    installCommand: INSTALL_COMMAND[provider]
  }
  if (cacheable) cache[provider] = info
  return info
}

/**
 * Every provider's status, for Settings → Providers — the one caller that needs
 * the version, and therefore the one that pays for it. The spawns run in
 * parallel and the rows are then rebuilt so the freshly-read versions land on
 * them; `refresh` (the Recheck button) is what drops a remembered version,
 * since reinstalling a CLI is the whole reason to press it.
 *
 * A disabled provider is probed too: the row has to show what it found, or
 * turning it back on is a leap of faith.
 */
export async function providerClis(refresh = false): Promise<ProviderCli[]> {
  if (refresh) {
    cache = {}
    versions.clear()
  }
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const { path, installed } = providerCli(provider)
      if (!installed || !path || versions.has(path)) return
      versions.set(path, await readVersion(path))
    })
  )
  // Cheap — a few `stat`s — and it is what carries the versions just read onto
  // the cached rows, which were built before the spawns resolved.
  cache = {}
  return PROVIDERS.map((provider) => providerCli(provider))
}

/**
 * The binary to spawn, or null when the provider is unavailable — switched off,
 * or nothing found. Probes call this and skip the provider; anything starting a
 * turn calls `requireCliPath`, which explains itself instead of going quiet.
 */
export function cliPath(provider: Provider, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!providerEnabled(provider)) return null
  const info = providerCli(provider, env)
  return info.installed ? info.path : null
}

/** Provider is switched on and resolved to something runnable. */
export function cliAvailable(provider: Provider, env: NodeJS.ProcessEnv = process.env): boolean {
  return providerEnabled(provider) && providerCli(provider, env).installed
}

/**
 * Same answer as `cliPath`, but throwing the message a user can act on. Session
 * construction is wrapped by `deliver`, so the throw lands in the chat as an
 * error card with the prompt preserved rather than as a dead turn.
 */
export function requireCliPath(provider: Provider): string {
  const info = providerCli(provider)
  if (!info.enabled) {
    throw new Error(`${PROVIDER_LABELS[provider]} is turned off in Settings \u2192 Providers.`)
  }
  if (info.source === 'configured' && !info.installed) {
    throw new Error(
      `${ENV_OVERRIDE[provider]} points at something that isn\u2019t executable:\n\n    ${info.path}`
    )
  }
  if (!info.installed || !info.path) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} isn\u2019t installed. Install it with:\n\n    ${info.installCommand}\n\nSettings \u2192 Providers has a Recheck button once it is.`
    )
  }
  return info.path
}

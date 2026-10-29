import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * How a Codex session in Carbon reaches the user's own Chrome, when it can.
 *
 * The ChatGPT desktop app installs two browser routes into `~/.codex`, and only
 * one of them works outside that app:
 *
 * - **`cua_repl`** (the `unified-computer-use` plugin) has a browser surface —
 *   `cua.getTab`, `cua.createBrowserTab`, the browsers in `cua.getState()` —
 *   but its launcher forces a browser-access check that only the ChatGPT app
 *   can answer (a pipe the app hosts, answered with the app's own signing key).
 *   Spawned by anything else it reports `The browser access host is
 *   unavailable`, lists no browsers, and Codex falls back to driving Chrome
 *   through desktop clicks and screenshots. That gate is the app's policy, not
 *   a bug, and Carbon does not try to answer it.
 * - **`node_repl`**, which the app writes into `config.toml` with the `chrome`
 *   backend, loads the Chrome plugin's `browser-client.mjs` and talks to the
 *   ChatGPT Chrome extension through its native-messaging host. No access check
 *   runs there unless the app supplies one, so it works from Carbon — measured:
 *   the extension found and the open tabs listed.
 *
 * The plugin ships no skill, so nothing tells the model the second route
 * exists, and it picks `cua_repl`. The rule this builds names the route, and is
 * built only where every piece of it is present — a rule pointing at a missing
 * file would send the model hunting.
 */
export function codexChromeRules(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): string {
  let config: string
  try {
    config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return ''
  }
  const plugin = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'chrome', 'latest')
  const client = join(plugin, 'scripts', 'browser-client.mjs')
  if (!chromeRouteConfigured(config) || !existsSync(client)) return ''
  return chromeRouteRules(client, join(plugin, 'docs'))
}

/**
 * Whether `config.toml` carries the `node_repl` server with the `chrome`
 * browser backend, and has not switched the Chrome plugin off. Read as text
 * rather than parsed: the app writes these lines itself, and a TOML parser
 * would be a dependency for two lookups.
 */
export function chromeRouteConfigured(config: string): boolean {
  const repl = section(config, 'mcp_servers.node_repl')
  if (repl === null || /^\s*enabled\s*=\s*false\b/m.test(repl)) return false
  const env = section(config, 'mcp_servers.node_repl.env') ?? ''
  const backends = /BROWSER_USE_AVAILABLE_BACKENDS\s*=\s*"([^"]*)"/.exec(env)?.[1] ?? ''
  if (!backends.split(',').map((b) => b.trim()).includes('chrome')) return false
  const plugin = section(config, 'plugins."chrome@openai-bundled"')
  return !(plugin && /^\s*enabled\s*=\s*false\b/m.test(plugin))
}

/** The body of `[name]`, up to the next table header; null when absent. */
function section(config: string, name: string): string | null {
  const lines = config.split('\n')
  const start = lines.findIndex((l) => l.trim() === `[${name}]`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

export function chromeRouteRules(client: string, docs: string): string {
  return [
    "The user's own Chrome is reachable from this session through the ChatGPT Chrome extension, with the `node_repl` tool:",
    `\`const { setupBrowserRuntime } = await import(${JSON.stringify(client)}); const agent = await setupBrowserRuntime();\``,
    'then `await agent.browsers.list()` and `await agent.browsers.get(id)` (for example `await browser.user.openTabs()`).',
    `Read the API and its rules in \`${docs}\` (\`api.json\`, browser safety, tab claiming) before acting in the user's browser.`,
    "The computer-use REPL's browser surface (`cua_repl`: `cua.getTab`, `cua.createBrowserTab`, the browsers in `cua.getState()`) is unavailable in this app — it needs the ChatGPT desktop app's browser-access host — so do not drive Chrome through `cua_repl` desktop clicks when the user asks for their browser; keep `cua_repl` for native desktop apps.",
    'If the extension cannot be reached, say so instead of falling back to desktop control.'
  ].join(' ')
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeRouteConfigured, codexChromeRules } from '../src/main/codexChrome.ts'

// The shape the ChatGPT app writes into ~/.codex/config.toml.
const APP_CONFIG = `model = "x"

[mcp_servers.node_repl]
args = []
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/u/.codex"
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"

[plugins."chrome@openai-bundled"]
enabled = true
`

test('the app-written config carries the Chrome route', () => {
  assert.equal(chromeRouteConfigured(APP_CONFIG), true)
})

test('no node_repl, no chrome backend, or either switched off: no route', () => {
  assert.equal(chromeRouteConfigured('model = "x"\n'), false)
  assert.equal(chromeRouteConfigured(APP_CONFIG.replace('chrome,iab,mcpapps', 'iab,mcpapps')), false)
  assert.equal(
    chromeRouteConfigured(APP_CONFIG.replace('args = []', 'args = []\nenabled = false')),
    false
  )
  assert.equal(
    chromeRouteConfigured(APP_CONFIG.replace('[plugins."chrome@openai-bundled"]\nenabled = true', '[plugins."chrome@openai-bundled"]\nenabled = false')),
    false
  )
})

test('an enabled flag under a later table does not leak into node_repl', () => {
  const later = APP_CONFIG + '\n[mcp_servers.other]\nenabled = false\n'
  assert.equal(chromeRouteConfigured(later), true)
})

test('the rule is built only when the plugin client is on disk', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  writeFileSync(join(home, 'config.toml'), APP_CONFIG)
  assert.equal(codexChromeRules(home), '')
  const scripts = join(home, 'plugins', 'cache', 'openai-bundled', 'chrome', 'latest', 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'browser-client.mjs'), '')
  const rules = codexChromeRules(home)
  assert.match(rules, /setupBrowserRuntime/)
  assert.ok(rules.includes(join(scripts, 'browser-client.mjs')))
  assert.match(rules, /cua_repl/)
})

test('no config at all is no rule, not an error', () => {
  assert.equal(codexChromeRules(join(tmpdir(), 'no-such-codex-home')), '')
})

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseCodexConfigModel, readCodexConfigModel } from '../src/main/codexConfig.ts'

test('reads only the top-level Codex model', () => {
  assert.equal(
    parseCodexConfigModel(`
      # Personal default
      model = "gpt-5.6-sol" # used when no thread model is supplied

      [profiles.review]
      model = "gpt-5.6-terra"
    `),
    'gpt-5.6-sol'
  )
  assert.equal(parseCodexConfigModel("model = 'gpt-5.6-luna'"), 'gpt-5.6-luna')
  assert.equal(parseCodexConfigModel('[profiles.review]\nmodel = "gpt-5.6-terra"'), null)
})

test('honors CODEX_HOME and falls back to ~/.codex', () => {
  const root = mkdtempSync(join(tmpdir(), 'carbon-codex-config-'))
  const customHome = join(root, 'custom')
  mkdirSync(customHome)
  writeFileSync(join(customHome, 'config.toml'), 'model = "gpt-5.6-sol"\n')
  assert.equal(readCodexConfigModel({ CODEX_HOME: customHome }, join(root, 'unused')), 'gpt-5.6-sol')

  const userHome = join(root, 'user')
  mkdirSync(join(userHome, '.codex'), { recursive: true })
  writeFileSync(join(userHome, '.codex', 'config.toml'), 'model = "gpt-5.6-terra"\n')
  assert.equal(readCodexConfigModel({}, userHome), 'gpt-5.6-terra')
})

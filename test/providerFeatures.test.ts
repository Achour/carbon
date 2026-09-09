import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureProviderClis } from '../src/main/providerCli.ts'
import {
  claudeFeatureEnv,
  claudeFeatureStates,
  codexFeatureArgs,
  codexFeatureStates,
  resolveFeature
} from '../src/main/providerFeatures.ts'
import { CLAUDE_FEATURES } from '../src/shared/types.ts'

const browser = CLAUDE_FEATURES.find((f) => f.id === 'browser')!
const artifacts = CLAUDE_FEATURES.find((f) => f.id === 'artifacts')!

test('an untouched feature takes the provider default', () => {
  configureProviderClis({})
  assert.equal(resolveFeature('claude', browser, browser.env, {}).enabled, true)
  assert.equal(
    resolveFeature('codex', { id: 'memories', label: '', description: '', defaultEnabled: false }, undefined, {})
      .enabled,
    false
  )
})

test("the user's switch beats the provider default", () => {
  configureProviderClis({ claude: { features: { browser: false } } })
  assert.equal(resolveFeature('claude', browser, browser.env, {}).enabled, false)
})

test('a `0` in the environment overrides the switch, and says which variable', () => {
  configureProviderClis({ claude: { features: { artifacts: true } } })
  const state = resolveFeature('claude', artifacts, artifacts.env, { CLAUDE_CODE_ARTIFACT: '0' })
  assert.equal(state.enabled, false)
  assert.equal(state.overriddenBy, 'CLAUDE_CODE_ARTIFACT')
})

test('a `1` in the environment does NOT override, so the switch stays live', () => {
  // Claude Code exports all three to every subprocess it spawns, so a Carbon
  // launched from a terminal inside a session inherits `1`s nobody chose. The
  // variable is documented as an opt-*out*; reading a `1` as an override greyed
  // out all three switches permanently for exactly the people who develop Carbon.
  configureProviderClis({ claude: { features: { browser: false } } })
  const state = resolveFeature('claude', browser, browser.env, { CLAUDE_CODE_ENABLE_CFC: '1' })
  assert.equal(state.enabled, false)
  assert.equal(state.overriddenBy, undefined)
})

test('an empty environment value is not an override', () => {
  configureProviderClis({})
  const state = resolveFeature('claude', browser, browser.env, { CLAUDE_CODE_ENABLE_CFC: '' })
  assert.equal(state.enabled, true)
  assert.equal(state.overriddenBy, undefined)
})

test('the session env spells every choice out, including the offs', () => {
  configureProviderClis({ claude: { features: { browser: false, tasks: true } } })
  const env = claudeFeatureEnv({})
  assert.equal(env.CLAUDE_CODE_ENABLE_CFC, '0')
  assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1')
  // Untouched, so the default — but still written, because an absent variable
  // means "fall back to the CLI's own gate", which is not the same as on.
  assert.equal(env.CLAUDE_CODE_ARTIFACT, '1')
})

test('a user-set `0` survives into the session env', () => {
  configureProviderClis({ claude: { features: { artifacts: true } } })
  assert.equal(claudeFeatureEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0')
})

test('claudeFeatureStates covers the whole catalog', () => {
  configureProviderClis({})
  assert.deepEqual(
    claudeFeatureStates({}).map((f) => f.id),
    CLAUDE_FEATURES.map((f) => f.id)
  )
})

test('only touched Codex flags become command-line overrides', () => {
  configureProviderClis({ codex: { features: { browser_use: false, memories: true } } })
  const args = codexFeatureArgs()
  assert.deepEqual(args, [
    '-c',
    'features.browser_use=false',
    '-c',
    'features.memories=true'
  ])
})

test('a provider with no choices contributes no arguments', () => {
  configureProviderClis({})
  assert.deepEqual(codexFeatureArgs(), [])
  // Not the same as writing every flag false: a flag Carbon never surfaces
  // must reach the CLI untouched.
  assert.deepEqual(codexFeatureArgs({}), [])
})

test("a discovered flag's switch position comes from the user, not the CLI's own answer", () => {
  configureProviderClis({ codex: { features: { browser_use: false } } })
  const states = codexFeatureStates([
    { id: 'browser_use', label: 'Browser use', description: '', defaultEnabled: true },
    { id: 'computer_use', label: 'Computer use', description: '', defaultEnabled: true }
  ])
  assert.equal(states.find((s) => s.id === 'browser_use')?.enabled, false)
  assert.equal(states.find((s) => s.id === 'computer_use')?.enabled, true)
})

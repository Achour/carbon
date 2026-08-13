import assert from 'node:assert/strict'
import test from 'node:test'
import {
  knownProviderForModel,
  providerForModel,
  providerForRememberedModel,
  type ModelOption,
  type Provider
} from '../src/shared/types.ts'

test('a live catalog places runtime-discovered ids', () => {
  const options: ModelOption[] = [
    { id: 'sonnet', label: 'Sonnet', provider: 'claude' },
    { id: 'gpt-6-nova', label: 'GPT-6 Nova', provider: 'codex' }
  ]
  assert.equal(knownProviderForModel('sonnet', options), 'claude')
  assert.equal(knownProviderForModel('gpt-6-nova', options), 'codex')
  // The static catalog stays the fallback for ids the live one omits.
  assert.equal(knownProviderForModel('gpt-5.6-sol', options), 'codex')
})

test('wire ids no catalog carries are still placed by shape', () => {
  // The SDK reports 1M-context models this way; no static row has the suffix,
  // and answering "unknown" is what let one be paired with the wrong backend.
  assert.equal(knownProviderForModel('claude-fable-5[1m]'), 'claude')
  assert.equal(knownProviderForModel('claude-opus-4-8[1m]'), 'claude')
  assert.equal(knownProviderForModel('gpt-5.7-unreleased'), 'codex')
})

test('an unplaceable id stays unknown so a recorded provider can answer', () => {
  assert.equal(knownProviderForModel('some-local-llm'), undefined)
  assert.equal(knownProviderForModel('claudia-1'), undefined)
  // providerForModel is the "always answer" variant, for callers with no
  // recorded provider to fall back on.
  assert.equal(providerForModel('some-local-llm'), 'claude')
})

test('a known model outranks a stale recorded provider', () => {
  // The pair the bug produced: Fable picked in the composer, the previous
  // chat's provider still sitting in the renderer's mirrored defaults.
  assert.equal(providerForRememberedModel('claude-fable-5[1m]', 'codex'), 'claude')
  assert.equal(providerForRememberedModel('gpt-5.6-sol', 'claude'), 'codex')
})

test('the recorded provider decides only what the model cannot', () => {
  assert.equal(providerForRememberedModel('some-local-llm', 'codex'), 'codex')
  assert.equal(providerForRememberedModel(undefined, undefined), 'claude')
})

test('an unpinned model leaves the provider alone', () => {
  // Both providers have a default of their own, so no model is no evidence —
  // even though the empty id is also the label of Claude's own Default row.
  assert.equal(providerForRememberedModel(undefined, 'codex'), 'codex')
  assert.equal(providerForRememberedModel('', 'codex'), 'codex')
  assert.equal(providerForRememberedModel('', 'claude'), 'claude')
})

test('a recorded provider this build does not have answers for nothing', () => {
  // settings.json is shared between builds like the database is, so
  // `modelProvider` can name a backend that no longer exists. It is consulted
  // only for ids nothing can place — passing it on would put an unplaceable
  // string into every `Record<Provider, …>` the composer indexes.
  const recorded = 'opencode' as unknown as Provider
  assert.equal(providerForRememberedModel(undefined, recorded), 'claude')
  assert.equal(providerForRememberedModel('opencode:laguna-s-2.1-free', recorded), 'claude')
  // A model that *can* be placed still wins, exactly as before.
  assert.equal(providerForRememberedModel('gpt-5.6-sol', recorded), 'codex')
  // And a provider this build does have is still honoured for an unplaceable id.
  assert.equal(providerForRememberedModel('some-unlisted-id', 'codex'), 'codex')
})

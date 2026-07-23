import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalModelId,
  claudeModelContextWindow,
  claudeModelLabel,
  claudeModelName,
  rememberedEffortForModel,
  resolvedModelName
} from '../src/shared/types.ts'

test('Claude SDK aliases retain their resolved model version', () => {
  assert.equal(claudeModelLabel('Opus', 'claude-opus-4-8'), 'Opus 4.8')
  assert.equal(claudeModelLabel('Fable', 'claude-fable-5'), 'Fable 5')
  assert.equal(claudeModelLabel('Haiku', 'claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(claudeModelLabel('Default (recommended)', 'claude-opus-4-8'), 'Default (recommended)')
})

test('the Default row can still name the model it resolves to', () => {
  // What the picker shows beside "Default (recommended)" — the label itself
  // stays generic, so this is the only place the real model surfaces.
  assert.equal(claudeModelName('claude-opus-4-8[1m]'), 'Opus 4.8')
  assert.equal(claudeModelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(claudeModelName('claude-fable-5'), 'Fable 5')
  assert.equal(claudeModelName(undefined), undefined)
  // Legacy family-after-version ids aren't recognized; callers fall back.
  assert.equal(claudeModelName('claude-3-5-sonnet-20241022'), undefined)
})

test('Claude SDK 1M variants retain their context metadata', () => {
  assert.equal(claudeModelContextWindow('', 'claude-opus-4-8[1m]'), 1_000_000)
  assert.equal(claudeModelContextWindow('Latest model with 1M context', 'claude-opus-4-8'), 1_000_000)
  assert.equal(claudeModelContextWindow('Standard context', 'claude-opus-4-8'), undefined)
})

test('provider default rows can name a resolved Codex model', () => {
  assert.equal(resolvedModelName('gpt-5.6-sol'), 'GPT-5.6 Sol')
  assert.equal(resolvedModelName('gpt-custom'), 'gpt-custom')
  assert.equal(resolvedModelName('claude-3-5-sonnet-20241022'), undefined)
  assert.equal(resolvedModelName(undefined), undefined)
})

test('per-model effort lookup preserves an explicit provider default', () => {
  const options = [{ id: 'sonnet', label: 'Sonnet', provider: 'claude' as const }]
  assert.equal(rememberedEffortForModel({ sonnet: '' }, 'sonnet', options), '')
  assert.equal(rememberedEffortForModel({}, 'sonnet', options), undefined)
})

test('per-model effort lookup matches legacy wire ids to SDK aliases', () => {
  const options = [
    {
      id: 'sonnet',
      label: 'Sonnet',
      provider: 'claude' as const,
      resolvedModel: 'claude-sonnet-5[1m]'
    }
  ]
  assert.equal(canonicalModelId('claude-sonnet-5', options), 'sonnet')
  assert.equal(
    rememberedEffortForModel({ 'claude-sonnet-5': 'high' }, 'sonnet', options),
    'high'
  )
})

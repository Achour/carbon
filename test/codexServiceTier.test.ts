import assert from 'node:assert/strict'
import test from 'node:test'
import { codexOptionsForServiceTier } from '../src/main/codex.ts'

test('Codex service tiers map to isolated CLI config overrides', () => {
  assert.deepEqual(codexOptionsForServiceTier('standard'), {
    config: {
      service_tier: 'default',
      features: { fast_mode: true }
    }
  })
  assert.deepEqual(codexOptionsForServiceTier('fast'), {
    config: {
      service_tier: 'fast',
      features: { fast_mode: true }
    }
  })
})

test('older chats default to Standard processing', () => {
  assert.deepEqual(codexOptionsForServiceTier(), codexOptionsForServiceTier('standard'))
})

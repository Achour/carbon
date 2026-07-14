import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EFFORT_OPTIONS, MODEL_OPTIONS, effortForProvider } from '../src/shared/types.ts'

test('GPT-5.6 effort options match the Codex model catalog', () => {
  const efforts = (model: string): string[] | undefined =>
    MODEL_OPTIONS.find((option) => option.id === model)?.supportedEfforts

  assert.deepEqual(efforts('gpt-5.6-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(efforts('gpt-5.6-terra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(efforts('gpt-5.6-luna'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.ok(EFFORT_OPTIONS.some((option) => option.id === 'ultra'))
})

test('provider-only effort values are normalized on provider switches', () => {
  assert.equal(effortForProvider('minimal', 'claude'), undefined)
  assert.equal(effortForProvider('minimal', 'codex'), undefined)
  assert.equal(effortForProvider('ultra', 'claude'), undefined)
  assert.equal(effortForProvider('max', 'codex'), 'max')
  assert.equal(effortForProvider('ultra', 'codex'), 'ultra')
  assert.equal(effortForProvider('high', 'codex'), 'high')
  assert.equal(effortForProvider('high', 'claude'), 'high')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EFFORT_OPTIONS, effortForProvider } from '../src/shared/types.ts'

test('effort options contain every Codex SDK reasoning value', () => {
  const ids = EFFORT_OPTIONS.map((option) => option.id)
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.ok(ids.includes(effort as (typeof ids)[number]))
  }
})

test('provider-only effort values are normalized on provider switches', () => {
  assert.equal(effortForProvider('minimal', 'claude'), undefined)
  assert.equal(effortForProvider('max', 'codex'), undefined)
  assert.equal(effortForProvider('high', 'codex'), 'high')
  assert.equal(effortForProvider('high', 'claude'), 'high')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsageFact } from '../src/shared/types.ts'
import {
  OTHER,
  change,
  dailyStack,
  filterFacts,
  groupFacts,
  totalOf,
  valueOf
} from '../src/renderer/src/lib/usagePivot.ts'

function fact(day: string, provider: UsageFact['provider'], model: string, project: number, usd: number, tokens: number): UsageFact {
  return {
    day,
    provider,
    model,
    project,
    tokens: { input: 0, cacheRead: tokens, cacheWrite: 0, output: 0 },
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: usd },
    reasoning: 0,
    savedUsd: 0,
    responses: 1,
    unpriced: 0
  }
}

const facts = [
  fact('2026-10-01', 'claude', 'opus', 0, 10, 100),
  fact('2026-10-01', 'codex', 'gpt', 1, 5, 900),
  fact('2026-10-02', 'claude', 'opus', 1, 1, 10),
  fact('2026-10-02', 'codex', 'opus', 1, 2, 20)
]

test('groups rank by the measure on screen', () => {
  assert.deepEqual(groupFacts(facts, 'provider', 'cost').map((r) => r.key), ['claude', 'codex'])
  assert.deepEqual(groupFacts(facts, 'provider', 'tokens').map((r) => r.key), ['codex', 'claude'])
})

test('a model is keyed with its provider', () => {
  // Same id from two backends stays two rows.
  assert.equal(groupFacts(facts, 'model', 'cost').length, 3)
})

test('filters combine day and focus', () => {
  const only = filterFacts(facts, { day: '2026-10-02', focus: { by: 'project', key: '1' } })
  assert.equal(only.length, 2)
  assert.equal(valueOf(totalOf(only), 'cost'), 3)
  assert.equal(filterFacts(facts, {}), facts)
})

test('daily stack keeps every day and folds the tail into Other', () => {
  const s = dailyStack(facts, ['2026-09-30', '2026-10-01', '2026-10-02'], 'model', 'cost', 1)
  assert.deepEqual(s.keys, ['claude\u0000opus', OTHER])
  assert.deepEqual(s.values, [
    [0, 10, 1],
    [0, 5, 2]
  ])
})

test('change needs something to compare against', () => {
  assert.equal(change(150, 100), 50)
  assert.equal(change(5, 0), null)
})

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { emptyCell, parseGrokLine, priceCell, type UsageCell } from '../src/main/usageScan.ts'

/**
 * A verbatim `turn_completed` line from `~/.grok/sessions/.../updates.jsonl`,
 * trimmed only of fields the parser never reads.
 */
const TURN = JSON.stringify({
  timestamp: 1786656222,
  method: '_x.ai/session/update',
  params: {
    sessionId: '019ffd02-5dcc-7920-8c70-b762e114a8db',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: '7fc4dec0',
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 33187,
        outputTokens: 97,
        totalTokens: 33284,
        cachedReadTokens: 22400,
        cacheCreationTokens: 0,
        reasoningTokens: 73,
        modelCalls: 2,
        costUsdTicks: 333560000,
        modelUsage: {
          'grok-4.6-build': {
            inputTokens: 33187,
            outputTokens: 97,
            cachedReadTokens: 22400,
            cacheCreationTokens: 0,
            reasoningTokens: 73,
            modelCalls: 2,
            costUsdTicks: 333560000
          }
        }
      }
    },
    _meta: { eventId: 'x-71', agentTimestampMs: 1786656222774 }
  }
})

test('parseGrokLine reads a turn_completed line into one sample per model', () => {
  const samples = parseGrokLine(TURN)
  assert.ok(samples)
  assert.equal(samples.length, 1)
  const [s] = samples
  assert.equal(s.model, 'grok-4.6-build')
  assert.equal(s.ts, 1786656222774)
  // `inputTokens` is inclusive of the cached part, as Codex's is and Claude's
  // is not — the cell wants them split.
  assert.equal(s.input, 33187 - 22400)
  assert.equal(s.cacheRead, 22400)
  assert.equal(s.output, 97)
  assert.equal(s.reasoning, 73)
  // 1 tick = 1e-10 USD, confirmed against the headless reply printing
  // total_cost_usd 0.0331 beside total_cost_usd_ticks 331000000.
  assert.ok(Math.abs(s.costUsd - 0.033356) < 1e-9)
})

test('parseGrokLine ignores every line that is not a completed turn', () => {
  assert.equal(parseGrokLine(''), null)
  assert.equal(parseGrokLine('not json'), null)
  assert.equal(
    parseGrokLine(
      JSON.stringify({
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } }
      })
    ),
    null
  )
  // The hint string appears, but the update is a different kind — the cheap
  // `includes` pre-filter must not be mistaken for the real check.
  assert.equal(
    parseGrokLine(
      JSON.stringify({
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'turn_completed' } } }
      })
    ),
    null
  )
})

test('parseGrokLine attributes a turn with no per-model breakdown rather than dropping it', () => {
  const line = JSON.stringify({
    timestamp: 1786656222,
    method: '_x.ai/session/update',
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        usage: { inputTokens: 100, outputTokens: 10, costUsdTicks: 1000 }
      },
      _meta: { agentTimestampMs: 1786656222774 }
    }
  })
  const samples = parseGrokLine(line)
  assert.ok(samples)
  assert.equal(samples[0].model, 'unknown')
  assert.equal(samples[0].input, 100)
})

test('parseGrokLine splits a turn that spanned two models', () => {
  const line = JSON.stringify({
    method: '_x.ai/session/update',
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        usage: {
          modelUsage: {
            'grok-4.6-build': { inputTokens: 10, outputTokens: 1, costUsdTicks: 100 },
            'grok-4.5-build': { inputTokens: 20, outputTokens: 2, costUsdTicks: 200 }
          }
        }
      },
      _meta: { agentTimestampMs: 1786656222774 }
    }
  })
  const samples = parseGrokLine(line)
  assert.ok(samples)
  assert.equal(samples.length, 2)
  assert.deepEqual(
    samples.map((s) => s.model).sort(),
    ['grok-4.5-build', 'grok-4.6-build']
  )
})

test('parseGrokLine drops a turn that spent nothing', () => {
  const line = JSON.stringify({
    method: '_x.ai/session/update',
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        usage: { modelUsage: { 'grok-4.6-build': { inputTokens: 0, outputTokens: 0 } } }
      },
      _meta: { agentTimestampMs: 1 }
    }
  })
  assert.equal(parseGrokLine(line), null)
})

test('a reported cost wins over the rate table, and needs no rate to be priced', () => {
  const cell: UsageCell = { ...emptyCell('grok', 'grok-4.6-build', '2026-08-13'), costUsd: 0.5 }
  cell.input = 1000
  cell.cacheRead = 500
  cell.output = 100
  // No rate table entry exists for this id; without the reported figure the cell
  // would count as unpriced rather than as half a dollar.
  const priced = priceCell(cell, () => null)
  assert.equal(priced.costUsd, 0.5)
  assert.equal(priced.unpricedTokens, 0)
})

test('a cell with no reported cost still prices from the table', () => {
  const cell = emptyCell('claude', 'claude-opus-5', '2026-08-13')
  cell.input = 1_000_000
  const priced = priceCell(cell)
  assert.equal(priced.costUsd, 5)
  assert.equal(priced.unpricedTokens, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CodexFileReader,
  addSample,
  emptyCell,
  localDay,
  parseClaudeLine,
  rateFor
} from '../src/main/usageScan.ts'

// ---------- Claude lines ----------

const TS = '2026-08-08T11:27:30.226Z'

function claudeLine(
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  message: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: TS,
    requestId: 'req_1',
    ...extra,
    message: { id: 'msg_1', model: 'claude-opus-5', usage, ...message }
  })
}

test('parses an assistant usage line', () => {
  const s = parseClaudeLine(
    claudeLine({
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }
    })
  )
  assert.ok(s)
  assert.equal(s.model, 'claude-opus-5')
  assert.equal(s.key, 'msg_1:req_1')
  assert.equal(s.input, 2)
  assert.equal(s.cacheRead, 900)
  assert.equal(s.cacheWrite1h, 100)
  assert.equal(s.cacheWrite5m, 0)
  assert.equal(s.output, 50)
})

test('ignores lines that are not billable assistant turns', () => {
  assert.equal(parseClaudeLine('{"type":"user","message":{}}'), null)
  assert.equal(parseClaudeLine('not json at all'), null)
  // The hint check must come first: a line with no "usage" is never parsed.
  assert.equal(parseClaudeLine('{"type":"assistant","message":{"model":"x"}}'), null)
  // The CLI's placeholder for turns answered without a model call.
  assert.equal(parseClaudeLine(claudeLine({ output_tokens: 1 }, {}, { model: '<synthetic>' })), null)
})

test('an unsplit cache write is charged at the cheaper 5-minute rate', () => {
  // Older transcripts report only the total. Guessing high would overstate the
  // bill; guessing low can only understate it, which is the safer failure.
  const s = parseClaudeLine(claudeLine({ cache_creation_input_tokens: 400, output_tokens: 1 }))
  assert.ok(s)
  assert.equal(s.cacheWrite5m, 400)
  assert.equal(s.cacheWrite1h, 0)
})

test('a cache-write breakdown that disagrees with its total defers to the total', () => {
  const s = parseClaudeLine(
    claudeLine({
      cache_creation_input_tokens: 200,
      output_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 75 }
    })
  )
  assert.ok(s)
  assert.equal(s.cacheWrite5m + s.cacheWrite1h, 200)
  // Ratio preserved: a quarter of the writes were the 5-minute kind.
  assert.equal(s.cacheWrite5m, 50)
})

test('a line without both ids carries no dedupe key rather than being dropped', () => {
  const s = parseClaudeLine(claudeLine({ output_tokens: 1 }, { requestId: undefined }))
  assert.ok(s)
  assert.equal(s.key, null)
})

// ---------- Pricing ----------

test('models price by longest matching prefix', () => {
  assert.equal(rateFor('claude-opus-5')?.input, 5)
  assert.equal(rateFor('claude-opus-4-1')?.input, 15)
  assert.equal(rateFor('claude-fable-5')?.output, 50)
  // Dated snapshots and the 1M-context suffix land on their family.
  assert.equal(rateFor('claude-haiku-4-5-20251001')?.input, 1)
  assert.equal(rateFor('claude-opus-5[1m]')?.input, 5)
  // Codex-only slugs bill as the GPT-5 family.
  assert.equal(rateFor('gpt-5.6-sol')?.input, 1.25)
  assert.equal(rateFor('gpt-5.4-mini')?.input, 0.25)
  assert.equal(rateFor('codex-auto-review')?.input, 1.25)
})

test('fast mode is a different SKU, not a faster tier of the same one', () => {
  assert.equal(rateFor('claude-opus-5', 'standard')?.output, 25)
  assert.equal(rateFor('claude-opus-5', 'fast')?.output, 50)
})

test('an unknown model has no rate rather than a free one', () => {
  assert.equal(rateFor('llama-7b'), null)
  assert.equal(rateFor(''), null)
})

test('cache reads and writes bill off the input rate', () => {
  const r = rateFor('claude-opus-5')
  assert.ok(r)
  assert.equal(r.cacheRead, 0.5)
  assert.equal(r.cacheWrite5m, 6.25)
  assert.equal(r.cacheWrite1h, 10)
})

// ---------- Accumulation ----------

test('a priced sample banks cost and the saving cache bought', () => {
  const cell = emptyCell('claude', 'claude-opus-5', '2026-08-08')
  addSample(cell, rateFor('claude-opus-5'), {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite5m: 0,
    cacheWrite1h: 1_000_000,
    output: 1_000_000
  })
  // 5 + 0.5 + 10 + 25
  assert.equal(cell.costUsd, 40.5)
  // The million cached tokens would have cost $5 uncached and cost $0.50.
  assert.equal(cell.savingsUsd, 4.5)
  assert.equal(cell.responses, 1)
  assert.equal(cell.unpricedTokens, 0)
})

test('an unpriced sample counts tokens but never invents a cost', () => {
  const cell = emptyCell('codex', 'mystery-model', '2026-08-08')
  addSample(cell, rateFor('mystery-model'), {
    input: 10,
    cacheRead: 20,
    cacheWrite5m: 5,
    cacheWrite1h: 0,
    output: 3
  })
  assert.equal(cell.costUsd, 0)
  assert.equal(cell.unpricedTokens, 38)
  assert.equal(cell.output, 3)
})

test('days are bucketed in the local zone, not UTC', () => {
  const d = new Date(2026, 7, 8, 23, 30)
  assert.equal(localDay(d.getTime()), '2026-08-08')
})

// ---------- Codex rollouts ----------

function codexLines(lines: object[]): CodexFileReader {
  const r = new CodexFileReader()
  for (const l of lines) r.push(JSON.stringify(l))
  return r
}

test('codex usage is attributed to the model in force at the time', () => {
  const r = codexLines([
    { type: 'turn_context', timestamp: TS, payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 900,
            output_tokens: 40,
            reasoning_output_tokens: 30
          }
        }
      }
    },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-luna' } }
    },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }
      }
    }
  ])
  const samples = r.take()
  assert.equal(samples.length, 2)
  assert.equal(samples[0].model, 'gpt-5.6-sol')
  // Codex reports total input inclusive of the cached part; we split it out so
  // the two never double-count against each other.
  assert.equal(samples[0].input, 100)
  assert.equal(samples[0].cacheRead, 900)
  assert.equal(samples[0].reasoning, 30)
  assert.equal(samples[1].model, 'gpt-5.6-luna')
  assert.equal(samples[1].input, 10)
})

test('codex running totals are ignored — only the per-call delta is summed', () => {
  const r = codexLines([
    { type: 'turn_context', timestamp: TS, payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 999_999, output_tokens: 999_999 },
          last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }
        }
      }
    }
  ])
  const [s] = r.take()
  assert.equal(s.input, 5)
  assert.equal(s.output, 1)
})

test('an empty token_count contributes nothing', () => {
  const r = codexLines([
    { type: 'turn_context', timestamp: TS, payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } }
      }
    }
  ])
  assert.equal(r.take().length, 0)
})

test('take() drains, so a reused reader never double-counts a file', () => {
  const r = codexLines([
    { type: 'turn_context', timestamp: TS, payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg',
      timestamp: TS,
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } }
      }
    }
  ])
  assert.equal(r.take().length, 1)
  assert.equal(r.take().length, 0)
})

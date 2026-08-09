import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpencodeCells, opencodeDbPath } from '../src/main/opencodeUsage.ts'
import { normalizeModel, priceCell, staticRate, type UsageCell } from '../src/main/usageScan.ts'

/**
 * Driven against a real SQLite database rather than a mock, because the things
 * worth pinning are properties of the file: that rows outside the window are
 * excluded by the query, and that a WAL-backed write is visible to a read-only
 * connection (it isn't, if you open the database `immutable`).
 */

function makeDb(dir: string): { path: string; insert: (row: unknown, ts: number) => void } {
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  )`)
  // WAL is what the real installation uses, and is the mode the reader has to
  // cope with — a checkpoint may not have run since the last turn.
  db.exec('PRAGMA journal_mode=WAL')
  let n = 0
  const insert = (row: unknown, ts: number): void => {
    n += 1
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      `msg_${n}`,
      'ses_1',
      ts,
      ts,
      JSON.stringify(row)
    )
  }
  return { path, insert }
}

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    providerID: 'openai',
    modelID: 'gpt-5.6-luna',
    cost: 0,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
    ...overrides
  }
}

test('assistant rows become one cell per model and day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
  try {
    const { path, insert } = makeDb(dir)
    const now = Date.now()
    insert(assistant(), now)
    insert(assistant(), now + 1000)
    insert(assistant({ modelID: 'gpt-5.6-sol' }), now + 2000)

    const cells = readOpencodeCells(path, now - 86_400_000)
    assert.equal(cells.length, 2, 'two models on one day')

    const luna = cells.find((c) => c.model === 'opencode:openai/gpt-5.6-luna')
    assert.ok(luna)
    assert.equal(luna.provider, 'opencode')
    assert.equal(luna.input, 200, 'the two rows are summed')
    // Reasoning is folded into output: OpenCode reports the two side by side
    // (input + output + reasoning + cache == total), where Carbon treats
    // reasoning as a subset of output — so 2 x (20 output + 5 reasoning).
    assert.equal(luna.output, 50)
    assert.equal(luna.cacheRead, 80)
    assert.equal(luna.cacheWrite5m, 20)
    assert.equal(luna.reasoning, 10)
    assert.equal(luna.responses, 2)
    // Cache writes have no TTL here, so nothing may land in the 1-hour slot —
    // that slot bills at 2x input and would overstate every cached turn.
    assert.equal(luna.cacheWrite1h, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rows before the window are excluded by the query, not filtered after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
  try {
    const { path, insert } = makeDb(dir)
    const now = Date.now()
    insert(assistant(), now - 40 * 86_400_000)
    insert(assistant(), now)

    const cells = readOpencodeCells(path, now - 7 * 86_400_000)
    assert.equal(cells.length, 1)
    assert.equal(cells[0].responses, 1, 'only the in-window row counts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('user rows and zero-token rows contribute nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
  try {
    const { path, insert } = makeDb(dir)
    const now = Date.now()
    insert({ role: 'user', model: { providerID: 'openai', modelID: 'x' } }, now)
    insert(assistant({ tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }), now)
    insert({ role: 'assistant' }, now)
    assert.deepEqual(readOpencodeCells(path, now - 1000), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a turn still sitting in the WAL is visible to the read-only connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
  try {
    const { path, insert } = makeDb(dir)
    const now = Date.now()
    // Written and deliberately not checkpointed: this is the state the database
    // is in moments after a real turn, and reading it wrong reports stale totals.
    insert(assistant(), now)
    const cells = readOpencodeCells(path, now - 1000)
    assert.equal(cells.length, 1)
    assert.equal(cells[0].input, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or unreadable database yields no cells rather than throwing', () => {
  // The common case on machines that have never run OpenCode; the Usage page
  // must simply show no OpenCode series.
  assert.deepEqual(readOpencodeCells('/nope/does-not-exist.db', 0), [])
})

test('corrupt rows are skipped without losing the rest of the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
  try {
    const { path, insert } = makeDb(dir)
    const now = Date.now()
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('bad', 'ses_1', now, now, '{not json')
    db.close()
    insert(assistant(), now)
    assert.equal(readOpencodeCells(path, now - 1000).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the database path is the one OpenCode actually uses', () => {
  assert.equal(opencodeDbPath('/home/x'), '/home/x/.local/share/opencode/opencode.db')
})

test('an OpenCode model id is stripped down to something a rate table can match', () => {
  // The wrapper and the upstream vendor both have to come off: matchRate is a
  // longest-*prefix* match, so 'opencode:openai/gpt-5.6-luna' matches nothing
  // and the turn is reported unpriced — i.e. free, next to two providers'
  // real numbers.
  assert.equal(normalizeModel('opencode:openai/gpt-5.6-luna'), 'gpt-5.6-luna')
  assert.equal(normalizeModel('opencode:opencode/deepseek-v4-flash-free'), 'deepseek-v4-flash-free')
  // A gateway that qualifies the model by vendor keeps that part: it is the
  // form the rate feed keys such models under.
  assert.equal(
    normalizeModel('opencode:openrouter/anthropic/claude-sonnet-5'),
    'anthropic/claude-sonnet-5'
  )
  // Other providers' ids are untouched.
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5')
  assert.equal(normalizeModel('GPT-5.6-Sol'), 'gpt-5.6-sol')
})

test('an OpenCode cell prices through the shared static table', () => {
  const cell: UsageCell = {
    provider: 'opencode',
    model: 'opencode:openai/gpt-5.6-luna',
    day: '2026-08-09',
    input: 1_000_000,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    responses: 1
  }
  const cost = priceCell(cell, staticRate)
  // The point is that it is priced at all — an unpriced cell is what "free"
  // looks like on the chart.
  assert.ok(cost.costUsd > 0, 'a known model must not come back unpriced')
  assert.equal(cost.unpricedTokens, 0)
})

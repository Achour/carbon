import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESUME_WINDOW_MS, ResumeTurns, type ResumeStore } from '../src/main/resumeTurns.ts'

function memory(): ResumeStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, read: (k) => data.get(k) ?? null, write: (k, v) => void data.set(k, v) }
}

test('a quit leaves the running chats for the next launch, once', () => {
  const store = memory()
  let now = 1_000
  const a = new ResumeTurns(store, 'resume:app', () => now)
  a.takeLeftover()
  a.note('c1', 'streaming')
  a.note('c2', 'waiting-permission')
  a.note('c3', 'streaming')
  a.note('c3', 'idle')
  a.freeze()
  now += 5 * 60_000
  const b = new ResumeTurns(store, 'resume:app', () => now)
  assert.deepEqual(b.takeLeftover().sort(), ['c1', 'c2'])
  // Offered once: a second launch finds nothing.
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => now).takeLeftover(), [])
})

test('the teardown after freeze does not erase the record', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.freeze()
  // Disposing the sessions reports every turn as ended.
  a.note('c1', 'idle')
  a.forget('c1')
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 2_000).takeLeftover(), ['c1'])
})

test('a crash is covered: the record is written as turns start, not at quit', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'starting')
  // No freeze: the process died.
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 2_000).takeLeftover(), ['c1'])
})

test('a launch long after the last sign of life resumes nothing', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.freeze()
  const later = new ResumeTurns(store, 'resume:app', () => 1_000 + RESUME_WINDOW_MS + 1)
  assert.deepEqual(later.takeLeftover(), [])
})

test('a deleted chat is not resumed', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.note('c2', 'streaming')
  a.forget('c1')
  a.freeze()
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 2_000).takeLeftover(), ['c2'])
})

test('each build keeps its own record', () => {
  const store = memory()
  const app = new ResumeTurns(store, 'resume:app', () => 1_000)
  app.note('c1', 'streaming')
  app.freeze()
  assert.deepEqual(new ResumeTurns(store, 'resume:dev', () => 2_000).takeLeftover(), [])
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 2_000).takeLeftover(), ['c1'])
})

test('a missing or broken record reads as nothing to resume', () => {
  const store = memory()
  assert.deepEqual(new ResumeTurns(store, 'resume:app').takeLeftover(), [])
  store.data.set('resume:app', '{not json')
  assert.deepEqual(new ResumeTurns(store, 'resume:app').takeLeftover(), [])
})

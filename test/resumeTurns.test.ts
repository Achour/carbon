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
  const left = b.takeLeftover().sort()
  assert.deepEqual(left, ['c1', 'c2'])
  // Offered once: resumed (or ruled out) and settled, a later launch finds nothing.
  for (const id of left) b.settle(id)
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => now).takeLeftover(), [])
})

test('a quit before the leftover is resumed keeps it for the launch after', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.freeze()
  const b = new ResumeTurns(store, 'resume:app', () => 2_000)
  assert.deepEqual(b.takeLeftover(), ['c1'])
  // Quit again within the few seconds before it was sent.
  b.freeze()
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 3_000).takeLeftover(), ['c1'])
})

test('background work with no turn running counts as running', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.noteJobs('c1', 2)
  // Claude reports idle while its background agents carry on.
  a.note('c1', 'idle')
  a.freeze()
  assert.deepEqual(new ResumeTurns(store, 'resume:app', () => 2_000).takeLeftover(), ['c1'])
  const b = new ResumeTurns(store, 'resume:app', () => 3_000)
  b.noteJobs('c2', 1)
  b.noteJobs('c2', 0)
  b.freeze()
  assert.ok(!new ResumeTurns(store, 'resume:app', () => 4_000).takeLeftover().includes('c2'))
})

test('a chat a turn started in since launch is overtaken', () => {
  const store = memory()
  const a = new ResumeTurns(store, 'resume:app', () => 1_000)
  a.note('c1', 'streaming')
  a.freeze()
  const b = new ResumeTurns(store, 'resume:app', () => 2_000)
  b.takeLeftover()
  assert.equal(b.overtaken('c1'), false)
  // The user sent, and the turn has already finished.
  b.note('c1', 'starting')
  b.note('c1', 'idle')
  assert.equal(b.overtaken('c1'), true)
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

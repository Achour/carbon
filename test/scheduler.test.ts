import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { ScheduledTask } from '../src/shared/types.ts'
import { ScheduleStore } from '../src/main/scheduleStore.ts'
import { Scheduler } from '../src/main/scheduler.ts'
import { canSchedule, resolveTask, runScheduleTool, scheduleFromInput, type ScheduleToolHost } from '../src/main/scheduleTools.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: 'Morning check',
    prompt: 'Summarize open PRs',
    cwd: '/repo',
    provider: 'claude',
    permissionMode: 'default',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    enabled: true,
    nextRunAt: at(2026, 10, 14, 9),
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function harness(now: { t: number }, store: ScheduleStore) {
  const fired: { id: string; dueAt: number; nextRunAt: number | null }[] = []
  const scheduler = new Scheduler(
    store,
    { fire: (t, dueAt) => fired.push({ id: t.id, dueAt, nextRunAt: t.nextRunAt }), changed: () => {} },
    () => now.t
  )
  return { scheduler, fired }
}

test('a due task fires once and moves to its next time', () => {
  const store = new ScheduleStore(new DatabaseSync(':memory:'))
  store.put(task())
  const now = { t: at(2026, 10, 14, 8, 59) }
  const { scheduler, fired } = harness(now, store)
  assert.deepEqual(scheduler.tick(), [])
  now.t = at(2026, 10, 14, 9)
  assert.deepEqual(scheduler.tick(), ['t1'])
  assert.deepEqual(scheduler.tick(), [])
  assert.equal(fired[0].dueAt, at(2026, 10, 14, 9))
  assert.equal(store.get('t1')!.nextRunAt, at(2026, 10, 15, 9))
})

test('a run missed for days catches up once, then resumes from now', () => {
  const store = new ScheduleStore(new DatabaseSync(':memory:'))
  store.put(task())
  const now = { t: at(2026, 10, 18, 14) }
  const { scheduler, fired } = harness(now, store)
  assert.deepEqual(scheduler.tick(), ['t1'])
  assert.deepEqual(scheduler.tick(), [])
  assert.equal(fired.length, 1)
  assert.equal(fired[0].dueAt, at(2026, 10, 14, 9))
  assert.equal(store.get('t1')!.nextRunAt, at(2026, 10, 19, 9))
})

test('two schedulers on one database never fire the same run', () => {
  const db = new DatabaseSync(':memory:')
  const a = new ScheduleStore(db)
  const b = new ScheduleStore(db)
  a.put(task())
  const now = { t: at(2026, 10, 14, 9, 0) }
  const one = harness(now, a)
  const two = harness(now, b)
  // Both read the due row before either claims it.
  const listed = b.list()
  assert.equal(listed[0].nextRunAt, at(2026, 10, 14, 9))
  one.scheduler.tick()
  two.scheduler.tick()
  assert.equal(one.fired.length + two.fired.length, 1)
  assert.equal(b.claim('t1', at(2026, 10, 14, 9), null), false)
})

test('a one-off fires and then has no next run; paused tasks never fire', () => {
  const store = new ScheduleStore(new DatabaseSync(':memory:'))
  const when = at(2026, 10, 14, 9, 30)
  store.put(task({ id: 'once', schedule: { kind: 'once', at: when }, nextRunAt: when }))
  store.put(task({ id: 'paused', enabled: false }))
  const now = { t: when + 1000 }
  const { scheduler } = harness(now, store)
  assert.deepEqual(scheduler.tick(), ['once'])
  assert.equal(store.get('once')!.nextRunAt, null)
  assert.deepEqual(scheduler.tick(), [])
})

test('an edit that keeps the schedule cannot undo another instance\'s claim', () => {
  const db = new DatabaseSync(':memory:')
  const a = new ScheduleStore(db)
  const b = new ScheduleStore(db)
  const when = at(2026, 10, 14, 9, 30)
  a.put(task({ id: 'once', schedule: { kind: 'once', at: when }, nextRunAt: when }))
  const now = { t: when + 1000 }
  const { scheduler, fired } = harness(now, a)
  scheduler.tick()
  // B edits the prompt, keeping *when*: the claim A made stands.
  const saved = b.save('once', (existing) => ({ task: { ...existing!, prompt: 'edited' }, keepClaim: true }))
  assert.equal(saved.nextRunAt, null)
  assert.equal(b.get('once')!.prompt, 'edited')
  scheduler.tick()
  assert.equal(fired.length, 1)
})

test('an edit never resurrects a task deleted under it', () => {
  const db = new DatabaseSync(':memory:')
  const a = new ScheduleStore(db)
  const b = new ScheduleStore(db)
  a.put(task())
  a.delete('t1')
  assert.throws(() => b.save('t1', () => ({ task: task(), keepClaim: true })), /no longer exists/)
  assert.equal(b.get('t1'), null)
})

test('every write tells the store a backup is due', () => {
  let writes = 0
  const store = new ScheduleStore(new DatabaseSync(':memory:'), () => writes++)
  store.put(task())
  store.patch('t1', { lastRunAt: 1 })
  store.save('t1', (t) => ({ task: { ...t!, name: 'x' }, keepClaim: true }))
  store.claim('t1', at(2026, 10, 14, 9), null)
  store.delete('t1')
  assert.equal(writes, 5)
})

test('a task naming a provider this build lacks is shown paused, as Claude', () => {
  const store = new ScheduleStore(new DatabaseSync(':memory:'))
  store.put(task({ provider: 'muse' as never, model: 'muse-1' }))
  const t = store.get('t1')!
  assert.equal(t.provider, 'claude')
  assert.equal(t.model, undefined)
  assert.equal(t.enabled, false)
})

test('patch leaves the claim column alone', () => {
  const store = new ScheduleStore(new DatabaseSync(':memory:'))
  store.put(task())
  store.patch('t1', { lastRunAt: 5, lastChatId: 'c' })
  const t = store.get('t1')!
  assert.equal(t.lastChatId, 'c')
  assert.equal(t.nextRunAt, at(2026, 10, 14, 9))
})

test('scheduleFromInput takes exactly one way of saying when', () => {
  const now = at(2026, 10, 14, 12)
  assert.deepEqual(scheduleFromInput({ cron: '0 9 * * 1-5' }, now), { ok: true, schedule: { kind: 'cron', cron: '0 9 * * 1-5' } })
  assert.deepEqual(scheduleFromInput({ in_minutes: '60' }, now), { ok: true, schedule: { kind: 'once', at: now + 3600_000 } })
  assert.deepEqual(scheduleFromInput({ at: '2026-10-15T09:00' }, now), { ok: true, schedule: { kind: 'once', at: at(2026, 10, 15, 9) } })
  assert.equal(scheduleFromInput({ cron: '0 9 * * *', at: '2026-10-15T09:00' }, now).ok, false)
  assert.equal(scheduleFromInput({ at: '2026-10-13T09:00' }, now).ok, false)
  assert.equal(scheduleFromInput({ cron: '0 9 * *' }, now).ok, false)
  assert.deepEqual(scheduleFromInput({}, now), { ok: true, schedule: undefined })
})

test('canSchedule: never from a run or a delegate', () => {
  assert.equal(canSchedule({ id: 'c' }), true)
  assert.equal(canSchedule({ id: 'c', scheduled: { taskId: 't', taskName: 'n', firedAt: 0, status: 'running' } }), false)
  assert.equal(
    canSchedule({ id: 'c', delegation: { parentId: 'p', name: 'codex-a', task: 'x', status: 'running', createdAt: 0 } }),
    false
  )
  assert.equal(canSchedule({ id: 'c', surface: 'terminal' }), false)
  assert.equal(canSchedule(null), false)
})

test('resolveTask matches names loosely and refuses ambiguity', () => {
  const tasks = [task(), task({ id: 't2', name: 'Weekly report' }), task({ id: 't3', name: 'weekly-report' })]
  assert.equal((resolveTask(tasks, 'morning CHECK') as { task: ScheduledTask }).task.id, 't1')
  assert.equal((resolveTask(tasks, 't2') as { task: ScheduledTask }).task.id, 't2')
  assert.match((resolveTask(tasks, 'weekly report') as { error: string }).error, /2 tasks/)
  assert.equal(resolveTask(tasks, 'nope').ok, false)
})

test('runScheduleTool: create needs a when, and passes the parsed request to the host', async () => {
  const seen: unknown[] = []
  const host: ScheduleToolHost = {
    list: () => [],
    create: async (_chat, request) => {
      seen.push(request)
      return { ok: true, task: task({ name: request.name, prompt: request.prompt, schedule: request.schedule }) }
    },
    update: async () => ({ ok: false, error: 'x' }),
    delete: () => {},
    run: async () => ({ ok: false, error: 'x' })
  }
  const now = at(2026, 10, 14, 12)
  const missing = await runScheduleTool(host, { chatId: 'c', now }, 'create', { name: 'A', prompt: 'B' })
  assert.equal(missing.isError, true)
  const made = await runScheduleTool(host, { chatId: 'c', now }, 'create', {
    name: 'A',
    prompt: 'B',
    cron: '0 9 * * *',
    permission_mode: 'acceptEdits',
    worktree: 'true'
  })
  assert.equal(made.isError, undefined)
  assert.deepEqual(seen[0], {
    name: 'A',
    prompt: 'B',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    permissionMode: 'acceptEdits',
    worktree: true
  })
  const noChat = await runScheduleTool(host, { chatId: null, now }, 'list')
  assert.equal(noChat.isError, true)
})

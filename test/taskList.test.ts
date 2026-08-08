import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_LIST_TOOLS,
  foldTaskParts,
  parseTaskList,
  reconcileSnapshots
} from '../src/renderer/src/lib/taskList.ts'
import type { TaskItem, TaskToolPart } from '../src/renderer/src/lib/taskList.ts'

let n = 0
const part = (p: Partial<TaskToolPart> & { name: string }): TaskToolPart => ({
  type: 'tool',
  toolUseId: p.toolUseId ?? `tu${++n}`,
  status: 'success',
  ...p
})

/** A TaskCreate exactly as the CLI reports it: the id is only in the output. */
const create = (id: string, subject: string, activeForm?: string): TaskToolPart =>
  part({
    name: 'TaskCreate',
    input: { subject, description: `do: ${subject}`, ...(activeForm ? { activeForm } : {}) },
    output: `Task #${id} created successfully: ${subject}`
  })

const update = (taskId: string, status: string, extra: object = {}): TaskToolPart =>
  part({
    name: 'TaskUpdate',
    input: { taskId, status, ...extra },
    output: `Updated task #${taskId} status`
  })

/** Any other rendered content; its only job here is to end a run of calls. */
const gap = (): TaskToolPart => part({ name: 'Bash', input: { command: 'npm test' } })

const snaps = (items: TaskToolPart[]): Map<string, TaskItem[]> =>
  foldTaskParts(items).snapshots
const last = (items: TaskToolPart[]): TaskItem[] => {
  const s = snaps(items)
  return [...s.values()][s.size - 1]
}
const subjects = (items: TaskItem[]): string[] => items.map((t) => t.subject)

test('a created task lands as pending, named from the output id', () => {
  assert.deepEqual(last([create('1', 'Add the percentile helper')]), [
    { id: '1', subject: 'Add the percentile helper', status: 'pending', activeForm: undefined }
  ])
})

test('an update in a later message still finds its task', () => {
  // The case the whole module exists for: TaskCreate and TaskUpdate never share
  // an assistant message, so the fold has to span them.
  assert.equal(last([create('1', 'Read the aggregation'), gap(), update('1', 'completed')])[0].status, 'completed')
})

test('each run snapshots the list as it stood once that run settled', () => {
  const a = create('1', 'One')
  const b = create('2', 'Two')
  const c = update('1', 'in_progress')
  const s = snaps([a, gap(), b, gap(), c])
  assert.deepEqual([...s.values()].map((list) => list.length), [1, 2, 2])
  assert.equal(s.get(b.toolUseId)![1].status, 'pending')
  assert.equal(s.get(c.toolUseId)![0].status, 'in_progress')
})

test('a back-to-back run draws one card, at its last call', () => {
  // Five TaskCreates in a row would otherwise stutter 0/1, 0/2, 0/3, 0/4, 0/5.
  const parts = [1, 2, 3, 4, 5].map((i) => create(String(i), `Task ${i}`))
  const { snapshots, superseded } = foldTaskParts(parts)
  assert.deepEqual([...snapshots.keys()], [parts[4].toolUseId])
  assert.equal(snapshots.get(parts[4].toolUseId)!.length, 5)
  assert.deepEqual([...superseded], parts.slice(0, 4).map((p) => p.toolUseId))
})

test('content between two calls ends the run', () => {
  const a = create('1', 'One')
  const b = create('2', 'Two')
  const { snapshots, superseded } = foldTaskParts([a, gap(), b])
  assert.deepEqual([...snapshots.keys()], [a.toolUseId, b.toolUseId])
  assert.equal(superseded.size, 0)
})

test('a failed call ends the run and keeps its own error card', () => {
  const a = create('1', 'One')
  const failed = part({ name: 'TaskUpdate', input: { taskId: '1' }, status: 'error', output: 'nope' })
  const b = update('1', 'completed')
  const { snapshots, superseded } = foldTaskParts([a, failed, b])
  assert.equal(snapshots.has(failed.toolUseId), false)
  assert.equal(superseded.has(failed.toolUseId), false)
  // `a` is drawn rather than swallowed, because the failure broke the run.
  assert.deepEqual([...snapshots.keys()], [a.toolUseId, b.toolUseId])
  assert.equal(snapshots.get(b.toolUseId)![0].status, 'completed')
})

test('updating keeps creation order rather than moving the task to the end', () => {
  const items = last([
    create('1', 'One'),
    create('2', 'Two'),
    create('3', 'Three'),
    gap(),
    update('1', 'completed')
  ])
  assert.deepEqual(subjects(items), ['One', 'Two', 'Three'])
})

test('activeForm survives a status-only update', () => {
  const items = last([create('1', 'Run the tests', 'Running the tests'), gap(), update('1', 'in_progress')])
  assert.equal(items[0].activeForm, 'Running the tests')
})

test('a deleted task leaves the list', () => {
  const items = last([create('1', 'One'), create('2', 'Two'), gap(), update('2', 'deleted')])
  assert.deepEqual(items.map((t) => t.id), ['1'])
})

test('task_id is accepted alongside the documented taskId', () => {
  const items = last([
    create('1', 'One'),
    gap(),
    part({ name: 'TaskUpdate', input: { task_id: '1', status: 'completed' } })
  ])
  assert.equal(items[0].status, 'completed')
})

test('an update for a task created before the window is dropped, not invented', () => {
  assert.deepEqual(last([update('7', 'completed'), gap(), create('1', 'One')]).map((t) => t.id), ['1'])
})

test('TaskCreate whose output could not be parsed still shows up', () => {
  const odd = part({ name: 'TaskCreate', input: { subject: 'Orphan' }, output: 'something else' })
  assert.deepEqual(subjects(last([odd])), ['Orphan'])
})

test('TaskList renames tasks created before the loaded window', () => {
  const items = last([
    update('4', 'completed'), // unnameable on its own
    part({
      name: 'TaskList',
      input: {},
      output: '#4 [completed] Phase 1: schema\n#5 [in_progress] Phase 2: checkout core'
    })
  ])
  assert.deepEqual(items, [
    { id: '4', subject: 'Phase 1: schema', status: 'completed', activeForm: undefined },
    { id: '5', subject: 'Phase 2: checkout core', status: 'in_progress', activeForm: undefined }
  ])
})

test('parseTaskList ignores lines that are not rows', () => {
  assert.deepEqual(parseTaskList('noise\n#2 [pending] Real row\n\nmore noise'), [
    { id: '2', subject: 'Real row', status: 'pending' }
  ])
})

test('the background-task tools are not part of the checklist', () => {
  for (const name of ['TaskStop', 'TaskOutput', 'TaskGet']) {
    assert.equal(TASK_LIST_TOOLS.has(name), false, name)
  }
  assert.equal(snaps([part({ name: 'TaskStop', input: { task_id: 'b9f2eea2e' } })]).size, 0)
})

test('reconcile keeps array identity for lists that did not change', () => {
  const parts = [create('1', 'One'), gap(), create('2', 'Two')]
  const first = foldTaskParts(parts).snapshots
  const second = reconcileSnapshots(first, foldTaskParts(parts).snapshots)
  for (const key of first.keys()) assert.equal(second.get(key), first.get(key))
})

test('reconcile hands back a new array only where the list actually moved', () => {
  const a = create('1', 'One')
  const b = update('1', 'in_progress')
  const first = foldTaskParts([a, gap(), b]).snapshots
  // Same calls, but the second one now completes the task — only its own
  // snapshot changed, so only that array may lose its identity.
  const b2: TaskToolPart = { ...b, input: { taskId: '1', status: 'completed' } }
  const second = reconcileSnapshots(first, foldTaskParts([a, gap(), b2]).snapshots)
  assert.equal(second.get(a.toolUseId), first.get(a.toolUseId))
  assert.notEqual(second.get(b.toolUseId), first.get(b.toolUseId))
  assert.equal(second.get(b.toolUseId)![0].status, 'completed')
})

test('a later call never disturbs the snapshots before it', () => {
  const parts = [create('1', 'One'), gap(), create('2', 'Two'), gap()]
  const first = foldTaskParts(parts).snapshots
  const grown = reconcileSnapshots(first, foldTaskParts([...parts, update('1', 'completed')]).snapshots)
  for (const key of first.keys()) assert.equal(grown.get(key), first.get(key))
})

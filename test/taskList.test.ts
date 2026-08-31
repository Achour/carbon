import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKLIST_TOOLS,
  foldTasks,
  parseTaskList,
  reconcileTasks
} from '../src/renderer/src/lib/taskList.ts'
import type { TaskToolPart } from '../src/renderer/src/lib/taskList.ts'

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

/** Codex's whole-list call. */
const todoWrite = (todos: object[]): TaskToolPart =>
  part({ name: 'TodoWrite', input: { todos }, output: 'Todos updated' })

/** Any other tool call, to prove the fold ignores everything but the checklist. */
const other = (): TaskToolPart => part({ name: 'Bash', input: { command: 'npm test' } })

const subjects = (items: { subject: string }[]): string[] => items.map((t) => t.subject)

test('a created task lands as pending, named from the output id', () => {
  assert.deepEqual(foldTasks([create('1', 'Add the percentile helper')]), [
    { id: '1', subject: 'Add the percentile helper', status: 'pending', activeForm: undefined }
  ])
})

test('an update in a later message still finds its task', () => {
  // The case the whole module exists for: TaskCreate and TaskUpdate never share
  // an assistant message, so the fold has to span them.
  const items = foldTasks([create('1', 'Read the aggregation'), other(), update('1', 'completed')])
  assert.equal(items[0].status, 'completed')
})

test('the answer is the list as it stands, not one entry per call', () => {
  // The five back-to-back TaskCreates that used to stutter 0/1, 0/2, 0/3… as a
  // card each: one list, five tasks, whatever order the calls arrived in.
  const items = foldTasks([1, 2, 3, 4, 5].map((i) => create(String(i), `Task ${i}`)))
  assert.deepEqual(subjects(items), ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5'])
})

test('a failed call changes nothing', () => {
  const failed = part({
    name: 'TaskUpdate',
    input: { taskId: '1', status: 'completed' },
    status: 'error',
    output: 'nope'
  })
  assert.equal(foldTasks([create('1', 'One'), failed])[0].status, 'pending')
})

test('a running call is not folded — its input is still partial', () => {
  const running = part({ name: 'TodoWrite', input: { todos: [{ content: 'Hal' }] }, status: 'running' })
  assert.deepEqual(foldTasks([running]), [])
})

test('updating keeps creation order rather than moving the task to the end', () => {
  const items = foldTasks([
    create('1', 'One'),
    create('2', 'Two'),
    create('3', 'Three'),
    update('1', 'completed')
  ])
  assert.deepEqual(subjects(items), ['One', 'Two', 'Three'])
})

test('activeForm survives a status-only update', () => {
  const items = foldTasks([create('1', 'Run the tests', 'Running the tests'), update('1', 'in_progress')])
  assert.equal(items[0].activeForm, 'Running the tests')
})

test('a deleted task leaves the list', () => {
  const items = foldTasks([create('1', 'One'), create('2', 'Two'), update('2', 'deleted')])
  assert.deepEqual(items.map((t) => t.id), ['1'])
})

test('task_id is accepted alongside the documented taskId', () => {
  const items = foldTasks([
    create('1', 'One'),
    part({ name: 'TaskUpdate', input: { task_id: '1', status: 'completed' } })
  ])
  assert.equal(items[0].status, 'completed')
})

test('an update for a task created before the window is dropped, not invented', () => {
  const items = foldTasks([update('7', 'completed'), create('1', 'One')])
  assert.deepEqual(items.map((t) => t.id), ['1'])
})

test('TaskCreate whose output could not be parsed still shows up', () => {
  const odd = part({ name: 'TaskCreate', input: { subject: 'Orphan' }, output: 'something else' })
  assert.deepEqual(subjects(foldTasks([odd])), ['Orphan'])
})

test('TaskList renames tasks created before the loaded window', () => {
  const items = foldTasks([
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

test("Codex's TodoWrite folds into the same list", () => {
  const items = foldTasks([
    todoWrite([
      { content: 'Read the schema', status: 'completed' },
      { content: 'Add the column', status: 'in_progress', activeForm: 'Adding the column' },
      { content: 'Run the tests', status: 'pending' }
    ])
  ])
  assert.deepEqual(subjects(items), ['Read the schema', 'Add the column', 'Run the tests'])
  assert.equal(items[1].activeForm, 'Adding the column')
  assert.equal(items[2].status, 'pending')
})

test('TodoWrite replaces the list wholesale, and cannot collide with Claude ids', () => {
  // A chat can switch provider mid-conversation, so a Codex list may land on
  // top of a Claude one. Positional ids are prefixed for exactly that reason —
  // a bare "1" would merge into the task the previous provider called #1.
  const items = foldTasks([
    create('1', 'Claude task'),
    todoWrite([{ content: 'Codex task', status: 'pending' }])
  ])
  assert.deepEqual(subjects(items), ['Codex task'])
  assert.deepEqual(items.map((t) => t.id), ['todo:0'])
})

test('an empty TodoWrite leaves the list alone', () => {
  assert.deepEqual(subjects(foldTasks([create('1', 'One'), todoWrite([])])), ['One'])
})

test('the background-task tools are not part of the checklist', () => {
  for (const name of ['TaskStop', 'TaskOutput', 'TaskGet']) {
    assert.equal(CHECKLIST_TOOLS.has(name), false, name)
  }
  assert.deepEqual(foldTasks([part({ name: 'TaskStop', input: { task_id: 'b9f2eea2e' } })]), [])
})

test('everything that is not a checklist call is ignored', () => {
  assert.deepEqual(subjects(foldTasks([other(), create('1', 'One'), other()])), ['One'])
})

test('reconcile keeps the array identity when nothing moved', () => {
  const parts = [create('1', 'One'), create('2', 'Two')]
  const first = foldTasks(parts)
  assert.equal(reconcileTasks(first, foldTasks(parts)), first)
})

test('reconcile hands back the new array when a status flips', () => {
  const parts = [create('1', 'One')]
  const first = foldTasks(parts)
  const next = foldTasks([...parts, update('1', 'completed')])
  const second = reconcileTasks(first, next)
  assert.equal(second, next)
  assert.equal(second[0].status, 'completed')
})

test('parseTaskList ignores lines that are not rows', () => {
  assert.deepEqual(parseTaskList('noise\n#2 [pending] Real row\n\nmore noise'), [
    { id: '2', subject: 'Real row', status: 'pending' }
  ])
})

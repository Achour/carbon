import { strict as assert } from 'node:assert'
import test from 'node:test'
import { pickPreviewPane, type PaneCandidate } from '../src/shared/previewPane.ts'

const live = new Set(['parent', 'codex-a', 'codex-b'])
const isLive = (id: string): boolean => live.has(id)

test("a chat takes its own pane, never another live chat's", () => {
  const panes: PaneCandidate[] = [
    { id: 'p1', cwd: '/app', owner: 'parent', visible: true },
    { id: 'p2', cwd: '/app', owner: 'codex-a' }
  ]
  assert.deepEqual(pickPreviewPane(panes, '/app', 'codex-a', isLive), { id: 'p2', claim: false })
  assert.deepEqual(pickPreviewPane(panes, '/app', 'parent', isLive), { id: 'p1', claim: false })
  // codex-b has none and every pane is someone's: it needs a new one.
  assert.equal(pickPreviewPane(panes, '/app', 'codex-b', isLive), null)
})

test("the user's unowned pane is claimed by the first chat, so one chat works as before", () => {
  const panes: PaneCandidate[] = [{ id: 'p1', cwd: '/app/' }]
  assert.deepEqual(pickPreviewPane(panes, '/app', 'parent', isLive), { id: 'p1', claim: true })
})

test('a pane whose owner chat is gone is free again', () => {
  const panes: PaneCandidate[] = [{ id: 'p1', cwd: '/app', owner: 'deleted-chat' }]
  assert.deepEqual(pickPreviewPane(panes, '/app', 'codex-a', isLive), { id: 'p1', claim: true })
})

test('only panes of the project; among equals the visible one, then the most recent', () => {
  const panes: PaneCandidate[] = [
    { id: 'other', cwd: '/elsewhere', owner: 'parent', visible: true },
    { id: 'old', cwd: '/app', owner: 'parent', lastActive: 1 },
    { id: 'new', cwd: '/app', owner: 'parent', lastActive: 5 }
  ]
  assert.deepEqual(pickPreviewPane(panes, '/app', 'parent', isLive), { id: 'new', claim: false })
  assert.deepEqual(
    pickPreviewPane([...panes, { id: 'shown', cwd: '/app', owner: 'parent', visible: true }], '/app', 'parent', isLive),
    { id: 'shown', claim: false }
  )
})

test('no owner (a caller with no chat) takes any pane of the project and claims none', () => {
  const panes: PaneCandidate[] = [{ id: 'p1', cwd: '/app', owner: 'codex-a' }]
  assert.deepEqual(pickPreviewPane(panes, '/app', undefined, isLive), { id: 'p1', claim: false })
})

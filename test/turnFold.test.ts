import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantPart, ChatMessage } from '../src/shared/types.ts'
import { foldTurns } from '../src/renderer/src/lib/turnFold.ts'

let clock = 0
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', ts: (clock += 1000) })
const assistant = (id: string, parts: AssistantPart[]): ChatMessage => ({
  id,
  role: 'assistant',
  parts,
  ts: (clock += 1000)
})
const text = (t: string): AssistantPart => ({ type: 'text', text: t })
const thinking = (t: string): AssistantPart => ({ type: 'thinking', text: t })
const tool = (id: string, over: Partial<AssistantPart & { type: 'tool' }> = {}): AssistantPart => ({
  type: 'tool',
  toolUseId: id,
  name: 'Bash',
  status: 'success',
  ...over
})

test('the answer is the trailing text run, across messages', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('let me check')]),
    assistant('a2', [tool('t1')]),
    assistant('a3', [text('done'), text('and here is why')])
  ])
  const fold = folds.get('u1')
  // The preamble folds away with the call it introduces — `turnAnswerText`
  // would have kept it, which is the copy rule and not the fold rule.
  assert.deepEqual(fold?.answerFrom, { messageId: 'a3', partIndex: 0 })
  assert.equal(fold?.collapsible, true)
})

test('the boundary can fall inside one message (Codex accumulates a turn)', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('checking'), tool('t1'), tool('t2'), text('all good')])
  ])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 3 })
})

test('a thought with text ends the answer run, a withheld one does not', () => {
  const visible = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1'), thinking('so the fix is…'), text('here it is')])
  ])
  assert.deepEqual(visible.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 2 })

  // Claude withholds the text, so the block draws nothing and decides nothing:
  // the answer still starts at the text part above it.
  const withheld = foldTurns([
    user('u1'),
    assistant('a1', [text('first'), thinking(''), text('second')]),
    assistant('a2', [thinking('')])
  ])
  assert.deepEqual(withheld.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 0 })
  assert.equal(withheld.get('u1')?.collapsible, false)
})

test('a turn that ends on work has no answer and folds whole', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('planning')]),
    assistant('a2', [tool('t1')])
  ])
  assert.equal(folds.get('u1')?.answerFrom, null)
  assert.equal(folds.get('u1')?.collapsible, true)
})

test('a turn that only talked hides nothing', () => {
  const folds = foldTurns([user('u1'), assistant('a1', [text('yes')])])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 0 })
  assert.equal(folds.get('u1')?.collapsible, false)
})

test('elapsed runs from the prompt to the turn’s last message, whatever its role', () => {
  clock = 0
  const messages: ChatMessage[] = [
    user('u1'),
    assistant('a1', [text('hi')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: 9000 },
    user('u2')
  ]
  const folds = foldTurns(messages)
  assert.equal(folds.get('u1')?.startTs, 1000)
  assert.equal(folds.get('u1')?.endTs, 9000)
  assert.equal(folds.get('u1')?.replied, true)
  // A prompt with nothing after it yet: no reply, so the header has no settled
  // reading to show and `renderMessages` draws none.
  assert.equal(folds.get('u2')?.replied, false)
  assert.equal(folds.get('u2')?.endTs, folds.get('u2')?.startTs)
})

test('work that outlives the turn keeps the turn open', () => {
  const idle = foldTurns([user('u1'), assistant('a1', [tool('t1'), text('done')])])
  assert.equal(idle.get('u1')?.running, false)

  // A backgrounded job's card stays live past the result (`claude.ts` skips
  // `terminalizeRunning` while one is open).
  const job = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1', { status: 'running' }), text('started it')])
  ])
  assert.equal(job.get('u1')?.running, true)

  // A backgrounded agent's own call returns at spawn; its children keep going.
  const agent = foldTurns([
    user('u1'),
    assistant('a1', [
      tool('t1', {
        name: 'Agent',
        children: [{ type: 'tool', toolUseId: 'c1', name: 'Read', status: 'running' }]
      }),
      text('spawned')
    ])
  ])
  assert.equal(agent.get('u1')?.running, true)
})

test('an interrupted turn dates itself by its last call, not its one message', () => {
  clock = 0
  // Codex accumulates the whole turn into one message, stamped when it opened,
  // and an interrupt closes no event — so the message stamp alone reports 0s.
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('working'), tool('t1', { startedAt: 100_000 })])
  ])
  assert.equal(folds.get('u1')?.startTs, 1000)
  assert.equal(folds.get('u1')?.endTs, 100_000)
})

test('assistant messages before the first prompt belong to no turn', () => {
  // The loaded window can start mid-turn. Those messages get no fold, so they
  // are never folded away behind a header that is not on screen.
  const folds = foldTurns([assistant('a0', [tool('t0')]), user('u1'), assistant('a1', [text('k')])])
  assert.equal(folds.size, 1)
  assert.ok(folds.has('u1'))
})

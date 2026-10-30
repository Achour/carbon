import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantPart, ChatMessage } from '../src/shared/types.ts'
import { foldTurns } from '../src/renderer/src/lib/turnFold.ts'
import {
  bookmarkText,
  earlierBookmarks,
  plainText,
  railTurns,
  reconcileTurns
} from '../src/renderer/src/lib/turnRail.ts'
import { isDelivery } from '../src/shared/delivery.ts'

let clock = 0
const user = (id: string, text = 'go', extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', text, ts: (clock += 1000), ...extra }) as ChatMessage
const assistant = (id: string, parts: AssistantPart[]): ChatMessage => ({
  id,
  role: 'assistant',
  parts,
  ts: (clock += 1000)
})
const text = (t: string): AssistantPart => ({ type: 'text', text: t })
const tool = (id: string): AssistantPart => ({ type: 'tool', toolUseId: id, name: 'Bash', status: 'success' })
const turnsOf = (messages: ChatMessage[], busy = false) => railTurns(messages, foldTurns(messages), busy)

test('one turn per prompt, with its answer and its steps across messages', () => {
  const turns = turnsOf([
    user('u1', 'show a **bmw** for sale'),
    assistant('a1', [text('let me look'), tool('t1')]),
    assistant('a2', [tool('t2'), text('There are **no BMWs** listed.')]),
    user('u2', 'thanks'),
    assistant('a3', [text('Any time.')])
  ])
  assert.deepEqual(
    turns.map((t) => [t.id, t.prompt, t.answer, t.steps]),
    [
      ['u1', 'show a bmw for sale', 'There are no BMWs listed.', 2],
      ['u2', 'thanks', 'Any time.', 0]
    ]
  )
  assert.ok(turns[0].ms > 0)
})

test('a labelled action is named by its label, an attachment by what it is', () => {
  const turns = turnsOf([
    user('u1', 'long hidden prompt the app wrote', { label: 'Commit' } as Partial<ChatMessage>),
    user('u2', '', { attachments: [{ id: 'x', kind: 'image', name: 'a.png', mediaType: 'image/png', data: '' }] } as Partial<ChatMessage>)
  ])
  assert.deepEqual(turns.map((t) => t.prompt), ['Commit', 'Attachment'])
})

test("a delegate's delivery is not a turn: its work counts toward the turn that sent the agent", () => {
  const delivered = (id: string) =>
    user(id, 'Your agent sol (Codex) has finished.\n\nAgent: sol (id c1)', { label: 'sol finished · review' } as Partial<ChatMessage>)
  const messages = [
    user('u1', 'review it with sol'),
    assistant('a1', [tool('t1')]),
    delivered('d1'),
    assistant('a2', [tool('t2'), text('sol found two bugs')]),
    user('u2', 'Your agent words, typed by hand'),
    assistant('a3', [text('ok')]),
    delivered('d2')
  ]
  const turns = railTurns(messages, foldTurns(messages), true, isDelivery)
  assert.deepEqual(turns.map((t) => [t.id, t.steps]), [['u1', 2], ['u2', 0]])
  // The delivery is the newest message, so the turn it continues is the live one.
  assert.deepEqual(turns.map((t) => t.live), [false, true])
})

test('a turn that ended on work has no answer, and only the last turn of a busy chat is live', () => {
  const messages = [user('u1'), assistant('a1', [tool('t1')]), user('u2'), assistant('a2', [text('hi')])]
  const turns = turnsOf(messages, true)
  assert.equal(turns[0].answer, '')
  assert.deepEqual(turns.map((t) => t.live), [false, true])
  assert.deepEqual(turnsOf(messages, false).map((t) => t.live), [false, false])
})

test('weight climbs with the work, on a log scale', () => {
  const short = turnsOf([user('u1'), assistant('a1', [text('ok')])])[0]
  const busy = turnsOf([user('u1'), assistant('a1', Array.from({ length: 12 }, (_, i) => tool(`t${i}`)))])[0]
  const huge = turnsOf([user('u1'), assistant('a1', [...Array.from({ length: 40 }, (_, i) => tool(`t${i}`)), text('x'.repeat(2000))])])[0]
  assert.deepEqual([short.weight, busy.weight, huge.weight], [0, 1, 3])
})

test('plainText drops markdown and keeps the words, code included', () => {
  assert.equal(
    plainText('## Result\n\n- **one** `two`\n- [three](http://x)\n\n```ts\nconst four = 4\n```'),
    'Result one two three const four = 4'
  )
})

test('long prompts and bookmark text are cut at a word', () => {
  const long = 'word '.repeat(80)
  const [turn] = turnsOf([user('u1', long)])
  assert.ok(turn.prompt.length <= 241 && turn.prompt.endsWith('…'))
  assert.ok(!bookmarkText(long).includes('wor…'))
})

test('reconcile keeps unchanged turns, and the list, at their identity', () => {
  const messages = [user('u1'), assistant('a1', [text('done')]), user('u2'), assistant('a2', [text('par')])]
  const first = turnsOf(messages, true)
  assert.equal(reconcileTurns(first, turnsOf(messages, true)), first)

  const grown = turnsOf([...messages.slice(0, 3), assistant('a2', [text('partial answer')])], true)
  const next = reconcileTurns(first, grown)
  assert.notEqual(next, first)
  assert.equal(next[0], first[0])
  assert.notEqual(next[1], first[1])
})

test('earlier bookmarks are the unmatched ones, and only while history is left to load', () => {
  const turns = turnsOf([user('u5'), user('u6')])
  const marks = [
    { id: 'u1', text: 'old one' },
    { id: 'u6', text: 'loaded' }
  ]
  assert.deepEqual(earlierBookmarks(marks, turns, 40).map((b) => b.id), ['u1'])
  // Everything is loaded and u1 is not there: it was rewound away.
  assert.deepEqual(earlierBookmarks(marks, turns, 0), [])
})

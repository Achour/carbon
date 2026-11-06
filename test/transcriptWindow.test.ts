import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/shared/types.ts'
import { placeMessage, truncateWindow } from '../src/shared/transcriptWindow.ts'

const msg = (id: string, ts: number, text = id): ChatMessage => ({ id, role: 'user', text, ts })
const window = [msg('a', 100), msg('b', 200), msg('c', 300)]

test('a known message is replaced where it sits', () => {
  const next = placeMessage(window, msg('b', 200, 'edited'), 40, 41)
  assert.deepEqual(next.map((m) => m.id), ['a', 'b', 'c'])
  assert.equal((next[1] as { text: string }).text, 'edited')
})

test('a new message is appended', () => {
  assert.deepEqual(placeMessage(window, msg('d', 400), 40, 43).map((m) => m.id), ['a', 'b', 'c', 'd'])
})

test('a message from above the window is left to the window that holds it', () => {
  assert.equal(placeMessage(window, msg('old', 50), 40, 39), window)
})

test('above is decided by index, not time: a shared millisecond still stays above', () => {
  // m59 re-stated with the same timestamp as the window's first message.
  assert.equal(placeMessage(window, msg('m59', 100), 40, 39), window)
  // ...and a genuinely new message sharing that millisecond is still appended.
  assert.deepEqual(placeMessage(window, msg('new', 100), 40, 43).map((m) => m.id), ['a', 'b', 'c', 'new'])
})

test('an event main could not place is appended, as before windows existed', () => {
  assert.deepEqual(placeMessage(window, msg('x', 50), 40).map((m) => m.id), ['a', 'b', 'c', 'x'])
})

test('truncating inside the window cuts it locally', () => {
  const next = truncateWindow(window, 40, 42)
  assert.deepEqual(next.messages.map((m) => m.id), ['a', 'b'])
  assert.equal(next.hiddenBefore, 40)
})

test('truncating past the window changes nothing', () => {
  const next = truncateWindow(window, 40, 43)
  assert.equal(next.messages, window)
})

test('truncating above the window empties it and moves the boundary', () => {
  assert.deepEqual(truncateWindow(window, 40, 25), { messages: [], hiddenBefore: 25 })
})

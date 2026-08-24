import { test } from 'node:test'
import assert from 'node:assert/strict'
import { widenPoint } from '../src/renderer/src/lib/diagnosticRange.ts'

// Line "abc" occupying offsets 4..7 of some larger document.
const FROM = 4
const TO = 7

test('widens forward onto the next character', () => {
  assert.deepEqual(widenPoint(4, FROM, TO), { from: 4, to: 5 })
  assert.deepEqual(widenPoint(6, FROM, TO), { from: 6, to: 7 })
})

test('at end of line, widens backward so the mark stays on that line', () => {
  // Widening forward here would take the newline and put the squiggle on a
  // line the error is not on.
  assert.deepEqual(widenPoint(TO, FROM, TO), { from: 6, to: 7 })
})

test('an empty line has nothing to underline', () => {
  assert.equal(widenPoint(9, 9, 9), null)
})

test('a one-character line still resolves', () => {
  assert.deepEqual(widenPoint(0, 0, 1), { from: 0, to: 1 })
  assert.deepEqual(widenPoint(1, 0, 1), { from: 0, to: 1 })
})

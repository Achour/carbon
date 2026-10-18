import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropTarget, insertionIndex, landingOffset, rowShift } from '../src/renderer/src/lib/sortShift.ts'

// Four rows, 40px apart; their midpoints at 20, 60, 100, 140.
const STEP = 40
const shifts = (n: number, origin: number | null, insertAt: number | null): number[] =>
  Array.from({ length: n }, (_, i) => rowShift(i, origin, insertAt, STEP))

test('insertion index counts the midpoints above the pointer', () => {
  assert.equal(insertionIndex([20, 60, 100], 0), 0)
  assert.equal(insertionIndex([20, 60, 100], 61), 2)
  assert.equal(insertionIndex([20, 60, 100], 500), 3)
})

test('a drag that has not moved shifts nothing', () => {
  assert.deepEqual(shifts(4, 1, 1), [0, 0, 0, 0])
})

test('dragging down: the rows passed move up into the slot left behind', () => {
  // Row 0 dragged below row 2: rows 1 and 2 move up, row 3 stays.
  assert.deepEqual(shifts(4, 0, 2), [0, -40, -40, 0])
})

test('dragging up: the rows passed move down to open the gap', () => {
  // Row 3 dragged to the top: rows 0–2 move down one step.
  assert.deepEqual(shifts(4, 3, 0), [40, 40, 40, 0])
})

test('leaving a list closes its gap; entering another opens one', () => {
  assert.deepEqual(shifts(4, 1, null), [0, 0, -40, -40])
  assert.deepEqual(shifts(3, null, 1), [0, 40, 40])
})

test('the landing offset is whole steps from the slot left', () => {
  assert.equal(landingOffset(0, 2, STEP), 80)
  assert.equal(landingOffset(3, 0, STEP), -120)
})

test('the drop names a neighbour, or nothing when the row has not moved', () => {
  const others = ['b', 'c', 'd']
  assert.deepEqual(dropTarget(others, 0, 3), { id: 'b', after: false })
  assert.deepEqual(dropTarget(others, 3, 0), { id: 'd', after: true })
  assert.equal(dropTarget(others, 1, 1), null)
  assert.deepEqual(dropTarget(others, 1, null), { id: 'c', after: false })
  assert.equal(dropTarget([], 0, null), null)
})

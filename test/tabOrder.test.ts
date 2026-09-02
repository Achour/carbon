import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveItem } from '../src/renderer/src/lib/tabOrder.ts'

const abcd = ['a', 'b', 'c', 'd']

test('moves an item before a later target', () => {
  assert.deepEqual(moveItem(abcd, 0, 2, 'before'), ['b', 'a', 'c', 'd'])
})

test('moves an item after a later target', () => {
  assert.deepEqual(moveItem(abcd, 0, 2, 'after'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveItem(abcd, 0, 3, 'after'), ['b', 'c', 'd', 'a'])
})

test('moves an item before and after an earlier target', () => {
  assert.deepEqual(moveItem(abcd, 3, 1, 'before'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveItem(abcd, 3, 1, 'after'), ['a', 'b', 'd', 'c'])
  assert.deepEqual(moveItem(abcd, 3, 0, 'before'), ['d', 'a', 'b', 'c'])
})

test('returns the same array when nothing would move', () => {
  assert.equal(moveItem(abcd, 1, 1, 'before'), abcd)
  assert.equal(moveItem(abcd, 1, 1, 'after'), abcd)
  assert.equal(moveItem(abcd, 1, 0, 'after'), abcd)
  assert.equal(moveItem(abcd, 1, 2, 'before'), abcd)
  assert.equal(moveItem(abcd, 9, 0, 'before'), abcd)
  assert.equal(moveItem(abcd, 0, -1, 'before'), abcd)
})

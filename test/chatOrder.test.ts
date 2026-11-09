import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyForDrop, sortChats } from '../src/renderer/src/lib/chatOrder.ts'

const list = [
  { id: 'a', sortKey: 400, updatedAt: 0 },
  { id: 'b', sortKey: 300, updatedAt: 0 },
  { id: 'c', sortKey: 200, updatedAt: 0 },
  { id: 'd', sortKey: 100, updatedAt: 0 }
]

const place = (from: string, target: string, after: boolean): string[] => {
  const key = keyForDrop(list, from, target, after)
  assert.notEqual(key, null)
  return sortChats(list.map((c) => (c.id === from ? { ...c, sortKey: key! } : c))).map((c) => c.id)
}

test('lands directly above or below the target', () => {
  assert.deepEqual(place('d', 'b', false), ['a', 'd', 'b', 'c'])
  assert.deepEqual(place('d', 'b', true), ['a', 'b', 'd', 'c'])
  assert.deepEqual(place('a', 'c', true), ['b', 'c', 'a', 'd'])
})

test('the ends of the list', () => {
  assert.deepEqual(place('c', 'a', false), ['c', 'a', 'b', 'd'])
  assert.deepEqual(place('a', 'd', true), ['b', 'c', 'd', 'a'])
})

test('a drop that changes nothing is null', () => {
  assert.equal(keyForDrop(list, 'b', 'b', false), null)
  assert.equal(keyForDrop(list, 'b', 'c', false), null)
  assert.equal(keyForDrop(list, 'b', 'a', true), null)
  assert.equal(keyForDrop(list, 'b', 'gone', true), null)
})

test('a chat with no key sorts by updatedAt', () => {
  const mixed = [
    { id: 'x', updatedAt: 250 },
    { id: 'y', sortKey: 300, updatedAt: 0 },
    { id: 'z', sortKey: 200, updatedAt: 999 }
  ]
  assert.deepEqual(sortChats(mixed).map((c) => c.id), ['y', 'x', 'z'])
})

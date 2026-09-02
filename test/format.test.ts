import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateGroup, relativeTime } from '../src/renderer/src/lib/format.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

test('relativeTime advances from now through minute and hour labels', () => {
  const updatedAt = Date.UTC(2026, 8, 2, 12)

  assert.equal(relativeTime(updatedAt, updatedAt + MINUTE - 1), 'now')
  assert.equal(relativeTime(updatedAt, updatedAt + MINUTE), '1m')
  assert.equal(relativeTime(updatedAt, updatedAt + 59 * MINUTE), '59m')
  assert.equal(relativeTime(updatedAt, updatedAt + HOUR), '1h')
})

test('dateGroup uses the supplied clock', () => {
  const updatedAt = new Date(2026, 8, 2, 23, 59).getTime()

  assert.equal(dateGroup(updatedAt, updatedAt), 'Today')
  assert.equal(dateGroup(updatedAt, new Date(2026, 8, 3, 0, 1).getTime()), 'Yesterday')
})

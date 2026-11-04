import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSteers, mergeSteers } from '../src/main/pendingSteers.ts'
import type { PendingSteer } from '../src/shared/types.ts'

function list(cancellable = true): {
  steers: PendingSteers
  published: { steers: PendingSteer[] }[]
} {
  const published: { steers: PendingSteer[] }[] = []
  const steers = new PendingSteers((s) => published.push({ steers: s }), cancellable)
  return { steers, published }
}

test('every change publishes the whole list, names and not image data', () => {
  const { steers, published } = list()
  const image = { id: 'i', name: 'shot.png', kind: 'image', data: 'BASE64' } as never
  steers.add({ id: 'a', text: 'one', attachments: [image] })
  steers.add({ id: 'b', text: 'two', attachments: [] })
  assert.deepEqual(published.at(-1)?.steers, [
    { id: 'a', text: 'one', attachmentNames: ['shot.png'], cancellable: true },
    { id: 'b', text: 'two', cancellable: true }
  ])
  assert.equal(steers.take('a')?.text, 'one')
  assert.deepEqual(published.at(-1)?.steers.map((s) => s.id), ['b'])
})

test('an unknown id changes nothing and publishes nothing', () => {
  const { steers, published } = list()
  assert.equal(steers.take('nope'), undefined)
  assert.equal(published.length, 0)
})

test('takeAll lands them oldest first and an empty list stays silent', () => {
  const { steers, published } = list(false)
  steers.add({ id: 'a', text: 'one', attachments: [] })
  steers.add({ id: 'b', text: 'two', attachments: [] })
  assert.deepEqual(steers.takeAll().map((s) => s.id), ['a', 'b'])
  assert.equal(published.at(-1)?.steers.length, 0)
  const before = published.length
  assert.deepEqual(steers.takeAll(), [])
  assert.equal(published.length, before)
})

test('takeExcept hands over whole messages and leaves what is still on its way', () => {
  const { steers, published } = list()
  const image = { id: 'i', name: 'shot.png', kind: 'image', data: 'BASE64' } as never
  steers.add({ id: 'a', text: 'one', attachments: [image] })
  steers.add({ id: 'b', text: 'two', attachments: [] })
  assert.deepEqual(steers.takeExcept(['b']), [{ id: 'a', text: 'one', attachments: [image] }])
  assert.deepEqual(published.at(-1)?.steers.map((s) => s.id), ['b'])
  const before = published.length
  assert.deepEqual(steers.takeExcept(['b']), [])
  assert.equal(published.length, before)
})

test('mergeSteers makes one message of what a Stop cut off, in order', () => {
  const image = { id: 'i', name: 'shot.png', kind: 'image', data: 'BASE64' } as never
  assert.equal(mergeSteers([]), undefined)
  assert.deepEqual(
    mergeSteers([
      { id: 'a', text: 'one', attachments: [] },
      { id: 'b', text: '', attachments: [image] },
      { id: 'c', text: 'two', attachments: [] }
    ]),
    { text: 'one\n\ntwo', attachments: [image] }
  )
})

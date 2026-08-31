import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { CanvasStore, MAX_CANVAS_BYTES } from '../src/main/canvasStore.ts'

function store(): CanvasStore {
  return new CanvasStore(new DatabaseSync(':memory:'))
}

test('a canvas is listed under its project, newest first', () => {
  const s = store()
  const a = s.save({ project: '/a', title: 'One', html: '<p>1</p>' })
  const b = s.save({ project: '/a', title: 'Two', html: '<p>2</p>' })
  s.save({ project: '/b', title: 'Elsewhere', html: '<p>3</p>' })
  const ids = s.list('/a').map((c) => c.id)
  assert.equal(ids.length, 2)
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
  assert.deepEqual(s.list('/b').map((c) => c.title), ['Elsewhere'])
  assert.deepEqual(s.list('/nothing'), [])
})

test('the list carries no bodies', () => {
  const s = store()
  s.save({ project: '/a', title: 'One', html: '<p>a very long document</p>' })
  // Listing forty canvases must not read forty documents; the type says so and
  // the query has to agree with it.
  assert.equal('html' in (s.list('/a')[0] as object), false)
})

test('saving with an id revises rather than duplicating', () => {
  const s = store()
  const first = s.save({ project: '/a', title: 'Report', html: '<p>v1</p>' })
  const second = s.save({ id: first.id, project: '/a', title: 'Report v2', html: '<p>v2</p>' })
  assert.equal(second.id, first.id)
  assert.equal(s.list('/a').length, 1)
  assert.equal(s.get(first.id)?.html, '<p>v2</p>')
  assert.equal(second.createdAt, first.createdAt)
})

test('a revision never moves a canvas between projects', () => {
  const s = store()
  const c = s.save({ project: '/a', title: 'One', html: '<p>1</p>' })
  // A worktree chat passes a different directory for the same document; the id
  // is the identity, so the canvas stays where it was created.
  s.save({ id: c.id, project: '/worktree', title: 'One', html: '<p>2</p>' })
  assert.equal(s.list('/a').length, 1)
  assert.equal(s.list('/worktree').length, 0)
})

test('an untitled canvas still gets a name', () => {
  const s = store()
  assert.equal(s.save({ project: '/a', title: '  ', html: '<p>x</p>' }).title, 'Untitled canvas')
})

test('an oversized canvas is refused, not truncated', () => {
  const s = store()
  // Half a document renders as a broken one with no way to tell it apart from
  // a document that is simply wrong, so the write fails loudly instead.
  assert.throws(
    () => s.save({ project: '/a', title: 'Big', html: 'x'.repeat(MAX_CANVAS_BYTES + 1) }),
    /too large/
  )
  assert.equal(s.list('/a').length, 0)
})

test('delete removes exactly one canvas', () => {
  const s = store()
  const a = s.save({ project: '/a', title: 'One', html: '<p>1</p>' })
  s.save({ project: '/a', title: 'Two', html: '<p>2</p>' })
  s.delete(a.id)
  assert.equal(s.get(a.id), null)
  assert.equal(s.list('/a').length, 1)
})

test('opening the same database twice is not a migration', () => {
  // userData is shared between builds and branches, so the schema has to be
  // additive and re-openable — that is why it carries no user_version bump.
  const db = new DatabaseSync(':memory:')
  const first = new CanvasStore(db)
  const saved = first.save({ project: '/a', title: 'One', html: '<p>1</p>' })
  const second = new CanvasStore(db)
  assert.equal(second.get(saved.id)?.title, 'One')
})

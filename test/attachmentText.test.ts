import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeCanvas, describeSelection } from '../src/main/attachmentText.ts'

const base = { path: '/proj/src/foo.ts', rel: 'src/foo.ts', startLine: 12, endLine: 30 }

test('a selection names its file, range and language', () => {
  const out = describeSelection({ ...base, text: 'const a = 1', language: 'typescript' })
  assert.equal(
    out,
    'Selected code from src/foo.ts (lines 12-30):\n```typescript\nconst a = 1\n```'
  )
})

test('a one-line selection says line, not lines', () => {
  const out = describeSelection({ ...base, endLine: 12, text: 'const a = 1' })
  assert.match(out, /\(line 12\)/)
})

test('the absolute path stands in when there is no relative one', () => {
  const out = describeSelection({ ...base, rel: undefined, text: 'x' })
  assert.match(out, /^Selected code from \/proj\/src\/foo\.ts /)
})

test('a truncated selection says so while still naming every line', () => {
  const out = describeSelection({ ...base, text: 'x', truncated: true })
  assert.match(out, /lines 12-30, truncated — read the file for the rest/)
})

test('a snippet containing a fence is wrapped in a longer one', () => {
  // A README excerpt: a 3-backtick fence here would close at the inner fence
  // and spill the rest of the file into the prompt as prose.
  const text = 'Example:\n```ts\nconst a = 1\n```\ndone'
  const out = describeSelection({ ...base, text })
  assert.ok(out.includes('````\n' + text + '\n````'), out)
  // The snippet survives intact.
  assert.ok(out.includes(text))
})

test('the fence outruns the longest backtick run, not just three', () => {
  const text = 'a ````` b'
  const out = describeSelection({ ...base, text })
  assert.ok(out.includes('``````\n' + text + '\n``````'), out)
})

test('inline backticks do not lengthen the fence past need', () => {
  const out = describeSelection({ ...base, text: 'a `code` b' })
  assert.ok(out.includes('```\na `code` b\n```'), out)
})

// ---------- canvases ----------

const canvas = {
  id: 'c-9f2a',
  title: 'Query Audit',
  text: 'Query | Calls\nlistFeed | 1,204'
}

test('a canvas names its title and content', () => {
  const out = describeCanvas(canvas)
  assert.match(out, /^Attached canvas "Query Audit" \(id: c-9f2a\)\./)
  assert.match(out, /```\nQuery \| Calls\nlistFeed \| 1,204\n```/)
})

test('the id is stated as the handle for a revision', () => {
  // Without this the model has no way to revise *this* canvas, and the next
  // "add a column" writes a second one with the same title.
  const out = describeCanvas(canvas)
  assert.match(out, /`read` tool with id c-9f2a/)
  assert.match(out, /`write` with the same id/)
})

test('a canvas says it is not a file in the project', () => {
  // It has no path, so an agent told only "attached" would go looking for one.
  assert.match(describeCanvas(canvas), /not a file in the project/)
})

test('a truncated canvas points at the tool for the rest', () => {
  const out = describeCanvas({ ...canvas, truncated: true })
  assert.match(out, /truncated; call the canvas `read` tool with this id for the rest/)
})

test('a canvas containing a fence is wrapped in a longer one', () => {
  // A canvas full of code samples is routine — an audit quoting the queries it
  // found — and a three-backtick fence around one ends at *its* fence.
  const out = describeCanvas({ ...canvas, text: 'see:\n```sql\nSELECT 1\n```' })
  assert.match(out, /````\nsee:/)
  assert.ok(out.trimEnd().endsWith('````'))
})

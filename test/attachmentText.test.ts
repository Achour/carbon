import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeSelection } from '../src/main/attachmentText.ts'

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

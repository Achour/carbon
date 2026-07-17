import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitMarkdownStream } from '../src/renderer/src/lib/markdownStream.ts'

// A tiny minChunk so a couple of paragraphs is enough to force a seal.
const MIN = 10

/** Chunks + tail must always reassemble to exactly the input. */
function split(text: string, minChunk = MIN): { chunks: string[]; tail: string } {
  const r = splitMarkdownStream(text, minChunk)
  assert.equal(r.chunks.join('') + r.tail, text, 'chunks+tail must reassemble the input')
  return r
}

test('short text stays a single tail', () => {
  const r = split('hello **world**')
  assert.deepEqual(r.chunks, [])
  assert.equal(r.tail, 'hello **world**')
})

test('seals at a blank-line boundary once minChunk is reached', () => {
  const text = 'first paragraph\n\nsecond paragraph\n\nthird'
  const r = split(text)
  assert.deepEqual(r.chunks, ['first paragraph\n\n', 'second paragraph\n\n'])
  assert.equal(r.tail, 'third')
})

test('accumulates blocks until minChunk before sealing', () => {
  const text = 'aa\n\nbb\n\ncc\n\ndddddddddddddddd\n\ntail'
  const r = split(text, 12)
  // 'aa\n\nbb\n\ncc\n\n' is the first prefix ≥ 12 chars ending at a boundary.
  assert.deepEqual(r.chunks, ['aa\n\nbb\n\ncc\n\n', 'dddddddddddddddd\n\n'])
  assert.equal(r.tail, 'tail')
})

test('never splits inside a fenced code block', () => {
  const text = 'intro paragraph\n\n```js\nconst a = 1\n\nconst b = 2\n\n```\n\nafter'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n', '```js\nconst a = 1\n\nconst b = 2\n\n```\n\n'])
  assert.equal(r.tail, 'after')
})

test('an unterminated fence keeps everything after it in the tail', () => {
  const text = 'intro paragraph\n\n```python\nprint(1)\n\nprint(2)\n\nstill code'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n'])
  assert.equal(r.tail, '```python\nprint(1)\n\nprint(2)\n\nstill code')
})

test('a backtick line inside a tilde fence does not close it', () => {
  const text = 'intro paragraph\n\n~~~\n```\n\ntext\n~~~\n\nafter'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n', '~~~\n```\n\ntext\n~~~\n\n'])
  assert.equal(r.tail, 'after')
})

test('a shorter closing marker does not close a longer fence', () => {
  const text = 'intro paragraph\n\n````\n```\n\n````\n\nafter'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n', '````\n```\n\n````\n\n'])
  assert.equal(r.tail, 'after')
})

test('a loose list seals as one whole block', () => {
  const text =
    'intro paragraph\n\n- item one\n\n- item two\n\n1. ordered\n\n2) also ordered\n\nclosing paragraph'
  const r = split(text)
  // Boundaries exist before and after the list run, never between its items.
  assert.deepEqual(r.chunks, [
    'intro paragraph\n\n',
    '- item one\n\n- item two\n\n1. ordered\n\n2) also ordered\n\n'
  ])
  assert.equal(r.tail, 'closing paragraph')
})

test('does not seal before indented continuations of a list', () => {
  const text = 'intro paragraph\n\n- item\n\n  continuation\n\n    indented code\n\nafter the list'
  const r = split(text)
  assert.deepEqual(r.chunks, [
    'intro paragraph\n\n',
    '- item\n\n  continuation\n\n    indented code\n\n'
  ])
  assert.equal(r.tail, 'after the list')
})

test('a paragraph starting with a bare number is a valid boundary', () => {
  const text = 'intro paragraph\n\n1976 was a good year'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n'])
  assert.equal(r.tail, '1976 was a good year')
})

test('headings, quotes and fences are valid boundaries', () => {
  const text = 'intro paragraph\n\n# Heading\n\n> a longer quote\n\n```\ncode\n```'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n', '# Heading\n\n', '> a longer quote\n\n'])
  assert.equal(r.tail, '```\ncode\n```')
})

test('sealed chunks are stable as the stream grows', () => {
  const full =
    'first paragraph with some length\n\n## Section\n\ntext under it\n\n```ts\nconst x = 1\n```\n\n' +
    'closing paragraph that keeps going for a while\n\nthe very end'
  let prev: string[] = []
  for (let n = 1; n <= full.length; n++) {
    const { chunks } = split(full.slice(0, n))
    for (let i = 0; i < prev.length; i++) {
      assert.equal(chunks[i], prev[i], `chunk ${i} changed at length ${n}`)
    }
    prev = chunks
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsWholeParse, splitMarkdownStream } from '../src/renderer/src/lib/markdownStream.ts'

// A tiny minChunk so a couple of paragraphs is enough to force a seal.
const MIN = 10

/** Chunks + tail + any open fence must always reassemble to exactly the input. */
function split(text: string, minChunk = MIN): ReturnType<typeof splitMarkdownStream> {
  const r = splitMarkdownStream(text, minChunk)
  assert.equal(
    r.chunks.join('') + r.tail + (r.code ? r.code.open + r.code.body : ''),
    text,
    'chunks+tail+code must reassemble the input'
  )
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

test('an unterminated fence is reported as an open code block', () => {
  const text = 'intro paragraph\n\n```python\nprint(1)\n\nprint(2)\n\nstill code'
  const r = split(text)
  assert.deepEqual(r.chunks, ['intro paragraph\n\n'])
  assert.equal(r.tail, '')
  assert.equal(r.code?.info, 'python')
  assert.equal(r.code?.body, 'print(1)\n\nprint(2)\n\nstill code')
})

test('the open fence carries the prose before it in the tail', () => {
  const r = split('lead-in\n\n```ts\nconst a = 1\n', 10_000)
  assert.deepEqual(r.chunks, [])
  assert.equal(r.tail, 'lead-in\n\n')
  assert.equal(r.code?.body, 'const a = 1\n')
})

test('a fence whose info string is still streaming has an empty body', () => {
  const r = split('```ty')
  assert.equal(r.tail, '')
  assert.equal(r.code?.info, 'ty')
  assert.equal(r.code?.body, '')
})

test('a citation info string is preserved verbatim', () => {
  const r = split('```896:905:src/a.ts\ncode\n')
  assert.equal(r.code?.info, '896:905:src/a.ts')
  assert.equal(r.code?.body, 'code\n')
})

test('a tilde fence opens a code block too', () => {
  const r = split('~~~ js\nlet a\n')
  assert.equal(r.code?.info, 'js')
  assert.equal(r.code?.body, 'let a\n')
})

test('a closed fence is ordinary markdown, not an open code block', () => {
  const r = split('```ts\nconst a = 1\n```\n\nafter')
  assert.equal(r.code, null)
})

test('an indented fence inside a list is left to the markdown parse', () => {
  // Lifting it out would render the code block outside the list item it belongs to.
  const text = 'intro paragraph\n\n- item\n\n  ```ts\n  const a = 1\n'
  const r = split(text)
  assert.equal(r.code, null)
  assert.equal(r.tail, '- item\n\n  ```ts\n  const a = 1\n')
})

test('a fence at column 0 after a list is still an open code block', () => {
  // "bulleted plan, then the file" is one of the commonest shapes an agent
  // emits: a column-0 fence cannot be list content, so the list must not
  // disqualify it. `prevListish` answers the sealing question, not this one.
  const r = split('- do a\n- do b\n\n```ts\nconst a = 1\n')
  assert.equal(r.code?.info, 'ts')
  assert.equal(r.code?.body, 'const a = 1\n')
})

test('the fence-open line rides `open`, not the body or the tail', () => {
  const r = split('```ts\nconst a = 1\n')
  assert.equal(r.code?.open, '```ts\n')
  assert.equal(r.code?.body, 'const a = 1\n')
  assert.equal(r.tail, '')
})

test('an info string with meta keeps the whole thing', () => {
  // `languageFromFenceInfo` takes the tag off it; the splitter does not guess.
  const r = split('```ts title=foo.ts\ncode\n')
  assert.equal(r.code?.info, 'ts title=foo.ts')
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

test('an open fence body only ever grows', () => {
  // What the memoized code rows depend on: the body is append-only, so a line
  // that has been drawn keeps its text as the rest of the block streams in.
  const full = 'intro\n\n```ts\nconst a = 1\nconst b = 2\nconst c = 3\n'
  let prev = ''
  for (let n = 1; n <= full.length; n++) {
    const { code } = split(full.slice(0, n))
    const body = code?.body ?? ''
    if (prev && body) assert.ok(body.startsWith(prev), `body shrank at length ${n}`)
    if (body) prev = body
  }
})

// ---- needsWholeParse: when settled text may not keep its chunked render ----

test('plain prose, lists, fences and tables settle chunked', () => {
  const text = [
    '# Title',
    '',
    '- [ ] a task item',
    '- [x] another',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'A [link](https://example.com) and an ![image](x.png).'
  ].join('\n')
  assert.equal(needsWholeParse(text), false)
})

test('a link reference definition forces the whole parse', () => {
  assert.equal(needsWholeParse('See [docs][1].\n\n[1]: https://example.com'), true)
  // Up to three leading spaces is still a definition.
  assert.equal(needsWholeParse('   [ref]: https://example.com'), true)
})

test('a footnote definition forces the whole parse', () => {
  assert.equal(needsWholeParse('Claim.[^1]\n\n[^1]: The source.'), true)
})

test('an HTML block that may span blank lines forces the whole parse', () => {
  assert.equal(needsWholeParse('<pre>\n\nraw\n\n</pre>'), true)
  assert.equal(needsWholeParse('<!-- note\n\nstill the comment -->'), true)
  assert.equal(needsWholeParse('<script>\nlet x\n</script>'), true)
})

test('inline HTML and a bracketed phrase mid-line do not', () => {
  assert.equal(needsWholeParse('a <b>bold</b> word, and [x]: is not a definition here'), false)
  assert.equal(needsWholeParse('<div>\n\ntext\n\n</div>'), false)
})

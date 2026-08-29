import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitHighlightedLines } from '../src/renderer/src/lib/highlightLines.ts'

/** Strip tags — every line must still carry exactly its own source text. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '')

/** Every line must be balanced on its own, or a row renders someone else's colors. */
function assertBalanced(line: string): void {
  let depth = 0
  for (const tag of line.match(/<[^>]*>/g) ?? []) {
    if (tag[1] === '/') depth--
    else depth++
    assert.ok(depth >= 0, `closed an unopened span in ${JSON.stringify(line)}`)
  }
  assert.equal(depth, 0, `unbalanced line ${JSON.stringify(line)}`)
}

function split(html: string): string[] {
  const lines = splitHighlightedLines(html)
  for (const line of lines) assertBalanced(line)
  assert.equal(lines.map(textOf).join('\n'), textOf(html), 'text content must survive the split')
  return lines
}

test('plain text splits on newlines', () => {
  assert.deepEqual(split('a\nb\nc'), ['a', 'b', 'c'])
})

test('a trailing newline leaves an empty final line', () => {
  assert.deepEqual(split('a\n'), ['a', ''])
})

test('no newline is a single line', () => {
  assert.deepEqual(split('const a = 1'), ['const a = 1'])
})

test('spans contained in one line are untouched', () => {
  const html = '<span class="hljs-keyword">const</span> a\n<span class="hljs-number">1</span>'
  assert.deepEqual(split(html), [
    '<span class="hljs-keyword">const</span> a',
    '<span class="hljs-number">1</span>'
  ])
})

test('a span crossing a newline is closed and reopened', () => {
  // The shape of a block comment: one span over several lines.
  const html = '<span class="hljs-comment">/* one\ntwo\nthree */</span>'
  assert.deepEqual(split(html), [
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two</span>',
    '<span class="hljs-comment">three */</span>'
  ])
})

test('nested spans crossing a newline reopen in order', () => {
  const html = '<span class="hljs-string">`a<span class="hljs-subst">${x\n+ y}</span>b`</span>'
  const lines = split(html)
  assert.equal(
    lines[0],
    '<span class="hljs-string">`a<span class="hljs-subst">${x</span></span>'
  )
  assert.equal(
    lines[1],
    '<span class="hljs-string"><span class="hljs-subst">+ y}</span>b`</span>'
  )
})

test('entities are carried through untouched', () => {
  const html = '<span class="hljs-keyword">if</span> (a &lt; b &amp;&amp; c &gt; d)\nnext'
  const lines = splitHighlightedLines(html)
  assert.ok(lines[0].includes('a &lt; b &amp;&amp; c &gt; d'))
  assert.equal(lines[1], 'next')
})

test('an empty body is one empty line', () => {
  assert.deepEqual(split(''), [''])
})

test('finished lines are stable as the block grows', () => {
  // The property the memoized rows depend on: appending to the last line must
  // not change the string of any line above it.
  const html = '<span class="hljs-comment">// a</span>\nb\n<span class="hljs-comment">// c</span>'
  let prev: string[] = []
  for (let n = 1; n <= html.length; n++) {
    const lines = splitHighlightedLines(html.slice(0, n))
    for (let i = 0; i < prev.length - 1; i++) {
      assert.equal(lines[i], prev[i], `line ${i} changed at length ${n}`)
    }
    prev = lines
  }
})

test('a truncated trailing tag is kept rather than dropped', () => {
  const lines = splitHighlightedLines('ab<span class="hljs-k')
  assert.equal(lines.length, 1)
  assert.ok(lines[0].startsWith('ab'))
})

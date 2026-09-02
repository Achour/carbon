import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDiff, type DiffLine } from '../src/renderer/src/lib/lineDiff.ts'

const render = (lines: DiffLine[]): string =>
  lines.map((l) => `${l.kind === 'ctx' ? ' ' : l.kind === 'del' ? '-' : '+'}${l.text}`).join('\n')

test('a one-line change inside an anchor shows only that line', () => {
  const before = 'const a = 1\nconst b = 2\nconst c = 3'
  const after = 'const a = 1\nconst b = 20\nconst c = 3'
  assert.equal(render(lineDiff(before, after)), ' const a = 1\n-const b = 2\n+const b = 20\n const c = 3')
})

test('identical strings are all context', () => {
  assert.deepEqual(lineDiff('x\ny', 'x\ny'), [
    { kind: 'ctx', text: 'x' },
    { kind: 'ctx', text: 'y' }
  ])
})

test('an insertion and a deletion are placed, not smeared', () => {
  assert.equal(render(lineDiff('a\nb\nc', 'a\nc\nd')), ' a\n-b\n c\n+d')
})

test('deletions come before additions at a divergence', () => {
  assert.equal(render(lineDiff('old', 'new')), '-old\n+new')
})

test('empty sides', () => {
  assert.equal(render(lineDiff('', 'a\nb')), '+a\n+b')
  assert.equal(render(lineDiff('a\nb', '')), '-a\n-b')
  assert.deepEqual(lineDiff('', ''), [])
})

test('a trailing newline is a terminator, not a blank line', () => {
  assert.deepEqual(lineDiff('a\n', 'a\n'), [{ kind: 'ctx', text: 'a' }])
  assert.equal(render(lineDiff('a\n', 'a\nb\n')), ' a\n+b')
})

test('a streaming prefix of the new text diffs cleanly against the whole old text', () => {
  // `new_string` arrives a few characters at a time; a prefix should read as
  // "kept so far, rest not yet written" rather than as a rewrite.
  const before = 'one\ntwo\nthree'
  assert.equal(render(lineDiff(before, 'one\ntw')), ' one\n-two\n-three\n+tw')
})

test('a huge divergence falls back to remove-all/add-all rather than a quadratic table', () => {
  const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n')
  const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n')
  const lines = lineDiff(a, b)
  assert.equal(lines.length, 1200)
  assert.ok(lines.slice(0, 600).every((l) => l.kind === 'del'))
  assert.ok(lines.slice(600).every((l) => l.kind === 'add'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lineSelection,
  selectionLabel,
  trimTrailingNewlines
} from '../src/renderer/src/lib/codeSelection.ts'

// Offsets:      0         10        20        30
//               |         |         |         |
const SRC = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4'
// line 1: 0-10, \n at 11; line 2: 12-22, \n at 23; line 3: 24-34, \n at 35; line 4: 36-46

test('a mid-line selection widens to the whole line', () => {
  const sel = lineSelection(SRC, 6, 8) // "a " inside line 1
  assert.deepEqual(sel, { startLine: 1, endLine: 1, text: 'const a = 1', truncated: false })
})

test('a selection spanning two lines reports both', () => {
  const sel = lineSelection(SRC, 6, 18)
  assert.equal(sel?.startLine, 1)
  assert.equal(sel?.endLine, 2)
  assert.equal(sel?.text, 'const a = 1\nconst b = 2')
})

test('a drag onto the next line does not claim that line', () => {
  // Ends at offset 12 — column 0 of line 2, i.e. just past line 1's newline.
  const sel = lineSelection(SRC, 0, 12)
  assert.equal(sel?.startLine, 1)
  assert.equal(sel?.endLine, 1)
  assert.equal(sel?.text, 'const a = 1')
})

test('the last line needs no trailing newline to be found', () => {
  const sel = lineSelection(SRC, 38, 40)
  assert.equal(sel?.startLine, 4)
  assert.equal(sel?.endLine, 4)
  assert.equal(sel?.text, 'const d = 4')
})

test('a whole-file selection reports every line', () => {
  const sel = lineSelection(SRC, 0, SRC.length)
  assert.equal(sel?.startLine, 1)
  assert.equal(sel?.endLine, 4)
  assert.equal(sel?.text, SRC)
})

test('a backwards drag reads the same as a forwards one', () => {
  assert.deepEqual(lineSelection(SRC, 18, 6), lineSelection(SRC, 6, 18))
})

test('a collapsed range is not a selection', () => {
  assert.equal(lineSelection(SRC, 7, 7), null)
  assert.equal(lineSelection('', 0, 0), null)
})

test('offsets past the end of the text are clamped', () => {
  const sel = lineSelection(SRC, 36, 9999)
  assert.equal(sel?.endLine, 4)
  assert.equal(sel?.text, 'const d = 4')
})

test('selecting only blank lines resolves to the line it began on', () => {
  const blanks = 'a\n\n\n\nb'
  const sel = lineSelection(blanks, 2, 4) // the empty lines 2 and 3
  assert.equal(sel?.startLine, 2)
  assert.equal(sel?.endLine, 2)
  assert.equal(sel?.text, '')
})

test('CRLF text keeps the carriage return inside the line', () => {
  const crlf = 'const a = 1\r\nconst b = 2'
  const sel = lineSelection(crlf, 0, 5)
  assert.equal(sel?.startLine, 1)
  assert.equal(sel?.endLine, 1)
  assert.equal(sel?.text, 'const a = 1\r')
})

test('an over-cap selection cuts on a line boundary and says so', () => {
  const sel = lineSelection(SRC, 0, SRC.length, 20)
  assert.equal(sel?.truncated, true)
  assert.equal(sel?.text, 'const a = 1')
  // The range still names every line the user picked, so the agent can read on.
  assert.equal(sel?.startLine, 1)
  assert.equal(sel?.endLine, 4)
})

test('an over-cap selection with no line break in range cuts at the cap', () => {
  const long = 'x'.repeat(100)
  const sel = lineSelection(long, 0, 100, 10)
  assert.equal(sel?.text, 'xxxxxxxxxx')
  assert.equal(sel?.truncated, true)
})

test('a selection at the cap exactly is not truncated', () => {
  const sel = lineSelection(SRC, 0, 11, 11)
  assert.equal(sel?.truncated, false)
  assert.equal(sel?.text, 'const a = 1')
})

test('the label collapses a one-line range', () => {
  assert.equal(selectionLabel('foo.ts', 12, 12), 'foo.ts:12')
  assert.equal(selectionLabel('foo.ts', 12, 30), 'foo.ts:12-30')
})

test('trimTrailingNewlines backs off every swept-up newline, not just one', () => {
  const text = 'a\n\n\nb'
  // A drag from 0 to 4 ends at column 0 of "b", having crossed two blank lines.
  assert.equal(trimTrailingNewlines(0, 4, (i) => text.charCodeAt(i)), 1)
  // Never past the start: a selection of nothing but newlines keeps its origin.
  assert.equal(trimTrailingNewlines(1, 4, (i) => text.charCodeAt(i)), 1)
  // A range not ending on a newline is untouched.
  assert.equal(trimTrailingNewlines(0, 5, (i) => text.charCodeAt(i)), 5)
})

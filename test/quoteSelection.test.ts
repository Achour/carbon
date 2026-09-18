import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quoteLabel, quoteText } from '../src/renderer/src/lib/quoteSelection.ts'

test('a passage keeps its inner shape and loses its outer whitespace', () => {
  const raw = '\n  Two paragraphs.\n\n    indented line\n\n'
  assert.deepEqual(quoteText(raw), {
    text: 'Two paragraphs.\n\n    indented line',
    truncated: false
  })
})

test('whitespace alone is not a quote', () => {
  assert.equal(quoteText('\n \n'), null)
  assert.equal(quoteText(''), null)
})

test('a quote under the cap is not truncated', () => {
  assert.deepEqual(quoteText('short', 100), { text: 'short', truncated: false })
})

test('a cut lands on a word boundary and reports itself', () => {
  const sel = quoteText('alpha beta gamma delta', 14)
  assert.deepEqual(sel, { text: 'alpha beta', truncated: true })
})

test('a cut with no whitespace in reach is taken where it fell', () => {
  const sel = quoteText('abcdefghijklmnop', 8)
  assert.deepEqual(sel, { text: 'abcdefgh', truncated: true })
})

test('a cap shorter than the first word still yields text', () => {
  const sel = quoteText('supercalifragilistic word', 5)
  assert.deepEqual(sel, { text: 'super', truncated: true })
})

test('a cut exactly at a space keeps the whole word before it', () => {
  assert.deepEqual(quoteText('alpha beta', 6), { text: 'alpha', truncated: true })
})

test('a label is one line', () => {
  assert.equal(quoteLabel('two\nlines   here'), 'two lines here')
})

test('a long label is cut on a word boundary with an ellipsis', () => {
  assert.equal(quoteLabel('the quick brown fox jumps over the lazy dog', 20), 'the quick brown fox…')
})

test('a label with no boundary in the second half is cut hard', () => {
  assert.equal(quoteLabel('averyveryverylongsingletoken', 10), 'averyveryv…')
})

test('a label that fits is left alone', () => {
  assert.equal(quoteLabel('fits fine', 20), 'fits fine')
})

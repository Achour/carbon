import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BTW_COMMAND, btwHistory, buildBtwPrompt, parseBtw, withBtw } from '../src/shared/btw.ts'

test('parseBtw reads the question and only /btw', () => {
  assert.equal(parseBtw('/btw what was that file?'), 'what was that file?')
  assert.equal(parseBtw('  /BTW   spaced out  '), 'spaced out')
  assert.equal(parseBtw('/btw first line\nsecond'), 'first line\nsecond')
  assert.equal(parseBtw('/btw'), '')
  assert.equal(parseBtw('/btw   '), '')
  assert.equal(parseBtw('/btwx no'), null)
  assert.equal(parseBtw('btw no slash'), null)
  assert.equal(parseBtw('ask /btw later'), null)
})

test('withBtw puts one /btw first', () => {
  const list = withBtw([{ name: 'review', description: '' }, { name: 'btw', description: 'theirs' }])
  assert.deepEqual(
    list.map((c) => c.name),
    ['btw', 'review']
  )
  assert.equal(list[0], BTW_COMMAND)
  // An argument shape, or picking it would send an empty question.
  assert.ok(BTW_COMMAND.argumentHint)
})

test('btwHistory keeps answered entries only', () => {
  assert.deepEqual(
    btwHistory([
      { id: '1', question: 'a', answer: 'A' },
      { id: '2', question: 'b', error: 'nope' },
      { id: '3', question: 'c' }
    ]),
    [{ question: 'a', response: 'A' }]
  )
})

test('buildBtwPrompt carries transcript, history and the question', () => {
  const p = buildBtwPrompt('## User\nhi', 'why?', [{ question: 'what?', response: 'that' }])
  assert.match(p, /Transcript:\n\n## User\nhi/)
  assert.match(p, /Q: what\?\nA: that/)
  assert.ok(p.endsWith('Side question: why?\n\nAnswer:'))
  assert.match(buildBtwPrompt('', 'q'), /no messages yet/)
})

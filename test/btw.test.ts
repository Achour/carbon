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

test('btwHistory carries this turn\'s answered side questions only', () => {
  const ev = (id: string, btw: { question: string; answer?: string; error?: string }) =>
    ({ id, role: 'event', kind: 'btw', text: btw.question, ts: 0, btw }) as const
  const messages = [
    ev('0', { question: 'old', answer: 'before the prompt' }),
    { id: 'u', role: 'user', text: 'do it', ts: 0 } as const,
    ev('1', { question: 'a', answer: 'A' }),
    ev('2', { question: 'b', error: 'nope' }),
    ev('3', { question: 'c' }),
    ev('4', { question: 'd', answer: 'D' })
  ]
  assert.deepEqual(btwHistory(messages), [
    { question: 'a', response: 'A' },
    { question: 'd', response: 'D' }
  ])
})

test('buildBtwPrompt carries transcript, history and the question', () => {
  const p = buildBtwPrompt('## User\nhi', 'why?', [{ question: 'what?', response: 'that' }])
  assert.match(p, /Transcript:\n\n## User\nhi/)
  assert.match(p, /Q: what\?\nA: that/)
  assert.ok(p.endsWith('Side question: why?\n\nAnswer:'))
  assert.match(buildBtwPrompt('', 'q'), /no messages yet/)
})

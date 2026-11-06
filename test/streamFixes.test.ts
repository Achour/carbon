import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineSplitter } from '../src/main/lineSplitter.ts'
import { mentionsText } from '../src/main/mentionsText.ts'

const split = (chunks: string[]): string[] => {
  const out: string[] = []
  const s = new LineSplitter((l) => out.push(l))
  for (const c of chunks) s.push(c)
  s.end()
  return out
}

test('LineSplitter joins a line spread over many chunks', () => {
  assert.deepEqual(split(['ab', 'cd', 'e\nf', 'g\n']), ['abcde', 'fg'])
})

test('LineSplitter skips empty lines and emits an unterminated tail', () => {
  assert.deepEqual(split(['\n\na\n', '\n', 'tail']), ['a', 'tail'])
})

test('LineSplitter handles a chunk that is only a newline after a long fragment', () => {
  assert.deepEqual(split(['x'.repeat(5), 'y'.repeat(5), '\n']), ['xxxxxyyyyy'])
})

test('mentionsText finds a path nested anywhere in messages', () => {
  const messages = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', parts: [{ type: 'tool', input: { file_path: '/p/shot.png' } }] }
  ]
  assert.equal(mentionsText(messages, ['/p/shot.png']), true)
  assert.equal(mentionsText(messages, ['/p/other.png']), false)
})

test('mentionsText matches a path inside prose and ignores non-strings', () => {
  assert.equal(mentionsText([{ text: 'saved to shots/a.png ok', n: 3, z: null }], ['shots/a.png']), true)
  assert.equal(mentionsText([{ n: 3 }], []), false)
})

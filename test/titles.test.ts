import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantSummaryText,
  cleanTitle,
  deriveTitle,
  firstUserText
} from '../src/main/titles.ts'
import type { ChatMessage } from '../src/shared/types.ts'

test('deriveTitle: label beats text and attachment names', () => {
  assert.equal(deriveTitle('the verbose commit prompt', 'Commit'), 'Commit')
})

test('deriveTitle: falls back to text, collapsing whitespace', () => {
  assert.equal(deriveTitle('fix   the\n  login\tbug'), 'fix the login bug')
})

test('deriveTitle: falls back to attachment names when no text/label', () => {
  assert.equal(
    deriveTitle('', undefined, [
      { id: '1', kind: 'image', name: 'a.png' },
      { id: '2', kind: 'file', name: 'b.txt' }
    ]),
    'a.png, b.txt'
  )
})

test('deriveTitle: caps at 64 chars', () => {
  assert.equal(deriveTitle('x'.repeat(100)).length, 64)
})

test('cleanTitle: unwraps surrounding quotes and trailing punctuation', () => {
  assert.equal(cleanTitle('"Fix Login Redirect."'), 'Fix Login Redirect')
  assert.equal(cleanTitle('“Refactor Store Reducer”'), 'Refactor Store Reducer')
  assert.equal(cleanTitle('Add Dark Mode!'), 'Add Dark Mode')
})

test('cleanTitle: collapses whitespace and clamps to 60 chars', () => {
  assert.equal(cleanTitle('  Rework   the\n  layout  '), 'Rework the layout')
  assert.equal(cleanTitle('y'.repeat(100)).length, 60)
})

test('cleanTitle: empty-ish input stays empty (caller treats as null)', () => {
  assert.equal(cleanTitle('  ""  '), '')
})

test('firstUserText: first user message text plus attachment names', () => {
  const messages: ChatMessage[] = [
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], ts: 1 },
    {
      id: 'u',
      role: 'user',
      text: 'add a chart',
      ts: 2,
      attachments: [{ id: '1', kind: 'image', name: 'mock.png' }]
    },
    { id: 'u2', role: 'user', text: 'second message', ts: 3 }
  ]
  assert.equal(firstUserText(messages), 'add a chart mock.png')
})

test('firstUserText: empty when there is no user message', () => {
  const messages: ChatMessage[] = [
    { id: 'e', role: 'event', kind: 'info', text: 'x', ts: 1 }
  ]
  assert.equal(firstUserText(messages), '')
})

test('assistantSummaryText: joins text parts, ignores thinking/tool and other roles', () => {
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', text: 'prompt', ts: 1 },
    {
      id: 'a',
      role: 'assistant',
      ts: 2,
      parts: [
        { type: 'thinking', text: 'secret reasoning' },
        { type: 'text', text: 'I updated the file.' },
        { type: 'tool', toolUseId: 't1', name: 'Edit', status: 'success' }
      ]
    },
    {
      id: 'a2',
      role: 'assistant',
      ts: 3,
      parts: [{ type: 'text', text: 'Done.' }]
    }
  ]
  assert.equal(assistantSummaryText(messages), 'I updated the file.\nDone.')
})

test('assistantSummaryText: respects the cap', () => {
  const messages: ChatMessage[] = [
    { id: 'a', role: 'assistant', ts: 1, parts: [{ type: 'text', text: 'z'.repeat(50) }] }
  ]
  assert.equal(assistantSummaryText(messages, 10).length, 10)
})

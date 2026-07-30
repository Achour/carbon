import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHandoffContext,
  serializeTranscript
} from '../src/main/handoff.ts'
import type { ChatMessage } from '../src/shared/types.ts'

const user = (text: string): ChatMessage => ({ id: text, role: 'user', text, ts: 1 })
const assistant = (text: string): ChatMessage => ({
  id: text,
  role: 'assistant',
  ts: 1,
  parts: [{ type: 'text', text }]
})

test('serializeTranscript: renders roles, tools and events; skips thinking', () => {
  const messages: ChatMessage[] = [
    user('fix the bug'),
    {
      id: 'a1',
      role: 'assistant',
      ts: 1,
      parts: [
        { type: 'thinking', text: 'private reasoning' },
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          toolUseId: 't1',
          name: 'Bash',
          input: { command: 'npm test' },
          status: 'success',
          output: 'all\npassed'
        }
      ]
    },
    { id: 'e1', role: 'event', kind: 'info', text: 'Switched model', ts: 1 }
  ]
  const out = serializeTranscript(messages, 10_000)
  assert.match(out, /## User\nfix the bug/)
  assert.match(out, /On it\./)
  assert.match(out, /\[tool Bash\] \{"command":"npm test"\} → all passed/)
  assert.match(out, /\[info\] Switched model/)
  assert.doesNotMatch(out, /private reasoning/)
})

test('serializeTranscript: over cap keeps the first user message and the tail', () => {
  const messages: ChatMessage[] = [
    user('the original goal'),
    ...Array.from({ length: 40 }, (_, i) => assistant(`middle work ${i} ${'x'.repeat(200)}`)),
    assistant('the latest state')
  ]
  const out = serializeTranscript(messages, 2000)
  assert.match(out, /the original goal/)
  assert.match(out, /the latest state/)
  assert.match(out, /earlier messages omitted/)
  assert.doesNotMatch(out, /middle work 1 /)
  assert.ok(out.length < 3000)
})

test('serializeTranscript: single giant message is clipped, not dropped', () => {
  const messages: ChatMessage[] = [user('goal'), assistant('z'.repeat(50_000))]
  const out = serializeTranscript(messages, 4000)
  assert.match(out, /goal/)
  assert.match(out, /zzz/)
  assert.match(out, /truncated/)
})

test('serializeTranscript: placeholder-shaped and empty messages vanish', () => {
  const messages: ChatMessage[] = [
    { id: 'unloaded-0', role: 'assistant', ts: 0, parts: [{ type: 'text', text: '' }] },
    user('hello')
  ]
  const out = serializeTranscript(messages, 1000)
  assert.equal(out, '## User\nhello')
})

test('serializeTranscript: unhydrated prefix is announced', () => {
  const out = serializeTranscript([user('recent')], 1000, true)
  assert.match(out, /earlier history not shown/)
})

test('buildHandoffContext: brief vs raw transcript framing', () => {
  const brief = buildHandoffContext('the brief', 'Codex')
  assert.match(brief, /handoff brief the previous agent wrote/)
  assert.match(brief, /Codex/)
  const raw = buildHandoffContext('the transcript', 'Fable 5 (Claude)', true)
  assert.match(raw, /transcript of that conversation/)
})

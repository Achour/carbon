import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatActivity, projectActivity } from '../src/renderer/src/lib/chatActivity.ts'

test('needs-input activity replaces generic work for provider questions', () => {
  const activity = chatActivity(
    'waiting-permission',
    [{ id: 'agent-1', type: 'subagent', description: 'Inspect renderer' }],
    [
      {
        id: 'question-1',
        chatId: 'chat-1',
        toolUseId: 'tool-1',
        toolName: 'AskUserQuestion',
        input: {},
        hasSuggestions: false
      }
    ]
  )

  assert.deepEqual(activity, { kind: 'needs-input', label: 'Needs your answer' })
})

test('plan review and tool approval use specific needs-input labels', () => {
  assert.deepEqual(
    chatActivity('waiting-permission', [], [
      {
        id: 'plan-1',
        chatId: 'chat-1',
        toolUseId: 'tool-1',
        toolName: 'ExitPlanMode',
        input: {},
        hasSuggestions: false
      }
    ]),
    { kind: 'needs-input', label: 'Plan ready for review' }
  )

  assert.deepEqual(
    chatActivity('streaming', [], [
      {
        id: 'permission-1',
        chatId: 'chat-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: {},
        hasSuggestions: false
      }
    ]),
    { kind: 'needs-input', label: 'Needs your permission' }
  )
})

test('background activity remains visible after the foreground turn goes idle', () => {
  assert.deepEqual(
    chatActivity('idle', [
      { id: 'task-1', type: 'shell', description: 'Run tests' },
      { id: 'task-2', type: 'subagent', description: 'Review changes' }
    ], []),
    { kind: 'background', label: 'Background jobs running', count: 2 }
  )
})

test('ordinary active and idle chats keep their existing behavior', () => {
  assert.deepEqual(chatActivity('starting', [], []), { kind: 'working', label: 'Working' })
  assert.deepEqual(chatActivity('streaming', [], []), { kind: 'working', label: 'Working' })
  assert.deepEqual(chatActivity('idle', [], []), { kind: 'idle', label: 'Idle' })
})

test('collapsed projects surface the highest-priority child activity', () => {
  assert.deepEqual(
    projectActivity([
      { kind: 'working', label: 'Working' },
      { kind: 'background', label: 'Background jobs running', count: 2 },
      { kind: 'needs-input', label: 'Needs your answer' },
      { kind: 'needs-input', label: 'Needs your permission' }
    ]),
    { kind: 'needs-input', label: '2 chats need your input' }
  )
})

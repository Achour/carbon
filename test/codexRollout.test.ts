import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexRolloutRecord } from '../src/main/codexRollout.ts'

test('parses a Codex sub_agent_activity spawn from the parent rollout', () => {
  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          event_id: 'call-spawn',
          agent_thread_id: 'child-thread',
          agent_path: '/root/architecture_scan',
          kind: 'started'
        }
      },
      { kind: 'parent' }
    ),
    [
      {
        type: 'agent-start',
        threadId: 'child-thread',
        callId: 'call-spawn',
        name: 'architecture scan'
      }
    ]
  )
})

test('parses live text, terminal activity, and completion from a child rollout', () => {
  const source = { kind: 'child' as const, threadId: 'child-thread' }
  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Checking the renderer.' }
      },
      source
    ),
    [{ type: 'agent-text', threadId: 'child-thread', text: 'Checking the renderer.' }]
  )

  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-tool',
          input:
            'const r = await tools.exec_command({"cmd":"pwd && rg --files","workdir":"/tmp"}); text(r.output);'
        }
      },
      source
    ),
    [
      {
        type: 'agent-tool-start',
        threadId: 'child-thread',
        toolUseId: 'call-tool',
        name: 'Bash',
        input: { command: 'pwd && rg --files' }
      }
    ]
  )

  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-tool',
          output: [
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: 'src/main.ts' }
          ]
        }
      },
      source
    ),
    [
      {
        type: 'agent-tool-complete',
        threadId: 'child-thread',
        toolUseId: 'call-tool',
        output: 'Script completed\nsrc/main.ts',
        failed: false
      }
    ]
  )

  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: 'Renderer inspection complete.'
        }
      },
      source
    ),
    [
      {
        type: 'agent-complete',
        threadId: 'child-thread',
        result: 'Renderer inspection complete.',
        failed: false
      }
    ]
  )

  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted' }
      },
      source
    ),
    [
      {
        type: 'agent-complete',
        threadId: 'child-thread',
        result: 'This agent was interrupted before it could finish.',
        failed: true
      }
    ]
  )
})

test('parses a child agent’s model, effort and token total', () => {
  const source = { kind: 'child' as const, threadId: 'child-thread' }
  // The child's own rollout file is the only record of what a sub-agent is
  // running on; the parent transcript never says.
  assert.deepEqual(
    parseCodexRolloutRecord({ type: 'turn_context', payload: { model: 'gpt-5.6-luna' } }, source),
    [{ type: 'agent-usage', threadId: 'child-thread', model: 'gpt-5.6-luna' }]
  )

  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          thread_settings: { model: 'gpt-5.6-luna', reasoning_effort: 'max' }
        }
      },
      source
    ),
    [{ type: 'agent-usage', threadId: 'child-thread', model: 'gpt-5.6-luna', effort: 'max' }]
  )

  // `total_token_usage` is the running total for the thread — `last_token_usage`
  // is the call that just finished, and summing that instead would count every
  // earlier call again on each event.
  assert.deepEqual(
    parseCodexRolloutRecord(
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 34_074, output_tokens: 768, total_tokens: 34_842 },
            last_token_usage: { total_tokens: 17_797 }
          }
        }
      },
      source
    ),
    [{ type: 'agent-usage', threadId: 'child-thread', tokens: 34_842 }]
  )

  // The same records in the PARENT transcript say nothing about a child.
  assert.deepEqual(
    parseCodexRolloutRecord({ type: 'turn_context', payload: { model: 'gpt-5.6-luna' } }, { kind: 'parent' }),
    []
  )
})

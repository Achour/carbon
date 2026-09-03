import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexChildSession,
  createCodexRolloutWatcher,
  type CodexRolloutEvent,
  parseCodexRolloutRecord
} from '../src/main/codexRollout.ts'

test('recognizes a multi-agent v2 child from its session metadata', () => {
  assert.deepEqual(
    codexChildSession(
      {
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          parent_thread_id: 'parent-thread',
          agent_path: '/root/review_codex',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-thread',
                agent_path: '/root/review_codex'
              }
            }
          },
          multi_agent_version: 'v2'
        }
      },
      'parent-thread'
    ),
    { threadId: 'child-thread', name: 'review codex' }
  )

  // A v2 child rollout also contains the inherited parent's session metadata.
  // It must not be rediscovered as its own child.
  assert.equal(
    codexChildSession(
      {
        type: 'session_meta',
        payload: { id: 'parent-thread', parent_thread_id: null, source: 'vscode' }
      },
      'parent-thread'
    ),
    null
  )
})

test('the rollout watcher discovers and tails a multi-agent v2 child', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'carbon-codex-rollout-'))
  t.after(() => rm(codexHome, { recursive: true, force: true }))
  const day = join(codexHome, 'sessions', '2026', '09', '04')
  await mkdir(day, { recursive: true })
  const timestamp = new Date().toISOString()
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`
  await writeFile(
    join(day, 'rollout-parent-thread.jsonl'),
    line({ timestamp, type: 'session_meta', payload: { id: 'parent-thread' } })
  )
  await writeFile(
    join(day, 'rollout-child-thread.jsonl'),
    [
      {
        timestamp,
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          parent_thread_id: 'parent-thread',
          agent_path: '/root/review_codex',
          multi_agent_version: 'v2'
        }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Reviewing Codex.' }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Codex reviewed.' }
      }
    ]
      .map(line)
      .join('')
  )

  const events: CodexRolloutEvent[] = []
  const watcher = createCodexRolloutWatcher((event) => events.push(event), codexHome)
  watcher.start('parent-thread', Date.now() - 1_000)
  await watcher.flush()

  assert.deepEqual(events, [
    {
      type: 'agent-start',
      threadId: 'child-thread',
      callId: 'session-child-thread',
      name: 'review codex'
    },
    { type: 'agent-text', threadId: 'child-thread', text: 'Reviewing Codex.' },
    {
      type: 'agent-complete',
      threadId: 'child-thread',
      result: 'Codex reviewed.',
      failed: false
    }
  ])
})

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

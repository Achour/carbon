import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentTotals,
  foldAgentRuns,
  formatAgentDuration,
  formatAgentTokens,
  reconcileAgentRuns
} from '../src/shared/agentRuns.ts'
import type { AssistantPart, ChatMessage, ToolPart } from '../src/shared/types.ts'

const tool = (over: Partial<ToolPart> & { toolUseId: string; name: string }): ToolPart => ({
  type: 'tool',
  status: 'success',
  ...over
})

const msg = (id: string, parts: (AssistantPart | null)[]): ChatMessage =>
  ({ id, role: 'assistant', parts: parts as AssistantPart[], ts: 0 }) as ChatMessage

test('folds a spawn into a run with its vitals', () => {
  const runs = foldAgentRuns([
    msg('m1', [
      tool({
        toolUseId: 't1',
        name: 'Task',
        status: 'running',
        input: { subagent_type: 'general-purpose', description: 'Go API endpoints' },
        agent: { startedAt: 1000, model: 'claude-sonnet-5', tokens: 35_300 },
        children: [
          { type: 'text', text: 'reading' },
          tool({ toolUseId: 'c1', name: 'Read' }),
          tool({ toolUseId: 'c2', name: 'Bash', status: 'running' })
        ]
      })
    ])
  ])
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0], {
    id: 't1',
    messageId: 'm1',
    type: 'general-purpose',
    description: 'Go API endpoints',
    status: 'running',
    startedAt: 1000,
    endedAt: undefined,
    model: 'claude-sonnet-5',
    effort: undefined,
    tokens: 35_300,
    tools: 2,
    current: 'Bash',
    depth: 0
  })
})

test('a settled spawn whose children are still moving is still running', () => {
  // A backgrounded agent's tool_result lands at spawn; reading the parent's
  // status alone would tick it done while it is visibly still working.
  const [run] = foldAgentRuns([
    msg('m1', [
      tool({
        toolUseId: 't1',
        name: 'Task',
        status: 'success',
        agent: { startedAt: 1000 },
        children: [tool({ toolUseId: 'c1', name: 'Grep', status: 'pending' })]
      })
    ])
  ])
  assert.equal(run.status, 'running')
})

test('a failed spawn is failed even mid-step', () => {
  const [run] = foldAgentRuns([
    msg('m1', [
      tool({
        toolUseId: 't1',
        name: 'Agent',
        status: 'error',
        agent: { startedAt: 1 },
        children: [tool({ toolUseId: 'c1', name: 'Bash', status: 'running' })]
      })
    ])
  ])
  assert.equal(run.status, 'failed')
})

test('a spawn recorded before agents were timed is still listed', () => {
  const [run] = foldAgentRuns([
    msg('m1', [tool({ toolUseId: 't1', name: 'Task', input: { prompt: 'old run' } })])
  ])
  assert.equal(run.description, 'old run')
  assert.equal(run.startedAt, undefined)
  assert.equal(run.status, 'done')
})

test('an agent that spawns an agent is nested by depth', () => {
  const runs = foldAgentRuns([
    msg('m1', [
      tool({
        toolUseId: 't1',
        name: 'Task',
        agent: { startedAt: 1 },
        children: [tool({ toolUseId: 't2', name: 'Task', agent: { startedAt: 2 } })]
      })
    ])
  ])
  assert.deepEqual(
    runs.map((r) => [r.id, r.depth]),
    [
      ['t1', 0],
      ['t2', 1]
    ]
  )
})

test('non-agent tools and sparse slots are skipped', () => {
  const runs = foldAgentRuns([
    msg('m1', [null, { type: 'text', text: 'hi' }, tool({ toolUseId: 'x', name: 'Read' })]),
    { id: 'u1', role: 'user', text: 'hello', ts: 0 } as ChatMessage
  ])
  assert.deepEqual(runs, [])
})

test('totals count only running agents but sum every reported token', () => {
  const runs = foldAgentRuns([
    msg('m1', [
      tool({
        toolUseId: 't1',
        name: 'Task',
        status: 'running',
        agent: { startedAt: 1, tokens: 1000 }
      }),
      tool({ toolUseId: 't2', name: 'Task', agent: { startedAt: 1, tokens: 500 } }),
      tool({ toolUseId: 't3', name: 'Task', agent: { startedAt: 1 } })
    ])
  ])
  assert.deepEqual(agentTotals(runs), { running: 1, total: 3, tokens: 1500 })
})

test('an unchanged fold keeps its identity, a changed one does not', () => {
  const parts = (status: 'running' | 'success'): ChatMessage[] => [
    msg('m1', [tool({ toolUseId: 't1', name: 'Task', status, agent: { startedAt: 1 } })])
  ]
  const first = foldAgentRuns(parts('running'))
  const again = reconcileAgentRuns(first, foldAgentRuns(parts('running')))
  assert.equal(again, first, 'same list, same array')

  const moved = reconcileAgentRuns(first, foldAgentRuns(parts('success')))
  assert.notEqual(moved, first)
  assert.equal(moved[0].status, 'done')
})

test('a run appearing replaces the array wholesale', () => {
  const one = foldAgentRuns([msg('m1', [tool({ toolUseId: 't1', name: 'Task' })])])
  const two = foldAgentRuns([
    msg('m1', [tool({ toolUseId: 't1', name: 'Task' }), tool({ toolUseId: 't2', name: 'Task' })])
  ])
  assert.equal(reconcileAgentRuns(one, two), two)
})

test('token counts read as magnitudes', () => {
  assert.equal(formatAgentTokens(0), '0')
  assert.equal(formatAgentTokens(999), '999')
  assert.equal(formatAgentTokens(1000), '1.0k')
  assert.equal(formatAgentTokens(67_800), '67.8k')
  assert.equal(formatAgentTokens(113_017), '113k')
  assert.equal(formatAgentTokens(2_400_000), '2.4M')
})

test('durations read as clocks', () => {
  assert.equal(formatAgentDuration(0), '0s')
  assert.equal(formatAgentDuration(58_000), '58s')
  assert.equal(formatAgentDuration(64_000), '1m 04s')
  assert.equal(formatAgentDuration(3_723_000), '1h 02m')
  // A clock that ran backwards (a clock change mid-run) reports nothing, not a
  // negative age.
  assert.equal(formatAgentDuration(-5000), '0s')
})

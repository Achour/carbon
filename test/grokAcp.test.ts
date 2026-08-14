import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  grokPermissionBaseline,
  isExitPlanTool,
  isGrokTranscriptUpdate,
  resolveGrokBinary,
  toolName,
  toolNameIfNamed,
  toolOutput,
  toolStatus
} from '../src/main/grokAcp.ts'
import { effortForProvider } from '../src/shared/types.ts'

// Fixtures are verbatim payloads captured from grok 1.0.3 over `agent stdio`,
// not hand-written approximations — the point of these tests is to pin the
// shapes the CLI actually emits.

test('toolName prefers xAI\'s human label over the raw ACP title', () => {
  assert.equal(
    toolName({
      toolCallId: 'call-1',
      title: 'run_terminal_command',
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', label: 'Run Command' } }
    }),
    'Run Command'
  )
})

test('toolName falls back through name, then title, then a constant', () => {
  assert.equal(
    toolName({ toolCallId: 'c', title: 'write', _meta: { 'x.ai/tool': { name: 'write' } } }),
    'write'
  )
  assert.equal(toolName({ toolCallId: 'c', title: 'Execute `ls`' }), 'Execute `ls`')
  assert.equal(toolName({ toolCallId: 'c' }), 'Tool')
})

test('toolStatus maps ACP statuses onto the three-state tool card', () => {
  assert.equal(toolStatus('completed'), 'success')
  assert.equal(toolStatus('failed'), 'error')
  // A cancelled call did not do what it said it would; showing it as success
  // would be a lie, and there is no third card state for "abandoned".
  assert.equal(toolStatus('cancelled'), 'error')
  assert.equal(toolStatus('pending'), 'running')
  assert.equal(toolStatus('in_progress'), 'running')
  assert.equal(toolStatus(undefined), 'running')
})

test('toolOutput flattens content blocks and ignores empty ones', () => {
  assert.equal(
    toolOutput({
      toolCallId: 'c',
      content: [
        { type: 'content', content: { type: 'text', text: 'exit: 0' } },
        { type: 'content', content: { type: 'text', text: '' } }
      ]
    }),
    'exit: 0'
  )
  // The real shape of a completed `rm`: a single empty text block. An empty
  // string would render an expandable card with nothing in it.
  assert.equal(
    toolOutput({
      toolCallId: 'c',
      content: [{ type: 'content', content: { type: 'text', text: '' } }]
    }),
    undefined
  )
  assert.equal(toolOutput({ toolCallId: 'c' }), undefined)
})

test('toolOutput names the file a diff block touched', () => {
  assert.equal(
    toolOutput({
      toolCallId: 'c',
      content: [{ type: 'diff', path: '/tmp/app.js', newText: 'x' }]
    }),
    '/tmp/app.js'
  )
})

test('isExitPlanTool matches on kind or name, not on the title', () => {
  assert.equal(
    isExitPlanTool({
      toolCallId: 'c',
      title: 'exit_plan_mode',
      _meta: { 'x.ai/tool': { name: 'exit_plan_mode', kind: 'exit_plan' } }
    }),
    true
  )
  assert.equal(isExitPlanTool({ toolCallId: 'c', _meta: { 'x.ai/tool': { name: 'exit_plan_mode' } } }), true)
  // A model that merely *writes* about exiting plan mode must not trip this.
  assert.equal(isExitPlanTool({ toolCallId: 'c', title: 'exit_plan_mode' }), false)
  assert.equal(
    isExitPlanTool({ toolCallId: 'c', _meta: { 'x.ai/tool': { name: 'write', kind: 'write' } } }),
    false
  )
})

test('effortForProvider is the single filter for Grok levels', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(effortForProvider(effort, 'grok'), effort)
  }
  // Other providers' levels. Forwarding one would be accepted by the CLI and
  // silently ignored, leaving the composer claiming a level that is not running.
  for (const effort of ['max', 'ultra', 'minimal']) {
    assert.equal(effortForProvider(effort, 'grok'), undefined)
  }
  assert.equal(effortForProvider(undefined, 'grok'), undefined)
})

test('transcript updates are the ones session/load replays', () => {
  for (const kind of [
    'agent_message_chunk',
    'agent_thought_chunk',
    'user_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan'
  ]) {
    assert.equal(isGrokTranscriptUpdate(kind), true)
  }
  // Commands and the mode flag arrive on load too, but they are session
  // state, not a turn — the palette would stay empty if they were dropped.
  for (const kind of [
    'available_commands_update',
    'session_info_update',
    'current_mode_update',
    'turn_completed'
  ]) {
    assert.equal(isGrokTranscriptUpdate(kind), false)
  }
})

test('grokPermissionBaseline reduces Carbon modes to the session-creation axis', () => {
  assert.equal(grokPermissionBaseline('bypassPermissions'), 'yolo')
  assert.equal(grokPermissionBaseline('auto'), 'auto')
  assert.equal(grokPermissionBaseline('default'), 'ask')
  // Plan is the *other*, independent axis: it moves live and does not change
  // the baseline the session was created with.
  assert.equal(grokPermissionBaseline('plan'), 'ask')
  // acceptEdits deliberately lands on ask rather than auto — upgrading it would
  // make the more restrictive of the two settings run more without asking.
  assert.equal(grokPermissionBaseline('acceptEdits'), 'ask')
})

test('resolveGrokBinary prefers an explicit override, then the CLI home', () => {
  assert.equal(
    resolveGrokBinary({ CARBON_GROK_PATH: '/custom/grok', HOME: '/nowhere' }),
    '/custom/grok'
  )
  // Nothing on disk under a bogus HOME: fall through to a bare name so PATH
  // resolution gets its turn rather than pinning a path that does not exist.
  assert.equal(resolveGrokBinary({ HOME: '/nonexistent-home-for-test' }), 'grok')
})

test('toolNameIfNamed answers only when the payload names the tool', () => {
  // The real closing update for a completed read: status only, no title, no
  // meta. Answering "Tool" here is what renamed a finished "Read" card.
  assert.equal(toolNameIfNamed({ toolCallId: 'c', status: 'completed' }), undefined)
  assert.equal(
    toolNameIfNamed({
      toolCallId: 'c',
      title: 'Read `/tmp/math.js`',
      _meta: { 'x.ai/tool': { name: 'read_file', label: 'Read' } }
    }),
    'Read'
  )
  // The fallback belongs to card *creation*, which must be labelled something.
  assert.equal(toolName({ toolCallId: 'c', status: 'completed' }), 'Tool')
})

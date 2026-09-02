import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGrokPrompt,
  grokAskUserQuestionResult,
  grokPermissionBaseline,
  isAskUserQuestionTool,
  isExitPlanTool,
  isGrokAskUserQuestionMethod,
  isGrokTranscriptUpdate,
  isPreviewSideEffectTool,
  isPreviewTool,
  previewToolId,
  grokToolInput,
  toolImages,
  parseGrokQuestions,
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

test('toolName maps Grok wire names onto the renderer\'s grouping ids', () => {
  // Verbatim 1.0.3 grep payload: label is "Search". Storing that is what
  // rendered two wrench cards that GROUPABLE_TOOLS (which keys on `Grep`)
  // would not coalesce.
  assert.equal(
    toolName({
      toolCallId: 'call-1',
      title: 'grep',
      _meta: { 'x.ai/tool': { name: 'grep', label: 'Search' } }
    }),
    'Grep'
  )
  assert.equal(
    toolName({
      toolCallId: 'call-1',
      title: 'run_terminal_command',
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', label: 'Run Command' } }
    }),
    'Bash'
  )
  assert.equal(
    toolName({ toolCallId: 'c', title: 'write', _meta: { 'x.ai/tool': { name: 'write' } } }),
    'Write'
  )
})

test('toolName falls back through name, then title, then a constant', () => {
  assert.equal(toolName({ toolCallId: 'c', title: 'Execute `ls`' }), 'Execute `ls`')
  assert.equal(toolName({ toolCallId: 'c' }), 'Tool')
})

test('grokToolInput copies Grok path fields onto the Claude/Codex names', () => {
  assert.deepEqual(grokToolInput('Read', { target_file: '/tmp/app.js', limit: 40 }), {
    target_file: '/tmp/app.js',
    limit: 40,
    file_path: '/tmp/app.js'
  })
  assert.deepEqual(grokToolInput('ListDir', { target_directory: '/tmp' }), {
    target_directory: '/tmp',
    path: '/tmp'
  })
  assert.deepEqual(grokToolInput('Grep', { pattern: 'foo', glob: '*.ts' }), {
    pattern: 'foo',
    glob: '*.ts'
  })
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

test('previewToolId only matches the in-app preview MCP', () => {
  assert.equal(
    previewToolId({
      toolCallId: 'c',
      _meta: { 'x.ai/tool': { name: 'screenshot', namespace: 'preview' } }
    }),
    'mcp__preview__screenshot'
  )
  assert.equal(
    previewToolId({ toolCallId: 'c', title: 'mcp__preview__start' }),
    'mcp__preview__start'
  )
  assert.equal(previewToolId({ toolCallId: 'c', title: 'preview_navigate' }), 'mcp__preview__navigate')
  // A bare "start" is not ours — Grok's own tools must not be auto-allowed.
  assert.equal(previewToolId({ toolCallId: 'c', title: 'start' }), undefined)
  assert.equal(isPreviewTool({ toolCallId: 'c', title: 'mcp__preview__console' }), true)
  assert.equal(isPreviewSideEffectTool({ toolCallId: 'c', title: 'mcp__preview__start' }), true)
  assert.equal(isPreviewSideEffectTool({ toolCallId: 'c', title: 'mcp__preview__status' }), false)
  assert.equal(
    toolName({
      toolCallId: 'c',
      title: 'screenshot',
      _meta: { 'x.ai/tool': { name: 'screenshot', namespace: 'preview', label: 'Screenshot' } }
    }),
    'mcp__preview__screenshot'
  )
})

test('toolImages pulls MCP image blocks out of a Grok tool result', () => {
  assert.deepEqual(
    toolImages({
      toolCallId: 'c',
      content: [{ type: 'content', content: { type: 'image', data: 'abc', mimeType: 'image/png' } }]
    }),
    [{ mediaType: 'image/png', data: 'abc' }]
  )
  assert.equal(
    toolImages({
      toolCallId: 'c',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
    }),
    undefined
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

test('isGrokAskUserQuestionMethod matches the 1.0.3 wire name', () => {
  assert.equal(isGrokAskUserQuestionMethod('_x.ai/ask_user_question'), true)
  assert.equal(isGrokAskUserQuestionMethod('x.ai/ask_user_question'), true)
  assert.equal(isGrokAskUserQuestionMethod('session/request_permission'), false)
  assert.equal(isGrokAskUserQuestionMethod('_x.ai/exit_plan_mode'), false)
})

test('isAskUserQuestionTool matches on the xAI name, not the title', () => {
  assert.equal(
    isAskUserQuestionTool({
      toolCallId: 'c',
      title: 'ask_user_question',
      _meta: { 'x.ai/tool': { name: 'ask_user_question' } }
    }),
    true
  )
  assert.equal(isAskUserQuestionTool({ toolCallId: 'c', title: 'ask_user_question' }), false)
})

test('parseGrokQuestions reads the tool-shaped payload Grok actually sends', () => {
  const questions = parseGrokQuestions({
    sessionId: 'sess',
    questions: [
      {
        question: 'Which store?',
        options: [
          { label: 'US', description: 'Ship from the US warehouse' },
          { label: 'EU' }
        ],
        multiSelect: false
      }
    ]
  })
  assert.equal(questions.length, 1)
  assert.equal(questions[0]?.question, 'Which store?')
  assert.equal(questions[0]?.options[0]?.label, 'US')
  assert.equal(questions[0]?.options[0]?.description, 'Ship from the US warehouse')
  assert.equal(questions[0]?.multiSelect, false)
  assert.equal(questions[0]?.allowOther, true)
})

test('parseGrokQuestions accepts snake_case and nested rawInput', () => {
  const questions = parseGrokQuestions({
    rawInput: {
      questions: [{ question: 'Pick one', options: ['A', 'B'], multi_select: true }]
    }
  })
  assert.equal(questions[0]?.multiSelect, true)
  assert.deepEqual(
    questions[0]?.options.map((option) => option.label),
    ['A', 'B']
  )
})

test('grokAskUserQuestionResult is internally tagged with outcome', () => {
  assert.deepEqual(grokAskUserQuestionResult(null), { outcome: 'declined' })
  assert.deepEqual(grokAskUserQuestionResult({ behavior: 'deny' }), { outcome: 'declined' })
  assert.deepEqual(
    grokAskUserQuestionResult({
      behavior: 'allow',
      updatedInput: { answers: { 'Which store?': 'US' } }
    }),
    { outcome: 'answered', answers: { 'Which store?': 'US' } }
  )
  // An empty allow is a dismiss, not an empty answer the model would treat as a choice.
  assert.deepEqual(grokAskUserQuestionResult({ behavior: 'allow', updatedInput: { answers: {} } }), {
    outcome: 'declined'
  })
})

test('buildGrokPrompt embeds a path-less screenshot so Grok can see it', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const { blocks, temps } = buildGrokPrompt('what is this?', [
    { id: '1', kind: 'image', name: 'shot.png', mediaType: 'image/png', data: png }
  ])
  try {
    assert.equal(temps.length, 1)
    const text = blocks.find((block) => block.type === 'text')
    assert.match(text?.text ?? '', /Attached files:/)
    assert.match(text?.text ?? '', /shot|\.png/)
    const resource = blocks.find((block) => block.type === 'resource')
    assert.equal(resource?.resource?.blob, png)
    assert.equal(resource?.resource?.mimeType, 'image/png')
    const link = blocks.find((block) => block.type === 'resource_link')
    assert.equal(link?.name, 'shot.png')
    assert.ok(link?.uri?.startsWith('file:'))
  } finally {
    for (const path of temps) rmSync(path, { force: true })
  }
})

test('buildGrokPrompt lists a file attachment by its existing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karbun-grok-test-'))
  const path = join(dir, 'notes.md')
  const { blocks, temps } = buildGrokPrompt('read this', [
    { id: '2', kind: 'file', name: 'notes.md', path }
  ])
  assert.deepEqual(temps, [])
  const text = blocks.find((block) => block.type === 'text')
  assert.match(text?.text ?? '', /notes\.md/)
  const link = blocks.find((block) => block.type === 'resource_link')
  assert.equal(link?.name, 'notes.md')
})

test('buildGrokPrompt carries an attached canvas into the prompt', () => {
  // Grok is the provider with no SDK, so its prompt is built by a free function
  // rather than a session method — the one place a new attachment kind can be
  // silently dropped while the other two work. That asymmetry is exactly what
  // this pins: the canvas has to arrive on all three or on none.
  const { blocks } = buildGrokPrompt('what should I fix first?', [
    {
      id: 'att-1',
      kind: 'canvas',
      name: 'Query Audit',
      canvas: {
        id: 'c-9f2a',
        title: 'Query Audit',
        text: 'listFeed | 1,204 calls'
      }
    }
  ])
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  assert.match(text, /what should I fix first\?/)
  assert.match(text, /Attached canvas "Query Audit" \(id: c-9f2a\)/)
  assert.match(text, /listFeed \| 1,204 calls/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CursorChildStream,
  buildCursorPrompt,
  cursorDefaultModel,
  cursorModelOptions,
  cursorModelSelection,
  cursorTodos,
  cursorToolInput,
  cursorToolName,
  cursorToolOutput,
  cursorToolPart,
  isActiveRunError,
  isCursorAuthError,
  isCursorShellSpawnFailure,
  parseContextSize,
  type CursorCatalogModel,
  type CursorToolCall
} from '../src/main/cursorSdk.ts'
import { knownProviderForModel, providerForRememberedModel } from '../src/shared/types.ts'

// Rows exactly as `Cursor.models.list()` answered for a Plus account (1.0.37).
const CATALOG: CursorCatalogModel[] = [
  {
    id: 'grok-4.7',
    displayName: 'Grok 4.7',
    parameters: [
      { id: 'context', displayName: 'Context', values: [{ value: '256k', displayName: '256K' }] },
      { id: 'reasoning_effort', displayName: 'Effort', values: [{ value: 'medium', displayName: 'Medium' }] },
      { id: 'fast', displayName: 'Fast', values: [{ value: 'false' }] }
    ],
    variants: [
      {
        params: [
          { id: 'context', value: '256k' },
          { id: 'reasoning_effort', value: 'medium' },
          { id: 'fast', value: 'false' }
        ],
        displayName: 'Grok 4.7  Medium',
        isDefault: true
      }
    ]
  },
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    aliases: ['composer-latest', 'composer', 'composer-2-5'],
    parameters: [{ id: 'fast', displayName: 'Fast', values: [{ value: 'false' }] }],
    variants: [{ params: [{ id: 'fast', value: 'false' }], displayName: 'Composer 2.5', isDefault: true }]
  }
]

test('every fixed parameter is sent, or a fixed-settings plan refuses the model', () => {
  // Measured: `{ id: 'composer-2.5' }` alone → "Model unavailable on Plus …
  // with fixed settings"; with the variant's `fast: false` it runs.
  assert.deepEqual(cursorModelSelection(CATALOG[1]), { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] })
})

test('effort and Fast replace their entry only with a value the catalog lists', () => {
  const grok = CATALOG[0]
  assert.deepEqual(cursorModelSelection(grok, { effort: 'high', fast: true }).params, [
    { id: 'context', value: '256k' },
    { id: 'reasoning_effort', value: 'medium' },
    { id: 'fast', value: 'false' }
  ])
  const open: CursorCatalogModel = {
    ...grok,
    parameters: grok.parameters!.map((param) =>
      param.id === 'reasoning_effort'
        ? { ...param, values: [{ value: 'medium' }, { value: 'high' }] }
        : param.id === 'fast'
          ? { ...param, values: [{ value: 'false' }, { value: 'true' }] }
          : param
    )
  }
  assert.deepEqual(cursorModelSelection(open, { effort: 'high', fast: true }).params, [
    { id: 'context', value: '256k' },
    { id: 'reasoning_effort', value: 'high' },
    { id: 'fast', value: 'true' }
  ])
})

test('picker rows are namespaced, and the Default row resolves to Composer', () => {
  const rows = cursorModelOptions(CATALOG)
  assert.deepEqual(
    rows.map((row) => row.id),
    ['cursor/default', 'cursor/grok-4.7', 'cursor/composer-2.5']
  )
  assert.equal(rows[0].resolvedModel, 'cursor/composer-2.5')
  assert.equal(cursorDefaultModel(CATALOG)?.id, 'composer-2.5')
  const grok = rows[1]
  assert.equal(grok.contextWindow, 256_000)
  // One effort level and Fast fixed off: no menus to offer.
  assert.deepEqual(grok.supportedEfforts, [])
  assert.equal(grok.supportsFastMode, false)
  assert.equal(parseContextSize('1m'), 1_000_000)
})

test("a Cursor model is Cursor's, even when its id is another lab's", () => {
  // `grok-4.6` is a row in Grok's static catalog; bare, it would be dropped
  // from a Cursor chat by the first reconcile.
  assert.equal(knownProviderForModel('cursor/grok-4.6'), 'cursor')
  assert.equal(knownProviderForModel('cursor/claude-4.6-sonnet'), 'cursor')
  assert.equal(providerForRememberedModel('cursor/gpt-5.5', 'codex'), 'cursor')
  assert.equal(knownProviderForModel('grok-4.6'), 'grok')
})

test('tool calls map onto the cards the renderer already draws', () => {
  const read: CursorToolCall = {
    type: 'read',
    args: { path: '/w/hello.py' },
    result: { status: 'success', value: { content: 'def greet(name):\n', totalLines: 2, fileSize: 18 } }
  }
  assert.equal(cursorToolName(read), 'Read')
  assert.equal((cursorToolInput(read) as { file_path: string }).file_path, '/w/hello.py')
  assert.equal(cursorToolOutput(read), 'def greet(name):\n')

  const shell: CursorToolCall = {
    type: 'shell',
    args: { command: 'ls -la && python3 --version', workingDirectory: '/w', timeout: 30000 },
    result: { status: 'success', value: { exitCode: 2, signal: '', stdout: 'a\n', stderr: 'oops', executionTime: 9 } }
  }
  assert.equal(cursorToolName(shell), 'Bash')
  assert.equal((cursorToolInput(shell) as { command: string }).command, 'ls -la && python3 --version')
  assert.equal(cursorToolOutput(shell), 'a\n\noops\n[exit 2]')
  assert.equal(cursorToolPart('tool_s', shell, true, false).status, 'error')

  const created: CursorToolCall = {
    type: 'edit',
    args: { path: '/w/notes.txt' },
    result: {
      status: 'success',
      value: { linesAdded: 1, linesRemoved: 0, diffString: '--- /dev/null\n+++ b//w/notes.txt\n@@ -1,0 +1 @@\n+done' }
    }
  }
  assert.equal(cursorToolName(created), 'Edit')
  const input = cursorToolInput(created) as { file_path: string; changes: { kind: string; diff?: string }[] }
  assert.equal(input.file_path, '/w/notes.txt')
  assert.equal(input.changes[0].kind, 'add')
  assert.match(input.changes[0].diff ?? '', /\+done/)
  assert.equal(cursorToolOutput(created), '+1 −0')

  const mcp: CursorToolCall = {
    type: 'mcp',
    args: { providerIdentifier: 'carbon', toolName: 'canvas_write', args: { title: 'Plan' } },
    result: { status: 'success', value: { content: [{ text: { text: 'Saved.' } }], isError: false } }
  }
  assert.equal(cursorToolName(mcp), 'mcp__carbon__canvas_write')
  assert.deepEqual(cursorToolInput(mcp), { title: 'Plan' })
  assert.equal(cursorToolOutput(mcp), 'Saved.')
  // Carbon's tools reach Cursor as `local.customTools`, which the SDK serves
  // as its own server; on the row they are Carbon's.
  const custom: CursorToolCall = { type: 'mcp', args: { providerIdentifier: 'custom-user-tools', toolName: 'chart_render', args: {} } }
  assert.equal(cursorToolName(custom), 'mcp__carbon__chart_render')

  const failed: CursorToolCall = { type: 'grep', args: { pattern: 'x' }, result: { status: 'error', error: { error: 'Glob pattern "**/*" matches every file' } } }
  const part = cursorToolPart('tool_1', failed, true, false)
  assert.equal(part.status, 'error')
  assert.match(part.output ?? '', /matches every file/)
})

test('a todo merge is read from the full list the result carries', () => {
  // Measured: the second call's args name only the three items it changed.
  const call: CursorToolCall = {
    type: 'updateTodos',
    args: { todos: [{ content: 'Edit greet', status: 'completed' }] },
    result: {
      status: 'success',
      value: {
        todos: [
          { content: 'Read hello.py', status: 'completed' },
          { content: 'Edit greet', status: 'inProgress' },
          { content: 'Dropped', status: 'cancelled' }
        ],
        totalCount: 3
      }
    }
  }
  assert.equal(cursorToolName(call), 'TodoWrite')
  assert.deepEqual(cursorTodos(call), [
    { content: 'Read hello.py', status: 'completed' },
    { content: 'Edit greet', status: 'in_progress' }
  ])
})

test("a subagent's nested updates become its card's children", () => {
  const stream = new CursorChildStream()
  stream.apply({ type: 'thinking-delta', text: 'Scanning ' })
  stream.apply({ type: 'thinking-delta', text: 'the folder' })
  stream.apply({ type: 'thinking-completed', thinkingDurationMs: 2 })
  stream.apply({ type: 'tool-call-started', callId: 'tool_b', toolCall: { type: 'shell', args: { command: 'find .' } } })
  stream.apply({ type: 'text-delta', text: 'All ' })
  stream.apply({ type: 'text-delta', text: 'files' })
  stream.apply({
    type: 'tool-call-completed',
    callId: 'tool_b',
    toolCall: { type: 'shell', args: { command: 'find .' }, result: { status: 'success', value: { exitCode: 0, stdout: '.\n' } } }
  })
  assert.deepEqual(
    stream.parts.map((part) => (part.type === 'tool' ? `${part.name}:${part.status}` : `${part.type}:${part.text}`)),
    ['thinking:Scanning the folder', 'Bash:success', 'text:All files']
  )
})

test('images ride natively and files are named', () => {
  const prompt = buildCursorPrompt('look', [
    { id: '1', kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AAAA' },
    { id: '2', kind: 'file', name: 'b.ts', path: '/w/b.ts' }
  ])
  assert.deepEqual(prompt.images, [{ data: 'AAAA', mimeType: 'image/png' }])
  assert.match(prompt.text, /Attached files:\n- \/w\/b\.ts/)
  assert.deepEqual(buildCursorPrompt('plain'), { text: 'plain' })
})

test('failures are recognized through their cause chain', () => {
  assert.ok(isCursorShellSpawnFailure({ syscall: 'spawn /bin/zsh', code: 'ENOENT', spawnargs: ['-c', 'x; dump_zsh_state'] }))
  assert.ok(!isCursorShellSpawnFailure({ syscall: 'spawn git', code: 'ENOENT', spawnargs: ['status'] }))
  assert.ok(isActiveRunError(new Error('wrapped', { cause: new Error('Agent agent-1 already has active run run-2') })))
  assert.ok(isCursorAuthError(Object.assign(new Error('nope'), { name: 'AuthenticationError' })))
  assert.ok(!isCursorAuthError(new Error('Cannot use this model: default.')))
})

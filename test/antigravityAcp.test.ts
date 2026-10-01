import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpMethodNotFound, AcpRpc, AcpRpcError } from '../src/main/acpRpc.ts'
import {
  agyAnswerOption,
  agyExecutionError,
  agyRestartsText,
  isAgyRetryNotice,
  agyMode,
  agyQuestion,
  agyToolInput,
  agyToolName,
  agyToolOutput,
  agyToolStatus,
  buildAgyPrompt,
  isAgyQuestion,
  isAuthRequired,
  parseAuthUrl,
  withPlanCommand,
  type AgyPermissionRequest
} from '../src/main/antigravityAcp.ts'
import {
  registryPlatform,
  releaseFromRegistry,
  trustedArchiveUrl
} from '../src/main/antigravityInstall.ts'
import { newestVersioned } from '../src/main/providerCli.ts'
import { knownProviderForModel } from '../src/shared/types.ts'

test('permission modes map onto the server’s three, with plan asking like default', () => {
  assert.equal(agyMode('default'), 'default')
  assert.equal(agyMode('acceptEdits'), 'auto_edit')
  assert.equal(agyMode('bypassPermissions'), 'yolo')
  assert.equal(agyMode('plan'), 'default')
})

test('plan mode is spelled as the /plan command, once', () => {
  assert.equal(withPlanCommand('add a cache', 'plan'), '/plan add a cache')
  assert.equal(withPlanCommand('/plan add a cache', 'plan'), '/plan add a cache')
  assert.equal(withPlanCommand('add a cache', 'default'), 'add a cache')
  assert.equal(withPlanCommand('', 'plan'), '/plan')
})

test('the sign-in link is read off the server’s stderr line', () => {
  const line =
    'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc'
  assert.equal(parseAuthUrl(line), 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc')
  assert.equal(parseAuthUrl('I1001 credential_manager.py:561] Credentials missing'), null)
})

test('"Authentication required" is recognized, other -32000s are not', () => {
  assert.equal(
    isAuthRequired(new AcpRpcError(-32000, 'Authentication required', { message: 'No authentication method selected.' })),
    true
  )
  assert.equal(isAuthRequired(new AcpRpcError(-32000, 'Rate limited')), false)
  assert.equal(isAuthRequired(new Error('Authentication required')), false)
})

test('tool names come from the title, the kind, or the MCP meta', () => {
  assert.equal(agyToolName({ toolCallId: '1', title: 'Running view_file', kind: 'read' }), 'Read')
  assert.equal(agyToolName({ toolCallId: '1', title: 'Run edit_file?', kind: 'edit' }), 'Edit')
  assert.equal(agyToolName({ toolCallId: '1', title: 'Running write_to_file' }), 'Write')
  // A shell call's title is the command itself.
  assert.equal(agyToolName({ toolCallId: '1', title: 'ls -la', kind: 'execute' }), 'Bash')
  assert.equal(
    agyToolName({
      toolCallId: '1',
      title: 'carbon_canvas_write',
      kind: 'other',
      _meta: { mcp: { tool: 'canvas_write', server: 'carbon' }, is_mcp_tool_call: true }
    }),
    'mcp__carbon__canvas_write'
  )
  assert.equal(
    agyToolName({ toolCallId: '1', title: 'x', _meta: { mcp: { tool: 'search', server: 'docs' } } }),
    'mcp__docs__search'
  )
  // A closing update carries no title; it must not rename the card.
  assert.equal(agyToolName({ toolCallId: '1', status: 'completed' }), undefined)
  assert.equal(agyToolName({ toolCallId: '1', title: 'Running mystery_tool' }), 'mystery_tool')
  // Measured: the server calls an MCP tool natively, with no `_meta` and no
  // server prefix — Carbon's own still have to land on their card.
  assert.equal(
    agyToolName({ toolCallId: '1', title: 'Running preview_screenshot', kind: 'other' }),
    'mcp__carbon__preview_screenshot'
  )
})

test('tool inputs are renamed to the fields the renderer reads', () => {
  assert.deepEqual(agyToolInput('Read', { AbsolutePath: '/a/b.ts', StartLine: 3 }), {
    AbsolutePath: '/a/b.ts',
    StartLine: 3,
    file_path: '/a/b.ts'
  })
  const edit = agyToolInput('Edit', {
    TargetFile: '/a/b.ts',
    TargetContent: 'old',
    ReplacementContent: 'new'
  }) as Record<string, unknown>
  assert.equal(edit.file_path, '/a/b.ts')
  assert.equal(edit.old_string, 'old')
  assert.equal(edit.new_string, 'new')
  const write = agyToolInput('Write', { TargetFile: '/a/c.ts', CodeContent: 'x' }) as Record<string, unknown>
  assert.equal(write.content, 'x')
  assert.equal((agyToolInput('Bash', { CommandLine: 'npm test', Cwd: '/p' }) as Record<string, unknown>).command, 'npm test')
  // No input at all: the title still names the command.
  assert.deepEqual(agyToolInput('Bash', undefined, { toolCallId: '1', title: 'ls', kind: 'execute' }), {
    command: 'ls'
  })
  assert.equal((agyToolInput('Grep', { Query: 'TODO', SearchPath: '/p' }) as Record<string, unknown>).pattern, 'TODO')
})

test('tool output reads rawOutput first, including a shell call’s structured one', () => {
  assert.equal(agyToolOutput({ toolCallId: '1', rawOutput: 'file contents' }), 'file contents')
  assert.equal(
    agyToolOutput({ toolCallId: '1', rawOutput: { commandLine: 'ls', combinedOutput: 'a\nb', exitCode: 0 } }),
    'a\nb'
  )
  assert.equal(
    agyToolOutput({ toolCallId: '1', rawOutput: { combinedOutput: 'boom', exitCode: 2 } }),
    'boom\nExit code 2'
  )
  assert.equal(
    agyToolOutput({
      toolCallId: '1',
      content: [{ type: 'content', content: { type: 'text', text: 'from content' } }]
    }),
    'from content'
  )
  assert.equal(agyToolOutput({ toolCallId: '1' }), undefined)
  assert.equal(agyToolStatus('completed'), 'success')
  assert.equal(agyToolStatus('failed'), 'error')
  assert.equal(agyToolStatus('pending'), 'running')
})

test('a question is told apart from a permission prompt, and answered by label', () => {
  const question: AgyPermissionRequest = {
    sessionId: 's',
    toolCall: { toolCallId: 'interaction_1a2b3c4d', title: 'Trust this folder?' },
    options: [
      { optionId: 'trust', name: 'Trust', kind: 'allow_once' },
      { optionId: 'dont_trust', name: 'Don’t trust', kind: 'reject_once' }
    ]
  }
  const permission: AgyPermissionRequest = {
    sessionId: 's',
    toolCall: { toolCallId: 'call_9', title: 'Run edit_file?' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  }
  assert.equal(isAgyQuestion(question), true)
  assert.equal(isAgyQuestion(permission), false)
  const card = agyQuestion(question)
  assert.equal(card.question, 'Trust this folder?')
  assert.deepEqual(
    card.options.map((option) => option.label),
    ['Trust', 'Don’t trust']
  )
  assert.equal(agyAnswerOption(question, { 'Trust this folder?': 'Don’t trust' }), 'dont_trust')
  assert.equal(agyAnswerOption(question, { q: ['Trust'] }), 'trust')
  assert.equal(agyAnswerOption(question, { q: 'Something else' }), null)
})

test('a retried model request is recognized, restarts replace, and a spent retry is an error', () => {
  // Measured on a free-tier account: the harness retries a 500/503 and says
  // so only by failing the open tool with this text.
  assert.equal(
    isAgyRetryNotice(
      'Encountered retryable error from model provider: Agent execution terminated due to error. ("request failed (code 500): Internal error encountered.")'
    ),
    true
  )
  assert.equal(isAgyRetryNotice('file contents'), false)
  // The retry re-streams from the first word, with or without that notice.
  assert.equal(agyRestartsText('The first line of', 'The first line of [README.md](file:///p'), true)
  assert.equal(
    agyRestartsText('The first line of [README.md](file:///private/tmp/claude-501/-', 'The first line of [README.md](file:///private/tmp/claude-501/-Users-'),
    true
  )
  assert.equal(agyRestartsText('The first line of', ' [README.md] is'), false)
  assert.equal(agyRestartsText('Hi', 'Hi there'), false)
  assert.match(
    agyExecutionError(
      'Agent execution error: Error 503, Message: No capacity available for model gemini-3.8-flash-high on the server, Status: UNAVAILABLE, Details: []'
    ) ?? '',
    /\(503: No capacity available for model gemini-3\.8-flash-high on the server\)/
  )
  assert.equal(agyExecutionError('All done.'), null)
})

test('a prompt sends images natively and names files in the text', () => {
  const blocks = buildAgyPrompt('look', [
    { id: 'a', kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAAA' },
    { id: 'b', kind: 'file', name: 'notes.md', path: '/p/notes.md' }
  ])
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text ?? '', /^look\n\nAttached files:\n- \/p\/notes\.md$/)
  assert.deepEqual(blocks[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' })
  assert.equal(blocks[2].type, 'resource_link')
  assert.equal(blocks[2].uri, 'file:///p/notes.md')
})

test('the registry entry is trusted only for Google’s download host', () => {
  assert.equal(registryPlatform('darwin', 'arm64'), 'darwin-aarch64')
  assert.equal(registryPlatform('win32', 'x64'), 'windows-x86_64')
  assert.equal(trustedArchiveUrl('https://dl.google.com/agy-extensions/x.zip'), true)
  assert.equal(trustedArchiveUrl('https://evil.example/agy.zip'), false)
  assert.equal(trustedArchiveUrl('http://dl.google.com/x.zip'), false)
  const entry = {
    version: '1.2.1',
    distribution: { binary: { 'darwin-aarch64': { archive: 'https://dl.google.com/a.zip' } } }
  }
  assert.deepEqual(releaseFromRegistry(entry, 'darwin-aarch64'), {
    version: '1.2.1',
    url: 'https://dl.google.com/a.zip'
  })
  assert.equal(releaseFromRegistry(entry, 'linux-x86_64'), null)
  assert.equal(
    releaseFromRegistry(
      { ...entry, distribution: { binary: { 'darwin-aarch64': { archive: 'https://x.io/a.zip' } } } },
      'darwin-aarch64'
    ),
    null
  )
})

test('the newest installed version wins, in both directory layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'carbon-agy-'))
  for (const dir of ['1.2.1', '1.10.0', 'v_1.9.9_abc_def', 'notes']) {
    mkdirSync(join(root, dir), { recursive: true })
    const path = join(root, dir, 'agy_acp_server.par')
    writeFileSync(path, '')
    chmodSync(path, 0o755)
  }
  assert.equal(newestVersioned(root, 'agy_acp_server.par'), join(root, '1.10.0', 'agy_acp_server.par'))
  assert.equal(newestVersioned(join(root, 'missing'), 'agy_acp_server.par'), null)
})

test('Antigravity’s gemini ids are placed by shape', () => {
  assert.equal(knownProviderForModel('gemini-3.8-flash-high'), 'antigravity')
  assert.equal(knownProviderForModel('antigravity-default'), 'antigravity')
  // Its server filters Claude models out, so a claude id stays Claude's.
  assert.equal(knownProviderForModel('claude-sonnet-4-6'), 'claude')
})

/** A fake ACP agent: answers `initialize`, asks one permission, then exits on `bye`. */
const FAKE_AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/x\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } })
  else if (m.method === 'ask') send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { n: 1 } })
  else if (m.method === 'unknown') send({ jsonrpc: '2.0', id: 901, method: 'fs/read_text_file', params: {} })
  else if (m.method === 'fail') send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } })
  else if (m.id === 900) send({ jsonrpc: '2.0', method: 'session/update', params: { echo: m.result } })
  else if (m.id === 901) send({ jsonrpc: '2.0', method: 'session/update', params: { echo: m.error } })
  else if (m.method === 'bye') process.exit(3)
})
`

test('the transport round-trips requests, agent requests and notifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-acp-'))
  const script = join(dir, 'agent.cjs')
  writeFileSync(script, FAKE_AGENT)
  const notes: unknown[] = []
  const stderr: string[] = []
  let exit: Error | null | undefined
  const rpc = new AcpRpc({
    label: 'Fake',
    command: process.execPath,
    args: [script],
    cwd: dir,
    env: process.env,
    onNotification: (_method, params) => notes.push(params),
    onRequest: async (method) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: 'allow' } }
      throw new AcpMethodNotFound()
    },
    onStderr: (line) => stderr.push(line),
    onExit: (error) => {
      exit = error
    }
  })
  rpc.start()
  assert.deepEqual(await rpc.request('initialize', {}), { protocolVersion: 1 })
  await assert.rejects(rpc.request('fail', {}), (error: unknown) => {
    assert.ok(error instanceof AcpRpcError)
    assert.equal(error.code, -32000)
    return true
  })
  rpc.notify('ask', {})
  rpc.notify('unknown', {})
  await waitFor(() => notes.length === 2)
  assert.deepEqual(notes[0], { echo: { outcome: { outcome: 'selected', optionId: 'allow' } } })
  assert.equal((notes[1] as { echo: { code: number } }).echo.code, -32601)
  assert.equal(parseAuthUrl(stderr[0] ?? ''), 'https://accounts.google.com/x')
  rpc.notify('bye', {})
  await waitFor(() => exit !== undefined)
  assert.match(String(exit?.message), /Fake exited unexpectedly \(code 3\)/)
})

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

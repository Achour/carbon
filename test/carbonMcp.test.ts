import { strict as assert } from 'node:assert'
import test from 'node:test'
import { startCarbonBridge, type CarbonBridgeHandle } from '../src/main/carbonBridge.ts'
import {
  carbonAcpServer,
  carbonCodexConfig,
  carbonToolList,
  handleMcpCall,
  handleMcpMessage,
  isCarbonSideEffect,
  parseCarbonTool,
  runCarbonTool
} from '../src/main/carbonMcp.ts'
import type { CanvasToolHost } from '../src/main/canvasTools.ts'
import type { PreviewToolHost } from '../src/main/previewTools.ts'

function previewHost(): PreviewToolHost {
  return {
    state: (cwd) => ({ cwd, status: 'stopped' }),
    startAndWait: async (cwd) => ({ cwd, status: 'running', url: 'http://localhost:3000' }),
    stop: (cwd) => ({ cwd, status: 'stopped' }),
    navigate: async () => ({ id: '1', ok: true }),
    screenshot: async () => 'abc',
    recentConsole: () => 'from preview'
  }
}

function canvasHost(saved: Array<Record<string, unknown>> = []): CanvasToolHost & {
  saved: Array<Record<string, unknown>>
} {
  return {
    saved,
    list: () => [],
    get: () => null,
    save: (input) => {
      saved.push(input as unknown as Record<string, unknown>)
      return {
        id: 'canvas-1',
        project: input.project,
        chatId: input.chatId ?? null,
        title: input.title,
        createdAt: 1,
        updatedAt: 1
      }
    }
  }
}

test('one server carries both tool tables, each name saying which half it is', () => {
  const tools = carbonToolList()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'preview_status',
      'preview_start',
      'preview_stop',
      'preview_navigate',
      'preview_screenshot',
      'preview_console',
      'canvas_write',
      'canvas_edit',
      'canvas_list',
      'canvas_read'
    ]
  )
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(
    (byName.preview_navigate.inputSchema as { required?: string[] }).required,
    ['url']
  )
  assert.deepEqual((byName.canvas_write.inputSchema as { required?: string[] }).required, [
    'title',
    'html'
  ])
  // Derived from the parameter tables, so a boolean stays a boolean on the wire
  // rather than becoming a string on the providers that read this schema and
  // not Claude's zod one.
  assert.equal(
    (byName.canvas_edit.inputSchema as { properties: Record<string, { type: string }> }).properties
      .replace_all.type,
    'boolean'
  )
  // A build with no canvas host advertises the preview half rather than four
  // tools that answer "not available" to every call.
  assert.equal(carbonToolList({ canvas: false }).length, 6)
})

test('a tool name is recognized however the provider spelled it', () => {
  assert.deepEqual(parseCarbonTool('preview_start'), { kind: 'preview', name: 'start' })
  assert.deepEqual(parseCarbonTool('mcp__carbon__preview_start'), {
    kind: 'preview',
    name: 'start'
  })
  assert.deepEqual(parseCarbonTool('carbon__canvas_write'), { kind: 'canvas', name: 'write' })
  assert.deepEqual(parseCarbonTool('carbon/canvas_read'), { kind: 'canvas', name: 'read' })
  assert.deepEqual(parseCarbonTool('CARBON:Preview-Screenshot'), {
    kind: 'preview',
    name: 'screenshot'
  })
  // Not ours: a bare verb is some other server's tool, and answering for it
  // would auto-allow a call this app knows nothing about.
  assert.equal(parseCarbonTool('start'), undefined)
  assert.equal(parseCarbonTool('write'), undefined)
  assert.equal(parseCarbonTool('preview_teleport'), undefined)
  assert.equal(parseCarbonTool(undefined), undefined)
})

test('only starting and stopping the dev server counts as a side effect', () => {
  assert.equal(isCarbonSideEffect('mcp__carbon__preview_start'), true)
  assert.equal(isCarbonSideEffect('mcp__carbon__preview_stop'), true)
  assert.equal(isCarbonSideEffect('mcp__carbon__preview_screenshot'), false)
  // A canvas is written to Carbon's own database — no file, no process — so a
  // plan that produces one is still a plan.
  assert.equal(isCarbonSideEffect('mcp__carbon__canvas_write'), false)
  assert.equal(isCarbonSideEffect('Bash'), false)
})

test('handleMcpMessage answers initialize, tools/list, and refuses the rest by name', () => {
  const init = handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' }
  })
  const result = init?.result as { serverInfo: { name: string }; protocolVersion: string }
  assert.equal(result.serverInfo.name, 'carbon')
  // Echoed rather than pinned: Grok asks for 2025-11-25 and Codex for
  // 2025-06-18, and both are answered in their own version.
  assert.equal(result.protocolVersion, '2025-11-25')

  const list = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal((list?.result as { tools: unknown[] }).tools.length, 10)
  assert.equal(
    (
      handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { canvas: false })
        ?.result as { tools: unknown[] }
    ).tools.length,
    6
  )

  // Grok opens with `server/discover`, which is not MCP. Answered `-32601`
  // rather than dropped — verified against the running CLI, which carries on to
  // `initialize` either way, where a silent drop leaves the request open.
  assert.equal(
    handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'server/discover' })?.error?.code,
    -32601
  )
  assert.equal(handleMcpMessage({ method: 'notifications/initialized' }), null)
  assert.equal(handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call' }), null)
})

test('handleMcpCall maps text, image and failure results', async () => {
  const text = await handleMcpCall(
    { id: 1, method: 'tools/call', params: { name: 'preview_status' } },
    async () => ({ ok: true, kind: 'text', text: '{"status":"running"}' })
  )
  assert.deepEqual(text.result, { content: [{ type: 'text', text: '{"status":"running"}' }] })

  const image = await handleMcpCall(
    { id: 2, method: 'tools/call', params: { name: 'preview_screenshot' } },
    async () => ({ ok: true, kind: 'image', data: 'abc', mimeType: 'image/png' })
  )
  assert.deepEqual(image.result, {
    content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
  })

  const failed = await handleMcpCall(
    { id: 3, method: 'tools/call', params: { name: 'preview_start' } },
    async () => ({ ok: false, error: 'boom' })
  )
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: 'boom' }], isError: true })

  // A handler that throws is still a tool result, not a dead request.
  const threw = await handleMcpCall(
    { id: 4, method: 'tools/call', params: { name: 'canvas_write' } },
    async () => {
      throw new Error('disk on fire')
    }
  )
  assert.deepEqual(threw.result, {
    content: [{ type: 'text', text: 'disk on fire' }],
    isError: true
  })
})

test('runCarbonTool routes by half, and plan mode is read at the call', async () => {
  const canvas = canvasHost()
  const hosts = { preview: previewHost(), canvas }
  let plan = true
  const ctx = { cwd: '/repo', project: '/repo', chatId: 'chat-1', plan: () => plan }

  const blocked = await runCarbonTool(hosts, ctx, 'preview_start')
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.error, /not allowed in plan mode/)
  // A screenshot reads; only start/stop are refused.
  assert.equal((await runCarbonTool(hosts, ctx, 'preview_screenshot')).ok, true)
  plan = false
  assert.equal((await runCarbonTool(hosts, ctx, 'preview_start')).ok, true)

  const wrote = await runCarbonTool(hosts, ctx, 'canvas_write', {
    title: 'Report',
    html: '<p>x</p>'
  })
  assert.equal(wrote.ok, true)
  // The project and chat ride the session context, not the tool arguments: a
  // model able to name its own project could write into another one's list.
  assert.equal(canvas.saved[0].project, '/repo')
  assert.equal(canvas.saved[0].chatId, 'chat-1')

  const unknown = await runCarbonTool(hosts, ctx, 'preview_teleport')
  assert.equal(unknown.ok, false)
  const noCanvas = await runCarbonTool({ preview: hosts.preview }, ctx, 'canvas_list')
  assert.equal(noCanvas.ok, false)
  if (!noCanvas.ok) assert.match(noCanvas.error, /not available/)
})

async function rpc(
  bridge: CarbonBridgeHandle,
  url: string,
  body: unknown,
  init: { token?: string } = {}
): Promise<{ status: number; json: unknown; sessionHeader: string | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${init.token ?? bridge.token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json'
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    sessionHeader: res.headers.get('mcp-session-id')
  }
}

test('the bridge speaks streamable-HTTP MCP behind a bearer token', async () => {
  const canvas = canvasHost()
  const bridge = await startCarbonBridge(previewHost(), canvas)
  let plan = false
  const session = bridge.register({
    cwd: '/repo',
    project: '/repo',
    chatId: 'chat-1',
    plan: () => plan
  })
  try {
    const init = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    })
    assert.equal(init.status, 200)
    assert.equal(
      ((init.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name),
      'carbon'
    )
    assert.equal(init.sessionHeader, session.url.split('/').pop())

    // A notification has nothing to answer.
    const notified = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
    assert.equal(notified.status, 202)

    const list = await rpc(bridge, session.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal((list.json as { result: { tools: unknown[] } }).result.tools.length, 10)

    const shot = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'preview_screenshot' }
    })
    assert.deepEqual((shot.json as { result: unknown }).result, {
      content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
    })

    // A JSON-RPC batch answers in kind. Neither CLI sends one today, and a
    // single reply to an array would be unparseable if one starts.
    const batch = await rpc(bridge, session.url, [
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'tools/list' }
    ])
    assert.equal((batch.json as unknown[]).length, 2)

    // Plan mode is read at the call, through the context the session registered
    // — not frozen into the endpoint, which is what used to make a mode change
    // invisible until the CLI was restarted.
    plan = true
    const refused = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'preview_start' }
    })
    assert.equal((refused.json as { result: { isError?: boolean } }).result.isError, true)
  } finally {
    session.dispose()
    bridge.close()
  }
})

test('the bridge refuses a bad token, a stale session, and an oversized preview call', async () => {
  const canvas = canvasHost()
  const bridge = await startCarbonBridge(previewHost(), canvas)
  const session = bridge.register({ cwd: '/repo', project: '/repo', chatId: 'chat-1' })
  try {
    const denied = await rpc(
      bridge,
      session.url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: 'nope' }
    )
    assert.equal(denied.status, 401)

    // Codex's `doctor` probes reachability with an unauthenticated HEAD; a 401
    // there paints a scary row for a server that is working.
    assert.equal((await fetch(session.url, { method: 'HEAD' })).status, 200)

    // The SSE half of streamable HTTP. Carbon pushes nothing, and both CLIs
    // carry on after the refusal.
    const stream = await fetch(session.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${bridge.token}` }
    })
    assert.equal(stream.status, 405)

    // Codex closes its MCP session on exit.
    const closed = await fetch(session.url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.token}` }
    })
    assert.equal(closed.status, 200)

    // A canvas carries a whole document; the cap is per tool *kind*, and the
    // kind is inside the body, so it is enforced after the parse.
    const big = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'canvas_write', arguments: { title: 'Big', html: 'x'.repeat(300_000) } }
    })
    assert.equal(big.status, 200)
    assert.equal(canvas.saved.length, 1)

    // The same payload on a preview call, which has no business being large.
    const fat = await rpc(bridge, session.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'preview_navigate', arguments: { url: `http://x/${'y'.repeat(300_000)}` } }
    })
    assert.equal(fat.status, 413)

    const unknown = await fetch(`${bridge.url}/mcp/2f1c4a3e-0000-4000-8000-000000000000`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    })
    assert.equal(unknown.status, 404)

    // A disposed session's endpoint stops answering: the context is the only
    // thing that made it addressable.
    session.dispose()
    const gone = await rpc(bridge, session.url, { jsonrpc: '2.0', id: 4, method: 'tools/list' })
    assert.equal(gone.status, 404)
  } finally {
    bridge.close()
  }
})

test('both provider configs name one http server and spawn nothing', async () => {
  const bridge = await startCarbonBridge(previewHost())
  const session = bridge.register({ cwd: '/repo', project: '/repo' })
  try {
    assert.deepEqual(session.acpServer, {
      type: 'http',
      name: 'carbon',
      url: session.url,
      headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }]
    })
    const servers = session.codexConfig.mcp_servers as Record<string, Record<string, unknown>>
    assert.deepEqual(Object.keys(servers), ['carbon'])
    assert.equal(servers.carbon.url, session.url)
    assert.deepEqual(servers.carbon.http_headers, {
      Authorization: `Bearer ${bridge.token}`
    })
    // The thing this change is for: no command, no args, no environment — there
    // is no child process to spawn on either provider.
    assert.equal(servers.carbon.command, undefined)
    assert.equal(servers.carbon.args, undefined)
    assert.equal(servers.carbon.env, undefined)

    // Each registration is its own endpoint, so two chats cannot read each
    // other's project out of one URL.
    const second = bridge.register({ cwd: '/other', project: '/other' })
    assert.notEqual(second.url, session.url)
    second.dispose()

    // The standalone builders agree with what `register` handed back.
    assert.deepEqual(carbonAcpServer(session.url, bridge.token), session.acpServer)
    assert.deepEqual(carbonCodexConfig(session.url, bridge.token), session.codexConfig)
  } finally {
    session.dispose()
    bridge.close()
  }
})

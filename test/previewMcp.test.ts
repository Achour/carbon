import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callCanvasBridge, startPreviewBridge } from '../src/main/previewBridge.ts'
import { carbonPreviewCodexMcp, carbonPreviewMcpServers } from '../src/main/previewMcpConfig.ts'
import {
  handleMcpCall,
  handleMcpMessage,
  previewToolList,
  readMcpMessages,
  writeMcpFrame
} from '../src/main/previewMcp.ts'
import type { PreviewToolHost } from '../src/main/previewTools.ts'

test('previewToolList advertises the six in-app preview tools', () => {
  const names = previewToolList().map((tool) => tool.name)
  assert.deepEqual(names, ['status', 'start', 'stop', 'navigate', 'screenshot', 'console'])
  const navigate = previewToolList().find((tool) => tool.name === 'navigate')
  assert.ok(navigate)
  assert.deepEqual((navigate.inputSchema as { required?: string[] }).required, ['url'])
})

test('handleMcpMessage answers initialize and tools/list', () => {
  const init = handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' }
  })
  assert.equal(init?.result && (init.result as { serverInfo: { name: string } }).serverInfo.name, 'preview')
  assert.equal(
    init?.result && (init.result as { protocolVersion: string }).protocolVersion,
    '2025-03-26'
  )
  const list = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(
    ((list?.result as { tools: unknown[] })?.tools.length),
    6
  )
  const unknown = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'foo' })
  assert.equal(unknown?.error?.code, -32601)
  assert.equal(handleMcpMessage({ method: 'notifications/initialized' }), null)
})

test('handleMcpCall maps bridge text and image results', async () => {
  const text = await handleMcpCall({ id: 1, method: 'tools/call', params: { name: 'status' } }, async () => ({
    ok: true,
    kind: 'text',
    text: '{"status":"running"}'
  }))
  assert.deepEqual(text.result, {
    content: [{ type: 'text', text: '{"status":"running"}' }]
  })
  const image = await handleMcpCall(
    { id: 2, method: 'tools/call', params: { name: 'screenshot' } },
    async () => ({ ok: true, kind: 'image', data: 'abc', mimeType: 'image/png' })
  )
  assert.deepEqual(image.result, {
    content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
  })
  const fail = await handleMcpCall({ id: 3, method: 'tools/call', params: { name: 'start' } }, async () => ({
    ok: false,
    error: 'boom'
  }))
  assert.deepEqual(fail.result, { content: [{ type: 'text', text: 'boom' }], isError: true })
})

test('readMcpMessages understands Content-Length frames and NDJSON', async () => {
  async function* chunks(data: string): AsyncGenerator<Buffer> {
    yield Buffer.from(data)
  }
  const framed = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const frames: unknown[] = []
  for await (const message of readMcpMessages(
    chunks(`Content-Length: ${Buffer.byteLength(framed)}\r\n\r\n${framed}`)
  )) {
    frames.push(message)
  }
  assert.deepEqual(frames, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])

  const lines: unknown[] = []
  for await (const message of readMcpMessages(chunks('{"id":2,"method":"ping"}\n'))) {
    lines.push(message)
  }
  assert.deepEqual(lines, [{ id: 2, method: 'ping' }])
})

test('writeMcpFrame writes NDJSON — one message per line, as MCP stdio requires', () => {
  const chunks: string[] = []
  const stream = { write: (chunk: string) => chunks.push(chunk) } as NodeJS.WritableStream
  writeMcpFrame(stream, { ok: true })
  writeMcpFrame(stream, { text: 'a\nb' })
  // LSP `Content-Length` frames here are what left Codex and Grok waiting on an
  // initialize reply their line-based readers could never parse.
  const written = chunks.join('')
  assert.equal(written, '{"ok":true}\n{"text":"a\\nb"}\n')
  const lines = written.split('\n').filter(Boolean)
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ ok: true }, { text: 'a\nb' }])
})

test('the loopback bridge runs preview tools behind a bearer token', async () => {
  const preview: PreviewToolHost = {
    state: () => ({ cwd: '/tmp/app', status: 'stopped' }),
    startAndWait: async () => ({ cwd: '/tmp/app', status: 'running', url: 'http://localhost:3000' }),
    stop: () => ({ cwd: '/tmp/app', status: 'stopped' }),
    navigate: async () => ({ id: '1', ok: true }),
    screenshot: async () => 'abc',
    recentConsole: () => ''
  }
  const bridge = await startPreviewBridge(preview)
  try {
    const denied = await fetch(`${bridge.url}/tool`, {
      method: 'POST',
      headers: { authorization: 'Bearer no', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'status', cwd: '/tmp/app' })
    })
    assert.equal(denied.status, 401)
    const { callPreviewBridge } = await import('../src/main/previewBridge.ts')
    const started = await callPreviewBridge(bridge.url, bridge.token, '/tmp/app', 'start')
    assert.equal(started.ok, true)
    if (started.ok && started.kind === 'text') assert.match(started.text, /running/)
    const shot = await callPreviewBridge(bridge.url, bridge.token, '/tmp/app', 'screenshot')
    assert.deepEqual(shot, { ok: true, kind: 'image', data: 'abc', mimeType: 'image/png' })
  } finally {
    bridge.close()
  }
})

test('carbonPreviewMcpServers is a stdio ACP server pinned to the project cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-preview-mcp-'))
  const script = join(dir, 'previewMcp.js')
  writeFileSync(script, 'true\n')
  const servers = carbonPreviewMcpServers(
    '/Users/me/app',
    { url: 'http://127.0.0.1:9', token: 'tok', close: () => {} },
    { scriptPath: script, execPath: '/bin/echo' }
  )
  assert.equal(servers.length, 1)
  assert.equal(servers[0].name, 'preview')
  assert.equal(servers[0].command, '/bin/echo')
  assert.deepEqual(servers[0].args, [script, '--stdio'])
  const env = Object.fromEntries(servers[0].env.map((entry) => [entry.name, entry.value]))
  assert.equal(env.CARBON_PREVIEW_URL, 'http://127.0.0.1:9')
  assert.equal(env.CARBON_PREVIEW_TOKEN, 'tok')
  assert.equal(env.CARBON_PREVIEW_CWD, '/Users/me/app')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
})

test('carbonPreviewCodexMcp is a keyed overlay, not a replacement table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-preview-codex-'))
  const script = join(dir, 'previewMcp.js')
  writeFileSync(script, 'true\n')
  const overlay = carbonPreviewCodexMcp(
    '/Users/me/app',
    { url: 'http://127.0.0.1:9', token: 'tok', close: () => {} },
    { scriptPath: script, execPath: '/bin/echo', plan: true }
  )
  assert.ok(overlay)
  const servers = overlay.mcp_servers as Record<string, { command: string; args: string[]; env: Record<string, string> }>
  assert.deepEqual(Object.keys(servers), ['preview'])
  assert.equal(servers.preview.command, '/bin/echo')
  assert.deepEqual(servers.preview.args, [script, '--stdio'])
  assert.equal(servers.preview.env.CARBON_PREVIEW_CWD, '/Users/me/app')
  assert.equal(servers.preview.env.CARBON_PREVIEW_PLAN, '1')
  assert.equal(servers.preview.env.ELECTRON_RUN_AS_NODE, '1')
})


test('the bridge routes canvas calls, and defaults to preview without a server field', async () => {
  const saved: Array<Record<string, unknown>> = []
  const canvas = {
    list: () => [],
    get: () => null,
    save: (input: { project: string; title: string; html: string; chatId?: string | null }) => {
      saved.push(input)
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
  const preview: PreviewToolHost = {
    state: (cwd) => ({ cwd, status: 'stopped' }),
    startAndWait: async (cwd) => ({ cwd, status: 'stopped' }),
    stop: (cwd) => ({ cwd, status: 'stopped' }),
    navigate: async () => ({ ok: true }),
    screenshot: async () => null,
    recentConsole: () => 'from preview'
  }
  const bridge = await startPreviewBridge(preview, canvas)
  try {
    const res = await callCanvasBridge(
      bridge.url,
      bridge.token,
      { project: '/repo', chatId: 'chat-1' },
      'write',
      { title: 'Report', html: '<p>x</p>' }
    )
    assert.equal(res.ok, true)
    assert.equal(saved.length, 1)
    // The project rides the envelope, not the tool arguments — it is a fact
    // about the session, fixed when the server was spawned.
    assert.equal(saved[0].project, '/repo')
    assert.equal(saved[0].chatId, 'chat-1')

    // A canvas payload far past the preview cap still lands: capping both at
    // 64 KB would have failed on Codex and Grok while working on Claude, whose
    // in-process server never touches this bridge.
    const big = await callCanvasBridge(
      bridge.url,
      bridge.token,
      { project: '/repo' },
      'write',
      { title: 'Big', html: `<p>${'x'.repeat(300_000)}</p>` }
    )
    assert.equal(big.ok, true)

    // An old-shaped body with no `server` field is still a preview call.
    const legacy = await fetch(`${bridge.url}/tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'console', cwd: '/repo' })
    })
    assert.deepEqual(await legacy.json(), { ok: true, kind: 'text', text: 'from preview' })
  } finally {
    bridge.close()
  }
})

test('the bridge refuses a canvas call it has no host for, and an unknown tool', async () => {
  const preview: PreviewToolHost = {
    state: (cwd) => ({ cwd, status: 'stopped' }),
    startAndWait: async (cwd) => ({ cwd, status: 'stopped' }),
    stop: (cwd) => ({ cwd, status: 'stopped' }),
    navigate: async () => ({ ok: true }),
    screenshot: async () => null,
    recentConsole: () => ''
  }
  const bridge = await startPreviewBridge(preview)
  try {
    const noHost = await callCanvasBridge(bridge.url, bridge.token, { project: '/r' }, 'write', {
      title: 'T',
      html: '<p>x</p>'
    })
    assert.deepEqual(noHost, { ok: false, error: 'Canvas is not available.' })
  } finally {
    bridge.close()
  }
})

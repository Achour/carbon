import { PREVIEW_TOOL_INFO, PREVIEW_TOOL_NAMES, previewPlanBlock } from './previewTools.ts'
import { CANVAS_TOOL_INFO, CANVAS_TOOL_NAMES } from './canvasTools.ts'
import { callCanvasBridge, callPreviewBridge, type PreviewBridgeResponse } from './previewBridge.ts'

/**
 * One child script serves both of Carbon's MCP servers, chosen by
 * `CARBON_MCP_SERVER`. A second script would mean a second entry in
 * `electron.vite.config` and a second built artifact to resolve beside the
 * compiled main — for a file that differs only in its tool table.
 */
export type McpServerName = 'preview' | 'canvas'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL = '2024-11-05'

/** The union of both tool tables' arguments — the child only forwards them. */
export type ToolArgs = { url?: string; title?: string; html?: string; id?: string }

export function previewToolList(): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  return PREVIEW_TOOL_NAMES.map((name) => {
    const info = PREVIEW_TOOL_INFO[name]
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    if (info.url) {
      properties.url = { type: 'string', description: 'The URL to load in the preview.' }
      required.push('url')
    }
    return {
      name,
      description: info.description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {})
      }
    }
  })
}

/**
 * The canvas tools' wire schema. `html` is a plain string parameter — the whole
 * document travels as one argument, which is why the bridge's canvas cap is
 * megabytes rather than the preview path's kilobytes.
 */
export function canvasToolList(): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  return CANVAS_TOOL_NAMES.map((name) => {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    if (name === 'write') {
      properties.title = { type: 'string', description: 'Short title for the canvas.' }
      properties.html = {
        type: 'string',
        description:
          'A complete, self-contained HTML document. Inline any CSS and JS; do not reference project files.'
      }
      properties.id = {
        type: 'string',
        description: 'Id of an existing canvas to replace. Omit to create a new one.'
      }
      required.push('title', 'html')
    }
    if (name === 'read') {
      properties.id = { type: 'string', description: 'The canvas id.' }
      required.push('id')
    }
    return {
      name,
      description: CANVAS_TOOL_INFO[name].description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {})
      }
    }
  })
}

export function handleMcpMessage(
  message: JsonRpcRequest,
  server: McpServerName = 'preview'
): JsonRpcResponse | null {
  if (!message.method || message.id == null) return null
  const id = message.id
  if (message.method === 'initialize') {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: server, version: '1.0.0' }
      }
    }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: server === 'canvas' ? canvasToolList() : previewToolList() }
    }
  }
  if (message.method === 'tools/call') return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${message.method}` } }
}

export async function handleMcpCall(
  message: JsonRpcRequest,
  callTool: (name: string, input: ToolArgs) => Promise<PreviewBridgeResponse>
): Promise<JsonRpcResponse> {
  const id = message.id ?? null
  const params = (message.params ?? {}) as { name?: string; arguments?: ToolArgs }
  const name = typeof params.name === 'string' ? params.name : ''
  try {
    const result = await callTool(name, params.arguments ?? {})
    if (!result.ok) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: result.error }], isError: true }
      }
    }
    if (result.kind === 'image') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] }
      }
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }] } }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true
      }
    }
  }
}

/**
 * MCP stdio is newline-delimited JSON — one message per line. It is *not* LSP,
 * whose `Content-Length` frames this used to write: Codex's and Grok's clients
 * both read lines, so the framed `initialize` reply was never parsed and the
 * server was dropped after their 30s startup timeout, with no preview tools
 * reaching the model. `JSON.stringify` never emits a literal newline, so the
 * one-message-per-line invariant holds without escaping.
 */
export function writeMcpFrame(stream: NodeJS.WritableStream, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`)
}

export async function* readMcpMessages(
  stream: AsyncIterable<Buffer | string>
): AsyncGenerator<JsonRpcRequest> {
  let buf = Buffer.alloc(0)
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n')
      const head = buf.subarray(0, Math.min(buf.length, 80)).toString('utf8')
      if (headerEnd >= 0 && /content-length\s*:/i.test(head)) {
        const header = buf.subarray(0, headerEnd).toString('utf8')
        const match = /content-length:\s*(\d+)/i.exec(header)
        if (!match) {
          buf = buf.subarray(headerEnd + 4)
          continue
        }
        const length = Number(match[1])
        const start = headerEnd + 4
        if (buf.length < start + length) break
        const json = buf.subarray(start, start + length).toString('utf8')
        buf = buf.subarray(start + length)
        yield JSON.parse(json) as JsonRpcRequest
        continue
      }
      const nl = buf.indexOf(0x0a)
      if (nl < 0) break
      const line = buf.subarray(0, nl).toString('utf8').trim()
      buf = buf.subarray(nl + 1)
      if (line.startsWith('{')) yield JSON.parse(line) as JsonRpcRequest
    }
  }
}

async function startStdio(): Promise<void> {
  const server: McpServerName = process.env.CARBON_MCP_SERVER === 'canvas' ? 'canvas' : 'preview'
  const url = process.env.CARBON_PREVIEW_URL ?? ''
  const token = process.env.CARBON_PREVIEW_TOKEN ?? ''
  const cwd = process.env.CARBON_PREVIEW_CWD ?? ''
  if (!url || !token || !cwd) {
    console.error('preview MCP: CARBON_PREVIEW_URL, CARBON_PREVIEW_TOKEN, and CARBON_PREVIEW_CWD are required.')
    process.exit(1)
  }
  const plan = process.env.CARBON_PREVIEW_PLAN === '1'
  // The canvas server is handed the *project* (repo root) and the chat, both
  // fixed at spawn: re-deriving the repo root per call would mean git work on
  // every write, and a model that could name its own project could write into
  // another one's list.
  const project = process.env.CARBON_CANVAS_PROJECT || cwd
  const chatId = process.env.CARBON_CANVAS_CHAT || null
  const callTool = async (name: string, input: ToolArgs): Promise<PreviewBridgeResponse> => {
    if (server === 'canvas') return callCanvasBridge(url, token, { project, chatId }, name, input)
    const blocked = previewPlanBlock(name, plan)
    if (blocked) return { ok: false, error: blocked }
    return callPreviewBridge(url, token, cwd, name, input)
  }

  process.stdin.on('error', () => process.exit(1))
  for await (const message of readMcpMessages(process.stdin)) {
    if (!message.method) continue
    if (message.id == null) continue
    if (message.method === 'tools/call') {
      writeMcpFrame(process.stdout, await handleMcpCall(message, callTool))
      continue
    }
    const reply = handleMcpMessage(message, server)
    if (reply) writeMcpFrame(process.stdout, reply)
  }
}

function isPreviewMcpEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return /previewMcp\.(js|ts|mjs|cjs)$/.test(entry.replace(/\\/g, '/'))
}

if (isPreviewMcpEntry()) {
  void startStdio().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

import { PREVIEW_TOOL_INFO, PREVIEW_TOOL_NAMES, previewPlanBlock } from './previewTools.ts'
import { callPreviewBridge, type PreviewBridgeResponse } from './previewBridge.ts'

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

export function handleMcpMessage(message: JsonRpcRequest): JsonRpcResponse | null {
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
        serverInfo: { name: 'preview', version: '1.0.0' }
      }
    }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: previewToolList() } }
  }
  if (message.method === 'tools/call') return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${message.method}` } }
}

export async function handleMcpCall(
  message: JsonRpcRequest,
  callTool: (name: string, input: { url?: string }) => Promise<PreviewBridgeResponse>
): Promise<JsonRpcResponse> {
  const id = message.id ?? null
  const params = (message.params ?? {}) as { name?: string; arguments?: { url?: string } }
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
  const url = process.env.CARBON_PREVIEW_URL ?? ''
  const token = process.env.CARBON_PREVIEW_TOKEN ?? ''
  const cwd = process.env.CARBON_PREVIEW_CWD ?? ''
  if (!url || !token || !cwd) {
    console.error('preview MCP: CARBON_PREVIEW_URL, CARBON_PREVIEW_TOKEN, and CARBON_PREVIEW_CWD are required.')
    process.exit(1)
  }
  const plan = process.env.CARBON_PREVIEW_PLAN === '1'
  const callTool = async (name: string, input: { url?: string }): Promise<PreviewBridgeResponse> => {
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
    const reply = handleMcpMessage(message)
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

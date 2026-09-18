import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  carbonAcpServer,
  carbonCodexConfig,
  handleMcpCall,
  handleMcpMessage,
  parseCarbonTool,
  runCarbonTool,
  type CarbonToolContext,
  type HttpMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './carbonMcp.ts'
import type { CanvasToolHost } from './canvasTools.ts'
import type { PreviewToolHost } from './previewTools.ts'

/**
 * **Carbon's MCP server, spoken over loopback HTTP.**
 *
 * This used to be a private POST endpoint that two stdio child processes
 * forwarded to — Codex and Grok cannot load an in-process server the way
 * Claude's SDK can, so each session paid for two Electron-as-node children
 * whose only job was to relay. Both CLIs turned out to speak streamable-HTTP
 * MCP (codex-cli 0.155.0 via `mcp_servers.<name>.url`, grok 1.0.34 via ACP
 * `session/new`, whose `initialize` advertises `mcpCapabilities.http`), so the
 * relay is gone and the server they connect to is this one, in the process that
 * owns the tools.
 *
 * Bound to 127.0.0.1 with a random bearer token. The per-session context —
 * which project, which chat, whether the chat is in plan mode — is held here
 * under an unguessable path segment rather than encoded into the URL, so the
 * endpoint a CLI is handed says nothing about the machine it runs on.
 */
const BODY_CAP = 64 * 1024
const CANVAS_BODY_CAP = 5 * 1024 * 1024
const READ_CAP = Math.max(BODY_CAP, CANVAS_BODY_CAP)

export interface CarbonMcpSession {
  /** The endpoint this session's CLI connects to. */
  url: string
  /** ACP `session/new` entry (Grok). */
  acpServer: HttpMcpServer
  /** `config.mcp_servers` overlay (Codex). */
  codexConfig: Record<string, unknown>
  /** Drop the context. Called when the provider session is disposed. */
  dispose(): void
}

/**
 * What a provider session needs from the bridge. A structural type rather than
 * `PreviewManager` itself, so a session test can stand one up without a dev
 * server, a port or an Electron window.
 */
export interface CarbonMcpProvider {
  mcpSession(ctx: CarbonToolContext): Promise<CarbonMcpSession | null>
}

export interface CarbonBridgeHandle {
  url: string
  token: string
  /**
   * Register one provider session's context and get its endpoint back.
   *
   * Once per session, not once per turn: Codex rebuilds its thread options on
   * every send, and registering there would leak an entry per turn. The context
   * object is held by reference and `plan` is a getter, so a mode change
   * between turns needs no re-registration.
   */
  register(ctx: CarbonToolContext): CarbonMcpSession
  close(): void
}

export function startCarbonBridge(
  preview: PreviewToolHost,
  canvas?: CanvasToolHost
): Promise<CarbonBridgeHandle> {
  return new Promise((resolve, reject) => {
    const token = randomUUID()
    const sessions = new Map<string, CarbonToolContext>()
    const server = createServer((req, res) => {
      void handleRequest(req, res, { token, sessions, preview, canvas })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Carbon MCP bridge has no address.'))
        return
      }
      const base = `http://127.0.0.1:${addr.port}`
      resolve({
        url: base,
        token,
        register: (ctx) => {
          const id = randomUUID()
          sessions.set(id, ctx)
          const url = `${base}/mcp/${id}`
          return {
            url,
            acpServer: carbonAcpServer(url, token),
            codexConfig: carbonCodexConfig(url, token),
            dispose: () => {
              sessions.delete(id)
            }
          }
        },
        close: () => closeServer(server)
      })
    })
  })
}

function closeServer(server: Server): void {
  server.close()
  server.closeAllConnections?.()
}

interface BridgeState {
  token: string
  sessions: Map<string, CarbonToolContext>
  preview: PreviewToolHost
  canvas?: CanvasToolHost
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState
): Promise<void> {
  try {
    const id = /^\/mcp\/([0-9a-f-]{36})$/i.exec(req.url ?? '')?.[1]
    const ctx = id ? state.sessions.get(id) : undefined
    if (!id || !ctx) {
      res.writeHead(404).end()
      return
    }
    // Codex's `doctor` reachability probe is an unauthenticated HEAD. Answering
    // it says only that something is listening on a port the caller was already
    // told about, and it is the difference between a green row and a scary one.
    if (req.method === 'HEAD') {
      res.writeHead(200).end()
      return
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
      return
    }
    // The SSE stream half of streamable HTTP. Carbon's tools are all
    // request/response — nothing is ever pushed — so there is no stream to
    // open, and both CLIs carry on after the refusal.
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    // The client closing its MCP session. Nothing is held per connection, so
    // there is nothing to tear down; saying so keeps the shutdown clean.
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const raw = await readBody(req)
    const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[]
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    // The cap is per *tool kind* and the kind is now inside the body, so it is
    // enforced after the parse rather than before it. A canvas write carries a
    // whole document; a preview call carries a URL at most and has no business
    // being large.
    if (raw.length > cap(messages)) {
      res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"payload too large"}')
      return
    }
    const replies: JsonRpcResponse[] = []
    for (const message of messages) {
      const reply = await answer(message, state, ctx)
      if (reply) replies.push(reply)
    }
    // Every message was a notification; there is nothing to answer.
    if (!replies.length) {
      res.writeHead(202).end()
      return
    }
    json(res, 200, Array.isArray(parsed) ? replies : replies[0], id)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    )
  }
}

function cap(messages: JsonRpcRequest[]): number {
  const canvas = messages.some((message) => {
    if (message.method !== 'tools/call') return false
    const name = (message.params as { name?: unknown } | undefined)?.name
    return parseCarbonTool(typeof name === 'string' ? name : undefined)?.kind === 'canvas'
  })
  return canvas ? CANVAS_BODY_CAP : BODY_CAP
}

async function answer(
  message: JsonRpcRequest,
  state: BridgeState,
  ctx: CarbonToolContext
): Promise<JsonRpcResponse | null> {
  if (message.method === 'tools/call' && message.id != null) {
    return handleMcpCall(message, (name, input) =>
      runCarbonTool({ preview: state.preview, canvas: state.canvas }, ctx, name, input)
    )
  }
  return handleMcpMessage(message, { canvas: !!state.canvas })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > READ_CAP) {
        req.destroy()
        reject(new Error('Request too large.'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown, session: string): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'mcp-session-id': session
  })
  res.end(payload)
}

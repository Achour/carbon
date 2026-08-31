import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  isPreviewToolName,
  runPreviewTool,
  type PreviewToolHost,
  type PreviewToolResult
} from './previewTools.ts'
import { isCanvasToolName, runCanvasTool, type CanvasToolHost } from './canvasTools.ts'

/**
 * Per-server body caps, not one global.
 *
 * A preview call carries a URL at most, so 64 KB is a generous bound on a
 * request that has no business being large. A canvas call carries the whole
 * document, and capping *that* at 64 KB would have failed on Codex and Grok
 * while succeeding on Claude — whose in-process server never touches this
 * bridge — which is exactly the silent provider asymmetry this codebase keeps
 * ruling out. The read is bounded by the larger of the two and the smaller is
 * enforced after the server is known, so a rogue preview payload is still
 * refused at 64 KB.
 */
const BODY_CAP = 64 * 1024
const CANVAS_BODY_CAP = 5 * 1024 * 1024
const READ_CAP = Math.max(BODY_CAP, CANVAS_BODY_CAP)

export interface PreviewBridgeHandle {
  url: string
  token: string
  close(): void
}

/**
 * Loopback HTTP front for the preview tools. Grok (and any other stdio MCP
 * adapter) cannot share Carbon's process, so the MCP child POSTs here.
 * Bound to 127.0.0.1 with a random bearer token — not a public server.
 */
export function startPreviewBridge(
  preview: PreviewToolHost,
  canvas?: CanvasToolHost
): Promise<PreviewBridgeHandle> {
  return new Promise((resolve, reject) => {
    const token = randomUUID()
    const server = createServer((req, res) => {
      void handleRequest(req, res, token, preview, canvas)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Preview bridge has no address.'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () => closeServer(server)
      })
    })
  })
}

function closeServer(server: Server): void {
  server.close()
  server.closeAllConnections?.()
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  preview: PreviewToolHost,
  canvas?: CanvasToolHost
): Promise<void> {
  try {
    if (req.method !== 'POST' || req.url !== '/tool') {
      json(res, 404, { ok: false, error: 'Not found.' })
      return
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${token}`) {
      json(res, 401, { ok: false, error: 'Unauthorized.' })
      return
    }
    const raw = await readBody(req)
    const body = JSON.parse(raw) as {
      server?: unknown
      name?: unknown
      cwd?: unknown
      project?: unknown
      chatId?: unknown
      input?: { url?: unknown; title?: unknown; html?: unknown; id?: unknown }
    }
    const name = typeof body.name === 'string' ? body.name : ''
    // Defaulted, so an existing preview client that sends no `server` field
    // still lands where it always did.
    const which = body.server === 'canvas' ? 'canvas' : 'preview'
    if (which === 'preview' && raw.length > BODY_CAP) {
      json(res, 413, { ok: false, error: 'Request too large.' })
      return
    }

    if (which === 'canvas') {
      if (!canvas) {
        json(res, 400, { ok: false, error: 'Canvas is not available.' })
        return
      }
      if (!isCanvasToolName(name)) {
        json(res, 400, { ok: false, error: `Unknown canvas tool: ${name || '(missing)'}` })
        return
      }
      const project = typeof body.project === 'string' ? body.project : ''
      if (!project) {
        json(res, 400, { ok: false, error: 'project is required.' })
        return
      }
      const chatId = typeof body.chatId === 'string' ? body.chatId : null
      const input = {
        title: typeof body.input?.title === 'string' ? body.input.title : undefined,
        html: typeof body.input?.html === 'string' ? body.input.html : undefined,
        id: typeof body.input?.id === 'string' ? body.input.id : undefined
      }
      json(res, 200, { ok: true, ...runCanvasTool(canvas, { project, chatId }, name, input) })
      return
    }

    const cwd = typeof body.cwd === 'string' ? body.cwd : ''
    if (!isPreviewToolName(name)) {
      json(res, 400, { ok: false, error: `Unknown preview tool: ${name || '(missing)'}` })
      return
    }
    if (!cwd) {
      json(res, 400, { ok: false, error: 'cwd is required.' })
      return
    }
    const url = typeof body.input?.url === 'string' ? body.input.url : undefined
    const result = await runPreviewTool(preview, cwd, name, { url })
    json(res, 200, { ok: true, ...result })
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
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

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export type PreviewBridgeResponse =
  | ({ ok: true } & PreviewToolResult)
  | { ok: false; error: string }

/** Used by the stdio MCP child (and tests) to call the bridge. */
export async function callPreviewBridge(
  url: string,
  token: string,
  cwd: string,
  name: string,
  input: { url?: string } = {}
): Promise<PreviewBridgeResponse> {
  const res = await fetch(`${url.replace(/\/$/, '')}/tool`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name, cwd, input })
  })
  const parsed = (await res.json()) as PreviewBridgeResponse
  return parsed
}

/** Used by the stdio MCP child (and tests) to call the bridge's canvas tools. */
export async function callCanvasBridge(
  url: string,
  token: string,
  ctx: { project: string; chatId?: string | null },
  name: string,
  input: { title?: string; html?: string; id?: string } = {}
): Promise<PreviewBridgeResponse> {
  const res = await fetch(`${url.replace(/\/$/, '')}/tool`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ server: 'canvas', name, project: ctx.project, chatId: ctx.chatId ?? null, input })
  })
  return (await res.json()) as PreviewBridgeResponse
}

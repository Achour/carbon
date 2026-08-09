import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { OpencodePart, OpencodePermissionAsked, OpencodeTodo } from './opencodeEvents.ts'
import { missingBinaryError } from './opencodeBinary.ts'

/**
 * The `opencode serve` transport: HTTP requests plus one SSE event bus.
 *
 * **The only file that knows OpenCode's wire protocol.** OpenCode 2 ships a
 * revised server API under a separate `opencode2` binary; when that stabilizes
 * the swap should be contained to this file, which is why the session above it
 * deals only in the types declared here.
 *
 * Two facts from the running server shape everything below:
 *
 * 1. **A session's working directory is the server process's cwd.** `POST
 *    /session` has no `directory` field — the session reports one, but it is
 *    inherited. So this pools **one server per directory** rather than one per
 *    app: two chats in the same project share a process, two projects do not.
 *
 * 2. **`--port 0` binds the documented default (4096), not an ephemeral port.**
 *    So the port is chosen here, by asking the OS for a free one and passing it
 *    explicitly. Letting it default would collide with the user's own TUI, which
 *    is the one process we must never fight over a port with.
 */

const HEALTH_TIMEOUT_MS = 20_000
const HEALTH_INTERVAL_MS = 150
const REQUEST_TIMEOUT_MS = 30_000
/** Reconnect backoff for the SSE stream, capped. */
const SSE_RETRY_MIN_MS = 500
const SSE_RETRY_MAX_MS = 5_000
/** Events held for a session that hasn't attached its route yet. */
const BUFFER_LIMIT = 500

// ---- events as the session consumes them ----

export type OpencodeEvent =
  | { type: 'message.part.updated'; part: OpencodePart }
  | { type: 'message.part.delta'; partID: string; field: string; delta: string }
  | { type: 'message.part.removed'; partID: string }
  | { type: 'message.updated'; messageID: string; role?: string; modelID?: string; providerID?: string }
  | { type: 'permission.asked'; request: OpencodePermissionAsked }
  | { type: 'permission.replied'; permissionID: string }
  | { type: 'session.status'; status: string }
  | { type: 'session.idle' }
  | { type: 'session.error'; message: string }
  | { type: 'todo.updated'; todos: OpencodeTodo[] }
  /** The stream reconnected and may have missed events; re-read authoritative state. */
  | { type: 'resync' }
  /** The server died. Any in-flight turn is over and will not resume. */
  | { type: 'server-lost'; message: string }

export type OpencodeEventHandler = (event: OpencodeEvent) => void

export interface OpencodeSessionCreate {
  title?: string
  agent?: string
}

/**
 * A stored message's envelope, as `GET /session/{id}/message` returns it.
 *
 * `time.created` is declared because it is the only thing that dates a message
 * the event stream never announced — which is exactly what a resync has to sort
 * out. See `OpencodeSession.resync`.
 */
export interface OpencodeMessageInfo {
  id?: string
  role?: string
  sessionID?: string
  time?: { created?: number; completed?: number }
}

export interface OpencodeStoredMessage {
  info?: OpencodeMessageInfo
  parts?: OpencodePart[]
}

export interface OpencodePromptBody {
  model?: { providerID: string; modelID: string }
  agent?: string
  /** OpenCode's name for reasoning effort — a level the model itself declares. */
  variant?: string
  system?: string
  parts: { type: string; text?: string; mime?: string; url?: string; filename?: string }[]
}

/**
 * What `OpencodeSession` is allowed to call. Declared as an interface so tests
 * can drive the session with a scripted fake and never start a server — the same
 * seam `CodexSession` takes its client through.
 */
export interface OpencodeClientLike {
  createSession(opts: OpencodeSessionCreate): Promise<{ id: string; directory?: string }>
  /** Resolves when the turn finishes: the endpoint is synchronous by design. */
  prompt(sessionID: string, body: OpencodePromptBody): Promise<unknown>
  abort(sessionID: string): Promise<void>
  replyPermission(permissionID: string, reply: string, message?: string): Promise<void>
  listMessages(sessionID: string): Promise<OpencodeStoredMessage[]>
  listProviders(): Promise<unknown>
  /** Every agent the server knows, primary and subagent alike; filtered above. */
  listAgents(): Promise<unknown>
  deleteSession(sessionID: string): Promise<void>
  subscribe(sessionID: string, handler: OpencodeEventHandler): () => void
}

// ---- server pool ----

interface ServerHandle {
  child: ChildProcess
  baseUrl: string
  token: string
  generation: number
}

interface Pooled {
  cwd: string
  starting: Promise<ServerHandle> | null
  handle: ServerHandle | null
  routes: Map<string, OpencodeEventHandler>
  buffered: Map<string, OpencodeEvent[]>
  /** Non-null while an SSE stream is live or reconnecting. */
  stream: AbortController | null
  closed: boolean
  generation: number
}

const pool = new Map<string, Pooled>()

function poolFor(cwd: string): Pooled {
  let entry = pool.get(cwd)
  if (!entry) {
    entry = {
      cwd,
      starting: null,
      handle: null,
      routes: new Map(),
      buffered: new Map(),
      stream: null,
      closed: false,
      generation: 0
    }
    pool.set(cwd, entry)
  }
  return entry
}

/** A port the OS says is free. Racy in principle, immediately reused in practice. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

function authHeader(token: string): string {
  // The server takes the password over HTTP basic auth; the username is ignored.
  return `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`
}

async function waitHealthy(baseUrl: string, token: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError = 'timed out'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`opencode serve exited before it was ready (${child.exitCode ?? child.signalCode})`)
    }
    try {
      const res = await fetch(`${baseUrl}/config`, {
        headers: { authorization: authHeader(token) },
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  throw new Error(`opencode serve did not become ready: ${lastError}`)
}

async function startServer(entry: Pooled): Promise<ServerHandle> {
  const port = await freePort()
  const token = randomBytes(24).toString('hex')
  const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: entry.cwd,
    // Deliberately *not* detached, unlike the pty in terminal.ts. A pty needs its
    // own process group so a shell's grandchildren can be reaped; `opencode serve`
    // is a single binary with nothing under it, so a group buys nothing — and it
    // would cost the server its one safety net, since a detached child no longer
    // receives the group signal that kills the app when it goes down abnormally
    // (before-quit, and so shutdownOpencodeServers, never runs then).
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: token }
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  if (process.env.NODE_ENV !== 'production') {
    child.stderr?.on('data', (d: string) => console.error(`[opencode ${entry.cwd}]`, d.trimEnd()))
  }

  const spawnFailure = new Promise<never>((_, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? missingBinaryError() : err)
    })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await Promise.race([waitHealthy(baseUrl, token, child), spawnFailure])
  } catch (err) {
    killTree(child)
    throw err
  }

  const handle: ServerHandle = { child, baseUrl, token, generation: ++entry.generation }
  child.once('exit', () => {
    if (entry.handle === handle) failServer(entry, 'The OpenCode server exited.')
  })
  return handle
}

/**
 * Stop a server. A plain signal, not a group kill: the child shares our process
 * group (see the spawn above), so `kill(-pid)` would either find no such group
 * or, worse, name someone else's after PID reuse.
 */
function killTree(child: ChildProcess | null): void {
  if (!child) return
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
}

/**
 * Tear down a dead server and tell every attached session.
 *
 * Nulling `handle`/`starting` is what makes the next request respawn: the pool
 * entry survives so the routes stay attached across the gap, which is why a
 * session that outlives a crashed server keeps working on its next send.
 */
function failServer(entry: Pooled, message: string): void {
  const handle = entry.handle
  entry.handle = null
  entry.starting = null
  entry.stream?.abort()
  entry.stream = null
  if (handle) killTree(handle.child)
  for (const handler of [...entry.routes.values()]) {
    try {
      handler({ type: 'server-lost', message })
    } catch {
      // a handler throwing must not stop the others being told
    }
  }
}

async function ensureServer(entry: Pooled): Promise<ServerHandle> {
  if (entry.closed) throw new Error('OpenCode server pool is shut down')
  if (entry.handle) return entry.handle
  if (!entry.starting) {
    entry.starting = startServer(entry)
      .then((handle) => {
        entry.handle = handle
        entry.starting = null
        startStream(entry, handle)
        return handle
      })
      .catch((err) => {
        // Cleared so a later send retries rather than caching the failure.
        entry.starting = null
        throw err
      })
  }
  return entry.starting
}

// ---- SSE bus ----

function deliver(entry: Pooled, sessionID: string, event: OpencodeEvent): void {
  const handler = entry.routes.get(sessionID)
  if (handler) {
    handler(event)
    return
  }
  // The prompt POST can return — and its first events arrive — before the
  // session has attached its route. Hold them rather than dropping them.
  const held = entry.buffered.get(sessionID) ?? []
  if (held.length < BUFFER_LIMIT) {
    held.push(event)
    entry.buffered.set(sessionID, held)
  }
}

/** Translate one raw bus event, or null when it is not one we act on. */
export function translateEvent(raw: {
  type?: string
  properties?: Record<string, unknown>
}): { sessionID: string; event: OpencodeEvent } | null {
  const p = (raw.properties ?? {}) as Record<string, never>
  const sessionID = (p.sessionID as string | undefined) ?? ''
  switch (raw.type) {
    case 'message.part.updated': {
      const part = p.part as OpencodePart | undefined
      if (!part) return null
      return { sessionID: (part.sessionID as string) ?? sessionID, event: { type: 'message.part.updated', part } }
    }
    case 'message.part.delta':
      return {
        sessionID,
        event: {
          type: 'message.part.delta',
          partID: (p.partID as string) ?? '',
          field: (p.field as string) ?? 'text',
          delta: (p.delta as string) ?? ''
        }
      }
    case 'message.part.removed':
      return { sessionID, event: { type: 'message.part.removed', partID: (p.partID as string) ?? '' } }
    case 'message.updated': {
      const info = (p.info ?? {}) as Record<string, unknown>
      return {
        sessionID: (info.sessionID as string) ?? sessionID,
        event: {
          type: 'message.updated',
          messageID: (info.id as string) ?? '',
          role: info.role as string | undefined,
          modelID: info.modelID as string | undefined,
          providerID: info.providerID as string | undefined
        }
      }
    }
    case 'permission.asked':
      return {
        sessionID: (p.sessionID as string) ?? sessionID,
        event: { type: 'permission.asked', request: p as unknown as OpencodePermissionAsked }
      }
    case 'permission.replied':
      return {
        sessionID,
        event: { type: 'permission.replied', permissionID: (p.permissionID as string) ?? (p.id as string) ?? '' }
      }
    case 'session.status': {
      const status = p.status as { type?: string } | string | undefined
      return {
        sessionID,
        event: {
          type: 'session.status',
          status: typeof status === 'string' ? status : (status?.type ?? '')
        }
      }
    }
    case 'session.idle':
      return { sessionID, event: { type: 'session.idle' } }
    case 'session.error': {
      const error = p.error as { message?: string; name?: string } | undefined
      return {
        sessionID,
        event: { type: 'session.error', message: error?.message ?? error?.name ?? 'OpenCode reported an error.' }
      }
    }
    case 'todo.updated':
      return { sessionID, event: { type: 'todo.updated', todos: (p.todos as OpencodeTodo[]) ?? [] } }
    default:
      return null
  }
}

/**
 * One SSE subscription per server, fanned out by sessionID.
 *
 * `/event` is a global bus, so per-session streams would each receive
 * everything. On reconnect the server replays nothing, so every attached route
 * is told to `resync` and re-reads its messages — cheaper than a replay protocol
 * and correct regardless of how long the gap was.
 */
function startStream(entry: Pooled, handle: ServerHandle): void {
  if (entry.stream) return
  const controller = new AbortController()
  entry.stream = controller
  let backoff = SSE_RETRY_MIN_MS

  const run = async (): Promise<void> => {
    while (!controller.signal.aborted && entry.handle === handle) {
      let sawData = false
      try {
        const res = await fetch(`${handle.baseUrl}/event`, {
          headers: { authorization: authHeader(handle.token), accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          sawData = true
          backoff = SSE_RETRY_MIN_MS
          buf += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line; we only send `data:`.
          let cut = buf.indexOf('\n\n')
          while (cut >= 0) {
            const frame = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              try {
                const translated = translateEvent(JSON.parse(line.slice(5).trim()))
                if (translated?.sessionID) deliver(entry, translated.sessionID, translated.event)
              } catch {
                // one malformed frame must not kill the stream
              }
            }
            cut = buf.indexOf('\n\n')
          }
        }
      } catch {
        if (controller.signal.aborted) return
      }
      if (controller.signal.aborted || entry.handle !== handle) return
      // Dropped mid-run: wait, reconnect, and have everyone re-read state.
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(SSE_RETRY_MAX_MS, backoff * 2)
      if (sawData) for (const handler of [...entry.routes.values()]) handler({ type: 'resync' })
    }
  }
  void run()
}

// ---- client ----

async function request<T>(
  entry: Pooled,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const handle = await ensureServer(entry)
  const res = await fetch(`${handle.baseUrl}${path}`, {
    method,
    headers: {
      authorization: authHeader(handle.token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`opencode ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

/**
 * A client bound to one working directory.
 *
 * Prompting has no request timeout: a turn legitimately runs for minutes, and
 * the POST *is* the turn-completion signal (the endpoint is synchronous). Every
 * other call is bounded.
 */
export function opencodeClient(cwd: string): OpencodeClientLike {
  const entry = poolFor(cwd)
  return {
    async createSession(opts) {
      // No `permission`: the ruleset is the user's own config to set, not
      // Carbon's to override — and this server is shared with their TUI.
      return await request(entry, 'POST', '/session', {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.agent ? { agent: opts.agent } : {})
      })
    },
    async prompt(sessionID, body) {
      const handle = await ensureServer(entry)
      const res = await fetch(`${handle.baseUrl}/session/${sessionID}/message`, {
        method: 'POST',
        headers: { authorization: authHeader(handle.token), 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`opencode prompt failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      return await res.json().catch(() => null)
    },
    async abort(sessionID) {
      await request(entry, 'POST', `/session/${sessionID}/abort`).catch(() => undefined)
    },
    async replyPermission(permissionID, reply, message) {
      await request(entry, 'POST', `/permission/${permissionID}/reply`, {
        reply,
        ...(message ? { message } : {})
      })
    },
    async listMessages(sessionID) {
      return (await request(entry, 'GET', `/session/${sessionID}/message`)) ?? []
    },
    async listProviders() {
      return await request(entry, 'GET', '/config/providers')
    },
    async listAgents() {
      return await request(entry, 'GET', '/agent')
    },
    async deleteSession(sessionID) {
      await request(entry, 'DELETE', `/session/${sessionID}`).catch(() => undefined)
    },
    subscribe(sessionID, handler) {
      entry.routes.set(sessionID, handler)
      const held = entry.buffered.get(sessionID)
      if (held) {
        entry.buffered.delete(sessionID)
        for (const event of held) handler(event)
      }
      return () => {
        if (entry.routes.get(sessionID) === handler) entry.routes.delete(sessionID)
      }
    }
  }
}

/** Stop every pooled server. Called from the app's quit path. */
export function shutdownOpencodeServers(): void {
  for (const entry of pool.values()) {
    entry.closed = true
    entry.stream?.abort()
    entry.stream = null
    killTree(entry.handle?.child ?? null)
    entry.handle = null
    entry.starting = null
    entry.routes.clear()
    entry.buffered.clear()
  }
  pool.clear()
}

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { connect } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { extname, join, normalize, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { projectRoot } from '@shared/types'
import type {
  AppDefaults,
  ChatEvent,
  ChatMeta,
  ChatStatus,
  PermissionRequestPayload,
  RemoteAccessPatch,
  RemoteAccessState,
  RemoteSnapshot
} from '@shared/types'
import type { RemoteSettings, Store } from './store'
import {
  hashToken,
  newPairingCode,
  newToken,
  parseCookies,
  remoteAddressAllowed,
  remoteAddresses,
  safeEqual,
  splitDeviceCredential
} from './remoteNet.ts'

/**
 * Remote access: Carbon from a phone.
 *
 * The Mac app runs a small HTTP server that serves a phone-sized client
 * (`src/renderer/remote.html`, built beside the desktop renderer) and relays a
 * fixed set of the same `ipcMain` handlers the desktop window calls. Events go
 * out as server-sent events — the same `ChatEvent`s `emit` sends the window. So
 * nothing about a session knows the phone exists: a prompt typed there is a
 * `chat:send` like any other, and both screens follow the one turn.
 *
 * Why the handlers are *captured* rather than re-implemented: every channel's
 * behaviour lives in `registerIpc`, and a second copy for the phone would drift
 * the first time either changed. `captureIpc` records each listener as it is
 * registered, and only the channels in `REMOTE_CHANNELS` are ever reachable.
 *
 * Reasoning, threat model and what was rejected: `docs/remote.md`.
 */

const DEFAULT_PORT = 7391
const PAIRING_TTL_MS = 10 * 60_000
const PAIRING_ATTEMPTS = 5
/** Across all codes: more misses than this in the window locks pairing. */
const FAILURE_LIMIT = 20
const FAILURE_WINDOW_MS = 10 * 60_000
const MAX_BODY = 25 * 1024 * 1024
/** A phone that stops reading (a suspended tab) is cut loose past this. */
const MAX_BUFFERED = 8 * 1024 * 1024
const HEARTBEAT_MS = 20_000
const SEEN_PERSIST_MS = 5 * 60_000
const COOKIE = 'carbon_device'

/**
 * What a phone may call: exactly what the client uses, and that is the
 * conversation and nothing else — no filesystem, no terminal, no git, no
 * settings, no deleting. The chat list rides `/api/snapshot`. A phone
 * that is lost while paired can steer the agents — which is what it is for —
 * but cannot be turned into a remote shell more directly than that.
 */
export const REMOTE_CHANNELS = new Set([
  'chats:get',
  'chats:load-older',
  'chats:create',
  'chat:send',
  'chat:interrupt',
  'chat:respond-permission',
  // Model, effort, speed and permission mode — the composer's own pickers. A
  // cross-provider model only arms the switch, as on the desktop; it applies
  // at the next send (`applyPendingSwitch`).
  'chat:set-options'
])

/** Per-chat events, sent only to a phone looking at that chat. */
const TRANSCRIPT_EVENTS = new Set<ChatEvent['type']>([
  'message',
  'part',
  'part-delta',
  'tool-update',
  'truncate',
  'context-usage'
])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json'
}

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface EventClient {
  id: string
  res: ServerResponse
  watch: string | null
}

export interface RemoteHost {
  store: Store
  /** Where the built renderer lives (`out/renderer`). */
  rendererDir: string
  /** The Vite dev server, in `npm run dev`; static files are proxied to it. */
  devServerUrl?: string
  /** A chat the phone created, so the desktop sidebar can add its row. */
  onChatCreated(meta: ChatMeta): void
  /** The model picker's inputs (`RemoteSnapshot.models`). */
  models(): Promise<Pick<RemoteSnapshot, 'models' | 'codexConfigModel' | 'available'>>
  /** Each project's mark, as the desktop sidebar draws it (`projects:icons`). */
  projectIcons(roots: string[]): Promise<Record<string, string | null>>
}

export class RemoteAccess {
  private handlers = new Map<string, Listener>()
  private statuses = new Map<string, ChatStatus>()
  private permissions = new Map<string, PermissionRequestPayload[]>()
  private clients = new Map<string, EventClient>()
  private server: Server | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private error: string | undefined
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private failures: number[] = []
  private seenPersistedAt = 0
  /** Compressed build files, by path. The build never changes under a running app. */
  private gzipped = new Map<string, Buffer>()
  /** Fired when anything Settings draws changes, so it can refetch. */
  onChange: (() => void) | null = null

  private host: RemoteHost

  constructor(host: RemoteHost) {
    this.host = host
  }

  // ---------- Wiring ----------

  /**
   * Record every `ipcMain.handle` listener as it registers. Called before
   * `registerIpc`; the phone reaches a listener only through `REMOTE_CHANNELS`.
   */
  captureIpc(ipc: IpcMain): void {
    const handle = ipc.handle.bind(ipc)
    ipc.handle = (channel, listener) => {
      this.handlers.set(channel, listener as Listener)
      handle(channel, listener)
    }
  }

  /**
   * Every `ChatEvent`, whether or not the server is running: a phone that
   * connects mid-turn needs to know which chats are working and what is
   * waiting on an answer, and both were only ever told as events.
   */
  observe(ev: ChatEvent): void {
    if (ev.type === 'status') this.statuses.set(ev.chatId, ev.status)
    else if (ev.type === 'permission-request') {
      const list = (this.permissions.get(ev.chatId) ?? []).filter((r) => r.id !== ev.request.id)
      this.permissions.set(ev.chatId, [...list, ev.request])
    } else if (ev.type === 'permission-resolved') {
      const list = (this.permissions.get(ev.chatId) ?? []).filter((r) => r.id !== ev.requestId)
      if (list.length) this.permissions.set(ev.chatId, list)
      else this.permissions.delete(ev.chatId)
    }
    if (this.clients.size) this.broadcast(ev)
  }

  forgetChat(chatId: string): void {
    this.statuses.delete(chatId)
    this.permissions.delete(chatId)
  }

  // ---------- Settings ----------

  private settings(): RemoteSettings {
    return (
      this.host.store.getRemote() ?? { enabled: false, allowLan: false, port: DEFAULT_PORT, devices: [] }
    )
  }

  private save(next: RemoteSettings): void {
    this.host.store.setRemote(next)
    this.onChange?.()
  }

  state(): RemoteAccessState {
    const s = this.settings()
    const urls = remoteAddresses(networkInterfaces(), s.allowLan).map((a) => ({
      url: `http://${a.address}:${s.port}`,
      kind: a.kind
    }))
    const pairing =
      this.pairing && this.pairing.expiresAt > Date.now()
        ? {
            code: this.pairing.code,
            expiresAt: this.pairing.expiresAt,
            links: urls.map((u) => `${u.url}/#pair=${this.pairing!.code}`)
          }
        : undefined
    return {
      enabled: s.enabled,
      allowLan: s.allowLan,
      port: s.port,
      running: !!this.server?.listening,
      ...(this.error ? { error: this.error } : {}),
      urls,
      devices: s.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt })),
      ...(pairing ? { pairing } : {})
    }
  }

  async configure(patch: RemoteAccessPatch): Promise<RemoteAccessState> {
    const next = { ...this.settings(), ...patch }
    this.save(next)
    if (next.enabled) await this.start()
    else await this.stop()
    // Turning the LAN off has to cut a LAN phone loose now, not at its next
    // reconnect — the address check only runs per request.
    if (patch.allowLan === false) this.dropClients()
    return this.state()
  }

  pair(): RemoteAccessState {
    this.pairing = { code: newPairingCode(), expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 }
    return this.state()
  }

  forget(deviceId?: string): RemoteAccessState {
    const s = this.settings()
    this.save({ ...s, devices: deviceId ? s.devices.filter((d) => d.id !== deviceId) : [] })
    // An open event stream outlives the cookie check that admitted it.
    this.dropClients()
    return this.state()
  }

  /** At launch: resume serving if it was on when the app last quit. */
  async restore(): Promise<void> {
    if (this.settings().enabled) await this.start()
  }

  // ---------- Server ----------

  private async start(): Promise<void> {
    if (this.server?.listening) return
    const port = this.settings().port
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        console.error('[remote] request failed:', err)
        if (!res.headersSent) json(res, 500, { error: 'Internal error' })
        else res.end()
      })
    })
    this.server = server
    // `npm run dev` only: Vite's client opens its hot-reload socket on the page's
    // own origin. Unanswered, it gives up and polls for the dev server, and
    // reloads the whole page each time it thinks the server came back — a
    // white flash mid-use, since in dev the styles arrive by script.
    if (this.host.devServerUrl) server.on('upgrade', (req, socket, head) => this.proxyUpgrade(req, socket, head))
    await new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error =
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use — is another Carbon serving it?`
            : err.message
        this.server = null
        resolve()
      })
      // Every interface, so a Tailscale that connects after launch needs no
      // restart; `remoteAddressAllowed` is what limits who gets an answer.
      server.listen(port, '0.0.0.0', () => {
        this.error = undefined
        resolve()
      })
    })
    if (this.server && !this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients.values()) c.res.write(': ping\n\n')
      }, HEARTBEAT_MS)
    }
    this.onChange?.()
  }

  async stop(): Promise<void> {
    this.dropClients()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const server = this.server
    this.server = null
    this.pairing = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.onChange?.()
  }

  private dropClients(): void {
    for (const c of this.clients.values()) c.res.end()
    this.clients.clear()
  }

  private broadcast(ev: ChatEvent): void {
    const transcript = TRANSCRIPT_EVENTS.has(ev.type)
    let data: string | null = null
    for (const c of this.clients.values()) {
      if (transcript && c.watch !== ev.chatId) continue
      if (c.res.writableLength > MAX_BUFFERED) {
        // It reconnects and refetches; queueing without bound would not help it.
        c.res.end()
        this.clients.delete(c.id)
        continue
      }
      data ??= `data: ${JSON.stringify(wire(ev))}\n\n`
      c.res.write(data)
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowLan = this.settings().allowLan
    if (!remoteAddressAllowed(req.socket.remoteAddress, allowLan)) {
      req.socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', 'http://carbon.invalid')
    const path = url.pathname

    if (path.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers['x-carbon-remote'] !== '1') {
        // A custom header no plain form or cross-site fetch can send without a
        // preflight this server never answers — the CSRF guard, beside the
        // cookie's SameSite.
        json(res, 403, { error: 'Forbidden' })
        return
      }
      if (path === '/api/pair' && req.method === 'POST') return this.handlePair(req, res)
      const device = this.authenticate(req)
      if (!device) {
        json(res, 401, { error: 'Not paired' })
        return
      }
      if (path === '/api/session') return json(res, 200, { ok: true, device: device.name })
      if (path === '/api/snapshot') return json(res, 200, await this.snapshot())
      if (path === '/api/icons') return json(res, 200, await this.icons())
      if (path === '/api/events') return this.handleEvents(res)
      if (path === '/api/watch' && req.method === 'POST') {
        const body = (await readJson(req)) as { conn?: string; chatId?: string | null }
        const client = body.conn ? this.clients.get(body.conn) : undefined
        if (client) client.watch = body.chatId ?? null
        return json(res, 200, { ok: !!client })
      }
      if (path === '/api/invoke' && req.method === 'POST') return this.handleInvoke(req, res)
      json(res, 404, { error: 'Not found' })
      return
    }

    // The manifest names the app for "Add to Home Screen". Its start URL
    // carries the device credential: a Home Screen web app may start with a
    // cookie jar of its own, and this is what signs it in on first launch.
    if (path === '/manifest.webmanifest') {
      const cred = parseCookies(req.headers.cookie)[COOKIE]
      const start = cred && this.authenticate(req) ? `/?device=${encodeURIComponent(cred)}` : '/'
      res.writeHead(200, { 'content-type': MIME['.webmanifest'], 'cache-control': 'no-store' })
      res.end(
        JSON.stringify({
          name: 'Carbon',
          short_name: 'Carbon',
          start_url: start,
          display: 'standalone',
          background_color: '#111111',
          theme_color: '#111111',
          icons: [{ src: '/remote-icon.png', sizes: '180x180', type: 'image/png' }]
        })
      )
      return
    }

    // `/?device=…` from the manifest: trade it for the cookie and drop it from
    // the address bar, so it is not left in the page's own history.
    const carried = url.searchParams.get('device')
    if (path === '/' && carried) {
      const headers: Record<string, string> = { location: '/', 'cache-control': 'no-store' }
      if (this.deviceFor(carried)) headers['set-cookie'] = cookieFor(carried)
      res.writeHead(302, headers)
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    // The app shell is public: it holds no data, and it is what draws the
    // pairing screen for a phone that has no cookie yet.
    if (this.host.devServerUrl) return this.proxyToDev(req, res, path === '/' ? '/remote.html' : req.url ?? '/')
    return this.serveStatic(req, res, path === '/' ? '/remote.html' : path)
  }

  private authenticate(req: IncomingMessage): RemoteSettings['devices'][number] | null {
    return this.deviceFor(parseCookies(req.headers.cookie)[COOKIE])
  }

  private deviceFor(credential: string | undefined): RemoteSettings['devices'][number] | null {
    const parsed = splitDeviceCredential(credential)
    if (!parsed) return null
    const s = this.settings()
    const device = s.devices.find((d) => d.id === parsed.id)
    if (!device || !safeEqual(device.tokenHash, hashToken(parsed.token))) return null
    const now = Date.now()
    device.lastSeenAt = now
    if (now - this.seenPersistedAt > SEEN_PERSIST_MS) {
      this.seenPersistedAt = now
      this.save(s)
    }
    return device
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now()
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS)
    const body = (await readJson(req)) as { code?: unknown; name?: unknown }
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
    const pairing = this.pairing
    if (this.failures.length >= FAILURE_LIMIT) {
      json(res, 429, { error: 'Too many attempts. Wait a few minutes, then make a new code in Carbon.' })
      return
    }
    if (!pairing || pairing.expiresAt < now) {
      json(res, 400, { error: 'No pairing code is active. Make one in Carbon → Settings → Remote access.' })
      return
    }
    if (!safeEqual(code, pairing.code)) {
      this.failures.push(now)
      pairing.attempts++
      // A code survives a typo or two, not a search.
      if (pairing.attempts >= PAIRING_ATTEMPTS) this.pairing = null
      this.onChange?.()
      json(res, 400, {
        error: this.pairing ? 'That code is not right.' : 'Too many wrong codes. Make a new one in Carbon.'
      })
      return
    }
    this.pairing = null
    const id = randomUUID().slice(0, 8)
    const token = newToken()
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Phone'
    const s = this.settings()
    this.save({ ...s, devices: [...s.devices, { id, name, tokenHash: hashToken(token), pairedAt: now, lastSeenAt: now }] })
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(`${id}.${token}`) })
    res.end(JSON.stringify({ ok: true }))
  }

  private async snapshot(): Promise<RemoteSnapshot> {
    const defaults: AppDefaults = this.host.store.getDefaults()
    const chats = this.host.store.listChats()
    return {
      hostname: hostname().replace(/\.local$/, ''),
      chats,
      statuses: Object.fromEntries(this.statuses),
      permissions: Object.fromEntries(this.permissions),
      defaults,
      ...(await this.host.models())
    }
  }

  /**
   * Project marks for every project the phone can list. The roots are the
   * server's own — the chats' projects and the recent folders — never the
   * phone's: `projects:icons` reads a file out of whatever folder it is given,
   * and a paired phone is not meant to read the Mac's disk.
   */
  private async icons(): Promise<Record<string, string | null>> {
    const roots = new Set(this.host.store.getDefaults().recentDirs)
    for (const c of this.host.store.listChats()) {
      if (!c.archivedAt && !c.ephemeral && c.surface !== 'terminal') roots.add(projectRoot(c))
    }
    return this.host.projectIcons([...roots])
  }

  private handleEvents(res: ServerResponse): void {
    const id = randomUUID()
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    // The connection's own id first, so the phone can say which chat it is
    // reading (`/api/watch`) and receive that chat's transcript events.
    res.write(`event: hello\ndata: ${JSON.stringify({ conn: id })}\n\n`)
    this.clients.set(id, { id, res, watch: null })
    res.on('close', () => this.clients.delete(id))
  }

  private async handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { channel?: unknown; args?: unknown }
    const channel = typeof body.channel === 'string' ? body.channel : ''
    // JSON has no `undefined`: an omitted positional argument arrives as `null`,
    // and a `null` slips past a default parameter (`attachments = []`) to throw
    // on its first `.length`. No allowlisted channel gives a positional `null`
    // a meaning of its own, so it is read back as what the phone left out.
    const args = Array.isArray(body.args) ? body.args.map((a) => (a === null ? undefined : a)) : []
    const listener = REMOTE_CHANNELS.has(channel) ? this.handlers.get(channel) : undefined
    if (!listener) {
      json(res, 404, { error: `Not available remotely: ${channel}` })
      return
    }
    try {
      // No handler on the allowlist reads the event; it stands in for the
      // `IpcMainInvokeEvent` only to keep the listener's signature whole.
      const result = await listener({} as IpcMainInvokeEvent, ...args)
      if (channel === 'chats:create' && result) this.host.onChatCreated(result as ChatMeta)
      json(res, 200, { result: result ?? null })
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const root = this.host.rendererDir
    const file = normalize(join(root, decodeURIComponent(path)))
    const type = MIME[extname(file)]
    // Inside the renderer build, and only file types the client is made of.
    if (!file.startsWith(root + sep) || !type) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const headers: Record<string, string> = {
        'content-type': type,
        // Vite fingerprints everything under assets/, so those can be kept.
        'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      }
      // The client shares React and the markdown stack with the desktop
      // build, about a megabyte of script; over a phone's connection,
      // compressing it is the difference between a blink and a wait.
      const text = /^(text|application\/json)/.test(type) || type.includes('javascript')
      if (text && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        let body = this.gzipped.get(file)
        if (!body) {
          body = gzipSync(await readFile(file))
          this.gzipped.set(file, body)
        }
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' })
        res.end(body)
        return
      }
      res.writeHead(200, headers)
      res.end(await readFile(file))
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  private proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!remoteAddressAllowed(req.socket.remoteAddress, this.settings().allowLan)) {
      socket.destroy()
      return
    }
    const target = new URL(this.host.devServerUrl!)
    const upstream = connect(Number(target.port) || 80, target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = (): void => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  }

  /** `npm run dev`: hand the client's files to Vite, so edits hot-reload here too. */
  private proxyToDev(req: IncomingMessage, res: ServerResponse, path: string): void {
    const target = new URL(path, this.host.devServerUrl)
    const upstream = httpRequest(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }
}

/**
 * A `meta` patch *clears* a field by carrying it as `undefined` — a cancelled
 * model switch is `pendingModel: undefined` — and JSON drops such keys, so the
 * phone would never hear the field went away and keep drawing the old value.
 * They cross as `null`; the phone's reducer reads them back as cleared.
 */
function wire(ev: ChatEvent): ChatEvent {
  if (ev.type !== 'meta') return ev
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ev.patch)) patch[k] = v === undefined ? null : v
  return { ...ev, patch: patch as typeof ev.patch }
}

function cookieFor(credential: string): string {
  // Not `Secure`: the transport is plain HTTP, made private by Tailscale's
  // WireGuard tunnel rather than by TLS. A year, because re-pairing a phone is
  // the user's chore and unpairing it is one button in Settings.
  return `${COOKIE}=${encodeURIComponent(credential)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

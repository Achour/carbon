import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { homedir, hostname, networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { basename, extname, join, normalize, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { projectRoot } from '@shared/types'
import { promptLine } from '@shared/promptLine'
import type {
  AppDefaults,
  ChatEvent,
  ChatMeta,
  ChatStatus,
  PermissionRequestPayload,
  RemoteAccessPatch,
  RemoteAccessState,
  RemoteHttpsState,
  RemoteSnapshot,
  RemoteUnseen
} from '@shared/types'
import type { RemoteSettings, Store } from './store'
import { fetchTailscaleCert } from './tailscaleCert'
import { generateVapidKeys, sendPush, type VapidKeys } from './webPush'
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
/** An uploaded file outlives the turn that read it by this much, then goes. */
const UPLOAD_TTL_MS = 7 * 24 * 3600_000
const COOKIE = 'carbon_device'
/** A live certificate is re-asked for this often; Tailscale renews it well before expiry. */
const CERT_REFRESH_MS = 12 * 3600_000
/** No certificate yet: Tailscale may have been installed or switched on since. */
const CERT_RETRY_MS = 5 * 60_000
/** VAPID's `sub` claim: who to contact about this sender. Apple requires one. */
const PUSH_SUBJECT = 'https://github.com/Achour/carbon'

/**
 * What a phone may call: exactly what the client uses, and that is the
 * conversation (and the plan headroom it spends) and nothing else — no
 * filesystem, no terminal, no git, no settings, no deleting. The chat list rides `/api/snapshot`. A phone
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
  'chat:set-options',
  // "Edit and resend" on a prompt: the transcript is cut back to it and the
  // turn runs again — a send, as far as what a phone may do is concerned.
  'chat:edit-message',
  // A turn's Undo. It restores only the files that turn's own checkpoint
  // recorded, which is less than the agent a phone already steers can do.
  'chat:rewind-files',
  // The sidebar's hand-made order: a held row dragged to a new place in the
  // list, or among the pins. The two the desktop's own drag calls, writing
  // only a position, so the Mac's sidebar moves with the phone's.
  'chats:place',
  'chats:set-pinned-order',
  // Canvases are what an agent wrote for the reader, kept by Carbon rather
  // than read off disk: reading one is reading the conversation.
  'canvas:list',
  'canvas:get',
  // The plan's headroom (5-hour, weekly): read-only, account-level, and
  // cached in main — what tells you which agent to start the next task on.
  'usage:overview',
  // The Usage page's history: token counts and list-price cost per day,
  // model and project, read from the CLIs' own logs. Aggregates, never a
  // transcript, and a scan main caches per file.
  'usage:report'
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
  deviceId: string
  /**
   * The page says whether it is on screen (`/api/watch`). A phone looking at
   * a chat needs no notification about it; one whose app is in the
   * background does, even while iOS has yet to close its stream.
   */
  visible: boolean
}

/** What the service worker draws (`public/remote-sw.js`). */
interface PushMessage {
  title: string
  body: string
  chatId: string
  /** Replaces the chat's previous notification instead of stacking another. */
  tag: string
  /**
   * The app icon's count once this lands: what the phone's home screen lists
   * under Needs you and Done. The worker cannot count it, so the Mac does.
   */
  badge: number
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
  /** Each folder's checked-out branch, as a detailed desktop row shows it (`git:branches`). */
  branches(cwds: string[]): Promise<Record<string, string | null>>
  /** The chat's last reply as plain text, for a notification's body. */
  lastReply(chatId: string): string | null
  /** Where files the phone attaches are written (`userData/remote-uploads`). */
  uploadDir: string
}

export class RemoteAccess {
  private handlers = new Map<string, Listener>()
  private statuses = new Map<string, ChatStatus>()
  private permissions = new Map<string, PermissionRequestPayload[]>()
  private clients = new Map<string, EventClient>()
  /**
   * The listening socket. It reads each connection's first byte and hands it
   * to `plain` or, once there is a certificate, `tls` — one port for both, so
   * the address keeps its port when it gains the `s`.
   */
  private server: NetServer | null = null
  private plain: Server | null = null
  private tls: HttpsServer | null = null
  private cert: { name: string; expiresAt: number } | null = null
  /** Why there is no certificate; null while the first ask is in flight. */
  private certReason: string | null = null
  private certTimer: ReturnType<typeof setTimeout> | null = null
  private certFetching = false
  private certTriedAt = 0
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
    let fresh = true
    if (ev.type === 'status') this.statuses.set(ev.chatId, ev.status)
    else if (ev.type === 'permission-request') {
      const prior = this.permissions.get(ev.chatId) ?? []
      fresh = !prior.some((r) => r.id === ev.request.id)
      const list = prior.filter((r) => r.id !== ev.request.id)
      this.permissions.set(ev.chatId, [...list, ev.request])
    } else if (ev.type === 'permission-resolved') {
      const list = (this.permissions.get(ev.chatId) ?? []).filter((r) => r.id !== ev.requestId)
      if (list.length) this.permissions.set(ev.chatId, list)
      else this.permissions.delete(ev.chatId)
    }
    if (this.clients.size) this.broadcast(ev)
    // A prompt re-announced (a reload re-emits the open ones) was already pushed.
    if (fresh) this.maybePush(ev)
  }

  forgetChat(chatId: string): void {
    this.statuses.delete(chatId)
    this.permissions.delete(chatId)
    const s = this.settings()
    const touched = s.devices.filter((d) => d.unseen && chatId in d.unseen)
    if (!touched.length) return
    for (const d of touched) delete d.unseen![chatId]
    this.host.store.setRemote(s)
    for (const d of touched) this.sendUnseen(d.id)
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
    const addresses = remoteAddresses(networkInterfaces(), s.allowLan)
    const name = addresses.some((a) => a.kind === 'lan') ? bonjourName() : null
    const urls: RemoteAccessState['urls'] = [
      ...addresses.filter((a) => a.kind === 'tailscale'),
      ...(name ? [{ address: name, kind: 'local' as const }] : []),
      ...addresses.filter((a) => a.kind === 'lan')
    ].map((a) => ({ url: `http://${a.address}:${s.port}`, kind: a.kind }))
    // Only the certificate's own name can be reached over HTTPS, and only that
    // address can deliver notifications — so it leads, and pairs.
    if (this.cert && this.server?.listening) urls.unshift({ url: `https://${this.cert.name}:${s.port}`, kind: 'https' })
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
      https: this.httpsState(),
      devices: s.devices.map(({ id, name, pairedAt, lastSeenAt, push }) => ({
        id,
        name,
        pairedAt,
        lastSeenAt,
        notifications: !!push
      })),
      ...(pairing ? { pairing } : {})
    }
  }

  private httpsState(): RemoteHttpsState {
    if (!this.server?.listening) return { status: 'off' }
    if (this.cert) return { status: 'on', name: this.cert.name, expiresAt: this.cert.expiresAt }
    if (this.certReason) return { status: 'unavailable', reason: this.certReason }
    return { status: 'pending' }
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

  private handle = (req: IncomingMessage, res: ServerResponse): void => {
    this.route(req, res).catch((err) => {
      console.error('[remote] request failed:', err)
      if (!res.headersSent) json(res, 500, { error: 'Internal error' })
      else res.end()
    })
  }

  /** Both protocols answer the same routes, and dev's hot-reload socket. */
  private withRoutes<T extends Server | HttpsServer>(server: T): T {
    // `npm run dev` only: Vite's client opens its hot-reload socket on the page's
    // own origin. Unanswered, it gives up and polls for the dev server, and
    // reloads the whole page each time it thinks the server came back — a
    // white flash mid-use, since in dev the styles arrive by script.
    if (this.host.devServerUrl) server.on('upgrade', (req, socket, head) => this.proxyUpgrade(req, socket, head))
    server.on('clientError', (_err, socket) => socket.destroy())
    return server
  }

  /**
   * A TLS connection opens with a handshake record, `0x16`; no HTTP method
   * does. So the first byte says which server gets the socket, and the byte
   * goes back on the stream for it to read. Before there is a certificate a
   * TLS hello has nowhere to go and is dropped.
   */
  private dispatch(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    if (!remoteAddressAllowed(socket.remoteAddress, this.settings().allowLan)) {
      socket.destroy()
      return
    }
    socket.once('data', (first: Buffer) => {
      socket.pause()
      socket.unshift(first)
      const target = first[0] === 0x16 ? this.tls : this.plain
      if (!target) {
        socket.destroy()
        return
      }
      target.emit('connection', socket)
      process.nextTick(() => socket.resume())
    })
  }

  private async start(): Promise<void> {
    if (this.server?.listening) return
    void this.pruneUploads()
    const port = this.settings().port
    this.plain = this.withRoutes(createServer(this.handle))
    const server = createNetServer((socket) => this.dispatch(socket))
    this.server = server
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
    // Plain HTTP is up now; the certificate can take a minute the first time
    // (an ACME challenge), and nothing waits on it.
    if (this.server) void this.refreshCert()
  }

  async stop(): Promise<void> {
    this.dropClients()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.certTimer) clearTimeout(this.certTimer)
    this.certTimer = null
    const server = this.server
    this.server = null
    this.pairing = null
    // Keep-alive connections belong to these two, and would hold the listener
    // open past `close` — the front server counts every socket it handed over.
    this.plain?.closeAllConnections()
    this.tls?.closeAllConnections()
    this.plain = null
    this.tls = null
    this.cert = null
    this.certReason = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.onChange?.()
  }

  /**
   * Ask the user's Tailscale for this Mac's certificate, and keep asking: on
   * a schedule once there is one (Tailscale hands back its cached copy until
   * renewal is due), and every few minutes while there is none, since the fix
   * is usually a switch the user flips in Tailscale with Carbon still open.
   */
  private async refreshCert(): Promise<void> {
    if (this.certFetching) return
    if (this.certTimer) clearTimeout(this.certTimer)
    this.certTimer = null
    this.certFetching = true
    this.certTriedAt = Date.now()
    const result = await fetchTailscaleCert().finally(() => (this.certFetching = false))
    if (!this.server) return
    if (result.ok) {
      const context = { cert: result.cert, key: result.key }
      if (this.tls) this.tls.setSecureContext(context)
      else this.tls = this.withRoutes(createHttpsServer(context, this.handle))
      this.cert = { name: result.name, expiresAt: result.expiresAt }
      this.certReason = null
    } else if (!this.cert || this.cert.expiresAt <= Date.now()) {
      // A failed renewal keeps a certificate that is still good.
      this.cert = null
      this.certReason = result.reason
      console.warn('[remote] no HTTPS:', result.reason)
    }
    this.certTimer = setTimeout(() => void this.refreshCert(), this.cert ? CERT_REFRESH_MS : CERT_RETRY_MS)
    this.certTimer.unref?.()
    this.onChange?.()
  }

  /** Settings → Remote access opened: someone may have just set Tailscale up. */
  recheckHttps(): void {
    // Each answer fires `onChange`, which is what reloads Settings: without the
    // floor, a missing Tailscale would be asked about in a loop.
    if (this.server?.listening && !this.cert && Date.now() - this.certTriedAt > 60_000) void this.refreshCert()
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
      if (path === '/api/snapshot') return json(res, 200, await this.snapshot(device))
      if (path === '/api/icons') return json(res, 200, await this.icons())
      if (path === '/api/branches') return json(res, 200, await this.branches())
      if (path === '/api/events') return this.handleEvents(res, device.id)
      if (path === '/api/watch' && req.method === 'POST') {
        const body = (await readJson(req)) as { conn?: string; chatId?: string | null; visible?: boolean }
        const client = body.conn ? this.clients.get(body.conn) : undefined
        if (client && client.deviceId === device.id) {
          client.watch = body.chatId ?? null
          if (typeof body.visible === 'boolean') client.visible = body.visible
          // Opening a chat, or coming back to the app on it, is what reading it means.
          if (client.visible && client.watch) this.clearUnseen(device.id, [client.watch])
        }
        return json(res, 200, { ok: !!client })
      }
      if (path === '/api/seen' && req.method === 'POST') {
        // The home screen's "Clear": everything it lists as Done, or the ids given.
        const body = (await readJson(req)) as { chatIds?: unknown }
        const ids = Array.isArray(body.chatIds) ? body.chatIds.filter((x): x is string => typeof x === 'string') : null
        this.clearUnseen(device.id, ids)
        return json(res, 200, { ok: true })
      }
      if (path === '/api/push') {
        if (req.method === 'POST') return this.handlePushSubscription(req, res, device.id)
        return json(res, 200, { publicKey: this.vapid().publicKey, subscribed: !!device.push })
      }
      if (path === '/api/invoke' && req.method === 'POST') return this.handleInvoke(req, res)
      if (path === '/api/upload' && req.method === 'POST') return this.handleUpload(req, res)
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
      if (this.deviceFor(carried)) headers['set-cookie'] = cookieFor(carried, encrypted(req))
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
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(`${id}.${token}`, encrypted(req)) })
    res.end(JSON.stringify({ ok: true }))
  }

  private async snapshot(device: RemoteSettings['devices'][number]): Promise<RemoteSnapshot> {
    const defaults: AppDefaults = this.host.store.getDefaults()
    // Side chats too, which `listChats` leaves out for the sidebar's sake: a
    // delegate's live state is read off its own chat (`AgentGroupCard`,
    // `DelegateCard`), and without the row the phone reads the delegate as
    // gone, so three running agents showed as "finished". The phone's lists
    // filter them back out (`listedChats`).
    const chats = [...this.host.store.listChats(), ...this.host.store.listSideChats()]
    return {
      hostname: hostname().replace(/\.local$/, ''),
      home: homedir(),
      chats,
      statuses: Object.fromEntries(this.statuses),
      permissions: Object.fromEntries(this.permissions),
      defaults,
      ...(await this.host.models()),
      unseen: device.unseen ?? {}
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

  /**
   * The branch each listed chat's folder is on, for the phone's detailed
   * sidebar rows. Like `icons`, the folders are the server's own (the chats'),
   * never a list the phone sends: a branch name is a read of the Mac's disk.
   */
  private async branches(): Promise<Record<string, string | null>> {
    const cwds = new Set<string>()
    for (const c of this.host.store.listChats()) {
      if (!c.archivedAt && !c.ephemeral && c.surface !== 'terminal') cwds.add(c.cwd)
    }
    return this.host.branches([...cwds])
  }

  private handleEvents(res: ServerResponse, deviceId: string): void {
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
    // Opening the stream is something only a page on screen does.
    this.clients.set(id, { id, res, watch: null, deviceId, visible: true })
    res.on('close', () => this.clients.delete(id))
  }

  // ---------- Push ----------

  /** This Mac's VAPID keys, made once and kept: every subscription is bound to them. */
  private vapid(): VapidKeys {
    const s = this.settings()
    if (s.vapid) return s.vapid
    const vapid = generateVapidKeys()
    this.save({ ...s, vapid })
    return vapid
  }

  /** `{ subscription }` from `PushSubscription.toJSON()`, or `{ subscription: null }` to stop. */
  private async handlePushSubscription(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const body = (await readJson(req)) as {
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
    }
    const sub = body.subscription
    let push: NonNullable<RemoteSettings['devices'][number]['push']> | undefined
    if (sub) {
      const { endpoint } = sub
      const p256dh = sub.keys?.p256dh
      const auth = sub.keys?.auth
      if (
        typeof endpoint !== 'string' ||
        !endpoint.startsWith('https://') ||
        typeof p256dh !== 'string' ||
        typeof auth !== 'string'
      ) {
        json(res, 400, { error: 'Not a push subscription.' })
        return
      }
      push = { endpoint, p256dh, auth }
    }
    const s = this.settings()
    this.save({ ...s, devices: s.devices.map((d) => (d.id === deviceId ? { ...d, push } : d)) })
    json(res, 200, { subscribed: !!push })
  }

  /**
   * The same moments the desktop notifies about (`notifyOnStatus`): a turn
   * that finished or failed, and an agent waiting on an answer. Decided here
   * rather than in the service worker, because iOS revokes a subscription
   * whose pushes show nothing — so every push sent must be one worth drawing.
   */
  private maybePush(ev: ChatEvent): void {
    if (!this.server?.listening) return
    let body: string | null = null
    let ended: 'done' | 'failed' | null = null
    if (ev.type === 'message' && ev.message.role === 'event') {
      if (ev.message.kind === 'turn') {
        body = this.host.lastReply(ev.chatId) || 'Finished'
        ended = 'done'
      } else if (ev.message.kind === 'error') {
        body = `Failed: ${ev.message.text}`
        ended = 'failed'
      }
    } else if (ev.type === 'permission-request') {
      body = promptLine(ev.request)
    }
    if (!body) return
    const meta = this.host.store.getMeta(ev.chatId)
    // Nowhere to land: an ephemeral chat with no thread to open it in.
    if (!meta || (meta.ephemeral && !meta.sideOf)) return
    // A delegate's ending is reported to the agent that started it, which
    // carries on; the notice worth having is that one finishing. Its approvals
    // still push: only the user can answer those.
    if (ended && meta.delegation) return
    if (ended && listed(meta)) {
      this.markUnseen(ev.chatId, ended === 'failed', clip(body, 160))
    }
    const s = this.settings()
    const targets = s.devices.filter((d) => d.push && !this.looking(d.id, ev.chatId))
    if (!targets.length) return
    const keys = this.vapid()
    for (const d of targets) {
      const message: PushMessage = {
        title: clip(meta.title?.trim() || meta.scheduled?.taskName || 'Carbon', 80),
        body: clip(body, 240),
        chatId: ev.chatId,
        tag: ev.chatId,
        // The turn's own status may not have gone idle yet; it is done all the same.
        badge: this.badgeFor(d, ended ? ev.chatId : null)
      }
      void sendPush(d.push!, message, keys, { subject: PUSH_SUBJECT })
        .then((r) => {
          if (r.gone) this.dropSubscription(d.id, d.push!.endpoint)
          else if (r.status >= 400) console.warn(`[remote] push to ${d.name} answered ${r.status}`)
        })
        .catch((err) => console.warn(`[remote] push to ${d.name} failed:`, err))
    }
  }

  /**
   * A turn ended on a chat a device was not looking at: it is listed as Done
   * on that phone's home screen until the phone opens it. Every paired device,
   * notifications or not — a phone without them still wants to know on opening
   * the app. Written straight to the store rather than through `save`, which
   * would redraw Settings at every turn's end.
   */
  private markUnseen(chatId: string, failed: boolean, text: string): void {
    const s = this.settings()
    const at = Date.now()
    const touched = s.devices.filter((d) => !this.looking(d.id, chatId))
    if (!touched.length) return
    const mark: RemoteUnseen = failed ? { at, failed, text } : { at, text }
    for (const d of touched) d.unseen = { ...d.unseen, [chatId]: mark }
    this.host.store.setRemote(s)
    for (const d of touched) this.sendUnseen(d.id)
  }

  /** `chatIds` null: all of them (the home screen's Clear). */
  private clearUnseen(deviceId: string, chatIds: string[] | null): void {
    const s = this.settings()
    const d = s.devices.find((x) => x.id === deviceId)
    if (!d?.unseen) return
    const drop = chatIds ?? Object.keys(d.unseen)
    if (!drop.some((id) => id in d.unseen!)) return
    const next = { ...d.unseen }
    for (const id of drop) delete next[id]
    d.unseen = next
    this.host.store.setRemote(s)
    this.sendUnseen(deviceId)
  }

  /** The device's marks, whole, to each of its open streams. */
  private sendUnseen(deviceId: string): void {
    let data: string | null = null
    for (const c of this.clients.values()) {
      if (c.deviceId !== deviceId) continue
      data ??= `event: unseen\ndata: ${JSON.stringify(this.settings().devices.find((d) => d.id === deviceId)?.unseen ?? {})}\n\n`
      c.res.write(data)
    }
  }

  /**
   * The phone's own count, made here: chats waiting on an answer, plus chats
   * marked unseen that are not working again. `finished` has just ended,
   * whatever its status says yet.
   */
  private badgeFor(device: RemoteSettings['devices'][number], finished: string | null): number {
    let n = 0
    for (const c of this.host.store.listChats()) {
      if (!listed(c)) continue
      if (this.permissions.get(c.id)?.length) n++
      else if (device.unseen?.[c.id] && (c.id === finished || (this.statuses.get(c.id) ?? 'idle') === 'idle')) n++
    }
    return n
  }

  /** The device has that chat open on screen right now. */
  private looking(deviceId: string, chatId: string): boolean {
    for (const c of this.clients.values()) {
      if (c.deviceId === deviceId && c.visible && c.watch === chatId) return true
    }
    return false
  }

  /** The push service forgot the subscription (the app was deleted, or iOS revoked it). */
  private dropSubscription(deviceId: string, endpoint: string): void {
    const s = this.settings()
    this.save({
      ...s,
      devices: s.devices.map((d) => (d.id === deviceId && d.push?.endpoint === endpoint ? { ...d, push: undefined } : d))
    })
  }

  /**
   * A file the phone attached, written to the Mac so the agent can read it by
   * path, the way a file dropped on the desktop composer is attached. The body
   * is the file's bytes and `x-file-name` its name. Each upload gets a folder
   * of its own, so two files of one name never collide and the name the agent
   * sees is the one the user picked.
   */
  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = decodeURIComponent(String(req.headers['x-file-name'] ?? ''))
    // Only the last segment, and never a dotfile or `..`: the name picks a file
    // inside this upload's folder, nothing else.
    const name = basename(raw).replace(/^\.+/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'file'
    const body = await readBody(req).catch(() => null)
    if (!body) {
      json(res, 413, { error: `${name} is over ${MAX_BODY / 1024 / 1024} MB.` })
      return
    }
    const dir = join(this.host.uploadDir, randomUUID())
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    await writeFile(path, body)
    json(res, 200, { path, name })
  }

  /** Uploads past `UPLOAD_TTL_MS`. Run at start; a missing folder is nothing to prune. */
  private async pruneUploads(): Promise<void> {
    const root = this.host.uploadDir
    const now = Date.now()
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, entry)
      const info = await stat(dir).catch(() => null)
      if (info && now - info.mtimeMs > UPLOAD_TTL_MS) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
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

let bonjour: string | null | undefined

/**
 * The name this Mac answers to on the local network — `scutil`'s
 * LocalHostName, which is what `<name>.local` resolves over Bonjour. A Home
 * Screen app saved at the LAN IP stops working the day the router hands the Mac
 * another one; saved at this name, it follows the Mac. `os.hostname()` is not
 * the same thing: it can be whatever name DHCP assigned (`MacBook-Pro.lan`).
 */
function bonjourName(): string | null {
  if (bonjour !== undefined) return bonjour
  bonjour = null
  if (process.platform !== 'darwin') return bonjour
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
    if (/^[A-Za-z0-9-]+$/.test(name)) bonjour = `${name}.local`
  } catch {
    // No name set: the raw addresses still answer.
  }
  return bonjour
}

function encrypted(req: IncomingMessage): boolean {
  return !!(req.socket as TLSSocket).encrypted
}

function cookieFor(credential: string, secure: boolean): string {
  // `Secure` only over HTTPS: the plain addresses are made private by
  // Tailscale's WireGuard tunnel (or are the LAN opt-in), not by TLS, and a
  // `Secure` cookie would never be sent back on them. A year, because
  // re-pairing a phone is the user's chore and unpairing it is one button in
  // Settings.
  return `${COOKIE}=${encodeURIComponent(credential)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`
}

/** A row the phone lists — its `listedChats`, so the badge counts what it shows. */
function listed(c: ChatMeta): boolean {
  return !c.ephemeral && !c.sideOf && !c.archivedAt && c.surface !== 'terminal'
}

/** One line of at most `max` characters, cut on a word. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))}…`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req)
  try {
    return body.length ? JSON.parse(body.toString('utf8')) : {}
  } catch {
    return {}
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

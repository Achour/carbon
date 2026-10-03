import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type {
  PreviewCommand,
  PreviewCommandResult,
  PreviewEmulation,
  PreviewEvent,
  PreviewState
} from '@shared/types'
import { describeViewport } from '../shared/previewDevices.ts'
import { killTree } from './pty'
import {
  startCarbonBridge,
  type CarbonBridgeHandle,
  type CarbonMcpSession
} from './carbonBridge.ts'
import type { CarbonToolContext, CarbonToolHosts } from './carbonMcp.ts'
import type { CanvasToolHost } from './canvasTools.ts'
import { PreviewDriver } from './previewDriver.ts'
import { cwdBelongsTo, descendsFrom, probeHttp, processParents, scanLocalServers } from './localServers.ts'
import { viewportPatch, type PreviewPageOp, type PreviewToolHost, type PreviewToolInput } from './previewTools.ts'
import { detectDevPlan, planLabel } from './devServerPlan.ts'

const nodeRequire = createRequire(import.meta.url)
const pty = nodeRequire('node-pty') as typeof import('node-pty')

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

// A local dev-server URL as printed by Vite/Next/CRA/etc.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s]*)?)/i

/**
 * A dev-server line worth an agent's attention. "error" alone matched the
 * all-clear (`0 errors`, `no errors found`), which is most of what a healthy
 * server prints about errors.
 */
const SERVER_ERROR_RE = /\b(error|errors|failed|exception|cannot|unexpected|uncaught|ENOENT|EADDRINUSE)\b/i
const SERVER_ALL_CLEAR_RE = /\b(0|no|zero)\s+(errors?|warnings?|problems?)\b|without errors/i

const LOG_CAP = 400

/** How long a spawned server may stay quiet about its URL before the port table is asked. */
const URL_FALLBACK_AFTER_MS = 4000
const URL_FALLBACK_EVERY_MS = 1500
const URL_FALLBACK_FOR_MS = 120_000

/** Page operations that act on the page, and so must act on the page they were asked about. */
const ACTING_OPS = new Set<PreviewPageOp>(['click', 'type', 'press', 'evaluate'])

type Emit = (ev: PreviewEvent) => void
type SendCommand = (cmd: Omit<PreviewCommand, 'id'>) => Promise<PreviewCommandResult>

interface Server {
  /** Distinct per process Carbon started, so a reader's cursor belongs to one. */
  id: number
  proc: IPty | null
  state: PreviewState
  log: string[]
  /** Chunks ever appended to `log`, so a reader's cursor survives the ring. */
  written: number
  urlFound: boolean
  /** Bounded tail of stripped output, scanned for the local URL until found. */
  sniff: string
  waiters: Array<(s: PreviewState) => void>
  fallback?: ReturnType<typeof setInterval>
  /** An adopted server's address, as the scan reached it — what its liveness check probes. */
  probeHost?: string
}

// How much recent stripped output to retain for URL sniffing. Big enough to
// catch a URL split across chunks, small enough to keep the scan O(1) per chunk.
const SNIFF_CAP = 8192

/**
 * Owns one dev-server process per project folder: starts it, finds its URL,
 * and buffers its logs. Everything that happens inside the page goes through
 * `driver` (CDP in main); the renderer is asked only for what it owns — which
 * pane is a project's, its tab and its pixels — via `send`.
 */
export class PreviewManager implements PreviewToolHost {
  private servers = new Map<string, Server>()
  /** In-flight starts, so a click and an agent call landing together start one server. */
  private starting = new Map<string, Promise<PreviewState>>()
  /**
   * Bumped by every stop, so a start still awaiting its port scan — or a
   * fallback scan still awaiting `lsof` — finds the project stopped under it
   * and gives up instead of spawning or publishing a URL afterwards.
   */
  private generation = new Map<string, number>()
  private disposed = false
  private gen(cwd: string): number {
    return this.generation.get(cwd) ?? 0
  }
  private bump(cwd: string): void {
    this.generation.set(cwd, this.gen(cwd) + 1)
  }
  /** Per caller, per project: how many dev-server chunks its console reads have seen. */
  private serverCursors = new Map<string, number>()
  readonly driver = new PreviewDriver()
  /**
   * Carbon's MCP server on loopback. Codex and Grok connect to it directly —
   * neither can load an in-process server the way Claude's SDK can, and both
   * speak streamable HTTP, which is what removed the two relay children a
   * session used to spawn.
   */
  private readonly mcp: Promise<CarbonBridgeHandle | null>

  constructor(
    private emit: Emit,
    private send: SendCommand,
    /**
     * The canvas tools ride the same bridge and the same `carbon` server. They
     * are passed in rather than owned because the bridge is the shared thing —
     * one port, one token, one tool table — and it is started here.
     */
    canvas?: CanvasToolHost
  ) {
    this.mcp = startCarbonBridge(this, canvas, () => this.agents).catch((err) => {
      console.warn('[preview] MCP bridge failed to start:', err)
      return null
    })
  }

  /** The delegation host — `ChatManager`, which is built after this. */
  private agents: CarbonToolHosts['agents']

  setAgentsHost(host: CarbonToolHosts['agents']): void {
    this.agents = host
  }

  agentsHost(): CarbonToolHosts['agents'] {
    return this.agents
  }

  /**
   * Register one provider session and get the endpoint its CLI connects to,
   * plus the two config shapes that name it. Once per session — the context is
   * held by reference, so a plan-mode change needs no new registration — and
   * `dispose()` belongs to whoever registered it.
   */
  async mcpSession(ctx: CarbonToolContext): Promise<CarbonMcpSession | null> {
    const bridge = await this.mcp
    if (!bridge || !ctx.cwd) return null
    return bridge.register(ctx)
  }

  /** The dev command inferred for a project, or null if there isn't one. */
  detect(cwd: string): string | null {
    const plan = detectDevPlan(cwd)
    return plan ? planLabel(plan, cwd) : null
  }

  state(cwd: string): PreviewState {
    return this.servers.get(cwd)?.state ?? { cwd, status: 'stopped' }
  }

  logs(cwd: string): string {
    // Contract (Api.previewLogs) is ANSI-stripped output.
    return stripAnsi(this.servers.get(cwd)?.log.join('') ?? '')
  }

  /**
   * Error-looking dev-server lines `caller` has not seen yet (or the recent
   * ones, with `all`) — compile errors live here, not in the browser.
   */
  private serverErrors(cwd: string, caller: string, all: boolean): string[] {
    const s = this.servers.get(cwd)
    if (!s) return []
    // Per server, too: a restarted server's chunk count starts again at zero,
    // and a cursor carried over would skip its first errors.
    const key = `${caller}\u0000${cwd}\u0000${s.id}`
    const seen = all ? 0 : (this.serverCursors.get(key) ?? 0)
    this.serverCursors.set(key, s.written)
    const fresh = Math.min(s.log.length, s.written - seen)
    if (fresh <= 0) return []
    return stripAnsi(s.log.slice(-fresh).join(''))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && SERVER_ERROR_RE.test(l) && !SERVER_ALL_CLEAR_RE.test(l))
      .slice(-30)
  }

  private setState(cwd: string, patch: Partial<PreviewState>): void {
    const server = this.servers.get(cwd)
    if (!server) return
    server.state = { ...server.state, ...patch }
    this.emit({ type: 'state', state: server.state })
    if (server.state.status === 'running' || server.state.status === 'error' || server.state.status === 'stopped') {
      if (server.fallback && !(server.state.external && server.state.status === 'running')) {
        clearInterval(server.fallback)
        server.fallback = undefined
      }
      const done = server.waiters.splice(0)
      for (const w of done) w(server.state)
    }
  }

  private serverSeq = 0
  private newServer(state: PreviewState, waiters: Server['waiters'] = []): Server {
    return { id: ++this.serverSeq, proc: null, state, log: [], written: 0, urlFound: false, sniff: '', waiters }
  }

  /**
   * A server for this project that is already up — started in the user's own
   * terminal, typically. Matched by the process's working directory, so a
   * worktree beside the checkout does not claim the checkout's server.
   */
  private async findExternal(cwd: string): Promise<{ url: string; label: string; host?: string } | null> {
    const servers = await scanLocalServers({ excludePids: [process.pid] }).catch(() => [])
    const mine = servers.filter((s) => cwdBelongsTo(s.cwd, cwd))
    if (!mine.length) return null
    const s = mine[0]
    return { url: s.url, label: `${s.command} (pid ${s.pid}), started outside Carbon`, host: s.host }
  }

  start(cwd: string, command?: string): Promise<PreviewState> {
    const inflight = this.starting.get(cwd)
    if (inflight) return inflight
    const p = this.startNow(cwd, command).finally(() => {
      if (this.starting.get(cwd) === p) this.starting.delete(cwd)
    })
    this.starting.set(cwd, p)
    return p
  }

  private async startNow(cwd: string, command?: string): Promise<PreviewState> {
    if (this.disposed) return this.state(cwd)
    const generation = this.gen(cwd)
    const current = this.servers.get(cwd)
    if (current && (current.state.status === 'running' || current.state.status === 'starting')) {
      // An adopted server is someone else's process, and it may have been
      // stopped in its terminal since: check before answering for it.
      if (!current.state.external || (await this.alive(current))) return current.state
      this.forgetExternal(cwd, current)
      if (this.gen(cwd) !== generation) return this.state(cwd)
    }
    const existing = this.servers.get(cwd)
    // Starting a second copy of a server the user already runs is a port
    // conflict at best; point the preview at theirs instead.
    if (!command) {
      const external = await this.findExternal(cwd)
      if (this.gen(cwd) !== generation || this.disposed) return this.state(cwd)
      if (external) {
        killTree(existing?.proc ?? null)
        const server = this.newServer(
          { cwd, status: 'running', url: external.url, command: external.label, external: true },
          existing?.waiters
        )
        server.probeHost = external.host
        this.servers.set(cwd, server)
        this.setState(cwd, {})
        this.watchExternal(cwd, server)
        return server.state
      }
    }
    const plan = command ? { command, dir: cwd } : detectDevPlan(cwd)
    if (!plan) {
      const state: PreviewState = {
        cwd,
        status: 'error',
        error: 'No dev server found to run — no dev script in package.json, and no Rails, Django, Phoenix, Jekyll or Hugo project.'
      }
      this.servers.set(cwd, this.newServer(state, existing?.waiters))
      this.setState(cwd, {})
      return state
    }
    // Clear any dead server for this cwd before spawning a fresh one.
    killTree(existing?.proc ?? null)
    const server = this.newServer({ cwd, status: 'starting', command: planLabel(plan, cwd) }, existing?.waiters)
    this.servers.set(cwd, server)
    this.emit({ type: 'state', state: server.state })

    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const proc = pty.spawn(shell, ['-lc', plan.command], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: existsSync(plan.dir) ? plan.dir : homedir(),
        // BROWSER=none stops CRA/others from opening the system browser; we
        // load the URL in the embedded preview instead.
        env: { ...process.env, TERM: 'xterm-256color', BROWSER: 'none', FORCE_COLOR: '1' } as Record<
          string,
          string
        >
      })
      server.proc = proc
      proc.onData((data) => {
        server.log.push(data)
        server.written++
        if (server.log.length > LOG_CAP) server.log.splice(0, server.log.length - LOG_CAP)
        if (!server.urlFound) {
          // Scan a bounded rolling tail of stripped output — enough to catch a
          // URL split across chunks (pty output isn't line-aligned) without
          // re-joining/re-scanning the whole log on every chunk.
          server.sniff = (server.sniff + stripAnsi(data)).slice(-SNIFF_CAP)
          const m = URL_RE.exec(server.sniff)
          if (m) {
            const url = m[1]
              // Trailing wrappers/punctuation the greedy path class can swallow
              // (e.g. a URL printed inside parens or followed by a period).
              .replace(/[)\]},.;'"]+$/, '')
              .replace(/\/\/(0\.0\.0\.0|\[::1?\])/, '//localhost')
              .replace(/\/$/, '')
            this.foundUrl(cwd, server, url)
          }
        }
      })
      proc.onExit(({ exitCode }) => {
        if (this.servers.get(cwd)?.proc !== proc) return
        // A clean stop() already set 'stopped'; a crash before/without a URL is
        // an error, otherwise the server simply ended.
        const cur = server.state.status
        if (cur !== 'stopped') {
          this.setState(cwd, {
            status: exitCode === 0 ? 'stopped' : 'error',
            error: exitCode === 0 ? undefined : `Dev server exited (code ${exitCode})`
          })
        }
        server.proc = null
        // URL discovery is over; free its scratch buffer. `log` is kept — the
        // logs drawer polls previewLogs after a server exits (a crash's error
        // output lives there) — and is already bounded + replaced wholesale on
        // the next start() for this cwd.
        server.sniff = ''
        if (server.fallback) clearInterval(server.fallback)
        server.fallback = undefined
      })
      this.armUrlFallback(cwd, server, proc.pid, plan.dir)
    } catch (err) {
      this.setState(cwd, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return server.state
  }

  /** Whether an adopted server still answers, on the address it was found on. */
  private async alive(server: Server): Promise<boolean> {
    const url = server.state.url ? new URL(server.state.url) : null
    // `new URL('http://localhost:80').port` is "" — the protocol's default.
    const port = url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : NaN
    return Number.isFinite(port) && (await probeHttp(port, server.probeHost)) !== null
  }

  private forgetExternal(cwd: string, server: Server): void {
    if (server.fallback) clearInterval(server.fallback)
    server.fallback = undefined
    if (this.servers.get(cwd) === server) {
      this.setState(cwd, { status: 'stopped', url: undefined, external: undefined, command: undefined, error: undefined })
    }
  }

  /**
   * An adopted server can stop at any time, in a terminal Carbon never sees;
   * without a check it would read "running" for good and the toolbar would
   * have nothing to restart. Polled gently while it is the project's server.
   */
  private watchExternal(cwd: string, server: Server): void {
    server.fallback = setInterval(() => {
      if (this.servers.get(cwd) !== server) {
        if (server.fallback) clearInterval(server.fallback)
        return
      }
      void this.alive(server).then((ok) => {
        if (!ok) this.forgetExternal(cwd, server)
      })
    }, 10_000)
  }

  private foundUrl(cwd: string, server: Server, url: string): void {
    // `!server.proc`: a stop landed while a fallback scan was in flight.
    if (server.urlFound || this.servers.get(cwd) !== server || !server.proc) return
    server.urlFound = true
    server.sniff = ''
    this.setState(cwd, { status: 'running', url })
  }

  /**
   * A server that never prints a localhost URL — a custom Express app, Rails,
   * `ready on port 3000` — used to leave the preview "starting" for good. After
   * a short wait the port table is asked instead: a listener in the spawned
   * process's tree wins, then one running in the project's folder.
   */
  private armUrlFallback(cwd: string, server: Server, rootPid: number, dir: string): void {
    const started = Date.now()
    const check = async (): Promise<void> => {
      if (server.urlFound || this.servers.get(cwd) !== server || !server.proc) return
      if (Date.now() - started > URL_FALLBACK_FOR_MS) {
        if (server.fallback) clearInterval(server.fallback)
        server.fallback = undefined
        return
      }
      const [found, parents] = await Promise.all([
        scanLocalServers({ fresh: true, excludePids: [process.pid] }).catch(() => []),
        processParents().catch(() => new Map<number, number>())
      ])
      if (server.urlFound || this.servers.get(cwd) !== server || !server.proc) return
      const pick =
        found.find((s) => descendsFrom(s.pid, rootPid, parents)) ?? found.find((s) => cwdBelongsTo(s.cwd, dir))
      if (pick) this.foundUrl(cwd, server, pick.url)
    }
    setTimeout(() => {
      if (server.urlFound || this.servers.get(cwd) !== server || !server.proc) return
      void check()
      server.fallback = setInterval(() => void check(), URL_FALLBACK_EVERY_MS)
    }, URL_FALLBACK_AFTER_MS)
  }

  /** Starts (if needed) and resolves once the URL is up or it fails/times out. */
  async startAndWait(cwd: string, timeoutMs = 25_000): Promise<PreviewState> {
    const state = await this.start(cwd)
    if (state.status === 'running' || state.status === 'error') return state
    const server = this.servers.get(cwd)
    if (!server) return state
    if (server.state.status === 'running' || server.state.status === 'error') return server.state
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = server.waiters.indexOf(onDone)
        if (i !== -1) server.waiters.splice(i, 1)
        resolve(server.state)
      }, timeoutMs)
      const onDone = (s: PreviewState): void => {
        clearTimeout(timer)
        resolve(s)
      }
      server.waiters.push(onDone)
    })
  }

  stop(cwd: string): PreviewState {
    this.bump(cwd)
    const server = this.servers.get(cwd)
    if (!server) return { cwd, status: 'stopped' }
    if (server.state.external) {
      // Not Carbon's to kill: it belongs to whatever terminal started it.
      return {
        ...server.state,
        error: 'This server was started outside Carbon, so Carbon will not stop it. Stop it where it was started.'
      }
    }
    killTree(server.proc)
    server.proc = null
    server.sniff = ''
    this.setState(cwd, { status: 'stopped', error: undefined })
    return server.state
  }

  /** Stops every server running in `dir` or below it — a worktree being removed. */
  stopUnder(dir: string): void {
    // In-flight starts too: one still scanning would otherwise spawn into the
    // directory being removed.
    for (const cwd of new Set([...this.servers.keys(), ...this.starting.keys()])) {
      if (!cwdBelongsTo(cwd, dir)) continue
      const server = this.servers.get(cwd)
      if (server?.state.external) {
        this.bump(cwd)
        this.forgetExternal(cwd, server)
      } else this.stop(cwd)
    }
  }

  // ---- The page ----

  /**
   * This project's preview pane, attached in main. `open` lets the renderer
   * open one at the dev server's URL when the project has none — what every
   * acting or reading tool wants; the console read alone does not open one.
   */
  private async target(
    cwd: string,
    open: boolean
  ): Promise<{ paneId: string; guest: NonNullable<ReturnType<PreviewDriver['guest']>> } | { error: string }> {
    const url = open ? this.state(cwd).url : undefined
    const res = await this.send({ cwd, kind: 'ensure', url })
    if (!res.ok || !res.paneId) {
      return {
        error:
          res.error && res.error !== 'No preview open'
            ? res.error
            : 'No preview is open for this project. Start the dev server with preview_start, or open a URL with preview_navigate.'
      }
    }
    // The attach IPC resolves before `ensure` answers, so this is normally
    // immediate; the wait covers a guest that was replaced in between.
    for (let i = 0; i < 20; i++) {
      const guest = this.driver.guest(res.paneId)
      if (guest) {
        this.lastPane.set(cwd, res.paneId)
        return { paneId: res.paneId, guest }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return { error: 'The preview did not finish loading. Try again in a moment.' }
  }

  async status(cwd: string): Promise<string> {
    const state = this.state(cwd)
    const lines = [JSON.stringify(state)]
    const shown = this.driver.guestsFor(cwd)[0]
    if (shown) lines.push(`The preview is showing ${shown.wc.getURL()}.`)
    else lines.push('No preview is open for this project.')
    const others = (await scanLocalServers({ excludePids: [process.pid] }).catch(() => [])).filter(
      (s) => cwdBelongsTo(s.cwd, cwd) && s.url !== state.url
    )
    if (others.length) {
      lines.push(
        `Other servers running in this project: ${others.map((s) => `${s.url} (${s.command}, pid ${s.pid}${s.title ? `, "${s.title}"` : ''})`).join('; ')}`
      )
    }
    return lines.join('\n')
  }

  /**
   * One preview command per project at a time. Two calls landing together —
   * parallel tool calls, or two chats on one project — used to interleave
   * inside the page: two `type`s focused A, focused B, then typed both values
   * into B. Each waits for the one before it, failed or not.
   */
  private lanes = new Map<string, Promise<unknown>>()
  /** The pane each project's last operation ran on, for admitting queued actions. */
  private lastPane = new Map<string, string>()
  private serial<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lanes.get(cwd) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    // The lane is held until the page has actually finished, not only until
    // the caller stopped waiting: a timed-out script still running would
    // otherwise mutate the page under the next operation.
    const settled = next.catch(() => {}).then(() => this.driver.quiesce(cwd))
    this.lanes.set(cwd, settled)
    void settled.then(() => {
      if (this.lanes.get(cwd) === settled) this.lanes.delete(cwd)
    })
    return next
  }

  screenshot(cwd: string, opts: { fullPage?: boolean }): Promise<string | { error: string }> {
    return this.serial(cwd, () => this.screenshotNow(cwd, opts))
  }

  private async screenshotNow(cwd: string, opts: { fullPage?: boolean }): Promise<string | { error: string }> {
    const t = await this.target(cwd, true)
    if ('error' in t) return t
    if (!opts.fullPage) {
      const res = await this.send({ cwd, kind: 'screenshot', paneId: t.paneId })
      return res.ok && res.data ? res.data : { error: res.error ?? 'Capture failed.' }
    }
    await this.send({ cwd, kind: 'reveal', paneId: t.paneId })
    try {
      const data = await this.driver.captureFullPage(t.guest)
      return data ?? { error: 'The full-page capture failed; try a viewport screenshot.' }
    } finally {
      await this.send({ cwd, kind: 'conceal', paneId: t.paneId })
    }
  }

  page(cwd: string, caller: string, op: PreviewPageOp, input: PreviewToolInput): Promise<string> {
    // What the page was when the call arrived — if it has to wait behind
    // another operation. An action that acts on the page (click, type, press,
    // evaluate) and finds, when its turn comes, a different pane or a page
    // navigated since, refuses rather than landing on what replaced it.
    const queued = this.lanes.has(cwd)
    const pane = queued ? this.lastPane.get(cwd) : undefined
    const guest = pane ? this.driver.guest(pane) : undefined
    const admitted = guest ? { pane: pane!, wc: guest.wc.id, doc: guest.docGen } : undefined
    return this.serial(cwd, async () => {
      // Queued with nothing yet to bind it to — the preview was still being
      // opened by the call ahead of it — an acting call has no page it was
      // asked about, so it does not guess one.
      if (ACTING_OPS.has(op) && queued && !admitted) {
        return 'Not done: the preview was still opening when this action arrived. Take a preview_snapshot and try again.'
      }
      try {
        return await this.pageOp(cwd, caller, op, input, ACTING_OPS.has(op) ? admitted : undefined)
      } catch (err) {
        return `Preview error: ${err instanceof Error ? err.message : String(err)}`
      }
    })
  }

  private async pageOp(
    cwd: string,
    caller: string,
    op: PreviewPageOp,
    input: PreviewToolInput,
    admitted?: { pane: string; wc: number; doc: number }
  ): Promise<string> {
    if (op === 'console') {
      const t = await this.target(cwd, false)
      const browser = 'error' in t ? '' : this.driver.console(t.guest, caller, input.all === true)
      const server = this.serverErrors(cwd, caller, input.all === true)
      const parts: string[] = []
      if (browser) parts.push(`Browser console:\n${browser}`)
      if (server.length) parts.push(`Dev server:\n${server.join('\n')}`)
      if (parts.length) return parts.join('\n\n')
      if ('error' in t) return `${t.error}\nNo dev-server errors either.`
      return input.all ? 'No console output captured yet.' : 'Nothing new in the console since your last read.'
    }
    if (op === 'navigate' && !input.action) {
      const url = input.url?.trim() ?? ''
      // Only browsing schemes. A `javascript:` URL is a script run in the
      // current page — past `evaluate`'s loopback rule and plan mode's deny.
      if (!/^(https?:\/\/|file:\/\/)/i.test(url) && url !== 'about:blank') {
        return 'preview_navigate takes an http(s) or file URL (or about:blank).'
      }
      const before = await this.target(cwd, false)
      const mark = 'error' in before ? 0 : before.guest.log.mark()
      const res = await this.send({ cwd, kind: 'navigate', url })
      if (!res.ok || !res.paneId) return `Failed to navigate: ${res.error ?? 'unknown'}`
      const guest = this.driver.guest(res.paneId)
      if (!guest) return `Navigating to ${url}.`
      return this.driver.afterNavigate(guest, 'error' in before || before.guest !== guest ? 0 : mark)
    }
    const t = await this.target(cwd, op !== 'network')
    if ('error' in t) return t.error
    const g = t.guest
    if (admitted && (admitted.pane !== t.paneId || admitted.wc !== g.wc.id || admitted.doc !== g.docGen)) {
      return 'Not done: the preview changed page or tab while this action was waiting behind another one. Take a new preview_snapshot and try again.'
    }
    // And again at the moment of input, inside the driver: the page can
    // still move between here and there.
    const doc = g.docGen
    switch (op) {
      case 'navigate':
        return this.driver.history(g, input.action as 'back' | 'forward' | 'reload')
      case 'snapshot':
        return this.driver.snapshot(g, caller)
      case 'click':
        return this.driver.click(g, input, doc)
      case 'type':
      case 'press':
        await this.send({ cwd, kind: 'focus', paneId: t.paneId })
        try {
          return op === 'type' ? await this.driver.type(g, input, doc) : await this.driver.press(g, input, doc)
        } finally {
          await this.send({ cwd, kind: 'unfocus', paneId: t.paneId })
        }
      case 'scroll':
        return this.driver.scroll(g, input)
      case 'wait_for':
        return this.driver.waitFor(g, input)
      case 'evaluate':
        return this.driver.evaluateTool(g, input, doc)
      case 'network':
        return this.driver.network(g, caller, input)
      case 'resize': {
        const patch = viewportPatch(input)
        if ('error' in patch) return patch.error
        const res = await this.send({ cwd, kind: 'viewport', paneId: t.paneId, viewport: patch })
        if (!res.ok) return `Could not resize: ${res.error ?? 'unknown'}`
        await new Promise((r) => setTimeout(r, 300))
        return `Viewport: ${describeViewport({ device: 'fill', ...res.viewport })}. ${await this.driver.viewportInfo(g)}`
      }
    }
    return `Unknown preview operation: ${op}`
  }

  // ---- Renderer → main ----

  guestAttach(paneId: string, cwd: string, webContentsId: number): boolean {
    return this.driver.attach(paneId, cwd, webContentsId)
  }

  guestDetach(paneId: string): void {
    this.driver.detach(paneId)
  }

  emulate(paneId: string, emulation: PreviewEmulation): Promise<void> {
    return this.driver.emulate(paneId, emulation)
  }

  disposeAll(): void {
    // A start still awaiting its scan must not spawn after this.
    this.disposed = true
    for (const cwd of new Set([...this.servers.keys(), ...this.starting.keys()])) this.bump(cwd)
    void this.mcp.then((bridge) => bridge?.close())
    for (const s of this.servers.values()) {
      if (s.fallback) clearInterval(s.fallback)
      if (!s.state.external) killTree(s.proc)
    }
    this.servers.clear()
    this.driver.disposeAll()
  }
}

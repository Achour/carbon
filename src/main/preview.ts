import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import type { PreviewCommand, PreviewCommandResult, PreviewEvent, PreviewState } from '@shared/types'
import { killTree } from './pty'
import { startPreviewBridge, type PreviewBridgeHandle } from './previewBridge.ts'
import { carbonPreviewMcpServers, type StdioMcpServer } from './previewMcpConfig.ts'

const nodeRequire = createRequire(import.meta.url)
const pty = nodeRequire('node-pty') as typeof import('node-pty')

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

// A local dev-server URL as printed by Vite/Next/CRA/etc.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?)/i

const SCRIPT_PREFERENCE = ['dev', 'start', 'develop', 'serve', 'preview']
const LOG_CAP = 400
const CONSOLE_CAP = 120

type Emit = (ev: PreviewEvent) => void
type SendCommand = (cmd: Omit<PreviewCommand, 'id'>) => Promise<PreviewCommandResult>

interface Server {
  proc: IPty | null
  state: PreviewState
  log: string[]
  consoleLines: string[]
  urlFound: boolean
  /** Bounded tail of stripped output, scanned for the local URL until found. */
  sniff: string
  waiters: Array<(s: PreviewState) => void>
}

// How much recent stripped output to retain for URL sniffing. Big enough to
// catch a URL split across chunks, small enough to keep the scan O(1) per chunk.
const SNIFF_CAP = 8192

/** Picks the package manager from lockfiles, defaulting to npm. */
function detectRunner(cwd: string): (script: string) => string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return (s) => `pnpm ${s}`
  if (existsSync(join(cwd, 'yarn.lock'))) return (s) => `yarn ${s}`
  if (existsSync(join(cwd, 'bun.lockb'))) return (s) => `bun run ${s}`
  return (s) => `npm run ${s}`
}

/**
 * Owns one dev-server process per project folder: starts it, sniffs its output
 * for the local URL, and buffers logs + guest console for agent read-back.
 * Screenshot/navigate are delegated to the renderer via `send`.
 */
export class PreviewManager {
  private servers = new Map<string, Server>()
  /** Loopback MCP front; Grok cannot take an in-process server. */
  private readonly mcp: Promise<PreviewBridgeHandle | null>

  constructor(
    private emit: Emit,
    private send: SendCommand
  ) {
    this.mcp = startPreviewBridge(this).catch((err) => {
      console.warn('[preview] MCP bridge failed to start:', err)
      return null
    })
  }

  /** ACP `mcpServers` entry that gives this project's preview to Grok. */
  async mcpServers(cwd: string): Promise<StdioMcpServer[]> {
    const bridge = await this.mcp
    if (!bridge || !cwd) return []
    return carbonPreviewMcpServers(cwd, bridge)
  }

  /** The dev command inferred from package.json, or null if there isn't one. */
  detect(cwd: string): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
      const scripts = pkg.scripts ?? {}
      const script = SCRIPT_PREFERENCE.find((s) => scripts[s])
      if (!script) return null
      return detectRunner(cwd)(script)
    } catch {
      return null
    }
  }

  state(cwd: string): PreviewState {
    return this.servers.get(cwd)?.state ?? { cwd, status: 'stopped' }
  }

  logs(cwd: string): string {
    // Contract (Api.previewLogs) is ANSI-stripped output.
    return stripAnsi(this.servers.get(cwd)?.log.join('') ?? '')
  }

  reportConsole(cwd: string, line: string): void {
    const s = this.servers.get(cwd)
    if (!s) return
    s.consoleLines.push(line)
    if (s.consoleLines.length > CONSOLE_CAP) s.consoleLines.splice(0, s.consoleLines.length - CONSOLE_CAP)
  }

  /** Recent guest console lines plus any error-looking dev-server output. */
  recentConsole(cwd: string): string {
    const s = this.servers.get(cwd)
    if (!s) return ''
    const errLines = stripAnsi(s.log.join(''))
      .split('\n')
      .filter((l) => /error|fail|exception|cannot|unexpected|warning/i.test(l))
      .slice(-30)
    const parts: string[] = []
    if (s.consoleLines.length) parts.push('Browser console:\n' + s.consoleLines.slice(-40).join('\n'))
    if (errLines.length) parts.push('Dev server:\n' + errLines.join('\n'))
    return parts.join('\n\n')
  }

  private setState(cwd: string, patch: Partial<PreviewState>): void {
    const server = this.servers.get(cwd)
    if (!server) return
    server.state = { ...server.state, ...patch }
    this.emit({ type: 'state', state: server.state })
    if (server.state.status === 'running' || server.state.status === 'error' || server.state.status === 'stopped') {
      const done = server.waiters.splice(0)
      for (const w of done) w(server.state)
    }
  }

  start(cwd: string, command?: string): PreviewState {
    const existing = this.servers.get(cwd)
    if (existing && (existing.state.status === 'running' || existing.state.status === 'starting')) {
      return existing.state
    }
    const cmd = command || this.detect(cwd)
    if (!cmd) {
      const state: PreviewState = { cwd, status: 'error', error: 'No dev script found in package.json' }
      this.servers.set(cwd, {
        proc: null,
        state,
        log: [],
        consoleLines: [],
        urlFound: false,
        sniff: '',
        waiters: []
      })
      this.emit({ type: 'state', state })
      return state
    }
    // Clear any dead server for this cwd before spawning a fresh one.
    killTree(existing?.proc ?? null)
    const server: Server = {
      proc: null,
      state: { cwd, status: 'starting', command: cmd },
      log: [],
      consoleLines: [],
      urlFound: false,
      sniff: '',
      waiters: existing?.waiters ?? []
    }
    this.servers.set(cwd, server)
    this.emit({ type: 'state', state: server.state })

    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const proc = pty.spawn(shell, ['-lc', cmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: existsSync(cwd) ? cwd : homedir(),
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
        if (server.log.length > LOG_CAP) server.log.splice(0, server.log.length - LOG_CAP)
        if (!server.urlFound) {
          // Scan a bounded rolling tail of stripped output — enough to catch a
          // URL split across chunks (pty output isn't line-aligned) without
          // re-joining/re-scanning the whole log on every chunk.
          server.sniff = (server.sniff + stripAnsi(data)).slice(-SNIFF_CAP)
          const m = URL_RE.exec(server.sniff)
          if (m) {
            server.urlFound = true
            server.sniff = ''
            const url = m[1]
              // Trailing wrappers/punctuation the greedy path class can swallow
              // (e.g. a URL printed inside parens or followed by a period).
              .replace(/[)\]},.;'"]+$/, '')
              .replace('0.0.0.0', 'localhost')
              .replace(/\/$/, '')
            this.setState(cwd, { status: 'running', url })
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
        // URL discovery is over; free its scratch buffer. `log`/`consoleLines`
        // are kept — the logs drawer polls previewLogs after a server exits (a
        // crash's error output lives there) — and are already bounded + replaced
        // wholesale on the next start() for this cwd.
        server.sniff = ''
      })
    } catch (err) {
      this.setState(cwd, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return server.state
  }

  /** Starts (if needed) and resolves once the URL is up or it fails/times out. */
  startAndWait(cwd: string, timeoutMs = 25_000): Promise<PreviewState> {
    const state = this.start(cwd)
    if (state.status === 'running' || state.status === 'error') return Promise.resolve(state)
    const server = this.servers.get(cwd)
    if (!server) return Promise.resolve(state)
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
    const server = this.servers.get(cwd)
    if (!server) return { cwd, status: 'stopped' }
    killTree(server.proc)
    server.proc = null
    server.sniff = ''
    this.setState(cwd, { status: 'stopped', error: undefined })
    return server.state
  }

  navigate(cwd: string, url: string): Promise<PreviewCommandResult> {
    return this.send({ cwd, kind: 'navigate', url })
  }

  /** Captures the live preview page; null if no preview is open / capture fails. */
  async screenshot(cwd: string): Promise<string | null> {
    const url = this.servers.get(cwd)?.state.url
    const res = await this.send({ cwd, kind: 'screenshot', url })
    return res.ok && res.data ? res.data : null
  }

  disposeAll(): void {
    void this.mcp.then((bridge) => bridge?.close())
    for (const s of this.servers.values()) killTree(s.proc)
    this.servers.clear()
  }
}

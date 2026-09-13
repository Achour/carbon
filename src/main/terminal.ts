import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { TerminalAttachResult, TerminalCreateOpts, TerminalEvent } from '@shared/types'
import { spawnEnv } from './parentEnv.ts'
import { killTree } from './pty'
import { TitleScanner } from './termTitle.ts'

// node-pty is a native CommonJS module; load it via require so the externalized
// build resolves the Electron-rebuilt binary at runtime (see `npm run rebuild`).
const nodeRequire = createRequire(import.meta.url)
const pty = nodeRequire('node-pty') as typeof import('node-pty')

/** How often the foreground process of each shell is sampled for `busy`. */
const BUSY_POLL_MS = 1000

/**
 * How much of a persistent session's output is kept for replay. A pane that
 * unmounts and comes back has to be *put back*, and the only record of what was
 * on it is the bytes the pty already wrote — so main keeps them.
 *
 * Generous, because the cost of losing the head is asymmetric: a full-screen TUI
 * repaints itself on the resize that follows every attach, but an inline one
 * (Claude Code's default) draws its transcript once and never again, so a short
 * buffer would silently amputate a conversation the CLI still has. Whole chunks
 * are dropped rather than bytes, so a replay can never begin in the middle of an
 * escape sequence.
 */
const SCROLLBACK_BYTES = 4 * 1024 * 1024

interface Session {
  proc: IPty
  /** Chat that opened the tab, if any — the unit `killForChat` reaps by. */
  chatId?: string
  /** Last foreground process reported, so we only emit on change. */
  busy: string | null
  /** Survives its pane's unmount — see `TerminalCreateOpts.persist`. */
  persist: boolean
  /**
   * Whether a pane is watching. A persistent session with none records its
   * output and emits nothing, so the replay `attach` hands back is the complete,
   * non-overlapping account of what was missed.
   */
  attached: boolean
  /** Replay buffer for `attach`; only kept for persistent sessions. */
  chunks: string[]
  bytes: number
  /** Last grid the pty was told about, so `attach` knows whether to nudge it. */
  cols: number
  rows: number
  /** When the pty last wrote anything — see `whenQuiet`. */
  lastDataAt: number
  /** The window title the running program last set (persistent sessions only). */
  title: string | null
  titles: TitleScanner
}

/** Owns pseudo-terminal sessions, one long-lived shell per id. */
export class TerminalManager {
  private sessions = new Map<string, Session>()
  private poll: NodeJS.Timeout | null = null
  private titleListeners: Array<(id: string, title: string) => void> = []

  constructor(private emit: (ev: TerminalEvent) => void) {}

  /**
   * Called when a persistent session's program sets a new window title —
   * whether or not a pane is attached, so a chat in the background still says
   * when its CLI is working.
   */
  onTitle(listener: (id: string, title: string) => void): void {
    this.titleListeners.push(listener)
  }

  create({ id, cwd, cols, rows, command, chatId, persist = false }: TerminalCreateOpts): void {
    // Replacing an existing session (e.g. "restart") kills the old shell first.
    this.kill(id)
    const shell = process.env.SHELL || '/bin/zsh'
    // A one-shot command (worktree setup) still runs in a pty so its output
    // streams into a normal terminal tab and the user can watch it work.
    const proc = pty.spawn(shell, command ? ['-lc', command] : ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      // Not `process.env`: a Carbon launched from inside a CLI session would
      // otherwise hand every shell that session's markers, and a `claude`
      // started in one runs with its transcript saving turned off. See
      // `parentEnv.ts`.
      env: spawnEnv({ TERM: 'xterm-256color' })
    })
    proc.onData((data) => {
      const live = this.sessions.get(id)
      if (live?.proc === proc) live.lastDataAt = Date.now()
      if (!persist) {
        this.emit({ type: 'data', id, data })
        return
      }
      // Recorded first, then emitted only if someone is watching: a detached
      // session's bytes reach the renderer exactly once, through the replay.
      this.record(id, proc, data)
      if (live?.proc === proc) {
        const title = live.titles.feed(data)
        if (title !== null && title !== live.title) {
          live.title = title
          for (const listener of this.titleListeners) listener(id, title)
        }
      }
      if (this.sessions.get(id)?.attached) this.emit({ type: 'data', id, data })
    })
    proc.onExit(({ exitCode }) => {
      // A replaced session (restart, or React StrictMode's dev remount) can emit
      // its exit late, after its successor is mapped under the same id — ignore
      // it so we don't evict the live shell or surface a stale "exited".
      if (this.sessions.get(id)?.proc !== proc) return
      this.sessions.delete(id)
      this.emit({ type: 'busy', id, command: null })
      this.emit({ type: 'exit', id, exitCode })
      this.syncPoll()
    })
    this.sessions.set(id, {
      proc,
      chatId,
      busy: null,
      persist,
      attached: true,
      chunks: [],
      bytes: 0,
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      lastDataAt: 0,
      title: null,
      titles: new TitleScanner()
    })
    this.syncPoll()
  }

  private record(id: string, proc: IPty, data: string): void {
    const s = this.sessions.get(id)
    // A replaced session (restart) can still see its predecessor's last write.
    if (!s || s.proc !== proc) return
    s.chunks.push(data)
    s.bytes += data.length
    while (s.bytes > SCROLLBACK_BYTES && s.chunks.length > 1) {
      s.bytes -= s.chunks.shift()!.length
    }
  }

  /**
   * Hand a reattaching pane everything the pty has written, and size it to the
   * pane it is landing in. The resize is deliberately part of attaching: it is
   * what makes a full-screen TUI repaint, which is the half of the restore the
   * replay cannot do for a screen the CLI drew and then scrolled over.
   */
  attach(id: string, cols: number, rows: number): TerminalAttachResult {
    const s = this.sessions.get(id)
    if (!s) return { alive: false, data: '' }
    s.attached = true
    // A pane that comes back the same size gets a one-row nudge first: the
    // kernel only raises SIGWINCH when the grid actually changes, and SIGWINCH
    // is the only thing that makes a full-screen TUI paint a screen it has
    // already drawn. The replayed bytes cover the inline case on their own.
    if (s.cols === cols && s.rows === rows) this.resize(id, cols, Math.max(rows - 1, 1))
    this.resize(id, cols, rows)
    return { alive: true, data: s.chunks.join('') }
  }

  /** Let a persistent session run on with nobody watching. */
  detach(id: string): void {
    const s = this.sessions.get(id)
    if (s) s.attached = false
  }

  /** Whether a pty is currently alive under this id. */
  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /** The pty leader's pid — the root of the process tree a terminal chat inspects. */
  pid(id: string): number | null {
    return this.sessions.get(id)?.proc.pid ?? null
  }

  /**
   * What is running in front of the shell, or null when the shell itself is —
   * the same sample the tab activity dot reads.
   */
  foreground(id: string): string | null {
    return this.sessions.get(id)?.busy ?? null
  }

  /**
   * Resolves once the pty has written something and then gone quiet for
   * `quietMs`, or after `maxMs` regardless. A login shell prints its prompt and
   * then waits, so this is "the shell is ready for input" without parsing a
   * prompt nobody can predict the shape of.
   */
  whenQuiet(id: string, quietMs: number, maxMs: number): Promise<void> {
    const started = Date.now()
    return new Promise((resolve) => {
      const tick = (): void => {
        const s = this.sessions.get(id)
        if (!s) return resolve()
        const now = Date.now()
        const settled = s.lastDataAt > 0 && now - s.lastDataAt >= quietMs
        if (settled || now - started >= maxMs) return resolve()
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  /** The grid a live session was last sized to, for a respawn with no pane to ask. */
  size(id: string): { cols: number; rows: number } | null {
    const s = this.sessions.get(id)
    return s ? { cols: s.cols, rows: s.rows } : null
  }

  /**
   * node-pty reports the pty's foreground process name. When it differs from the
   * shell itself something is running in the tab — the signal behind the tab's
   * activity dot, which is what makes a forgotten `npm run dev` visible.
   */
  private sampleBusy(): void {
    const shell = (process.env.SHELL || '/bin/zsh').split('/').pop()
    for (const [id, s] of this.sessions) {
      let name: string | null = null
      try {
        name = s.proc.process || null
      } catch {
        // pty died between iterations — its onExit already reported idle
        continue
      }
      const busy = !name || name === shell ? null : name
      if (busy === s.busy) continue
      s.busy = busy
      this.emit({ type: 'busy', id, command: busy })
    }
  }

  /** Runs the busy poll only while at least one shell is alive. */
  private syncPoll(): void {
    if (this.sessions.size > 0 && !this.poll) {
      this.poll = setInterval(() => this.sampleBusy(), BUSY_POLL_MS)
      this.poll.unref?.()
    } else if (this.sessions.size === 0 && this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)?.proc
    if (!s) return
    try {
      s.write(data)
    } catch {
      // pty exited between its onExit and this write — drop the input
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.cols = Math.max(cols, 1)
    s.rows = Math.max(rows, 1)
    try {
      s.proc.resize(s.cols, s.rows)
    } catch {
      // resize can throw if the process died between the check and the call
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    killTree(s.proc)
    this.syncPoll()
  }

  /**
   * Reaps every shell opened by a chat. Deleting a chat can also remove its
   * worktree, which would leave a dev server running in a directory the user
   * can no longer see or reach — there is no tab left to close it from.
   */
  killForChat(chatId: string): void {
    for (const [id, s] of [...this.sessions]) {
      if (s.chatId === chatId) this.kill(id)
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) killTree(s.proc)
    this.sessions.clear()
    this.syncPoll()
  }
}

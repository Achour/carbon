import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { TerminalCreateOpts, TerminalEvent } from '@shared/types'
import { killTree } from './pty'

// node-pty is a native CommonJS module; load it via require so the externalized
// build resolves the Electron-rebuilt binary at runtime (see `npm run rebuild`).
const nodeRequire = createRequire(import.meta.url)
const pty = nodeRequire('node-pty') as typeof import('node-pty')

/** How often the foreground process of each shell is sampled for `busy`. */
const BUSY_POLL_MS = 1000

interface Session {
  proc: IPty
  /** Chat that opened the tab, if any — the unit `killForChat` reaps by. */
  chatId?: string
  /** Last foreground process reported, so we only emit on change. */
  busy: string | null
}

/** Owns pseudo-terminal sessions, one long-lived shell per id. */
export class TerminalManager {
  private sessions = new Map<string, Session>()
  private poll: NodeJS.Timeout | null = null

  constructor(private emit: (ev: TerminalEvent) => void) {}

  create({ id, cwd, cols, rows, command, chatId }: TerminalCreateOpts): void {
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
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    proc.onData((data) => this.emit({ type: 'data', id, data }))
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
    this.sessions.set(id, { proc, chatId, busy: null })
    this.syncPoll()
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
    const s = this.sessions.get(id)?.proc
    if (!s) return
    try {
      s.resize(Math.max(cols, 1), Math.max(rows, 1))
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

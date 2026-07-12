import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { TerminalCreateOpts, TerminalEvent } from '@shared/types'

// node-pty is a native CommonJS module; load it via require so the externalized
// build resolves the Electron-rebuilt binary at runtime (see `npm run rebuild`).
const nodeRequire = createRequire(import.meta.url)
const pty = nodeRequire('node-pty') as typeof import('node-pty')

/** Owns pseudo-terminal sessions, one long-lived shell per id. */
export class TerminalManager {
  private sessions = new Map<string, IPty>()

  constructor(private emit: (ev: TerminalEvent) => void) {}

  create({ id, cwd, cols, rows }: TerminalCreateOpts): void {
    // Replacing an existing session (e.g. "restart") kills the old shell first.
    this.kill(id)
    const shell = process.env.SHELL || '/bin/zsh'
    const proc = pty.spawn(shell, ['-l'], {
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
      if (this.sessions.get(id) !== proc) return
      this.sessions.delete(id)
      this.emit({ type: 'exit', id, exitCode })
    })
    this.sessions.set(id, proc)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
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
    try {
      s.kill()
    } catch {
      // already gone
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.kill()
      } catch {
        // ignore
      }
    }
    this.sessions.clear()
  }
}

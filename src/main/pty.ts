import type { IPty } from 'node-pty'

/**
 * Kill a pty and its descendants. `npm run dev` (and other wrappers) spawn the
 * real process as a grandchild and don't forward signals, so a plain
 * `proc.kill()` (SIGHUP to the pty leader) can orphan it — leaking the process
 * and holding its port (EADDRINUSE on restart). node-pty puts the child in its
 * own session, so it's a process-group leader; signalling the whole group reaps
 * the grandchildren.
 */
export function killTree(proc: IPty | null): void {
  if (!proc) return
  const pid = proc.pid
  if (typeof pid === 'number' && pid > 1) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // group already gone, or pid isn't a group leader — fall through
    }
  }
  try {
    proc.kill()
  } catch {
    // already gone
  }
}

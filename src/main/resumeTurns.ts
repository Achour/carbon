/**
 * Turns cut off by a restart, resumed on the next launch.
 *
 * A quit — an upgrade's, a crash, ⌘Q — ends every running turn mid-step. The
 * conversation survives (`sessionId`), but the agent sits stopped until
 * someone sends to it. So the chats with a turn running are kept as a record,
 * updated as each turn starts and ends rather than written at quit: a crash
 * or a force-quit never reaches a quit handler, and those are restarts too.
 * A heartbeat says when the record was last true, and a launch more than
 * `RESUME_WINDOW_MS` after it resumes nothing — an agent woken days later on
 * stale work is worse than one left stopped.
 *
 * Dependency-free (the store is passed in as two functions), so `node --test`
 * runs it directly.
 */

export const RESUME_WINDOW_MS = 60 * 60_000
const HEARTBEAT_MS = 60_000

export interface ResumeStore {
  read(key: string): string | null
  write(key: string, value: string): void
}

interface Record_ {
  chats: string[]
  alive: number
}

export class ResumeTurns {
  private readonly running = new Set<string>()
  private frozen = false
  private timer: ReturnType<typeof setInterval> | null = null

  private readonly store: ResumeStore
  private readonly key: string
  private readonly now: () => number

  /** `key` is per build, so a dev launch never resumes what the installed app was running. */
  constructor(store: ResumeStore, key: string, now: () => number = Date.now) {
    this.store = store
    this.key = key
    this.now = now
  }

  /**
   * What the last run left running, if it was alive recently enough — and the
   * record is cleared either way, so a chat is offered once.
   */
  takeLeftover(): string[] {
    let rec: Record_ | null = null
    try {
      rec = JSON.parse(this.store.read(this.key) ?? 'null') as Record_ | null
    } catch {
      rec = null
    }
    this.store.write(this.key, JSON.stringify({ chats: [], alive: this.now() } satisfies Record_))
    if (!rec || !Array.isArray(rec.chats) || typeof rec.alive !== 'number') return []
    if (this.now() - rec.alive > RESUME_WINDOW_MS) return []
    return rec.chats.filter((id) => typeof id === 'string')
  }

  /** A chat's status, from the one place every status passes (`emit`). */
  note(chatId: string, status: string): void {
    if (this.frozen) return
    const busy = status !== 'idle'
    if (busy === this.running.has(chatId)) return
    if (busy) this.running.add(chatId)
    else this.running.delete(chatId)
    this.persist()
  }

  forget(chatId: string): void {
    if (this.frozen || !this.running.delete(chatId)) return
    this.persist()
  }

  /**
   * Quitting: what is running now is what the next launch resumes. Called
   * before the sessions are torn down, because their teardown reports every
   * turn as ended and would erase the record it is meant to leave.
   */
  freeze(): void {
    if (this.frozen) return
    this.persist()
    this.frozen = true
    this.stopHeartbeat()
  }

  private persist(): void {
    this.store.write(this.key, JSON.stringify({ chats: [...this.running], alive: this.now() } satisfies Record_))
    if (this.running.size && !this.timer) {
      this.timer = setInterval(() => this.persist(), HEARTBEAT_MS)
      ;(this.timer as { unref?: () => void }).unref?.()
    } else if (!this.running.size) this.stopHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

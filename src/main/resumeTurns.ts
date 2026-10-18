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
  /** Chats whose turn is live: any status but idle. */
  private readonly busy = new Set<string>()
  /**
   * Chats with background work and no turn: Claude reports idle while a
   * background agent or shell runs, and its notification would have continued
   * the conversation. A restart kills that work as surely as a turn.
   */
  private readonly jobs = new Set<string>()
  /** Left by the last run and not yet resumed or ruled out: kept on record meanwhile. */
  private readonly pending = new Set<string>()
  /** Chats that started a turn in this run, so whatever the last run left is overtaken. */
  private readonly started = new Set<string>()
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
   * What the last run left running, if it was alive recently enough. They stay
   * on record as pending until each is resumed or ruled out (`settle`), so a
   * quit during the few seconds before they are sent loses nothing.
   */
  takeLeftover(): string[] {
    let rec: Record_ | null = null
    try {
      rec = JSON.parse(this.store.read(this.key) ?? 'null') as Record_ | null
    } catch {
      rec = null
    }
    const fresh = !!rec && Array.isArray(rec.chats) && typeof rec.alive === 'number' && this.now() - rec.alive <= RESUME_WINDOW_MS
    const left = fresh ? rec!.chats.filter((id): id is string => typeof id === 'string') : []
    for (const id of left) this.pending.add(id)
    this.persist()
    return left
  }

  /** A chat's status, from the one place every status passes (`emit`). */
  note(chatId: string, status: string): void {
    if (this.frozen) return
    const busy = status !== 'idle'
    if (busy) this.started.add(chatId)
    if (busy === this.busy.has(chatId)) return
    if (busy) this.busy.add(chatId)
    else this.busy.delete(chatId)
    this.persist()
  }

  /** A chat's background jobs, from `emit`'s `background-jobs`. */
  noteJobs(chatId: string, count: number): void {
    if (this.frozen || count > 0 === this.jobs.has(chatId)) return
    if (count > 0) this.jobs.add(chatId)
    else this.jobs.delete(chatId)
    this.persist()
  }

  /**
   * Whether a chat the last run left is still worth resuming: not if a turn has
   * started in it since launch, which the user (or a delegation's delivery)
   * began, and which either is running or has already ended on its own.
   */
  overtaken(chatId: string): boolean {
    return this.started.has(chatId)
  }

  /** A pending chat resumed, or ruled out: off the record unless it is live again. */
  settle(chatId: string): void {
    if (this.frozen || !this.pending.delete(chatId)) return
    this.persist()
  }

  /** Deleted, or its session disposed: nothing of it to resume. */
  forget(chatId: string): void {
    if (this.frozen) return
    const had = this.busy.delete(chatId) || this.jobs.delete(chatId) || this.pending.delete(chatId)
    this.jobs.delete(chatId)
    this.pending.delete(chatId)
    if (had) this.persist()
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
    const chats = [...new Set([...this.busy, ...this.jobs, ...this.pending])]
    this.store.write(this.key, JSON.stringify({ chats, alive: this.now() } satisfies Record_))
    if (chats.length && !this.timer) {
      this.timer = setInterval(() => this.persist(), HEARTBEAT_MS)
      ;(this.timer as { unref?: () => void }).unref?.()
    } else if (!chats.length) this.stopHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

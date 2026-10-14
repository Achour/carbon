import type { ScheduledTask } from '../shared/types.ts'
import { nextRun } from '../shared/schedule.ts'

/**
 * **The clock behind scheduled tasks.** One timer, armed for the soonest due
 * task and never further out than `MAX_WAIT`; each tick re-reads the table,
 * claims what is due and hands it to the host to run.
 *
 * - **The table is read every tick, not cached.** Another instance sharing
 *   `chats.db` (dev beside the installed app) edits and fires tasks too, and a
 *   copy held here would be stale by exactly those changes. A tick is a few
 *   rows of JSON.
 * - **A claim is a compare-and-swap** (`ScheduleStore.claim`) that moves the
 *   due time on to the *following* one. Only the instance whose update landed
 *   fires, so two schedulers never start the same run.
 * - **The following time is computed from now, not from the due time.** A task
 *   overdue by a night of sleep or a weekend with the app quit fires once on
 *   wake — a catch-up — and then resumes its schedule, instead of firing once
 *   per missed slot. That is the whole catch-up policy.
 * - **`MAX_WAIT` bounds what a timer cannot see.** Timers do not advance while
 *   the Mac sleeps, the wall clock can be moved, and a task another instance
 *   created arrives without a word; a minute's ceiling bounds all three, and
 *   `poke` (wake, an edit here) answers the common ones at once.
 *
 * Dependency-free on purpose — no Electron — so `node --test` drives it with
 * a fake store and clock.
 */

export interface SchedulerStore {
  list(): ScheduledTask[]
  get(id: string): ScheduledTask | null
  claim(id: string, due: number, next: number | null): boolean
}

export interface SchedulerHost {
  /** Start a run of `task` that was due at `dueAt`. The claim is already made. */
  fire(task: ScheduledTask, dueAt: number): void
  /** The task list changed under the renderer — a claim moved a next-run time. */
  changed(): void
}

const MAX_WAIT = 60_000
/** Slack past the due time, so a timer that lands a hair early still finds it due. */
const LATE = 25

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private ticking = false
  private store: SchedulerStore
  private host: SchedulerHost
  private clock: () => number

  constructor(store: SchedulerStore, host: SchedulerHost, clock: () => number = () => Date.now()) {
    this.store = store
    this.host = host
    this.clock = clock
  }

  start(): void {
    this.running = true
    this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Look again now — the Mac woke, or a task was created or edited here. */
  poke(): void {
    if (this.running) this.tick()
  }

  /** Claim and fire everything due. Returns the ids fired, for tests. */
  tick(): string[] {
    // A run started from inside the loop can report a change that pokes back
    // in here; the outer pass re-arms once it is done.
    if (this.ticking) return []
    this.ticking = true
    try {
      return this.pass()
    } finally {
      this.ticking = false
      if (this.running) this.arm()
    }
  }

  private pass(): string[] {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const fired: string[] = []
    const now = this.clock()
    for (const task of this.store.list()) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue
      const following = nextRun(task.schedule, now)
      if (!this.store.claim(task.id, task.nextRunAt, following)) continue
      fired.push(task.id)
      // Fired from the row as it is *now*, not the list read above: an edit
      // landing between the two (another instance's, say) is what runs.
      const fresh = this.store.get(task.id) ?? task
      try {
        this.host.fire({ ...fresh, nextRunAt: following }, task.nextRunAt)
      } catch (err) {
        console.error(`Scheduled task ${task.id} could not start:`, err)
      }
    }
    if (fired.length) this.host.changed()
    return fired
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    let soonest: number | null = null
    for (const task of this.store.list()) {
      if (!task.enabled || task.nextRunAt === null) continue
      if (soonest === null || task.nextRunAt < soonest) soonest = task.nextRunAt
    }
    const wait = soonest === null ? MAX_WAIT : Math.min(MAX_WAIT, Math.max(0, soonest - this.clock()) + LATE)
    this.timer = setTimeout(() => this.tick(), wait)
    this.timer.unref?.()
  }
}

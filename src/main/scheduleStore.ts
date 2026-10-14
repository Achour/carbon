import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { knownProvider, type ScheduledTask } from '../shared/types.ts'

/**
 * Additive and unversioned, like `CANVAS_SCHEMA`: an older build sharing this
 * `userData` opens the database and simply never reads the table.
 *
 * `next_run` is a real column rather than a field of `data` because it is the
 * scheduler's **claim**. The dev and packaged builds share this database and
 * both run a scheduler; whichever moves `next_run` off the due time first —
 * `UPDATE … WHERE next_run = <due>`, one statement, so SQLite serializes it —
 * owns that run, and the other's update changes nothing. Without it every task
 * fired twice whenever `npm run dev` was up beside the installed app.
 */
export const SCHEDULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    next_run   INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
`

type Row = { id: string; data: string; next_run: number | null }

/**
 * A row as a task. A provider this build does not have (a branch that added
 * one wrote the row — `userData` is shared) is coerced at the read, as
 * `store.ts` coerces a chat's, so nothing keyed by provider throws on it; and
 * the task is shown **paused** rather than run on Claude, which is not what
 * anyone scheduled. Resuming it on the page saves it as Claude, deliberately.
 */
function parse(row: Row): ScheduledTask | null {
  try {
    const data = JSON.parse(row.data) as Omit<ScheduledTask, 'nextRunAt'>
    const task: ScheduledTask = { ...data, id: row.id, nextRunAt: row.next_run }
    if (!knownProvider(task.provider)) {
      task.provider = 'claude'
      task.model = undefined
      task.effort = undefined
      task.serviceTier = undefined
      task.enabled = false
    }
    return task
  } catch {
    return null
  }
}

export class ScheduleStore {
  private db: DatabaseSync
  private selAll: StatementSync
  private selOne: StatementSync
  private upsert: StatementSync
  private del: StatementSync
  private cas: StatementSync

  /** Told after every write, so the store's rolling backup knows it is due. */
  private onWrite: () => void

  constructor(db: DatabaseSync, onWrite: () => void = () => {}) {
    this.db = db
    this.onWrite = onWrite
    this.db.exec(SCHEDULE_SCHEMA)
    this.selAll = this.db.prepare('SELECT id, data, next_run FROM scheduled_tasks')
    this.selOne = this.db.prepare('SELECT id, data, next_run FROM scheduled_tasks WHERE id = ?')
    this.upsert = this.db.prepare(
      `INSERT INTO scheduled_tasks (id, data, next_run, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, next_run = excluded.next_run, updated_at = excluded.updated_at`
    )
    this.del = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?')
    this.cas = this.db.prepare(
      'UPDATE scheduled_tasks SET next_run = ?, updated_at = ? WHERE id = ? AND next_run = ?'
    )
  }

  /** Every task: the ones that will run, soonest first, then the rest by name. */
  list(): ScheduledTask[] {
    const tasks = (this.selAll.all() as Row[]).map(parse).filter((t): t is ScheduledTask => !!t)
    return tasks.sort((a, b) => {
      if (a.nextRunAt !== null && b.nextRunAt !== null) return a.nextRunAt - b.nextRunAt
      if (a.nextRunAt !== null) return -1
      if (b.nextRunAt !== null) return 1
      return a.name.localeCompare(b.name)
    })
  }

  get(id: string): ScheduledTask | null {
    const row = this.selOne.get(id) as Row | undefined
    return row ? parse(row) : null
  }

  /** Insert or replace a task outright — creation, and tests. */
  put(task: ScheduledTask): ScheduledTask {
    const { nextRunAt, ...data } = task
    this.upsert.run(task.id, JSON.stringify(data), nextRunAt, Date.now())
    this.onWrite()
    return task
  }

  /**
   * Create (`id` null) or update a task, deciding from the row as it is
   * *inside* the write lock. Another instance shares this table, and every
   * read-then-write outside one lost to it some way: an edit resurrecting a
   * task deleted in between, or a stale schedule written beside the next-run
   * time of the one that replaced it.
   *
   * `build` gets the current row and returns the task plus `keepClaim`: true
   * for an edit that leaves *when* alone, which then writes the data and never
   * `next_run` — writing back the value it had read would undo a claim made in
   * the meantime and fire a one-off twice. A changed schedule writes a time
   * computed from now, which no earlier claim can have taken.
   */
  save(
    id: string | null,
    build: (existing: ScheduledTask | null) => { task: ScheduledTask; keepClaim: boolean }
  ): ScheduledTask {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = id ? this.get(id) : null
      if (id && !existing) throw new Error('That scheduled task no longer exists.')
      const { task, keepClaim } = build(existing)
      const { nextRunAt, ...data } = task
      if (existing && keepClaim) {
        this.db
          .prepare('UPDATE scheduled_tasks SET data = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(data), Date.now(), task.id)
      } else if (existing) {
        this.db
          .prepare('UPDATE scheduled_tasks SET data = ?, next_run = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(data), nextRunAt, Date.now(), task.id)
      } else {
        this.upsert.run(task.id, JSON.stringify(data), nextRunAt, Date.now())
      }
      const saved = this.get(task.id) ?? task
      this.db.exec('COMMIT')
      this.onWrite()
      return saved
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Already unwound by the failure itself.
      }
      throw err
    }
  }

  /**
   * Set a few fields inside a task's data, in one statement — never a read,
   * merge and write, which would put back whatever another instance edited
   * in between. Leaves `next_run` (the claim) alone.
   */
  patch(id: string, patch: { lastRunAt?: number; lastChatId?: string }): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
    if (!entries.length) return
    const paths = entries.map(([k]) => `'$.${k}', ?`).join(', ')
    this.db
      .prepare(`UPDATE scheduled_tasks SET data = json_set(data, ${paths}), updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number), Date.now(), id)
    this.onWrite()
  }

  delete(id: string): void {
    this.del.run(id)
    this.onWrite()
  }

  /**
   * Move `next_run` from `due` to `next` — true only for the one caller that
   * did. Every instance sharing the database may try; the rest find the row
   * already moved and fire nothing.
   */
  claim(id: string, due: number, next: number | null): boolean {
    const claimed = Number(this.cas.run(next, Date.now(), id, due).changes) === 1
    if (claimed) this.onWrite()
    return claimed
  }
}

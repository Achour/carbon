/**
 * Claude Code's task list, reconstructed from its `Task*` tool calls.
 *
 * The checklist used to arrive as `TodoWrite`, where one call carried the whole
 * list and the card was just a render of `input.todos`. Claude Code replaced it
 * with an incremental API — `TaskCreate` one at a time, `TaskUpdate` to flip a
 * status — so there is no longer any single call that holds the list. It has to
 * be folded out of the calls, which is what this module does. (Codex still
 * emits `TodoWrite`; that path is untouched.)
 *
 * Two things make the fold less obvious than it looks, both measured against
 * the real corpus rather than assumed:
 *
 * - **The id only exists in the output.** `TaskCreate`'s *input* has no id —
 *   the id comes back in its result ("Task #3 created successfully: …"), and
 *   that is the only thing a later `TaskUpdate` can be matched against.
 * - **It is never message-local.** Of 366 real `TaskUpdate` calls, *none* had
 *   its `TaskCreate` in the same assistant message — each API response carries
 *   at most one of them. So the fold has to run across the whole loaded
 *   transcript; folding per message would produce an empty list every time.
 *
 * `Task{Stop,Output,Get}` are a *different* feature — background agents, keyed
 * by a snake_case `task_id` hash rather than the checklist's numeric `taskId` —
 * and are deliberately not folded in.
 *
 * Dependency-free (no imports at all) so `node --test` can run the `.ts`
 * directly; the part shape is declared structurally below.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskItem {
  id: string
  subject: string
  status: TaskStatus
  /** Present continuous ("Running tests"), shown while the task is in progress. */
  activeForm?: string
}

/**
 * The tools that define the checklist. `TaskGet` reads a single task and is
 * left out: it changes nothing, so folding it would only add a card.
 */
export const TASK_LIST_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList'
])

/** The subset of `ToolPart` this module reads. Structural, so nothing is imported. */
export interface TaskToolPart {
  type: string
  toolUseId: string
  name: string
  input?: unknown
  status: string
  output?: string
}

/**
 * Anything else the transcript renders — prose, another tool, a user message.
 * Only its presence matters: it ends a run of checklist calls.
 */
export type TranscriptItem = TaskToolPart | { type: string }

/** Snapshot of the list immediately after each `Task*` call, keyed by its id. */
export type TaskSnapshots = Map<string, TaskItem[]>

export interface TaskFold {
  /** Lists to draw, keyed by the call that draws them. */
  snapshots: TaskSnapshots
  /**
   * Checklist calls folded into a later one and drawn by it instead. Their own
   * cards render nothing — see `foldTaskParts`.
   */
  superseded: Set<string>
}

const CREATED = /Task #(\d+) created successfully:\s*(.+)/
const LIST_ROW = /^#(\d+)\s+\[([a-z_]+)\]\s+(.+)$/

const isStatus = (v: unknown): v is TaskStatus =>
  v === 'pending' || v === 'in_progress' || v === 'completed'

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Parse `TaskList`'s rendered output: `#1 [completed] Ship the thing`. */
export function parseTaskList(output: string): TaskItem[] {
  const items: TaskItem[] = []
  for (const line of output.split('\n')) {
    const m = LIST_ROW.exec(line.trim())
    if (!m) continue
    items.push({
      id: m[1],
      subject: m[3].trim(),
      status: isStatus(m[2]) ? m[2] : 'pending'
    })
  }
  return items
}

function apply(state: Map<string, TaskItem>, part: TaskToolPart): void {
  const input = (part.input ?? {}) as Record<string, unknown>
  switch (part.name) {
    case 'TaskCreate': {
      const m = CREATED.exec(part.output ?? '')
      // Without the id from the output nothing can ever update this task, but
      // it is still a real entry on the list — key it off the call so it shows
      // up and simply never moves.
      const id = m?.[1] ?? `call:${part.toolUseId}`
      const subject = str(input.subject) ?? str(m?.[2])
      if (!subject) return
      state.set(id, { id, subject, status: 'pending', activeForm: str(input.activeForm) })
      return
    }
    case 'TaskUpdate': {
      // `taskId` is the documented spelling; `task_id` turns up occasionally and
      // the tool accepts it, so honour both rather than dropping those updates.
      const id = str(input.taskId) ?? str(input.task_id)
      if (!id) return
      const status = str(input.status) ?? str(input.state)
      if (status === 'deleted') {
        state.delete(id)
        return
      }
      const existing = state.get(id)
      const subject = str(input.subject) ?? existing?.subject
      // A task created before the loaded window: there is nothing to name it
      // with, and inventing "Task #7" would put a row on screen that says less
      // than no row at all. Load earlier messages and it fills itself in.
      if (!subject) return
      // Map.set on an existing key keeps its position, so the list stays in
      // creation order however often a task is updated.
      state.set(id, {
        id,
        subject,
        status: isStatus(status) ? status : (existing?.status ?? 'pending'),
        activeForm: str(input.activeForm) ?? existing?.activeForm
      })
      return
    }
    case 'TaskList': {
      const rows = parseTaskList(part.output ?? '')
      if (!rows.length) return
      // Authoritative: this is the one call that can name tasks created before
      // the loaded window, so it replaces the state rather than merging into it.
      const activeForms = new Map([...state].map(([id, t]) => [id, t.activeForm]))
      state.clear()
      for (const row of rows) state.set(row.id, { ...row, activeForm: activeForms.get(row.id) })
      return
    }
  }
}

const isChecklistCall = (item: TranscriptItem): item is TaskToolPart =>
  item.type === 'tool' &&
  'name' in item &&
  TASK_LIST_TOOLS.has(item.name) &&
  // A failed call changed nothing and renders as an ordinary (red) tool card —
  // claiming a task the session doesn't have would be worse than showing it.
  item.status === 'success'

/**
 * Fold the transcript into the list as it stood at each point it was shown.
 *
 * Feed this *everything the transcript renders*, in order — not just the
 * checklist calls — because runs matter. Where `TodoWrite` carried the whole
 * list in one call, `TaskCreate` adds one task per call, so a five-task plan
 * arrives as five calls back to back. Drawing a card for each gives a stutter of
 * "0/1, 0/2, 0/3…" that says nothing; across the real corpus that is 566 calls
 * for 255 runs, i.e. more than half the cards. So a back-to-back run collapses
 * to a single card at its last call, showing the list once the run has settled,
 * and any other rendered content between two calls ends the run.
 */
export function foldTaskParts(items: Iterable<TranscriptItem | null | undefined>): TaskFold {
  const state = new Map<string, TaskItem>()
  const snapshots: TaskSnapshots = new Map()
  const superseded = new Set<string>()
  let run: string[] = []

  const endRun = (): void => {
    const drawn = run.pop()
    if (drawn) snapshots.set(drawn, [...state.values()])
    for (const id of run) superseded.add(id)
    run = []
  }

  for (const item of items) {
    if (!item) continue
    if (!isChecklistCall(item)) {
      endRun()
      continue
    }
    apply(state, item)
    run.push(item.toolUseId)
  }
  endRun()
  return { snapshots, superseded }
}

const sameItem = (a: TaskItem, b: TaskItem): boolean =>
  a.id === b.id && a.subject === b.subject && a.status === b.status && a.activeForm === b.activeForm

/**
 * Carry forward the previous fold's arrays wherever the list is unchanged.
 *
 * The fold reruns on every streamed token and builds fresh arrays each time, so
 * without this every task card in the transcript would get a new prop identity
 * — and re-render — several times a second, which is exactly what keeping this
 * state out of the message-history render path exists to prevent.
 */
export function reconcileSnapshots(prev: TaskSnapshots, next: TaskSnapshots): TaskSnapshots {
  for (const [id, items] of next) {
    const before = prev.get(id)
    if (before && before.length === items.length && before.every((t, i) => sameItem(t, items[i]))) {
      next.set(id, before)
    }
  }
  return next
}

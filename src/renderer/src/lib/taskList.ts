/**
 * The agent's checklist, reconstructed from its checklist tool calls.
 *
 * There is exactly **one** list per chat and it lives above the composer, not
 * in the transcript (see `TaskDock`) — so this module answers one question:
 * what does the list look like *now*. Every successful checklist call in the
 * loaded window is applied in order and the final state is the answer.
 *
 * That is a change of shape as much as of code. The checklist used to be drawn
 * where it was written, once per call, which meant the fold also had to decide
 * *which* call drew it: a five-task plan arrives as five back-to-back
 * `TaskCreate`s, and a card each gave a stutter of "0/1, 0/2, 0/3…" saying
 * nothing (566 real calls for 255 runs, i.e. over half the cards). Runs,
 * snapshots and superseded ids all existed for that. A single docked list is
 * the same problem answered once and for good: the box shows the list, so the
 * calls that built it are ordinary muted rows like any other step.
 *
 * The two providers deliver the list in completely different shapes and both
 * land here, which is what lets the dock stay unaware of the backend:
 *
 * - **Codex** sends `TodoWrite`, one call carrying the whole list. It replaces
 *   the state wholesale, exactly as `TaskList` does.
 * - **Claude Code** builds it incrementally — `TaskCreate` one task at a time,
 *   `TaskUpdate` to flip a status — so no single call ever holds the list.
 *   Two things about that are less obvious than they look, both measured
 *   against the real corpus rather than assumed:
 *   - **The id only exists in the output.** `TaskCreate`'s *input* has no id —
 *     it comes back in the result ("Task #3 created successfully: …"), and that
 *     is the only thing a later `TaskUpdate` can be matched against.
 *   - **It is never message-local.** Of 366 real `TaskUpdate` calls, *none* had
 *     its `TaskCreate` in the same assistant message — each API response
 *     carries at most one of them. So the fold has to span the whole loaded
 *     window; folding per message would produce an empty list every time.
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
 * The tools that define the checklist, in either provider's spelling. `TaskGet`
 * reads a single task and is left out: it changes nothing.
 */
export const CHECKLIST_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TodoWrite'
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

/** Anything else the transcript holds; only checklist calls are read. */
export type TranscriptItem = TaskToolPart | { type: string }

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
    case 'TodoWrite': {
      // Codex's whole-list call. The ids are positions rather than identities,
      // so they are prefixed: a chat can switch provider mid-conversation, and
      // a bare "1" would collide with a Claude `taskId` still in the state this
      // call is about to replace.
      const rows = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : []
      const items: TaskItem[] = []
      rows.forEach((row, i) => {
        const subject = str(row?.content) ?? str(row?.subject)
        if (!subject) return
        const status = str(row?.status)
        items.push({
          id: `todo:${i}`,
          subject,
          status: isStatus(status) ? status : 'pending',
          activeForm: str(row?.activeForm)
        })
      })
      if (!items.length) return
      state.clear()
      for (const item of items) state.set(item.id, item)
      return
    }
  }
}

const isChecklistCall = (item: TranscriptItem): item is TaskToolPart =>
  item.type === 'tool' &&
  'name' in item &&
  CHECKLIST_TOOLS.has(item.name) &&
  // A failed call changed nothing and renders as an ordinary (red) tool row —
  // claiming a task the session doesn't have would be worse than showing it.
  // A *running* one is skipped for a second reason: its input is still partial.
  item.status === 'success'

/**
 * The checklist as it stands after everything in the loaded window.
 *
 * Feed it the transcript's tool parts in order; anything else is ignored.
 */
export function foldTasks(items: Iterable<TranscriptItem | null | undefined>): TaskItem[] {
  const state = new Map<string, TaskItem>()
  for (const item of items) {
    if (!item || !isChecklistCall(item)) continue
    apply(state, item)
  }
  return [...state.values()]
}

const sameItem = (a: TaskItem, b: TaskItem): boolean =>
  a.id === b.id && a.subject === b.subject && a.status === b.status && a.activeForm === b.activeForm

const sameList = (a: readonly TaskItem[] | null, b: readonly TaskItem[]): boolean =>
  !!a && a.length === b.length && a.every((t, i) => sameItem(t, b[i]))

/**
 * Hand back the previous list whenever nothing about it moved.
 *
 * The fold reruns on every streamed token and builds a fresh array each time,
 * so without this the dock would re-render several times a second through a
 * turn that never touched a task — which is the whole reason this state is kept
 * out of the message-history render path in the first place.
 */
export function reconcileTasks(prev: TaskItem[], next: TaskItem[]): TaskItem[] {
  return sameList(prev, next) ? prev : next
}

/** The subset of a transcript message the timeline reads. Structural, like `TaskToolPart`. */
export interface TaskTranscriptMessage {
  id: string
  role: string
  parts?: readonly (TranscriptItem | null | undefined)[]
}

/** The list, and the turns that finished one. */
export interface TaskTimeline {
  /** What the dock draws — empty once a card in the transcript holds the list. */
  tasks: TaskItem[]
  /** Assistant message id → the finished list to draw after it. */
  completions: ReadonlyMap<string, TaskItem[]>
}

export const NO_TASK_TIMELINE: TaskTimeline = { tasks: [], completions: new Map() }

/**
 * The list, plus the moment it was *finished* — which is where it stops being
 * the composer's business and becomes history.
 *
 * A checklist is state while it is being worked and a record once it isn't, and
 * the dock is only right about the first of those. Left docked, a finished list
 * sits on top of the input for the rest of the chat saying "All done · 6/6" —
 * a permanent row about a turn that ended, in the one place on screen reserved
 * for what happens next. So a completed list is **committed**: it lands in the
 * transcript as one card, at the end of the turn that finished it, and the dock
 * clears. One fold answers both halves, which is the point — `tasks` is empty
 * exactly when `completions` holds the list, so the box can never be in two
 * places at once, or in neither.
 *
 * Three rules, each of which is a case that went wrong when it was missing:
 *
 * - **It commits on the idle transition, not on the last tick.** An agent
 *   routinely finishes its list and keeps working; committing on the sixth
 *   check would yank the box off the composer mid-turn and then have to put it
 *   back the moment the next task was created.
 * - **Only a turn that touched the checklist can commit one.** Otherwise every
 *   later turn in a finished chat qualifies — the list is still complete and
 *   the chat is still idle — and the card lands on whichever turn happens to be
 *   last, migrating down the transcript as the conversation goes on.
 * - **A snapshot commits once.** Claude *appends* to its list, so a second plan
 *   turns 6/6 into 6/12 and finishing it commits a second card holding all
 *   twelve. Comparing against what was already committed is what keeps that to
 *   one card per finished plan rather than one per idle turn.
 *
 * The anchor is the turn's last assistant message, which is what
 * `turnPresentations` anchors the changes card to — so both cards hang off the
 * same message and the two render paths (a plain block, a collapsed run) each
 * settle both at once. Feed it the messages the transcript will actually draw:
 * an anchor filtered out downstream is a card nothing renders.
 */
export function foldTaskTimeline(
  messages: Iterable<TaskTranscriptMessage>,
  busy = false
): TaskTimeline {
  const state = new Map<string, TaskItem>()
  const completions = new Map<string, TaskItem[]>()
  /** The last list handed to a card; the dock stands down while it matches. */
  let committed: TaskItem[] | null = null
  let anchor: string | null = null
  let touched = false

  const endTurn = (finished: boolean): void => {
    if (finished && touched && anchor) {
      const list = [...state.values()]
      const done = list.length > 0 && list.every((t) => t.status === 'completed')
      if (done && !sameList(committed, list)) {
        completions.set(anchor, list)
        committed = list
      }
    }
    anchor = null
    touched = false
  }

  for (const message of messages) {
    // A user message ends the turn before it; anything else that isn't an
    // assistant message (a switch divider, an error row) is not part of one.
    if (message.role === 'user') {
      endTurn(true)
      continue
    }
    if (message.role !== 'assistant') continue
    anchor = message.id
    for (const part of message.parts ?? []) {
      if (!part || !isChecklistCall(part)) continue
      apply(state, part)
      touched = true
    }
  }
  // The final turn is only over when the chat is: a running one is still
  // creating tasks, and its list belongs on the composer until it stops.
  endTurn(!busy)

  const live = [...state.values()]
  return { tasks: sameList(committed, live) ? [] : live, completions }
}

const sameCompletions = (
  a: ReadonlyMap<string, TaskItem[]>,
  b: ReadonlyMap<string, TaskItem[]>
): boolean => {
  if (a.size !== b.size) return false
  for (const [id, list] of a) {
    const other = b.get(id)
    if (!other || !sameList(list, other)) return false
  }
  return true
}

/**
 * `reconcileTasks` for the whole timeline, and the map half is the load-bearing
 * one: `completions` crosses into the transcript's render context, which is
 * compared by identity, so a fresh Map per fold would re-render every message
 * in the chat on every streamed token. It is empty in most chats and unchanged
 * in the rest, so carrying it forward costs a size check.
 */
export function reconcileTimeline(prev: TaskTimeline, next: TaskTimeline): TaskTimeline {
  const tasks = reconcileTasks(prev.tasks, next.tasks)
  const completions = sameCompletions(prev.completions, next.completions)
    ? prev.completions
    : next.completions
  return tasks === prev.tasks && completions === prev.completions ? prev : { tasks, completions }
}

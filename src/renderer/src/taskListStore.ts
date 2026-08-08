import { create } from 'zustand'
import type { TaskSnapshots } from '@/lib/taskList'

/**
 * The active chat's task checklist, kept deliberately OUTSIDE the message-history
 * render path.
 *
 * Two things live here:
 *
 * - `latestId` — the `toolUseId` of the chat's most recent checklist call, the
 *   one card that stays expanded while earlier ones collapse.
 * - `snapshots` — the list as it stood after each call, folded from Claude
 *   Code's incremental `Task*` calls (see `lib/taskList.ts`). Codex's
 *   `TodoWrite` carries its own list and doesn't need this.
 *
 * Both churn constantly: an agent flips tasks in-progress/done many times a
 * turn, and the fold reruns on every streamed token. Threading either through
 * props would cross the `MessageHistory` memo boundary and re-render every row
 * in the transcript on each flip. Instead each card subscribes to just its own
 * slice — `latestId === myId`, and `snapshots.get(myId)` — so a change
 * re-renders only the cards whose own state actually moved. That is only true
 * because `reconcileSnapshots` carries unchanged arrays forward by identity; a
 * fresh array per fold would defeat the whole arrangement.
 */
interface TaskListStore {
  latestId: string | null
  snapshots: TaskSnapshots
  /** Calls whose list is drawn by a later call in the same run. */
  superseded: ReadonlySet<string>
  setLatestId: (id: string | null) => void
  setFold: (snapshots: TaskSnapshots, superseded: ReadonlySet<string>) => void
}

export const useTaskList = create<TaskListStore>((set) => ({
  latestId: null,
  snapshots: new Map(),
  superseded: new Set(),
  // No-op when unchanged so redundant pushes don't notify subscribers.
  setLatestId: (id) => set((s) => (s.latestId === id ? s : { latestId: id })),
  setFold: (snapshots, superseded) =>
    set((s) => (s.snapshots === snapshots && s.superseded === superseded ? s : { snapshots, superseded }))
}))

import { create } from 'zustand'
import { reconcileTasks, type TaskItem } from '@/lib/taskList'

/**
 * The active chat's checklist, kept deliberately OUTSIDE the message-history
 * render path.
 *
 * It churns constantly — an agent flips tasks in-progress/done many times a
 * turn, and the fold reruns on every streamed token — while the only thing
 * reading it is one box above the composer. Threading it through props would
 * cross the `MessageHistory` memo boundary and re-render every row in the
 * transcript on each flip; here, a change re-renders the dock and nothing else.
 *
 * **`chatId` is load-bearing, not bookkeeping.** The list is published from an
 * effect, which runs after paint, so on a chat switch there is one frame where
 * this store still holds the previous chat's tasks. A per-chat card could fail
 * soft on that (it looked itself up by call id); one box shared by every chat
 * would show the wrong chat's plan, so the dock checks the id and draws nothing
 * until it matches.
 */
interface TaskListStore {
  /** Chat the list belongs to; the dock draws nothing when it isn't its own. */
  chatId: string | null
  tasks: TaskItem[]
  setTasks: (chatId: string, tasks: TaskItem[]) => void
}

export const useTaskList = create<TaskListStore>((set) => ({
  chatId: null,
  tasks: [],
  // No-op when nothing moved, so a token that changed no task notifies nobody.
  // `reconcileTasks` is applied here as well as at the call site because the
  // guarantee belongs to the store: a caller that rebuilt the array is the
  // normal case, not a bug to be fixed at each one.
  setTasks: (chatId, tasks) =>
    set((s) => {
      if (s.chatId !== chatId) return { chatId, tasks }
      const next = reconcileTasks(s.tasks, tasks)
      return next === s.tasks ? s : { chatId, tasks: next }
    })
}))

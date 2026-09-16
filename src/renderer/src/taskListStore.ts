import { create } from 'zustand'
import { reconcileTasks, type TaskItem } from '@/lib/taskList'
import { omit } from '@/lib/utils'

/**
 * Each on-screen chat's checklist, kept deliberately OUTSIDE the message-history
 * render path.
 *
 * It churns constantly — an agent flips tasks in-progress/done many times a
 * turn, and the fold reruns on every streamed token — while the only thing
 * reading it is one box above the composer. Threading it through props would
 * cross the cached history nodes and re-render every row in the
 * transcript on each flip; here, a change re-renders the dock and nothing else.
 *
 * Keyed by chat id, because a thread draws up to four composers at once and
 * each carries its own dock. A single slot stamped with its chat — what this
 * was while only one transcript was ever on screen — would blank every dock but
 * the one that published last. Each `ChatView` publishes its own entry and
 * removes it on unmount, so a dock never reads a chat that is not drawn.
 */
interface TaskListStore {
  byChat: Record<string, TaskItem[]>
  setTasks: (chatId: string, tasks: TaskItem[]) => void
  clearTasks: (chatId: string) => void
}

export const useTaskList = create<TaskListStore>((set) => ({
  byChat: {},
  setTasks: (chatId, tasks) =>
    set((s) => {
      const prev = s.byChat[chatId]
      if (!prev) {
        return tasks.length === 0 ? s : { byChat: { ...s.byChat, [chatId]: tasks } }
      }
      const next = reconcileTasks(prev, tasks)
      return next === prev ? s : { byChat: { ...s.byChat, [chatId]: next } }
    }),
  clearTasks: (chatId) => set((s) => (chatId in s.byChat ? { byChat: omit(s.byChat, [chatId]) } : s))
}))

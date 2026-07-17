import { create } from 'zustand'

/**
 * The `toolUseId` of the chat's single most recent `TodoWrite` — the one live
 * task list that stays expanded while earlier ones collapse.
 *
 * It lives in its own store, deliberately OUTSIDE the message-history render
 * path. An agent flips todos in-progress/done many times per turn, and each
 * `TodoWrite` is a new part with a new id, so this value churns constantly
 * mid-stream. Threading it through props/context would cross the `MessageHistory`
 * memo boundary and re-render every history row on each flip. Instead, each
 * `TodoCard` host subscribes with an equality selector (`latestTodoId === myId`),
 * so a change re-renders only the two cards whose live-state actually flips —
 * the one losing "live" and the one gaining it.
 */
interface LatestTodoStore {
  latestTodoId: string | null
  setLatestTodoId: (id: string | null) => void
}

export const useLatestTodo = create<LatestTodoStore>((set) => ({
  latestTodoId: null,
  // No-op when unchanged so redundant pushes don't notify subscribers.
  setLatestTodoId: (id) => set((s) => (s.latestTodoId === id ? s : { latestTodoId: id }))
}))

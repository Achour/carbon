import * as api from './api'
import { useRemote } from './state'

/**
 * Pin, archive and rename from the phone: the desktop row menu's own channels
 * (`chats:set-pinned`, `chats:set-archived`, `chats:rename`). Each is drawn
 * here first and then sent, so a swiped row does not snap back for the round
 * trip; main's `meta` event follows with what it wrote.
 */

function patch(id: string, fields: Record<string, unknown>): void {
  useRemote.setState((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, ...fields } : c)) }))
}

function fail(err: unknown): void {
  useRemote.getState().setError(err instanceof Error ? err.message : String(err))
}

export function setPinned(id: string, pinned: boolean): void {
  patch(id, { pinnedAt: pinned ? Date.now() : undefined })
  void api.invoke('chats:set-pinned', id, pinned).catch(fail)
}

/** Archiving unpins too, as main does, or the two would disagree until a relaunch. */
export function setArchived(id: string, archived: boolean): void {
  patch(id, archived ? { archivedAt: Date.now(), pinnedAt: undefined } : { archivedAt: undefined })
  void api.invoke('chats:set-archived', id, archived).catch(fail)
}

export function rename(id: string, title: string): void {
  const clean = title.trim()
  if (!clean) return
  patch(id, { title: clean, titleManual: true })
  void api.invoke('chats:rename', id, clean).catch(fail)
}

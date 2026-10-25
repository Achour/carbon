import { keyForDrop } from '@/lib/chatOrder'
import * as api from './api'
import { useRemote } from './state'
import { listedChats } from './format'

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

/**
 * Move a chat in the sidebar: before or after `target` among the pins
 * (`zone` "pins"), or among the rest. The order written is the desktop's
 * (`chats:set-pinned-order`, `chats:place`), so the Mac's sidebar moves with
 * the phone's; drawn here first, so the row does not jump back for the round
 * trip.
 */
export function placeChat(zone: string, from: string, target: { id: string; after: boolean }): void {
  const all = listedChats(useRemote.getState().chats)
  if (zone === 'pins') {
    // Against every pin, not the filtered ones on screen, or a reorder under
    // a project filter would reshuffle the pins it cannot see.
    const ids = all
      .filter((c) => c.pinnedAt !== undefined)
      .sort((a, b) => a.pinnedAt! - b.pinnedAt!)
      .map((c) => c.id)
      .filter((id) => id !== from)
    const at = ids.indexOf(target.id)
    ids.splice(at === -1 ? ids.length : target.after ? at + 1 : at, 0, from)
    const base = Date.now() - ids.length
    const pinnedAt = new Map(ids.map((id, i) => [id, base + i]))
    useRemote.setState((st) => ({
      chats: st.chats.map((c) => (pinnedAt.has(c.id) ? { ...c, pinnedAt: pinnedAt.get(c.id) } : c))
    }))
    void api.invoke('chats:set-pinned-order', ids).catch(fail)
    return
  }
  const key = keyForDrop(
    all.filter((c) => c.pinnedAt === undefined),
    from,
    target.id,
    target.after
  )
  if (key === null) return
  patch(from, { sortKey: key })
  void api.invoke('chats:place', from, key).catch(fail)
}

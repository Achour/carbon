import * as React from 'react'
import type { ChatMeta, ChatStatus, PermissionRequestPayload, RemoteUnseen } from '@shared/types'
import { chatActivityKind } from '@/lib/chatActivity'
import { useRemote } from './state'
import { isLiveDelegate, listedChats } from './format'

/**
 * The home screen's board: what needs you, what is working, and what finished
 * while you were away. Each chat sits in one row only, the most urgent: a
 * finished chat that was sent again is Working until it ends again, and one
 * that stopped on a question is Needs you. Done is the Mac's per-phone marks
 * (`RemoteUnseen`), since a phone in a pocket heard none of those turns end.
 */
export interface Board {
  needs: ChatMeta[]
  working: ChatMeta[]
  done: { chat: ChatMeta; mark: RemoteUnseen }[]
}

export function deriveBoard(
  chats: ChatMeta[],
  statuses: Record<string, ChatStatus>,
  permissions: Record<string, PermissionRequestPayload[]>,
  unseen: Record<string, RemoteUnseen>
): Board {
  const board: Board = { needs: [], working: [], done: [] }
  for (const chat of listedChats(chats)) {
    const kind = chatActivityKind(statuses[chat.id], undefined, permissions[chat.id])
    if (kind === 'needs-input') board.needs.push(chat)
    else if (kind === 'working') board.working.push(chat)
    else if (unseen[chat.id]) board.done.push({ chat, mark: unseen[chat.id] })
  }
  // A delegate asking or working is on the board; its outcome is the
  // parent's to report, so a finished one is not.
  for (const chat of chats.filter(isLiveDelegate)) {
    const kind = chatActivityKind(statuses[chat.id], undefined, permissions[chat.id])
    if (kind === 'needs-input') board.needs.push(chat)
    else if (kind === 'working') board.working.push(chat)
  }
  board.needs.sort((a, b) => b.updatedAt - a.updatedAt)
  board.working.sort((a, b) => b.updatedAt - a.updatedAt)
  board.done.sort((a, b) => b.mark.at - a.mark.at)
  return board
}

export function useBoard(): Board {
  const chats = useRemote((s) => s.chats)
  const statuses = useRemote((s) => s.statuses)
  const permissions = useRemote((s) => s.permissions)
  const unseen = useRemote((s) => s.unseen)
  return React.useMemo(
    () => deriveBoard(chats, statuses, permissions, unseen),
    [chats, statuses, permissions, unseen]
  )
}

/**
 * The app icon's count: Needs you plus Done, the rows that want a look. The
 * service worker sets it from each push (the Mac counts it there, the same
 * way); this keeps it true while the app is open, and clears it at zero.
 */
export function useAppBadge(): void {
  const board = useBoard()
  const live = useRemote((s) => s.connection === 'live')
  const count = board.needs.length + board.done.length
  React.useEffect(() => {
    // A count from before the snapshot landed is a guess; the last real one stands.
    if (!live) return
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (!nav.setAppBadge) return
    const done = count ? nav.setAppBadge(count) : nav.clearAppBadge?.()
    // Refused without notification permission; there is nothing to say about it.
    void done?.catch(() => {})
  }, [count, live])
}

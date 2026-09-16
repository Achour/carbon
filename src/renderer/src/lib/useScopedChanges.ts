import * as React from 'react'
import type { ChatMessage, GitFileChange } from '@shared/types'
import { chatMeta, messagesOf, scopedChanges, useApp } from '@/store'
import { useStableChanges } from '@/lib/useStableChanges'

const NO_MESSAGES: ChatMessage[] = []

/**
 * The change list for the review's scope selector — the one block the changes
 * tree, the stacked diffs and the review bar each need, in one place.
 *
 * "Last turn" is the **focused** column's: in a thread, the turn you are looking
 * at, not necessarily the thread's first chat's. Its transcript is subscribed to
 * only while that scope is picked; under the other two scopes a streamed token
 * changes nothing here, so it no longer re-renders the panel either.
 */
export function useScopedChanges(cwd: string): GitFileChange[] {
  const changeScope = useApp((s) => s.changeScope)
  const git = useApp((s) => s.git)
  const branchChanges = useApp((s) => s.branchChanges)
  const lastTurn = changeScope === 'last-turn'
  const messages = useApp((s) => (lastTurn ? messagesOf(s, s.focusedChatId) : NO_MESSAGES))
  const chatCwd = useApp((s) => (lastTurn ? chatMeta(s, s.focusedChatId)?.cwd : undefined))
  const raw = React.useMemo(
    () => scopedChanges({ changeScope, git, branchChanges }, messages, chatCwd, cwd),
    [changeScope, git, branchChanges, messages, chatCwd, cwd]
  )
  return useStableChanges(raw)
}

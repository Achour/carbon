import * as React from 'react'
import { Bot, MessageCircleQuestion } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_LABELS, modelDisplayName } from '@shared/types'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { chatActivityKind } from '@/lib/chatActivity'
import { useApp } from '@/store'

/**
 * What a chat is doing, as the header draws it: waiting on you, working, a
 * background agent, finished while you were in another column — or nothing.
 * A primitive, from a non-allocating read, because it runs for every column on
 * every streamed delta.
 */
function useChatMark(id: string): 'needs-input' | 'working' | 'background' | 'unread' | null {
  return useApp((s) => {
    const kind = chatActivityKind(s.statuses[id], s.backgroundJobs[id], s.permissions[id])
    if (kind !== 'idle') return kind
    return s.unreadChats[id] ? 'unread' : null
  })
}

/**
 * A chat's status, drawn with the sidebar row's icons. `labelled` adds the words
 * a column header has room for.
 */
export function ChatMark({ id, labelled = false }: { id: string; labelled?: boolean }): React.JSX.Element | null {
  const mark = useChatMark(id)
  if (mark === 'needs-input') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning" aria-label="Needs your input">
        <MessageCircleQuestion className="size-3" />
        {labelled && 'Needs input'}
      </span>
    )
  }
  if (mark === 'background') {
    return <Bot aria-label="Background jobs running" className="size-3 shrink-0 animate-pulse-soft text-primary" />
  }
  if (mark === 'working') {
    return <DotSpinner aria-label="Working" className="size-3 shrink-0 text-primary" />
  }
  if (mark === 'unread') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-success" aria-label="Finished">
        <span className="size-1.5 rounded-full bg-success" />
        {labelled && 'Done'}
      </span>
    )
  }
  return null
}

/**
 * A thread chat's name. Until its first answer names it, a chat is told apart
 * by what runs in it: four columns all reading "New chat" were four of the same.
 */
export function threadChatTitle(chat: ChatMeta): string {
  return (
    chat.title?.trim() ||
    (chat.model ? modelDisplayName(chat.model, chat.provider) : PROVIDER_LABELS[chat.provider])
  )
}

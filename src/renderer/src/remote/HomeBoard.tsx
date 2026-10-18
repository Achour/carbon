import * as React from 'react'
import { ChevronRight, CircleAlert, CircleCheck, MessageCircleQuestion } from 'lucide-react'
import { projectRoot, type ChatMeta } from '@shared/types'
import { promptLine } from '@shared/promptLine'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { navigate } from './App'
import type { Board } from './board'
import { baseName, chatTitle } from './format'
import { useRemote } from './state'

/** Done rows shown before "Show more": the latest few are the news. */
const DONE_FOLD = 5

/**
 * The home screen's status board (`board.ts`): Needs you, Working, Done. It
 * answers what the phone was picked up to ask, and tapping a row opens the
 * chat, which is also what takes it off Done.
 */
export function HomeBoard({ board }: { board: Board }): React.JSX.Element {
  const permissions = useRemote((s) => s.permissions)
  const clearDone = useRemote((s) => s.clearDone)
  const [more, setMore] = React.useState(false)
  const done = more ? board.done : board.done.slice(0, DONE_FOLD)
  return (
    <div className="flex flex-col gap-5">
      {board.needs.length > 0 && (
        <BoardSection label="Needs you" warn>
          {board.needs.map((chat) => (
            <BoardRow
              key={chat.id}
              chat={chat}
              glyph={<MessageCircleQuestion className="size-[18px] text-warning" />}
              line={permissions[chat.id]?.[0] ? promptLine(permissions[chat.id][0]) : 'Needs your input'}
              time={chat.updatedAt}
            />
          ))}
        </BoardSection>
      )}
      {board.working.length > 0 && (
        <BoardSection label="Working">
          {board.working.map((chat) => (
            <BoardRow key={chat.id} chat={chat} glyph={<DotSpinner className="text-primary" />} />
          ))}
        </BoardSection>
      )}
      {board.done.length > 0 && (
        <BoardSection
          label="Done"
          action={
            <button
              type="button"
              onClick={() => void clearDone()}
              className="-my-1 rounded-lg px-2 py-1 text-[13px] text-muted-foreground active:bg-accent"
            >
              Clear
            </button>
          }
        >
          {done.map(({ chat, mark }) => (
            <BoardRow
              key={chat.id}
              chat={chat}
              glyph={
                mark.failed ? (
                  <CircleAlert className="size-[18px] text-destructive" />
                ) : (
                  <CircleCheck className="size-[18px] text-success" />
                )
              }
              line={mark.text}
              time={mark.at}
            />
          ))}
          {done.length < board.done.length && (
            <button
              type="button"
              onClick={() => setMore(true)}
              className="flex h-11 w-full items-center gap-1.5 px-4 text-[14px] text-muted-foreground active:bg-accent"
            >
              <ChevronRight className="size-3.5" /> Show {board.done.length - done.length} more
            </button>
          )}
        </BoardSection>
      )}
    </div>
  )
}

function BoardSection({
  label,
  warn,
  action,
  children
}: {
  label: string
  warn?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className={cn('text-[13px] font-medium', warn ? 'text-warning' : 'text-muted-foreground')}>{label}</span>
        {action}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
    </section>
  )
}

/**
 * One chat: its state's glyph, the title and when, the project under it, and
 * a line of what it said or is asking. Working rows carry no time — "now" is
 * what the spinner already says.
 */
function BoardRow({
  chat,
  glyph,
  line,
  time
}: {
  chat: ChatMeta
  glyph: React.ReactNode
  line?: string
  time?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => navigate(`#/c/${encodeURIComponent(chat.id)}`)}
      className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-accent"
    >
      <span className="flex h-[22px] w-[18px] shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15.5px] leading-[22px] font-medium">{chatTitle(chat)}</span>
          {time !== undefined && (
            <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">{relativeTime(time)}</span>
          )}
        </span>
        <span className="block truncate text-[12.5px] leading-tight text-muted-foreground">
          {baseName(projectRoot(chat))}
        </span>
        {line && <span className="mt-1 line-clamp-2 text-[14px] leading-snug text-foreground/75">{line}</span>}
      </span>
    </button>
  )
}

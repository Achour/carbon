import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import type { ChatMeta, ToolPart } from '@shared/types'
import { PROVIDER_SHORT_LABELS, knownProvider } from '@shared/types'
import { formatAgentDuration } from '@shared/agentRuns'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { threadFull, useApp } from '@/store'

/**
 * The delegate's chat id, read off the `agents_delegate` result — "Started
 * Codex as "codex-a" (id …)". Absent until the call returns, and on a refusal.
 */
export function delegateChildId(part: ToolPart): string | null {
  return /\(id ([0-9a-f-]{36})\)/i.exec(part.output ?? '')?.[1] ?? null
}

type Look = { word: string; dot: string; live: boolean }

function lookOf(meta: ChatMeta | undefined, waiting: boolean): Look {
  const status = meta?.delegation?.status
  if (!meta) return { word: 'Deleted', dot: 'bg-muted-foreground/40', live: false }
  if (status === 'running') {
    return waiting
      ? { word: 'Needs your approval', dot: 'bg-warning', live: true }
      : { word: 'Running', dot: 'bg-primary animate-pulse', live: true }
  }
  if (status === 'completed') return { word: 'Finished', dot: 'bg-success', live: false }
  if (status === 'failed') return { word: 'Failed', dot: 'bg-destructive', live: false }
  if (status === 'cancelled') return { word: 'Stopped', dot: 'bg-muted-foreground/60', live: false }
  return { word: 'Interrupted', dot: 'bg-muted-foreground/60', live: false }
}

function useElapsed(from: number | undefined, to: number | undefined, live: boolean): string | null {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])
  if (!from) return null
  const end = live ? now : to
  return end ? formatAgentDuration(Math.max(0, end - from)) : null
}

/**
 * An agent this chat delegated to, as one live row of its transcript — the
 * *collapsed* form of the delegate's chat, whose open form is its column.
 *
 * It is the same chat either way, which is why the row is a toggle rather than
 * a link: clicking it opens the column (reopening it from the thread's closed
 * list), and clicking again folds the column back into this row. Closing the
 * column from its own ✕ leaves the row standing, so a delegate you put away
 * is always one click from coming back.
 *
 * Everything on it is the child's live state, not the tool call's: the call
 * returns the moment the agent starts, and what a reader wants from this row
 * is whether that agent is still working, waiting on them, or done.
 */
export function DelegateCard({ part }: { part: ToolPart }): React.JSX.Element {
  const input = (part.input ?? {}) as Record<string, unknown>
  const childId = delegateChildId(part)
  const meta = useApp((s) => (childId ? s.chats.find((c) => c.id === childId) : undefined))
  const waiting = useApp((s) => (childId ? s.statuses[childId] === 'waiting-permission' : false))
  const open = useApp((s) => (childId ? s.sideColumns.includes(childId) : false))
  const full = useApp((s) => threadFull(s))
  const reopenSideChat = useApp((s) => s.reopenSideChat)
  const closeSideChat = useApp((s) => s.closeSideChat)

  const d = meta?.delegation
  const provider = meta?.provider ?? knownProvider(input.provider) ?? 'claude'
  const pending = !childId
  const look: Look = pending
    ? { word: `Starting ${PROVIDER_SHORT_LABELS[provider]}…`, dot: 'bg-primary animate-pulse', live: true }
    : lookOf(meta, waiting)
  const elapsed = useElapsed(d?.startedAt ?? d?.createdAt, d?.finishedAt, look.live && !pending)
  const name = d?.name ?? (typeof input.name === 'string' ? input.name : PROVIDER_SHORT_LABELS[provider])
  const task = (d?.followUp ?? d?.task ?? (typeof input.task === 'string' ? input.task : ''))
    .replace(/\s+/g, ' ')
    .trim()
  const clickable = !!meta && (open || !full)

  const toggle = (): void => {
    if (!childId || !meta) return
    if (open) void closeSideChat(childId)
    else void reopenSideChat(childId)
  }

  const row = (
    <button
      type="button"
      data-delegate={childId ?? 'pending'}
      data-delegate-open={open ? 'true' : undefined}
      disabled={!clickable}
      onClick={toggle}
      title={meta ? (open ? 'Collapse its chat' : 'Open its chat beside this one') : undefined}
      className={cn(
        'group flex w-full animate-step-in items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none transition-colors',
        clickable ? 'hover:bg-accent/50 focus-visible:bg-accent/50' : 'cursor-default'
      )}
    >
      <span className="relative shrink-0">
        <ProviderAvatar provider={provider} className="size-7 [&>svg]:size-4" />
        <span
          className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background', look.dot)}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">
          <span className="font-medium">{name}</span>
          {task && <span className="text-foreground/80">: {task}</span>}
        </span>
        <span className={cn('text-xs text-muted-foreground', look.live && 'shimmer-text')}>
          {look.word}
          {/* A stop carries no report — its `deliveredAt` only marks that
              nothing is owed — so "reported back" would be a claim about a
              message that never went. */}
          {!look.live && d?.deliveredAt && d.status !== 'cancelled' ? ' · reported back' : ''}
        </span>
      </span>
      {elapsed && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
      )}
      {meta && (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground',
            open && 'rotate-90'
          )}
        />
      )}
    </button>
  )
  // Disabled only when there is no room for its column; say why rather than
  // leave a row that silently does nothing.
  if (meta && !clickable) {
    return (
      <WithTooltip label="The thread already shows four chats — close one to open this agent.">
        <span className="block">{row}</span>
      </WithTooltip>
    )
  }
  return row
}

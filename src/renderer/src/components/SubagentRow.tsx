import * as React from 'react'
import type { ChatMeta, Provider } from '@shared/types'
import { agentColumnId, type AgentRunView } from '@shared/agentRuns'
import { useApp } from '@/store'
import { useAgents } from '@/agentsStore'
import { isAgentJob } from '@/components/BackgroundJobs'
import { useElapsed } from '@/components/messages/AgentRows'
import { ProviderMark } from '@/components/ui/provider-mark'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SubagentRunRow {
  chatId: string
  run: AgentRunView
  provider: Provider
}

/**
 * Every run the given chats' agents spawned, in each chat's transcript order.
 * Read off `agentsStore`, which each `ChatView` publishes carried forward by
 * identity, so this moves when an agent does and not on every token.
 */
export function useSubagentRuns(chatIds: readonly string[]): SubagentRunRow[] {
  const byChat = useAgents((s) => s.byChat)
  const chats = useApp((s) => s.chats)
  return React.useMemo(
    () =>
      chatIds.flatMap((chatId) =>
        (byChat[chatId]?.runs ?? []).map((run) => ({
          chatId,
          run,
          provider: chats.find((c) => c.id === chatId)?.provider ?? 'claude'
        }))
      ),
    [chatIds, byChat, chats]
  )
}

/**
 * The thread's delegates — the chats its agents handed tasks to with
 * `agents_delegate`. Killed ones included: this is a roster, and opening one
 * takes the kill back.
 */
export function useThreadDelegates(threadId: string): ChatMeta[] {
  const chats = useApp((s) => s.chats)
  return React.useMemo(() => chats.filter((c) => c.sideOf === threadId && c.delegation), [chats, threadId])
}

/** One agent of the roster, delegate or sub-agent, with what sorting needs. */
export type RosterItem =
  | { kind: 'delegate'; key: string; chat: ChatMeta; live: boolean; waiting: boolean; at: number }
  | { kind: 'run'; key: string; row: SubagentRunRow; live: boolean; waiting: false; at: number }

/**
 * The thread's agents as one list, split into the ones working and the ones
 * that have stopped, each newest first, and anything waiting on the user at
 * the very top. It used to be delegates oldest-first and then sub-agents in
 * transcript order, so a fan-out of ten read as two unordered runs with the
 * live ones scattered through them — the one question the list exists to
 * answer, "which of these is still going", had no place to look.
 *
 * "Newest" is when a working agent started and when a finished one ended:
 * the finish is what the reader just saw happen.
 */
export function useAgentRoster(
  threadId: string,
  chatIds: readonly string[]
): { working: RosterItem[]; finished: RosterItem[] } {
  const runs = useSubagentRuns(chatIds)
  const delegates = useThreadDelegates(threadId)
  // Only the delegates' statuses, as one string, so a status change anywhere
  // else in the app is not a re-sort here.
  const waitingKey = useApp((s) =>
    delegates
      .filter((c) => s.statuses[c.id] === 'waiting-permission')
      .map((c) => c.id)
      .join(',')
  )
  return React.useMemo(() => {
    const waiting = new Set(waitingKey ? waitingKey.split(',') : [])
    const items: RosterItem[] = [
      ...delegates.map((chat): RosterItem => {
        const d = chat.delegation!
        const live = d.status === 'running'
        return {
          kind: 'delegate',
          key: chat.id,
          chat,
          live,
          waiting: live && waiting.has(chat.id),
          at: live ? (d.startedAt ?? d.createdAt) : (d.finishedAt ?? d.startedAt ?? d.createdAt)
        }
      }),
      ...runs.map((row): RosterItem => {
        const live = row.run.status === 'running'
        return {
          kind: 'run',
          key: `${row.chatId}:${row.run.id}`,
          row,
          live,
          waiting: false,
          at: live ? (row.run.startedAt ?? 0) : (row.run.endedAt ?? row.run.startedAt ?? 0)
        }
      })
    ]
    const newest = (a: RosterItem, b: RosterItem): number =>
      Number(b.waiting) - Number(a.waiting) || b.at - a.at
    return {
      working: items.filter((i) => i.live).sort(newest),
      finished: items.filter((i) => !i.live).sort(newest)
    }
  }, [delegates, runs, waitingKey])
}

/**
 * The roster drawn: a "Working" group, then "Finished", each a list of rows.
 * The rail passes `limit` to fold the older finished ones behind "Show N
 * earlier"; the robot menu shows everything in a scroller.
 */
export function AgentRoster({
  working,
  finished,
  limit
}: {
  working: RosterItem[]
  finished: RosterItem[]
  limit?: number
}): React.JSX.Element {
  const [all, setAll] = React.useState(false)
  const shown = limit != null && !all ? finished.slice(0, limit) : finished
  const hidden = finished.length - shown.length
  return (
    <div data-agent-roster className="flex flex-col gap-2">
      {working.length > 0 && (
        <RosterGroup title="Working" count={working.length}>
          {working.map((i) => (
            <RosterRow key={i.key} item={i} />
          ))}
        </RosterGroup>
      )}
      {finished.length > 0 && (
        <RosterGroup title="Finished" count={finished.length}>
          {shown.map((i) => (
            <RosterRow key={i.key} item={i} />
          ))}
          {(hidden > 0 || (all && limit != null && finished.length > limit)) && (
            <button
              type="button"
              onClick={(e) => {
                // Inside the robot menu a click closes it; this one only folds.
                e.stopPropagation()
                setAll((a) => !a)
              }}
              className="rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {all ? 'Show fewer' : `Show ${hidden} earlier`}
            </button>
          )}
        </RosterGroup>
      )}
    </div>
  )
}

function RosterGroup({
  title,
  count,
  children
}: {
  title: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums text-muted-foreground/60">{count}</span>
      </div>
      <div className="surface-group flex flex-col gap-px p-0.5">{children}</div>
    </div>
  )
}

function RosterRow({ item }: { item: RosterItem }): React.JSX.Element {
  if (item.kind === 'delegate') return <DelegateRow chat={item.chat} waiting={item.waiting} />
  const { chatId, run, provider } = item.row
  return <SubagentRow chatId={chatId} run={run} provider={provider} />
}

/**
 * The provider's mark, carrying the row's state: a spinner over it while the
 * agent works — the one state the eye has to find in a long list, so it moves
 * — and a small dot once it has stopped.
 */
function AgentMark({
  provider,
  live,
  dot
}: {
  provider: Provider
  live: boolean
  dot: string
}): React.JSX.Element {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {live ? (
        <DotSpinner className="size-4 text-foreground" />
      ) : (
        <>
          <ProviderMark provider={provider} className="size-3.5 text-muted-foreground" />
          <span className={cn('absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full', dot)} />
        </>
      )}
    </span>
  )
}

/**
 * One spawned sub-agent as a compact row: its state, its short label, its
 * clock, a dot while it is the page on screen, and the Stop a backgrounded one
 * needs. A click opens the agent in place of the chat (`openAgentView`).
 */
export function SubagentRow({
  chatId,
  run,
  provider
}: {
  chatId: string
  run: AgentRunView
  provider: Provider
}): React.JSX.Element {
  const openAgentView = useApp((s) => s.openAgentView)
  const stopBackgroundJob = useApp((s) => s.stopBackgroundJob)
  const viewId = agentColumnId(chatId, run.id)
  const shown = useApp((s) => s.agentView === viewId)
  const running = run.status === 'running'
  // `callId` is the spawning call's id, which is what a run is keyed by.
  const job = useApp((s) =>
    running ? s.backgroundJobs[chatId]?.find((j) => isAgentJob(j.type) && j.callId === run.id) : undefined
  )
  const elapsed = useElapsed(run.startedAt, run.endedAt, running)
  const failed = run.status === 'failed'
  return (
    <div className="group flex items-center rounded-md hover:bg-accent">
      <button
        type="button"
        data-subagent-row={run.id}
        data-live={running || undefined}
        title={[run.type, run.description].filter(Boolean).join(': ')}
        onClick={() => void openAgentView(viewId)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]"
      >
        <AgentMark provider={provider} live={running} dot={failed ? 'bg-destructive' : 'bg-muted-foreground/60'} />
        <span className={cn('min-w-0 flex-1 truncate', running ? 'text-foreground' : 'text-muted-foreground')}>
          {run.description || run.type || 'Sub-agent'}
        </span>
        {failed && <span className="shrink-0 text-[11px] text-destructive">Failed</span>}
        {elapsed && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
        )}
        {shown && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" title="On screen" />}
      </button>
      {job && job.stoppable !== false && (
        <Button
          size="sm"
          variant="ghost"
          className="mr-1 h-6 shrink-0 px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
          onClick={() => stopBackgroundJob(chatId, job.id)}
        >
          Stop
        </Button>
      )}
    </div>
  )
}

/** The word a stopped delegate needs beside its name; a finished one needs none. */
const DELEGATE_WORD: Partial<Record<NonNullable<ChatMeta['delegation']>['status'], [string, string]>> = {
  failed: ['Failed', 'text-destructive'],
  cancelled: ['Stopped', 'text-muted-foreground'],
  interrupted: ['Interrupted', 'text-muted-foreground']
}

const DELEGATE_DOT: Record<NonNullable<ChatMeta['delegation']>['status'], string> = {
  running: 'bg-foreground',
  completed: 'bg-muted-foreground/60',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/60',
  interrupted: 'bg-muted-foreground/60'
}

/**
 * A delegate as one compact row: its state, its name — the word the user and
 * the parent both call it by; the task is a whole prompt and goes in the
 * tooltip — and the round's clock. A click opens the delegate's chat in place
 * of the thread's (`openAgentView`).
 */
export function DelegateRow({ chat, waiting = false }: { chat: ChatMeta; waiting?: boolean }): React.JSX.Element {
  const shown = useApp((s) => s.agentView === chat.id)
  const openAgentView = useApp((s) => s.openAgentView)
  const d = chat.delegation!
  const live = d.status === 'running'
  const elapsed = useElapsed(d.startedAt ?? d.createdAt, d.finishedAt, live)
  const task = (d.followUp ?? d.task).replace(/\s+/g, ' ').trim()
  const word = waiting ? (['Needs approval', 'text-warning'] as const) : DELEGATE_WORD[d.status]
  return (
    <button
      type="button"
      data-delegate-row={chat.id}
      data-live={live || undefined}
      title={task}
      onClick={() => void openAgentView(chat.id)}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
    >
      <AgentMark provider={chat.provider} live={live && !waiting} dot={waiting ? 'bg-warning' : DELEGATE_DOT[d.status]} />
      <span className={cn('min-w-0 flex-1 truncate font-medium', live ? 'text-foreground' : 'text-muted-foreground')}>
        {d.name}
      </span>
      {word && <span className={cn('shrink-0 text-[11px]', word[1])}>{word[0]}</span>}
      {elapsed && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
      )}
      {shown && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" title="On screen" />}
    </button>
  )
}

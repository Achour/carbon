import * as React from 'react'
import type { ChatMeta, Provider } from '@shared/types'
import { agentColumnId, type AgentRunView } from '@shared/agentRuns'
import { useApp } from '@/store'
import { useAgents } from '@/agentsStore'
import { isAgentJob } from '@/components/BackgroundJobs'
import { useElapsed } from '@/components/messages/AgentRows'
import { delegateLook } from '@/components/messages/DelegateCard'
import { ProviderMark } from '@/components/ui/provider-mark'
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
 * `agents_delegate` — oldest first. Killed ones included: this is a roster, and
 * opening one takes the kill back.
 */
export function useThreadDelegates(threadId: string): ChatMeta[] {
  const chats = useApp((s) => s.chats)
  return React.useMemo(
    () => chats.filter((c) => c.sideOf === threadId && c.delegation).sort((a, b) => a.createdAt - b.createdAt),
    [chats, threadId]
  )
}

/**
 * One spawned sub-agent as a compact row: the provider's mark with a status
 * dot, `type: description`, its clock, a dot while it is the page on screen,
 * and the Stop a backgrounded one needs. A click opens the agent in place of
 * the chat (`openAgentView`). Shared by the header's robot menu and the session
 * rail's Agents card, so the two can never disagree about what a row does.
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
  return (
    <div className="group flex items-center rounded-md hover:bg-accent">
      <button
        type="button"
        data-subagent-row={run.id}
        onClick={() => void openAgentView(viewId)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
          run.depth > 0 && 'pl-6'
        )}
      >
        <span className="relative shrink-0">
          <ProviderMark provider={provider} className="size-3.5 text-muted-foreground" />
          <span
            className={cn(
              'absolute -right-1 -bottom-1 size-1.5 rounded-full',
              running ? 'animate-pulse bg-primary' : run.status === 'failed' ? 'bg-destructive' : 'bg-success'
            )}
          />
        </span>
        <span className={cn('min-w-0 flex-1 truncate', !running && 'text-muted-foreground')}>
          {run.type && <span className="text-muted-foreground">{run.type}: </span>}
          {run.description || 'Sub-agent'}
        </span>
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

/**
 * A delegate as one compact row: the provider's mark with the dot its
 * transcript card wears, `name: task`, and the round's clock. A click opens
 * the delegate's chat in place of the thread's (`openAgentView`).
 */
export function DelegateRow({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const waiting = useApp((s) => s.statuses[chat.id] === 'waiting-permission')
  const shown = useApp((s) => s.agentView === chat.id)
  const openAgentView = useApp((s) => s.openAgentView)
  const d = chat.delegation!
  const look = delegateLook(chat, waiting)
  const elapsed = useElapsed(d.startedAt ?? d.createdAt, d.finishedAt, look.live)
  const task = (d.followUp ?? d.task).replace(/\s+/g, ' ').trim()
  return (
    <button
      type="button"
      data-delegate-row={chat.id}
      title={`${look.word}: ${task}`}
      onClick={() => void openAgentView(chat.id)}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
    >
      <span className="relative shrink-0">
        <ProviderMark provider={chat.provider} className="size-3.5 text-muted-foreground" />
        <span className={cn('absolute -right-1 -bottom-1 size-1.5 rounded-full', look.dot)} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', !look.live && 'text-muted-foreground')}>
        <span className="font-medium">{d.name}</span>
        {task && <span className="text-muted-foreground">: {task}</span>}
      </span>
      {elapsed && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
      )}
      {shown && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" title="On screen" />}
    </button>
  )
}

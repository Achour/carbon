import * as React from 'react'
import type { Provider } from '@shared/types'
import { agentColumnId, type AgentRunView } from '@shared/agentRuns'
import { threadFull, useApp } from '@/store'
import { useAgents } from '@/agentsStore'
import { isAgentJob } from '@/components/BackgroundJobs'
import { useElapsed } from '@/components/messages/AgentRows'
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
 * One spawned sub-agent as a compact row: the provider's mark with a status
 * dot, `type: description`, its clock, a dot while its column is open, and the
 * Stop a backgrounded one needs. A click opens the agent as a column, or folds
 * an open one back. Shared by the header's robot menu and the session rail's
 * Agents card, so the two can never disagree about what a row does.
 */
export function SubagentRow({
  chatId,
  run,
  provider,
  openIds
}: {
  chatId: string
  run: AgentRunView
  provider: Provider
  openIds: readonly string[]
}): React.JSX.Element {
  const toggleAgentColumn = useApp((s) => s.toggleAgentColumn)
  const stopBackgroundJob = useApp((s) => s.stopBackgroundJob)
  const full = useApp(threadFull)
  const running = run.status === 'running'
  // `callId` is the spawning call's id, which is what a run is keyed by.
  const job = useApp((s) =>
    running ? s.backgroundJobs[chatId]?.find((j) => isAgentJob(j.type) && j.callId === run.id) : undefined
  )
  const elapsed = useElapsed(run.startedAt, run.endedAt, running)
  const columnOpen = openIds.includes(agentColumnId(chatId, run.id))
  return (
    <div className="group flex items-center rounded-md hover:bg-accent">
      <button
        type="button"
        data-subagent-row={run.id}
        disabled={!columnOpen && full}
        title={!columnOpen && full ? 'The thread already shows four chats — close one to open this agent.' : undefined}
        onClick={() => toggleAgentColumn(chatId, run.id)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] disabled:opacity-50',
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
        {columnOpen && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" title="Open" />}
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

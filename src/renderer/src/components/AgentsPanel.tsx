import * as React from 'react'
import { Bot } from 'lucide-react'
import {
  formatAgentDuration,
  formatAgentTokens,
  type AgentRunView
} from '@shared/agentRuns'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { useAgents } from '@/agentsStore'

/**
 * Every sub-agent this chat has spawned, with what it is running on and what it
 * has spent — the one place the whole fan-out is visible at once.
 *
 * The transcript can show an agent's *work*, and does; what it cannot show is
 * five of them at the same time, because each card sits where its spawn landed
 * and the running ones scroll away under the output of the agent that answered
 * first. So this reads off the same `ToolPart`s the cards do (see
 * `@shared/agentRuns`) and lays them out as a roster instead of a stream.
 *
 * Nothing here is provider-specific. Claude reports a model and a token total
 * per step, Codex reports both plus an effort off the child's own rollout file,
 * and Grok reports neither — so a Grok row is a name, a status and a clock. A
 * missing field is *drawn missing* rather than filled in with the parent's
 * model, which would be a plausible-looking guess about the one thing this
 * panel exists to state.
 */
export function AgentsPanel(): React.JSX.Element {
  const runs = useAgents((s) => s.runs)
  const totals = useAgents((s) => s.totals)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Bot className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Spawned agents
          </span>
        </div>
        {runs.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">
            No agents have been spawned in this chat.
          </div>
        ) : (
          <div className="space-y-px">
            {runs.map((run) => (
              <AgentRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
      {runs.length > 0 && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <StatusDot status={totals.running > 0 ? 'running' : 'done'} />
          <span className={cn('tabular-nums', totals.running > 0 && 'text-foreground')}>
            {totals.running > 0
              ? `${totals.running} working`
              : `${totals.total} ${totals.total === 1 ? 'agent' : 'agents'}`}
          </span>
          <span className="ml-auto tabular-nums">
            {totals.tokens > 0 ? `Σ ${formatAgentTokens(totals.tokens)} tok` : ''}
          </span>
        </footer>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: AgentRunView['status'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'running'
          ? 'animate-pulse bg-primary'
          : status === 'failed'
            ? 'bg-destructive'
            : 'bg-muted-foreground/50'
      )}
    />
  )
}

/**
 * A live clock, ticking in the component.
 *
 * Elapsed time is the one number here that changes without any event arriving,
 * and putting it in the store would mean a state write per second per chat for
 * a value only this list reads. The interval runs only while something is
 * actually running.
 */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

function AgentRow({ run }: { run: AgentRunView }): React.JSX.Element {
  const now = useNow(run.status === 'running')
  const focusAgent = useAgents((s) => s.focusAgent)
  // While it runs the clock is against *now*; once settled it is against the
  // agent's last activity — which is not the same as when its spawning call
  // returned, since a backgrounded agent's call returns immediately.
  const end = run.status === 'running' ? now : run.endedAt
  const elapsed =
    run.startedAt != null && end != null ? formatAgentDuration(end - run.startedAt) : null

  // Scroll the transcript to the card this row describes. The anchor is on the
  // card itself (`data-agent-run`), the same way the review's next/previous
  // change walks `[data-diff-hunk]`.
  const reveal = (): void => {
    // Naming it opens the card (see agentsStore); scrolling puts it on screen.
    focusAgent(run.id)
    const el = document.querySelector(`[data-agent-run="${CSS.escape(run.id)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const meta = [
    run.model,
    run.effort,
    run.tokens ? `${formatAgentTokens(run.tokens)} tok` : null,
    run.tools > 0 ? `${run.tools} ${run.tools === 1 ? 'tool' : 'tools'}` : null
  ].filter(Boolean) as string[]

  return (
    <button
      type="button"
      onClick={reveal}
      style={run.depth > 0 ? { marginLeft: `${Math.min(run.depth, 3) * 12}px` } : undefined}
      className="group flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent/50"
    >
      <span className="mt-[7px]">
        <StatusDot status={run.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              run.status === 'running' ? 'text-foreground' : 'text-foreground/80'
            )}
          >
            {run.description || 'Agent'}
          </span>
          {run.type && (
            <span className="shrink-0 rounded bg-secondary px-1 py-px font-mono text-[10px] text-muted-foreground">
              {run.type}
            </span>
          )}
          {elapsed && (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
              {elapsed}
            </span>
          )}
        </span>
        {run.status === 'running' && (
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="shimmer-text">{run.current ? `▸ ${run.current}` : 'Working'}</span>
          </span>
        )}
        {run.status === 'failed' && (
          <span className="mt-0.5 block text-[11px] text-destructive/80">Failed</span>
        )}
        {meta.length > 0 && (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground/70">
            {meta.join(' · ')}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The one line the transcript gets: how many agents are working right now, what
 * they have cost between them, and the way into the roster.
 *
 * It sits above the composer rather than in the message list because a fan-out
 * is *state*, not an event — five cards spread through the transcript scroll
 * away the moment the first agent answers, and this is the thing you want on
 * screen while you read what they produce. It is present only while something
 * is running, so it costs nothing the rest of the time.
 */
export function AgentActivityBar(): React.JSX.Element | null {
  const totals = useAgents((s) => s.totals)
  const openAgentsPanel = useApp((s) => s.openAgentsPanel)
  if (totals.running === 0) return null

  return (
    <button
      type="button"
      onClick={openAgentsPanel}
      className="group mb-2 flex w-full animate-enter items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <StatusDot status="running" />
      <span className="shimmer-text min-w-0 flex-1 truncate text-left">
        {totals.running} {totals.running === 1 ? 'agent' : 'agents'} working
      </span>
      {totals.tokens > 0 && (
        <span className="shrink-0 tabular-nums">Σ {formatAgentTokens(totals.tokens)} tok</span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground/70 group-hover:text-foreground">
        Open Agents ▸
      </span>
    </button>
  )
}

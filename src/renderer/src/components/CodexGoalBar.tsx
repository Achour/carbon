import * as React from 'react'
import {
  Check,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
  X
} from 'lucide-react'
import type { CodexGoal, CodexGoalStatus } from '@shared/types'
import { formatTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { WithTooltip } from '@/components/ui/tooltip'

const STATUS_LABEL: Record<CodexGoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limited',
  budgetLimited: 'Budget reached',
  complete: 'Complete'
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return `${seconds}s`
}

function StatusMark({
  status,
  working
}: {
  status: CodexGoalStatus
  working: boolean
}): React.JSX.Element {
  if (working) return <Loader2 className="size-3 animate-spin text-primary" />
  if (status === 'complete') return <Check className="size-3 text-success" strokeWidth={2.5} />
  return (
    <span
      className={cn(
        'size-1.5 rounded-full',
        status === 'active'
          ? 'animate-pulse bg-primary'
          : status === 'paused'
            ? 'bg-warning'
            : status === 'blocked'
              ? 'bg-destructive'
              : 'bg-muted-foreground/60'
      )}
    />
  )
}

/**
 * Codex's persisted thread goal, kept on screen beside the work it governs.
 *
 * This is App Server state, not a second Carbon checklist: reads and controls
 * go through thread/goal/* and live usage/status updates arrive on the shared
 * chat event channel. The edit form expands in place so a goal never turns the
 * composer into a modal workflow.
 */
export function CodexGoalBar({
  chatId,
  threadId,
  working
}: {
  chatId: string
  threadId?: string
  working: boolean
}): React.JSX.Element | null {
  const goal = useApp((s) => {
    const value = s.codexGoals[chatId]
    return value?.threadId === threadId ? value : null
  })
  const loadGoal = useApp((s) => s.loadCodexGoal)
  const setGoal = useApp((s) => s.setCodexGoal)
  const clearGoal = useApp((s) => s.clearCodexGoal)
  const [editing, setEditing] = React.useState(false)
  const [objective, setObjective] = React.useState('')
  const [pending, setPending] = React.useState<'status' | 'edit' | 'clear' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // A chat with no thread cannot have a persisted native goal yet. Do not
    // start an empty Codex thread merely because the user opened the chat.
    if (!threadId) return
    void loadGoal(chatId).catch(() => {
      // No strip is the honest fallback for an unavailable/older App Server;
      // slash-command errors still surface in the transcript when invoked.
    })
  }, [chatId, loadGoal, threadId])

  React.useEffect(() => {
    if (goal && !editing) setObjective(goal.objective)
  }, [goal, editing])

  if (!goal) return null

  const updateStatus = async (status: CodexGoalStatus): Promise<void> => {
    setPending('status')
    setError(null)
    try {
      await setGoal(chatId, { status })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const saveEdit = async (): Promise<void> => {
    const trimmed = objective.trim()
    if (!trimmed) {
      setError('The goal cannot be empty.')
      return
    }
    setPending('edit')
    setError(null)
    try {
      await setGoal(chatId, { objective: trimmed, status: 'active' })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const clear = async (): Promise<void> => {
    setPending('clear')
    setError(null)
    try {
      await clearGoal(chatId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const budget = goal.tokenBudget ?? null
  const progress = budget && budget > 0 ? Math.min(100, (goal.tokensUsed / budget) * 100) : null
  const canResume = goal.status !== 'active' && goal.status !== 'complete'
  const isWorking = working && goal.status === 'active'

  return (
    <div data-codex-goal className="border-b border-border">
      <div className="group flex min-h-10 items-center rounded-t-2xl transition-colors hover:bg-accent/30 focus-within:bg-accent/30">
        <div className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-3.5">
          <Target className="size-3.5 shrink-0 text-primary" />
          <span className="shrink-0 text-xs font-medium">Goal</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {goal.objective}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <StatusMark status={goal.status} working={isWorking} />
            {isWorking ? 'Working' : STATUS_LABEL[goal.status]}
          </span>
          <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 tabular-nums sm:inline">
            {budget != null
              ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(budget)}`
              : formatTokens(goal.tokensUsed)}
            {' · '}
            {formatElapsed(goal.timeUsedSeconds)}
          </span>
        </div>

        {goal.status === 'active' ? (
          <WithTooltip label="Pause goal">
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => void updateStatus('paused')}
              aria-label="Pause goal"
            >
              {pending === 'status' ? <Loader2 className="animate-spin" /> : <Pause />}
            </Button>
          </WithTooltip>
        ) : canResume ? (
          <WithTooltip label="Resume goal">
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => void updateStatus('active')}
              aria-label="Resume goal"
            >
              {pending === 'status' ? <Loader2 className="animate-spin" /> : <Play />}
            </Button>
          </WithTooltip>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={pending !== null}
                aria-label="Goal actions"
              >
                {pending === 'clear' ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              onClick={() => {
                setObjective(goal.objective)
                setError(null)
                setEditing(true)
              }}
            >
              <Pencil className="size-3.5" />
              Edit goal
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={clear}>
              <Trash2 className="size-3.5" />
              Clear goal
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {progress != null && !editing && (
        <div
          className="h-px overflow-hidden bg-primary/10"
          aria-label={`${Math.round(progress)}% of token budget used`}
        >
          <div
            className="h-full bg-primary/65 transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {editing && (
        <div className="px-3.5 pb-2.5 pl-9">
          <textarea
            autoFocus
            value={objective}
            maxLength={4_000}
            rows={2}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void saveEdit()
              if (event.key === 'Escape') {
                setEditing(false)
                setError(null)
              }
            }}
            className="min-h-16 w-full resize-y rounded-lg border border-border bg-background/70 px-2.5 py-2 text-[13px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
            aria-label="Goal objective"
          />
          <div className="mt-2 flex items-center gap-2">
            {error ? (
              <span className="min-w-0 flex-1 truncate text-[11px] text-destructive">{error}</span>
            ) : (
              <span className="min-w-0 flex-1 text-[10px] text-muted-foreground/60">
                {objective.length.toLocaleString()}/4,000
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
            >
              <X />
              Cancel
            </Button>
            <Button size="sm" disabled={pending !== null || !objective.trim()} onClick={saveEdit}>
              {pending === 'edit' ? <Loader2 className="animate-spin" /> : <Check />}
              Save
            </Button>
          </div>
        </div>
      )}

      {!editing && error && (
        <div className="px-3.5 pb-2 pl-9 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}

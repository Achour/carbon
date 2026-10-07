import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Activity, Bot, Boxes, SquareTerminal, Workflow } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'
import type { BackgroundJob } from '@shared/types'

// Stable empty reference so the selector never returns a fresh array (which
// would spin the getSnapshot loop).
const EMPTY: BackgroundJob[] = []

// The wire spellings are the CLI's `task_type` — `local_bash`, `local_agent`,
// `mcp_task`, … — which the first version of this switch never saw, so every
// job drew the generic mark and named itself in snake_case. The friendly
// spellings stay so a provider that reports them keeps matching.
function jobIcon(type: string): React.ElementType {
  switch (type) {
    case 'shell':
    case 'local_bash':
      return SquareTerminal
    case 'subagent':
    case 'local_agent':
    case 'remote_agent':
      return Bot
    case 'monitor':
    case 'local_monitor':
      return Activity
    case 'workflow':
    case 'local_workflow':
      return Workflow
    default:
      return Boxes
  }
}

/**
 * Whether this job IS a spawned agent. Those are left to the header's robot
 * menu (`SubagentsMenu`), which lists every run with its elapsed time, opens it
 * as a column and carries the Stop a backgrounded one needs — so counting them
 * here too drew two indicators for one fan-out, side by side. The wire
 * spellings are the CLI's `task_type`; the friendly ones stay for a provider
 * that reports those instead.
 */
export function isAgentJob(type: string): boolean {
  return type === 'subagent' || type === 'local_agent' || type === 'remote_agent'
}

function jobLabel(type: string): string {
  switch (type) {
    case 'local_bash':
      return 'shell'
    case 'local_agent':
      return 'agent'
    case 'remote_agent':
      return 'remote agent'
    case 'local_monitor':
      return 'monitor'
    case 'local_workflow':
      return 'workflow'
    case 'mcp_task':
      return 'MCP task'
    default:
      return type
  }
}

/**
 * Header pill listing the SDK's live background tasks for one chat
 * (backgrounded shell commands, monitors, workflows — agents live in the robot
 * menu, see `isAgentJob`). Hidden when there are none; each job can be stopped
 * from the popover. The thread header passes the focused chat, so the pill
 * always describes the column you are in.
 */
export function BackgroundJobs({ chatId }: { chatId: string }): React.JSX.Element | null {
  const all = useApp((s) => s.backgroundJobs[chatId]) ?? EMPTY
  const jobs = React.useMemo(() => all.filter((j) => !isAgentJob(j.type)), [all])
  const stopBackgroundJob = useApp((s) => s.stopBackgroundJob)
  const [open, setOpen] = React.useState(false)

  if (jobs.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="no-drag h-7 shrink-0 gap-1.5 rounded-md border border-border bg-secondary/50 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
            aria-label={`${jobs.length} background job${jobs.length === 1 ? '' : 's'} running`}
          >
            <DotSpinner className="size-3 text-primary" />
            <span className="tabular-nums">
              {jobs.length} running
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          Background jobs
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {jobs.map((job) => {
            const Icon = jobIcon(job.type)
            return (
              <div
                key={job.id}
                className="group flex items-start gap-2.5 px-3 py-2 hover:bg-accent/50"
              >
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] leading-snug">
                    {job.description || job.type}
                  </div>
                  <div className="text-[11px] text-muted-foreground/70">{jobLabel(job.type)}</div>
                </div>
                {job.stoppable !== false && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={() => stopBackgroundJob(chatId, job.id)}
                  >
                    Stop
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

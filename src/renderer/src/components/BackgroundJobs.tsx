import * as React from 'react'
import { Activity, Bot, Boxes, Loader2, SquareTerminal, Workflow } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'
import type { BackgroundJob } from '@shared/types'

// Stable empty reference so the selector never returns a fresh array (which
// would spin the getSnapshot loop).
const EMPTY: BackgroundJob[] = []

function jobIcon(type: string): React.ElementType {
  switch (type) {
    case 'shell':
      return SquareTerminal
    case 'subagent':
      return Bot
    case 'monitor':
      return Activity
    case 'workflow':
      return Workflow
    default:
      return Boxes
  }
}

/**
 * Header pill listing the SDK's live background tasks for the active chat
 * (backgrounded shell commands, sub-agents, monitors, workflows). Hidden when
 * there are none; each job can be stopped from the popover.
 */
export function BackgroundJobs(): React.JSX.Element | null {
  const activeId = useApp((s) => s.activeId)
  const jobs = useApp((s) => (activeId ? s.backgroundJobs[activeId] : undefined)) ?? EMPTY
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
            <Loader2 className="size-3 animate-spin text-primary" />
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
                  <div className="text-[11px] text-muted-foreground/70">{job.type}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={() => stopBackgroundJob(job.id)}
                >
                  Stop
                </Button>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

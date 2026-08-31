import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { Check, ChevronRight, ListTodo } from 'lucide-react'
import type { TaskItem } from '@/lib/taskList'

/**
 * A finished checklist, parked in the transcript at the end of the turn that
 * finished it.
 *
 * This is the other half of `TaskDock`, and the two are one object seen at two
 * moments: while the plan is being worked it is state, so it rides the composer
 * where it stays on screen; once it is done it is a record of what that turn
 * set out to do, so it belongs with the turn, in history, and the composer goes
 * back to being the composer. `foldTaskTimeline` decides which of the two holds
 * the list, so it is never in both places and never in neither.
 *
 * The header is deliberately the dock's own row, down to the `6/6` — the box
 * the user was watching a second ago should be recognizable as the box that
 * just landed, and a re-worded summary is a second object as far as the eye is
 * concerned. What does change is the rows: the dock strikes completed tasks
 * through to separate them from the ones still to come, and here there are no
 * others, so a struck-through wall of text would carry no information at the
 * cost of being the hardest thing on screen to read.
 *
 * Uncapped, unlike the dock's list. The cap exists there because that box is
 * glued to the input and a twenty-task plan would push it off screen; a card in
 * the transcript is history, and scrolls like everything else in it — the same
 * reason `TurnChangesCard` lists every file it changed.
 */
export const TasksCard = React.memo(function TasksCard({
  tasks
}: {
  tasks: TaskItem[]
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true)
  if (tasks.length === 0) return null

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="animate-enter overflow-hidden rounded-xl border border-border bg-card/60"
    >
      <Collapsible.Trigger className="group flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/30">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[13px] font-medium">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">All done</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {tasks.length}/{tasks.length}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-1.5 border-t border-border/70 px-3 py-2.5">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2.5 text-[13px] leading-snug">
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2.5} />
              <span className="text-muted-foreground">{task.subject}</span>
            </div>
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
})

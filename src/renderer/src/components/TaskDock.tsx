import * as React from 'react'
import { Check, ChevronDown, Circle, ListTodo, Loader2 } from 'lucide-react'
import { useTaskList } from '@/taskListStore'
import type { TaskItem } from '@/lib/taskList'
import { cn } from '@/lib/utils'

/** Stable empty list, so a chat with no checklist never mints a new array. */
const NO_TASKS: TaskItem[] = []

/**
 * The agent's checklist, docked on top of the composer.
 *
 * It used to be a card in the transcript, drawn once per checklist call, and
 * that is the wrong shape for what it is: a checklist is **state, not an
 * event** — the same argument `AgentActivityBar` makes for the agent roster.
 * A card lands where it was written and scrolls away under the work it
 * describes, so the one thing you want on screen while reading a long turn is
 * the one thing that isn't; and because the list changes many times a turn, the
 * transcript filled with near-identical boxes of a list that only ever had one
 * current value. There is now one box, it holds that value, and it is always
 * where you left it.
 *
 * It renders **inside** the composer's own bordered box (`Composer`'s `header`)
 * rather than as a sibling above it. That is what makes it read as one object:
 * a separate box would need its own border, and the composer's border moves —
 * to the ring colour on focus, to primary on a file drag — so the two halves of
 * one outline would disagree at exactly the moments the user is acting.
 *
 * Collapsed by default: what you want at a glance is how far along the plan is
 * and what is happening right now, which is the row itself, and the list is one
 * click away. Opening it is scoped to the current visit — `ChatView` is keyed by
 * chat id, so the dock remounts collapsed when you come back — which is the
 * right default for a box glued to the input: it never quietly eats half the
 * composer's room on a chat you only came back to type in.
 */
export function TaskDock({ chatId }: { chatId: string }): React.JSX.Element | null {
  // Never the previous chat's plan: the publish happens in an effect, so this
  // store trails a chat switch by a frame. See `taskListStore`.
  const tasks = useTaskList((s) => (s.chatId === chatId ? s.tasks : NO_TASKS))
  const [open, setOpen] = React.useState(false)

  if (tasks.length === 0) return null

  const done = tasks.filter((t) => t.status === 'completed').length
  const active = tasks.find((t) => t.status === 'in_progress')

  return (
    <div data-task-dock className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-t-2xl px-3.5 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {active
            ? (active.activeForm ?? active.subject)
            : done === tasks.length
              ? 'All done'
              : undefined}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {done}/{tasks.length}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        // Capped and scrolled rather than allowed to grow: a twenty-task plan
        // would otherwise push the input it is attached to off the screen.
        <div className="max-h-[38vh] space-y-1.5 overflow-y-auto px-3.5 pb-2.5">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2.5 text-[13px] leading-snug">
              <span className="mt-0.5 shrink-0">
                {task.status === 'completed' ? (
                  <Check className="size-3.5 text-success" strokeWidth={2.5} />
                ) : task.status === 'in_progress' ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <Circle className="size-3.5 text-muted-foreground/40" strokeWidth={2} />
                )}
              </span>
              <span
                className={cn(
                  task.status === 'completed' && 'text-muted-foreground/70 line-through',
                  task.status === 'in_progress' && 'font-medium',
                  task.status === 'pending' && 'text-muted-foreground'
                )}
              >
                {task.status === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

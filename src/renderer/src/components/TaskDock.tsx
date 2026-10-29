import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Check, ChevronDown, Circle, ListTodo } from 'lucide-react'
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
 * event** — the same argument the session rail's Agents card makes for the roster.
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
 * click away. **The open list floats above the composer** rather than growing
 * inside it: grown in place, opening a six-task plan raised the composer's top
 * edge by the list's height and shoved the transcript up under the reader's
 * eye, then dropped it back on close. Floating, the row is the only thing the
 * dock ever adds to the layout. Escape or a click outside closes it, as any
 * popover does. Opening is scoped to the current visit — `ChatView` is keyed by
 * chat id, so the dock remounts collapsed when you come back.
 */
export function TaskDock({ chatId }: { chatId: string }): React.JSX.Element | null {
  // Keyed by chat, so a dock never draws another column's plan — nor the
  // previous chat's, since the entry is removed when its `ChatView` unmounts.
  const tasks = useTaskList((s) => s.byChat[chatId] ?? NO_TASKS)
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const shown = open && tasks.length > 0

  React.useEffect(() => {
    if (!shown) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [shown])

  if (tasks.length === 0) return null

  const done = tasks.filter((t) => t.status === 'completed').length
  const active = tasks.find((t) => t.status === 'in_progress')

  return (
    <div ref={rootRef} data-task-dock className="relative border-b border-border">
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
            !open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        // Out of flow, so opening it moves nothing beneath it; capped and
        // scrolled so a twenty-task plan cannot climb off the top of the window.
        <div className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[38vh] space-y-1.5 overflow-y-auto rounded-xl border border-border bg-popover px-3.5 py-2.5 shadow-xl">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2.5 text-[13px] leading-snug">
              <span className="mt-0.5 shrink-0">
                {task.status === 'completed' ? (
                  <Check className="size-3.5 text-success" strokeWidth={2.5} />
                ) : task.status === 'in_progress' ? (
                  <DotSpinner className="size-3.5 text-primary" />
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

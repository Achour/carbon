import * as React from 'react'
import { Check, ChevronRight, Circle, ListTodo, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TodoItem {
  content?: string
  status?: string
  activeForm?: string
}

/**
 * The agent's task checklist. Only the chat's latest card (`live`) stays
 * expanded; earlier ones collapse to a summary row.
 *
 * Takes the list rather than the tool part, because the two providers deliver
 * it in completely different shapes: Codex's `TodoWrite` carries the whole list
 * in one call, while Claude Code builds it up across many `TaskCreate` /
 * `TaskUpdate` calls that have to be folded first (see `lib/taskList.ts`).
 */
export const TodoCard = React.memo(function TodoCard({
  todos,
  live
}: {
  todos: TodoItem[]
  live: boolean
}): React.JSX.Element {
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')

  const [open, setOpen] = React.useState(live)
  React.useEffect(() => setOpen(live), [live])

  return (
    <div className="animate-enter overflow-hidden rounded-xl border border-border bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
            open && 'rotate-90'
          )}
        />
        <ListTodo className="size-4 shrink-0 text-primary" />
        <span className="shrink-0 text-[13px] font-medium">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {todos.length === 0
            ? 'Updating task list…'
            : active
              ? (active.activeForm ?? active.content)
              : done === todos.length
                ? 'All done'
                : undefined}
        </span>
        {todos.length > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {done}/{todos.length}
          </span>
        )}
      </button>
      {open && todos.length > 0 && (
        <div className="space-y-1.5 border-t border-border px-3.5 py-2.5">
          {todos.map((todo, i) => {
            const status = todo.status ?? 'pending'
            return (
              <div key={i} className="flex items-start gap-2.5 text-[13px] leading-snug">
                <span className="mt-0.5 shrink-0">
                  {status === 'completed' ? (
                    <Check className="size-3.5 text-success" strokeWidth={2.5} />
                  ) : status === 'in_progress' ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <Circle className="size-3.5 text-muted-foreground/40" strokeWidth={2} />
                  )}
                </span>
                <span
                  className={cn(
                    status === 'completed' && 'text-muted-foreground/70 line-through',
                    status === 'in_progress' && 'font-medium',
                    status === 'pending' && 'text-muted-foreground'
                  )}
                >
                  {status === 'in_progress' && live ? (todo.activeForm ?? todo.content) : todo.content}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

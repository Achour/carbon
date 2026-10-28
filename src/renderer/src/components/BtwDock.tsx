import * as React from 'react'
import { MessageCircleQuestion, X } from 'lucide-react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Markdown } from '@/components/Markdown'
import type { BtwEntry } from '@shared/btw'
import { useApp } from '@/store'
import { cn } from '@/lib/utils'

/** Stable empty list, so a chat with no side questions never mints a new array. */
const NO_ENTRIES: BtwEntry[] = []

/**
 * The `/btw` card: side questions and their answers, docked on top of the
 * composer inside its own frame (`Composer`'s `header`, beside `TaskDock` and
 * `PromptDock` — see `TaskDock` for why inside).
 *
 * It is **in flow**, where the task list floats, and on purpose. The list opens
 * on a click while you read the transcript, so it must not move what you are
 * reading; this opens because you just asked something, with your eye on the
 * composer, and the answer is the thing to read. Floated, it would sit over the
 * foot of the transcript — the part a running turn is writing to. In flow it
 * only shortens the scroller, which keeps following the bottom.
 *
 * Nothing in it is part of the conversation. It holds no turn and no history:
 * it closes on its button, or Escape from an empty composer, and a pending
 * answer is cancelled with it. Several questions stack in one card, and each
 * one carries the answers above it to the model, so a follow-up reads as one.
 */
export function BtwDock({ chatId, cwd }: { chatId: string; cwd?: string }): React.JSX.Element | null {
  const entries = useApp((s) => s.btw[chatId] ?? NO_ENTRIES)
  const dismiss = useApp((s) => s.dismissBtw)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // The newest question is the one being waited on; keep it in view as the
  // card grows past its cap.
  const last = entries[entries.length - 1]
  const lastSettled = !!(last?.answer || last?.error)
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, lastSettled])

  if (entries.length === 0) return null

  return (
    <div data-btw-dock className="animate-enter border-b border-border">
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-1">
        <MessageCircleQuestion className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">Side question</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          Not added to the chat
        </span>
        <button
          type="button"
          onClick={() => dismiss(chatId)}
          title="Close (Esc)"
          aria-label="Close side question"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div ref={scrollRef} className="max-h-[40vh] overflow-y-auto px-3.5 pb-2.5">
        <BtwThread entries={entries} cwd={cwd} />
      </div>
    </div>
  )
}

/** The questions and answers themselves — the desktop's card and the phone's sheet. */
export function BtwThread({
  entries,
  cwd,
  className
}: {
  entries: BtwEntry[]
  cwd?: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('space-y-3', className)}>
      {entries.map((e) => (
        <div key={e.id} className="space-y-1">
          <div className="text-[13px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground/80">/btw</span> {e.question || '…'}
          </div>
          {e.answer ? (
            <div className="text-[13px]">
              <Markdown text={e.answer} cwd={cwd ?? null} />
            </div>
          ) : (
            <div
              className={cn(
                'flex items-center gap-2 text-[13px]',
                e.error ? 'text-warning' : 'text-muted-foreground'
              )}
            >
              {!e.error && <DotSpinner className="size-3.5 text-primary" />}
              <span>{e.error ?? 'Answering…'}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

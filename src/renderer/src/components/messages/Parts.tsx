import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { AlertTriangle, ChevronRight, FileText, MousePointerClick } from 'lucide-react'
import type { AssistantMessage, EventMessage, ToolPart, UserMessage } from '@shared/types'
import { cn } from '@/lib/utils'
import { formatCost, formatDuration } from '@/lib/format'
import { Markdown } from '@/components/Markdown'
import { GROUPABLE_TOOLS, ToolCard, ToolGroup } from './ToolCard'
import { TodoCard } from './TodoCard'

/** Group a run of this many consecutive read/search tools into one row. */
const GROUP_MIN = 3

export const UserBubble = React.memo(function UserBubble({
  message
}: {
  message: UserMessage
}): React.JSX.Element {
  return (
    <div className="flex animate-enter flex-col items-end gap-1.5">
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {message.attachments.map((att) =>
            att.kind === 'image' || (att.kind === 'element' && att.data) ? (
              <img
                key={att.id}
                src={`data:${att.mediaType};base64,${att.data}`}
                alt={att.name}
                title={att.name}
                className="max-h-40 max-w-56 rounded-xl border border-border object-cover"
              />
            ) : att.kind === 'element' ? (
              <div
                key={att.id}
                title={att.element?.selector}
                className="flex h-8 max-w-56 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5"
              >
                <MousePointerClick className="size-3.5 shrink-0 text-primary" />
                <span className="truncate font-mono text-[11px]">{att.name}</span>
              </div>
            ) : (
              <div
                key={att.id}
                title={att.path}
                className="flex h-8 max-w-56 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs">{att.name}</span>
              </div>
            )
          )}
        </div>
      )}
      {message.text && (
        <div className="max-w-[85%] select-text rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap">
          {message.text}
        </div>
      )}
    </div>
  )
})

export const ThinkingBlock = React.memo(function ThinkingBlock({
  text,
  active
}: {
  text: string
  active: boolean
}): React.JSX.Element {
  return (
    <Collapsible.Root className="animate-enter">
      <Collapsible.Trigger
        className={cn(
          'group flex items-center gap-1.5 rounded-md py-0.5 pr-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground',
          active && 'shimmer-text'
        )}
      >
        <ChevronRight className="size-3 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
        {active ? 'Thinking…' : 'Thought process'}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="mt-1.5 ml-1 select-text border-l-2 border-border pl-3.5 text-[13px] leading-relaxed text-muted-foreground italic whitespace-pre-wrap">
          {text}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
})

export const AssistantBlock = React.memo(function AssistantBlock({
  message,
  cwd,
  streaming,
  onOpenPlan,
  latestTodoId
}: {
  message: AssistantMessage
  cwd: string
  streaming: boolean
  onOpenPlan?: (plan: string) => void
  /** toolUseId of the chat's most recent TodoWrite; that card stays expanded. */
  latestTodoId?: string | null
}): React.JSX.Element {
  const parts = message.parts
  const lastIndex = parts.length - 1

  // Coalesce consecutive read/search tools into groups so a long run of reads
  // collapses to one row instead of flooding the transcript. Everything else
  // (text, thinking, edits, todos, agents) renders individually as before.
  const items: Array<
    | { kind: 'group'; parts: ToolPart[]; key: string }
    | { kind: 'single'; part: NonNullable<(typeof parts)[number]>; index: number }
  > = []
  let run: { part: ToolPart; index: number }[] = []
  const flushRun = (): void => {
    if (run.length >= GROUP_MIN) {
      items.push({ kind: 'group', parts: run.map((r) => r.part), key: `grp-${run[0].index}` })
    } else {
      for (const r of run) items.push({ kind: 'single', part: r.part, index: r.index })
    }
    run = []
  }
  parts.forEach((part, i) => {
    // Streamed arrays can be sparse; persisted ones turn holes into null.
    if (!part) return
    if (part.type === 'tool' && GROUPABLE_TOOLS.has(part.name)) {
      run.push({ part, index: i })
    } else {
      flushRun()
      items.push({ kind: 'single', part, index: i })
    }
  })
  flushRun()

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        if (item.kind === 'group') {
          return <ToolGroup key={item.key} parts={item.parts} cwd={cwd} />
        }
        const { part, index: i } = item
        const isLast = i === lastIndex
        if (part.type === 'text') {
          if (!part.text) return null
          return <Markdown key={i} text={part.text} cwd={cwd} />
        }
        if (part.type === 'thinking') {
          if (!part.text) return null
          return <ThinkingBlock key={i} text={part.text} active={streaming && isLast} />
        }
        if (part.name === 'TodoWrite') {
          return <TodoCard key={part.toolUseId} part={part} live={part.toolUseId === latestTodoId} />
        }
        return <ToolCard key={part.toolUseId} part={part} cwd={cwd} onOpenPlan={onOpenPlan} />
      })}
    </div>
  )
})

export const EventRow = React.memo(function EventRow({
  message
}: {
  message: EventMessage
}): React.JSX.Element | null {
  switch (message.kind) {
    case 'turn': {
      const s = message.stats
      if (!s) return null
      return (
        <div className="flex justify-end gap-1 pt-0.5 text-[11px] text-muted-foreground/70">
          <span>{formatDuration(s.durationMs)}</span>
          <span>·</span>
          <span>{formatCost(s.costUsd)}</span>
        </div>
      )
    }
    case 'compact':
    case 'info':
      return (
        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[11px] text-muted-foreground">{message.text}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )
    case 'error':
      return (
        <div className="flex animate-enter items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/8 px-3.5 py-2.5 dark:bg-destructive/10">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-destructive">Something went wrong</div>
            <div className="mt-0.5 select-text text-xs break-words text-muted-foreground">
              {message.text}
            </div>
          </div>
        </div>
      )
  }
})

export function StreamingIndicator({ label = 'Thinking…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shimmer-text text-[13px] font-medium">{label}</span>
    </div>
  )
}

import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  GitCommitHorizontal,
  Loader2,
  MousePointerClick,
  RotateCcw
} from 'lucide-react'
import type { AssistantMessage, EventMessage, RewindResult, ToolPart, UserMessage } from '@shared/types'
import { cn } from '@/lib/utils'
import { formatCost, formatDuration } from '@/lib/format'
import { Markdown, StreamingMarkdown, useStreamText } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WithTooltip } from '@/components/ui/tooltip'
import { useApp } from '@/store'
import { FILE_MUTATION_TOOLS, GROUPABLE_TOOLS, ToolCard, ToolGroup } from './ToolCard'
import { TodoCard } from './TodoCard'
import { useLatestTodo } from '@/latestTodoStore'

/**
 * Wraps `TodoCard` with an equality-selector subscription to the latest-todo
 * store. Only this leaf re-renders when the live task list changes — the id
 * never crosses the `AssistantBlock`/`MessageHistory` memo boundary, so history
 * rows are untouched while an agent flips todos mid-turn.
 */
const LiveTodoCard = React.memo(function LiveTodoCard({
  part
}: {
  part: ToolPart
}): React.JSX.Element {
  const live = useLatestTodo((s) => s.latestTodoId === part.toolUseId)
  return <TodoCard part={part} live={live} />
})

/**
 * Rewind affordance on a user message: reverts the working tree to the file
 * checkpoint taken when that message was sent (files only — the conversation is
 * untouched). Opens a popover that previews the impact (dry run) before applying.
 */
function RewindControl({ messageId }: { messageId: string }): React.JSX.Element {
  const rewindFiles = useApp((s) => s.rewindFiles)
  const provider = useApp((s) => s.chats.find((c) => c.id === s.activeId)?.provider)
  const [open, setOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<RewindResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<RewindResult | null>(null)

  React.useEffect(() => {
    if (!open) {
      setPreview(null)
      setDone(null)
      return
    }
    let alive = true
    void rewindFiles(messageId, true).then((r) => {
      if (alive) setPreview(r)
    })
    return () => {
      alive = false
    }
  }, [open, messageId, rewindFiles])

  // Codex has no file checkpoints — rewind always fails, so don't offer it.
  if (provider === 'codex') return <></>

  const noChanges = (preview?.filesChanged?.length ?? 0) === 0
  const apply = async (): Promise<void> => {
    setBusy(true)
    const r = await rewindFiles(messageId, false)
    setBusy(false)
    setDone(r)
    if (r.canRewind) setTimeout(() => setOpen(false), 1400)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label="Rewind files to here">
        <PopoverTrigger
          aria-label="Rewind files to this message"
          className="no-drag mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground data-[popup-open]:opacity-100"
        >
          <RotateCcw className="size-3.5" />
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent side="left" align="start" className="w-64">
        <div className="text-[13px] font-medium">Rewind files</div>
        {done ? (
          <p className={cn('mt-1.5 text-xs', done.canRewind ? 'text-muted-foreground' : 'text-destructive')}>
            {done.canRewind
              ? `Reverted ${done.filesChanged?.length ?? 0} file${(done.filesChanged?.length ?? 0) === 1 ? '' : 's'}.`
              : (done.error ?? 'Rewind failed.')}
          </p>
        ) : !preview ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Checking…
          </div>
        ) : preview.canRewind ? (
          <>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Restore the project files to their state when you sent this message. Later chat
              messages stay.
            </p>
            <div className="mt-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-[11px] tabular-nums text-muted-foreground">
              {noChanges
                ? 'No file changes to undo.'
                : `${preview.filesChanged!.length} file${preview.filesChanged!.length === 1 ? '' : 's'} · +${preview.insertions ?? 0} −${preview.deletions ?? 0}`}
            </div>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || noChanges} onClick={() => void apply()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Rewind'}
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {preview.error ?? 'Can’t rewind to this message.'}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Group a run of this many consecutive read/search tools into one row. */
const GROUP_MIN = 2

export const UserBubble = React.memo(function UserBubble({
  message
}: {
  message: UserMessage
}): React.JSX.Element {
  // App-initiated actions (e.g. a "Commit" from the source-control button) show
  // as a compact chip, Cursor-style — the verbose prompt behind it stays hidden.
  if (message.label) {
    return (
      <div className="group flex animate-enter items-center justify-end gap-1">
        <RewindControl messageId={message.id} />
        <div className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 py-1 pr-3 pl-2.5">
          <GitCommitHorizontal className="size-3.5 shrink-0 text-primary" />
          <span className="text-[12.5px] font-medium text-primary">{message.label}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="group flex animate-enter flex-col items-end gap-1.5">
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
      <div className="flex w-full items-start justify-end gap-1">
        <RewindControl messageId={message.id} />
        {message.text && (
          <div className="max-w-[85%] min-w-0 select-text rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[14px] leading-relaxed break-words whitespace-pre-wrap">
            {message.text}
          </div>
        )}
      </div>
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
  // Thinking streams as raw deltas (~25/s); commit at the same throttled rate
  // as streaming markdown so a long thought doesn't relayout on every token.
  const shown = useStreamText(text, active)
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
          {shown}
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
  summarizeEdits = false
}: {
  message: AssistantMessage
  cwd: string
  streaming: boolean
  onOpenPlan?: (plan: string) => void
  /** Hide completed edit rows when the turn-level summary represents them. */
  summarizeEdits?: boolean
}): React.JSX.Element {
  const parts = message.parts
  const lastIndex = parts.length - 1

  // Coalesce inspection/terminal sequences into one activity row. Short progress
  // narration between calls stays available inside the expanded group instead
  // of breaking the sequence into a wall of cards.
  const items: Array<
    | { kind: 'group'; parts: ToolPart[]; key: string }
    | { kind: 'single'; part: NonNullable<(typeof parts)[number]>; index: number }
  > = []
  let run: { part: NonNullable<(typeof parts)[number]>; index: number }[] = []
  const flushRun = (): void => {
    if (run.length >= GROUP_MIN) {
      items.push({
        kind: 'group',
        parts: run.map((entry) => entry.part as ToolPart),
        key: `grp-${run[0].index}`
      })
    } else {
      for (const r of run) items.push({ kind: 'single', part: r.part, index: r.index })
    }
    run = []
  }
  parts.forEach((part, i) => {
    // Streamed arrays can be sparse; persisted ones turn holes into null.
    if (!part) return
    if (
      part.type === 'tool' &&
      summarizeEdits &&
      part.status === 'success' &&
      FILE_MUTATION_TOOLS.has(part.name)
    ) {
      return
    }
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
          return streaming && isLast ? (
            <StreamingMarkdown key={i} text={part.text} cwd={cwd} />
          ) : (
            <Markdown key={i} text={part.text} cwd={cwd} />
          )
        }
        if (part.type === 'thinking') {
          if (!part.text) return null
          return <ThinkingBlock key={i} text={part.text} active={streaming && isLast} />
        }
        if (part.name === 'TodoWrite') {
          return <LiveTodoCard key={part.toolUseId} part={part} />
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
          {/* Subscription turns (Codex on ChatGPT, Claude on a plan) report no
              per-turn dollar cost — show duration only rather than "$0.0000". */}
          {s.costUsd > 0 && (
            <>
              <span>·</span>
              <span>{formatCost(s.costUsd)}</span>
            </>
          )}
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

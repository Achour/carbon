import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  GitCommitHorizontal,
  Loader2,
  MousePointerClick,
  Pencil
} from 'lucide-react'
import type { AssistantMessage, EventMessage, ToolPart, UserMessage } from '@shared/types'
import { cn } from '@/lib/utils'
import { formatCost, formatDuration } from '@/lib/format'
import { Markdown, StreamingMarkdown, useStreamText } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { useApp } from '@/store'
import { FILE_MUTATION_TOOLS, GROUPABLE_TOOLS, ToolCard, ToolGroup } from './ToolCard'
import { TodoCard } from './TodoCard'
import type { TodoItem } from './TodoCard'
import { useTaskList } from '@/taskListStore'
import { TASK_LIST_TOOLS } from '@/lib/taskList'

/**
 * Wraps `TodoCard` with an equality-selector subscription to the task-list
 * store. Only this leaf re-renders when the live task list changes — the id
 * never crosses the `AssistantBlock`/`MessageHistory` memo boundary, so history
 * rows are untouched while an agent flips todos mid-turn.
 */
const LiveTodoCard = React.memo(function LiveTodoCard({
  part
}: {
  part: ToolPart
}): React.JSX.Element {
  const live = useTaskList((s) => s.latestId === part.toolUseId)
  const input = (part.input ?? {}) as { todos?: TodoItem[] }
  const todos = Array.isArray(input.todos) ? input.todos.filter((t) => t?.content) : []
  return <TodoCard todos={todos} live={live} />
})

/**
 * The same card for Claude Code's incremental checklist. The list isn't in the
 * call — it's folded across the whole transcript in `ChatView` and looked up
 * here by call id.
 *
 * A call with no snapshot falls back to the ordinary tool card: that means it
 * failed, or it only touched tasks created before the loaded window, and an
 * empty "Tasks 0/0" would be a worse answer than the call itself.
 */
const TaskListCard = React.memo(function TaskListCard({
  part,
  cwd,
  onOpenPlan
}: {
  part: ToolPart
  cwd: string
  onOpenPlan?: (plan: string) => void
}): React.JSX.Element {
  const live = useTaskList((s) => s.latestId === part.toolUseId)
  const tasks = useTaskList((s) => s.snapshots.get(part.toolUseId))
  const todos = React.useMemo<TodoItem[]>(
    () => (tasks ?? []).map((t) => ({ content: t.subject, status: t.status, activeForm: t.activeForm })),
    [tasks]
  )
  if (!todos.length) return <ToolCard part={part} cwd={cwd} onOpenPlan={onOpenPlan} />
  return <TodoCard todos={todos} live={live} />
})

/**
 * One button in a user message's hover row. Shared so the two actions cannot
 * drift apart in size, spacing or hit area — they sit side by side under the
 * bubble and any mismatch reads as a mistake at this scale.
 */
function MessageAction({
  label,
  icon: Icon,
  onClick
}: {
  label: string
  icon: React.ComponentType
  onClick: () => void
}): React.JSX.Element {
  return (
    <WithTooltip label={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
        <Icon />
      </Button>
    </WithTooltip>
  )
}

/**
 * Reword a sent message and run it again, dropping everything after it.
 *
 * The transcript is NOT trimmed here — main truncates the store and sends back
 * a `truncate` event, so what the user sees is what actually reached disk. An
 * optimistic splice would show the messages gone in the one case they are not:
 * a chat open in a second Carbon instance, where the write is refused.
 */
function MessageEditor({
  message,
  onClose
}: {
  message: UserMessage
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = React.useState(message.text)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ref = React.useRef<HTMLTextAreaElement>(null)
  // Frozen at open: the answer must describe the chat the user is looking at,
  // and a turn cannot start underneath an open editor without main refusing the
  // edit anyway (which lands in `error` below).
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  // Grow with the content: a reworded prompt is usually about as long as the
  // one it replaces, and a fixed two-row box would hide most of it.
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`
  }, [text])

  const submit = async (): Promise<void> => {
    const next = text.trim()
    if (!next || busy) return
    if (next === message.text.trim()) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    const res = await useApp.getState().editMessage(message.id, next)
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.error ?? 'The message could not be edited.')
  }

  return (
    <div className="flex w-full max-w-[85%] flex-col gap-2 rounded-2xl border border-border bg-secondary/60 p-2.5">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        className="max-h-[420px] w-full resize-none bg-transparent px-1.5 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
      />
      {error && <div className="px-1.5 text-[11px] text-destructive">{error}</div>}
      {/* No "this removes N messages below" line: resending replaces the tail of
          a conversation, which is what the button says. And nothing here
          predicts whether the provider can rewind itself — that is only known
          once it has been asked, so main reports it afterwards as an event in
          the transcript rather than as a guess from the provider id here. */}
      <div className="flex items-center justify-end gap-3 px-1.5">
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Resend'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Group a run of this many consecutive read/search tools into one row. */
const GROUP_MIN = 2

export const UserBubble = React.memo(function UserBubble({
  message
}: {
  message: UserMessage
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  // App-initiated actions (e.g. a "Commit" from the source-control button) show
  // as a compact chip, Cursor-style — the verbose prompt behind it stays hidden.
  // No actions: the text behind the chip is a prompt the app wrote, so editing
  // it would leave the label describing something that never ran, and copying it
  // would hand over words the user never typed.
  if (message.label) {
    return (
      <div className="flex animate-enter items-center justify-end">
        <div className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 py-1 pr-3 pl-2.5">
          <GitCommitHorizontal className="size-3.5 shrink-0 text-primary" />
          <span className="text-[12.5px] font-medium text-primary">{message.label}</span>
        </div>
      </div>
    )
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(message.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
            ) : att.kind === 'selection' && att.selection ? (
              <div
                key={att.id}
                title={`${att.selection.rel ?? att.selection.path}\n\n${att.selection.text}`}
                className="flex h-8 max-w-56 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
              >
                <Code2 className="size-3.5 shrink-0 text-muted-foreground" />
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
      {editing ? (
        <MessageEditor message={message} onClose={() => setEditing(false)} />
      ) : (
        message.text && (
          <>
            {/* Prompts render as markdown, the same as replies — a pasted list or
                a fenced snippet reads as one. `breaks` keeps the newlines the
                user actually typed, which plain markdown would collapse and
                which every prompt already in the transcript was written
                expecting. */}
            <div className="max-w-[85%] min-w-0 select-text rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 break-words">
              <Markdown text={message.text} breaks className="leading-relaxed" />
            </div>
            {/* Under the bubble rather than beside it: the message is
                right-aligned and grows leftward, so a column of icons to its
                left sits at a different x on every row and reads as debris in
                the margin. Below, they line up with the bubble's own right edge
                on every message. `-mt-0.5` pulls the row into the gap the flex
                parent already leaves, so hovering does not shift the
                transcript. */}
            <div className="-mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <MessageAction label="Edit and resend" icon={Pencil} onClick={() => setEditing(true)} />
              <MessageAction
                label={copied ? 'Copied' : 'Copy prompt'}
                icon={copied ? Check : Copy}
                onClick={copy}
              />
            </div>
          </>
        )
      )}
    </div>
  )
})

/**
 * A thought with *text*. One whose content was withheld draws nothing at all —
 * see `isBlankMsg` (ChatView) — so this component never sees an empty `text`.
 */
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
}): React.JSX.Element | null {
  const parts = message.parts
  const lastIndex = parts.length - 1

  // Checklist calls folded into a later card in the same run draw nothing. They
  // have to be dropped *here* rather than rendered as null: Claude Code emits
  // one Task call per message, so a superseded one is usually the message's only
  // part, and an AssistantBlock with no children is still a flex item in the
  // message list — a message-sized gap where no message is (the same trap
  // `isBlankMsg` exists for). Subscribing to a joined string rather than the
  // Set: the Set's identity changes on every streamed token, and this component
  // is inside the memo boundary that keeps history out of the stream loop.
  const supersededKey = useTaskList((s) =>
    parts
      .filter((p) => p?.type === 'tool' && s.superseded.has(p.toolUseId))
      .map((p) => (p as ToolPart).toolUseId)
      .join(',')
  )
  const superseded = React.useMemo(
    () => new Set(supersededKey ? supersededKey.split(',') : []),
    [supersededKey]
  )

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
    // A text/thinking part with no text renders nothing. Skip it here rather
    // than returning null from the map below: an item that renders null still
    // occupies a slot in the parent's `gap`, so it would show up as a blank
    // band between cards.
    if ((part.type === 'text' || part.type === 'thinking') && !part.text) return
    if (part.type === 'tool' && superseded.has(part.toolUseId)) return
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

  // Nothing to show — the wrapper alone would still be a flex item in the
  // message list and add a message-sized gap where no message is.
  if (items.length === 0) return null

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        if (item.kind === 'group') {
          return <ToolGroup key={item.key} parts={item.parts} cwd={cwd} />
        }
        const { part, index: i } = item
        const isLast = i === lastIndex
        if (part.type === 'text') {
          return streaming && isLast ? (
            <StreamingMarkdown key={i} text={part.text} cwd={cwd} />
          ) : (
            <Markdown key={i} text={part.text} cwd={cwd} />
          )
        }
        if (part.type === 'thinking') {
          return <ThinkingBlock key={i} text={part.text} active={streaming && isLast} />
        }
        if (part.name === 'TodoWrite') {
          return <LiveTodoCard key={part.toolUseId} part={part} />
        }
        if (TASK_LIST_TOOLS.has(part.name)) {
          return (
            <TaskListCard key={part.toolUseId} part={part} cwd={cwd} onOpenPlan={onOpenPlan} />
          )
        }
        return <ToolCard key={part.toolUseId} part={part} cwd={cwd} onOpenPlan={onOpenPlan} />
      })}
    </div>
  )
})

export const EventRow = React.memo(function EventRow({
  message,
  pending = false
}: {
  message: EventMessage
  /** Switch dividers only: the handoff this divider records is still running. */
  pending?: boolean
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
    case 'switch': {
      const s = message.switch
      if (!s) {
        // Old events persisted without the structured payload keep the divider.
        return (
          <div className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-foreground">{message.text}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )
      }
      // The same single-row card language as tool calls (see the Plan row in
      // ToolCard): icon, bold names, muted detail, live status icon — spinner
      // while the outgoing model writes the brief, check once the turn reaches
      // the new model. Left-aligned in the flow, exactly like a tool.
      return (
        <div
          className="flex w-full animate-enter items-center gap-2.5 rounded-xl border border-border bg-card/60 px-3 py-2"
          title={message.text}
        >
          <ArrowRightLeft className="size-4 shrink-0 text-primary" />
          <span className="shrink-0 text-[13px] font-medium">{s.fromModel}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="shrink-0 text-[13px] font-medium">{s.toModel}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {pending ? `${s.fromModel} is writing a handoff brief…` : 'context handed off'}
          </span>
          <span className="shrink-0">
            {pending ? (
              <Loader2 className="size-3.5 animate-spin text-warning" />
            ) : (
              <Check className="size-3.5 text-success" />
            )}
          </span>
        </div>
      )
    }
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

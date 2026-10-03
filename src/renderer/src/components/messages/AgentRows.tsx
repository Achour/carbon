import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import type { ChatMessage, Provider, ToolPart } from '@shared/types'
import {
  DELEGATE_TOOL,
  agentColumnId,
  agentAtPath,
  agentRunOf,
  findAgentPath,
  untrackedBackground,
  formatAgentDuration
} from '@shared/agentRuns'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { messagesOf, threadFull, useApp } from '@/store'
import { DelegateCard, delegateChildId } from './DelegateCard'

/**
 * Which chat a transcript belongs to, and on which provider — what an agent
 * row needs to name its column and draw its avatar, and what nothing else in a
 * `ToolCard` tree knows. Provided by `ChatView` (and by an agent column, for an
 * agent's own nested spawns). Its value changes only with the chat, so the
 * memoized rows under it are not re-rendered per streamed token.
 */
export const TranscriptChat = React.createContext<{ chatId: string; provider: Provider } | null>(null)

/**
 * One spawn's part, live, out of its parent chat's transcript — returning the
 * *same reference* until that part itself changes.
 *
 * Selecting the parent's whole message array would re-render an open agent
 * column on every token the parent streams, and a selector that walked the
 * transcript would run that walk on every store write. So the selector keeps
 * the last answer and the message it came from: an unchanged array is a cache
 * hit, and a changed one re-reads only that message (`applyEvent` replaces
 * just the message it patches) before falling back to a full walk.
 */
export function useAgentPart(parentId: string, toolUseId: string): ToolPart | undefined {
  const cache = React.useRef<{
    messages: ChatMessage[] | null
    index: number
    message?: ChatMessage
    path: number[]
    part?: ToolPart
  }>({ messages: null, index: -1, path: [] })
  return useApp((s) => {
    const messages = messagesOf(s, parentId || null)
    const c = cache.current
    if (messages === c.messages) return c.part
    // The message that held it, by index — O(1) per streamed token. Unchanged
    // (the parent patched another message), the answer stands. Patched — Codex
    // writes its agents and its own text into one message — the part is read
    // at its remembered path rather than by walking every sibling agent's
    // history. A prepend (`loadOlder`) or truncation moves the index, which the
    // id check catches, and only then is the transcript walked.
    const held = c.index >= 0 ? messages[c.index] : undefined
    if (held && held === c.message) {
      c.messages = messages
      return c.part
    }
    let part: ToolPart | undefined
    if (held && held.id === c.message?.id && held.role === 'assistant') {
      const at = agentAtPath(held.parts, c.path)
      if (at?.toolUseId === toolUseId) part = at
      else {
        const path = findAgentPath(held.parts, toolUseId)
        if (path) {
          c.path = path
          part = agentAtPath(held.parts, path)
        }
      }
      if (part) c.message = held
    }
    if (!part && !(c.index === -2 && c.messages && messages.length === c.messages.length)) {
      // Searched and not found, with no message added or removed since, is
      // still not found — a token elsewhere cannot bring it back.
      c.index = -2
      c.message = undefined
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (m.role !== 'assistant') continue
        const path = findAgentPath(m.parts, toolUseId)
        if (path) {
          c.index = i
          c.message = m
          c.path = path
          part = agentAtPath(m.parts, path)
          break
        }
      }
    }
    c.messages = messages
    c.part = part
    return part
  })
}

/** A clock that ticks only while `live`; settled, it reads `to - from`. */
export function useElapsed(from: number | undefined, to: number | undefined, live: boolean): string | null {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])
  if (!from) return null
  const end = live ? now : to
  return end ? formatAgentDuration(Math.max(0, end - from)) : null
}

/**
 * The one row every agent draws as, native or delegated: the provider's avatar
 * with a status dot, `name: task`, a status line, the clock, and a chevron
 * that is the row's affordance — it opens the agent's column, and turned down
 * it says the column is open and a click folds it back.
 */
export function AgentRowShell({
  provider,
  dot,
  name,
  task,
  status,
  live,
  elapsed,
  open,
  clickable,
  blockedReason,
  onToggle,
  data
}: {
  provider: Provider
  dot: string
  name: string
  task: string
  status: React.ReactNode
  live: boolean
  elapsed: string | null
  open: boolean
  /** False while the row has nowhere to open into — see `blockedReason`. */
  clickable: boolean
  blockedReason?: string
  onToggle: () => void
  data?: Record<string, string | undefined>
}): React.JSX.Element {
  const row = (
    <button
      type="button"
      {...data}
      disabled={!clickable}
      onClick={onToggle}
      title={clickable ? (open ? 'Collapse its column' : 'Open it beside this chat') : undefined}
      className={cn(
        'group flex w-full animate-step-in items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none transition-colors',
        clickable ? 'hover:bg-accent/50 focus-visible:bg-accent/50' : 'cursor-default'
      )}
    >
      <span className="relative shrink-0">
        <ProviderAvatar provider={provider} className="size-7 [&>svg]:size-4" />
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background', dot)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">
          <span className="font-medium">{name}</span>
          {task && <span className="text-foreground/80">: {task}</span>}
        </span>
        <span className={cn('truncate text-xs text-muted-foreground', live && 'shimmer-text')}>{status}</span>
      </span>
      {elapsed && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
      )}
      {(clickable || open) && (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground',
            open && 'rotate-90'
          )}
        />
      )}
    </button>
  )
  if (!clickable && blockedReason) {
    return (
      <WithTooltip label={blockedReason}>
        <span className="block">{row}</span>
      </WithTooltip>
    )
  }
  return row
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A sub-agent the provider spawned itself — Claude's `Task`, Codex's and
 * Grok's and Antigravity's `Agent` — as a row whose open form is a column of
 * the thread (`AgentColumn`). Status, model and clock come off `agentRunOf`,
 * the roster's own rule, so the row, the column and the Agents panel agree.
 */
export function NativeAgentRow({ part }: { part: ToolPart }): React.JSX.Element {
  const ctx = React.useContext(TranscriptChat)
  const run = React.useMemo(() => agentRunOf(part), [part])
  const columnId = ctx ? agentColumnId(ctx.chatId, part.toolUseId) : null
  const open = useApp((s) => (columnId ? s.sideColumns.includes(columnId) : false))
  const full = useApp(threadFull)
  // The column reads the agent out of its parent's transcript, so it can only
  // open while that transcript is on screen — the thread's chat or a column.
  const parentShown = useApp((s) =>
    ctx ? s.activeId === ctx.chatId || s.sideColumns.includes(ctx.chatId) : false
  )
  const toggleAgentColumn = useApp((s) => s.toggleAgentColumn)
  const running = run.status === 'running'
  const background = untrackedBackground(part)
  const elapsed = useElapsed(run.startedAt, run.endedAt, running)
  const steps = run.tools ? ` · ${run.tools} ${run.tools === 1 ? 'step' : 'steps'}` : ''
  const status = running
    ? `Working${run.current ? ` · ${run.current}` : ''}${steps}`
    : run.status === 'failed'
      ? `Failed${steps}`
      : background
        ? 'Started in the background'
        : `Finished${steps}`
  const clickable = !!ctx && parentShown && (open || !full)
  return (
    <AgentRowShell
      provider={ctx?.provider ?? 'claude'}
      dot={
        running
          ? 'bg-primary animate-pulse'
          : run.status === 'failed'
            ? 'bg-destructive'
            : background
              ? 'bg-muted-foreground/60'
              : 'bg-success'
      }
      name={run.type ?? 'Agent'}
      task={oneLine(run.description)}
      status={status}
      live={running}
      elapsed={background ? null : elapsed}
      open={open}
      clickable={clickable}
      blockedReason={
        parentShown ? 'The thread already shows four chats — close one to open this agent.' : undefined
      }
      onToggle={() => ctx && toggleAgentColumn(ctx.chatId, part.toolUseId)}
      data={{ 'data-agent-run': part.toolUseId, 'data-agent-open': open ? 'true' : undefined }}
    />
  )
}

/** One agent call as its row — native or delegated. */
export function AgentPartRow({ part }: { part: ToolPart }): React.JSX.Element {
  return part.name === DELEGATE_TOOL ? <DelegateCard part={part} /> : <NativeAgentRow part={part} />
}

/**
 * Several agents started together, as one card — the way they were launched.
 * Stacked avatars, how many and how many are still working, and the span from
 * the first start to the last finish; the chevron lists them, each row opening
 * its own column. A run of one is just its row.
 *
 * Native spawns and delegates share it: "3 agents" is what the reader wants to
 * know whether two of them are Claude's own `Task`s and one is a Codex chat.
 */
export function AgentGroupCard({ parts }: { parts: ToolPart[] }): React.JSX.Element {
  const ctx = React.useContext(TranscriptChat)
  const [expanded, setExpanded] = React.useState(false)
  // Delegates' live state lives on their chats; read once per store change, a
  // few `find`s over the chat list, and settled to a stable string so the card
  // re-renders only when it changes.
  const delegateKey = useApp((s) =>
    parts
      .filter((p) => p.name === DELEGATE_TOOL)
      .map((p) => {
        const id = delegateChildId(p)
        const meta = id ? s.chats.find((c) => c.id === id) : undefined
        return `${meta?.provider ?? ''}:${meta?.delegation?.status ?? (id ? 'deleted' : 'running')}:${meta?.delegation?.startedAt ?? meta?.delegation?.createdAt ?? ''}:${meta?.delegation?.finishedAt ?? ''}`
      })
      .join('|')
  )
  const agents = React.useMemo(() => {
    const delegates = delegateKey ? delegateKey.split('|') : []
    let d = 0
    return parts.map((p) => {
      if (p.name === DELEGATE_TOOL) {
        const [provider, status, startedAt, finishedAt] = (delegates[d++] ?? '').split(':')
        const input = (p.input ?? {}) as Record<string, unknown>
        return {
          provider: (provider || (typeof input.provider === 'string' ? input.provider : '') || ctx?.provider || 'claude') as Provider,
          // Still starting (no child yet) or running is working; a delegate
          // whose chat was deleted is not, whatever its card last said.
          running: status === 'running',
          failed: status === 'failed',
          background: false,
          startedAt: startedAt ? Number(startedAt) : undefined,
          endedAt: finishedAt ? Number(finishedAt) : undefined
        }
      }
      const run = agentRunOf(p)
      const background = untrackedBackground(p)
      return {
        provider: ctx?.provider ?? 'claude',
        running: run.status === 'running',
        failed: run.status === 'failed',
        background,
        startedAt: background ? undefined : run.startedAt,
        endedAt: background ? undefined : run.endedAt
      }
    })
  }, [parts, delegateKey, ctx?.provider])
  const working = agents.filter((a) => a.running).length
  const failed = agents.filter((a) => a.failed).length
  const background = agents.filter((a) => a.background).length
  const starts = agents.map((a) => a.startedAt).filter((t): t is number => !!t)
  const ends = agents.map((a) => a.endedAt).filter((t): t is number => !!t)
  const elapsed = useElapsed(
    starts.length ? Math.min(...starts) : undefined,
    ends.length ? Math.max(...ends) : undefined,
    working > 0
  )
  const allNative = parts.every((p) => p.name !== DELEGATE_TOOL)
  const noun = allNative ? 'subagents' : 'agents'
  const shown = agents.slice(0, 3)
  return (
    <div data-agent-group={parts.length} className="animate-step-in">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
      >
        <span className="flex shrink-0 items-center">
          {shown.map((a, i) => (
            <ProviderAvatar
              key={i}
              provider={a.provider}
              className={cn('size-7 ring-2 ring-background [&>svg]:size-4', i > 0 && '-ml-2.5')}
            />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {parts.length} {noun}
          </span>
          <span
            className={cn(
              'truncate text-xs',
              working ? 'text-primary' : failed ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {working
              ? `${working} working`
              : failed
                ? `${failed} failed`
                : background === agents.length
                  ? 'Started in the background'
                  : background
                    ? `${background} in the background`
                    : 'All finished'}
          </span>
        </span>
        {elapsed && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
        )}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div className="mt-0.5 ml-4 border-l border-border pl-2">
          {parts.map((p) => (
            <AgentPartRow key={p.toolUseId} part={p} />
          ))}
        </div>
      )}
    </div>
  )
}

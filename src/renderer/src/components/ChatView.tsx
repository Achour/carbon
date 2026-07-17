import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  FileDiff,
  Folder,
  GitBranch,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Trash2,
  X
} from 'lucide-react'
import type { AssistantMessage, ChatMessage, ChatMeta, ToolPart } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
import { useLatestTodo } from '@/latestTodoStore'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { WithTooltip } from '@/components/ui/tooltip'
import { Composer } from '@/components/Composer'
import {
  AssistantBlock,
  EventRow,
  StreamingIndicator,
  UserBubble
} from '@/components/messages/Parts'
import {
  FILE_MUTATION_TOOLS,
  GROUPABLE_TOOLS,
  ToolCard,
  ToolGroup
} from '@/components/messages/ToolCard'
import { PermissionCard } from '@/components/messages/PermissionCard'
import { QuestionCard } from '@/components/messages/QuestionCard'
import { BackgroundJobs } from '@/components/BackgroundJobs'
import { TurnChangesCard } from '@/components/messages/TurnChangesCard'
import { turnPresentations } from '@/lib/turnChanges'

const NO_PERMISSIONS: never[] = []
const NO_QUEUED: never[] = []

/** Coalesce a run of this many consecutive read/search-only messages into one row. */
const GROUP_MIN = 2

/** True when a message is nothing but read/search tool calls — each such call
 *  arrives as its own assistant message, so these are what pile up. */
function isGroupableMsg(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    m.parts.length > 0 &&
    m.parts.every((p) => !!p && p.type === 'tool' && GROUPABLE_TOOLS.has(p.name))
  )
}

interface RenderCtx {
  cwd: string
  busy: boolean
  lastAssistantId?: string
  onOpenPlan?: (plan: string) => void
}

/**
 * Most-recent TodoWrite in `messages[from, to)`, scanning backward. Returns its
 * `toolUseId` and array index, or null. Pulled out so the id can be recomputed
 * incrementally (see the `latestTodoId` memo) instead of re-walking the whole
 * conversation on every stream token.
 */
function findLatestTodo(
  messages: ChatMessage[],
  from: number,
  to: number
): { id: string; index: number } | null {
  for (let i = to - 1; i >= from; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (let j = m.parts.length - 1; j >= 0; j--) {
      // Streamed part arrays can be sparse — indexes may arrive out of order.
      const p = m.parts[j]
      if (p?.type === 'tool' && p.name === 'TodoWrite') return { id: p.toolUseId, index: i }
    }
  }
  return null
}

/**
 * Renders the message list, collapsing runs of consecutive read/search-only
 * assistant messages into a single ToolGroup ("Read 12 files"). Since every tool
 * call is its own assistant message, a task that reads many files would otherwise
 * bury the conversation under a wall of identical cards.
 */
function renderMessages(messages: ChatMessage[], ctx: RenderCtx): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let run: AssistantMessage[] = []
  const presentations = turnPresentations(messages, ctx.cwd, ctx.busy)

  const renderAssistant = (m: AssistantMessage): React.ReactNode => {
    const turn = presentations.get(m.id)
    const showSummary = turn?.summary?.id === m.id
    return (
      <React.Fragment key={m.id}>
        <AssistantBlock
          message={m}
          cwd={ctx.cwd}
          streaming={ctx.busy && m.id === ctx.lastAssistantId}
          onOpenPlan={ctx.onOpenPlan}
          summarizeEdits={turn?.hasChanges ?? false}
        />
        {showSummary && turn?.summary && (
          <TurnChangesCard
            message={turn.summary}
            cwd={ctx.cwd}
            userMessageId={turn.userMessageId}
          />
        )}
      </React.Fragment>
    )
  }

  const flush = (): void => {
    if (run.length >= GROUP_MIN) {
      const turn = presentations.get(run[0].id)
      const parts = run.flatMap((m) =>
        m.parts.filter((p): p is ToolPart => !!p && p.type === 'tool')
      )
      const visibleParts = turn?.hasChanges
        ? parts.filter(
            (part) => !(part.status === 'success' && FILE_MUTATION_TOOLS.has(part.name))
          )
        : parts
      if (visibleParts.length >= GROUP_MIN) {
        out.push(<ToolGroup key={`grp-${run[0].id}`} parts={visibleParts} cwd={ctx.cwd} />)
      } else if (visibleParts.length === 1) {
        out.push(<ToolCard key={visibleParts[0].toolUseId} part={visibleParts[0]} cwd={ctx.cwd} />)
      }
      const last = run[run.length - 1]
      const lastTurn = presentations.get(last.id)
      if (lastTurn?.summary?.id === last.id) {
        out.push(
          <TurnChangesCard
            key={`changes-${last.id}`}
            message={lastTurn.summary}
            cwd={ctx.cwd}
            userMessageId={lastTurn.userMessageId}
          />
        )
      }
    } else {
      for (const m of run) out.push(renderAssistant(m))
    }
    run = []
  }

  for (const m of messages) {
    if (m.role === 'assistant' && isGroupableMsg(m)) {
      run.push(m)
      continue
    }
    flush()
    if (m.role === 'user') {
      out.push(<UserBubble key={m.id} message={m} />)
    }
    else if (m.role === 'assistant') out.push(renderAssistant(m))
    else out.push(<EventRow key={m.id} message={m} />)
  }
  flush()
  return out
}

/**
 * Keep completed history out of the live-stream render loop. Zustand replaces
 * the active assistant message for each delta but preserves earlier message
 * objects, so a cheap reference comparison is enough to detect the uncommon
 * case where a background tool updates an older message.
 */
const MessageHistory = React.memo(
  function MessageHistory({
    messages,
    end,
    ctx
  }: {
    messages: ChatMessage[]
    end: number
    ctx: RenderCtx
  }): React.JSX.Element {
    return <>{renderMessages(messages.slice(0, end), ctx)}</>
  },
  (prev, next) => {
    if (
      prev.end !== next.end ||
      prev.ctx.cwd !== next.ctx.cwd ||
      prev.ctx.busy !== next.ctx.busy ||
      prev.ctx.lastAssistantId !== next.ctx.lastAssistantId ||
      prev.ctx.onOpenPlan !== next.ctx.onOpenPlan
    ) {
      return false
    }
    for (let i = 0; i < prev.end; i++) {
      if (prev.messages[i] !== next.messages[i]) return false
    }
    return true
  }
)

export function ChatView({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const messages = useApp((s) => s.messages)
  const status = useApp((s) => s.statuses[chat.id] ?? 'idle')
  // Fall back to a stable constant — a fresh `[]` per render makes zustand's
  // snapshot comparison always fail and loops React into a crash.
  const permissions = useApp((s) => s.permissions[chat.id] ?? NO_PERMISSIONS)
  const queued = useApp((s) => s.queued[chat.id] ?? NO_QUEUED)
  const removeQueued = useApp((s) => s.removeQueued)
  const sendQueuedNow = useApp((s) => s.sendQueuedNow)
  const git = useApp((s) => s.git)
  const commands = useApp((s) => s.commands)
  const openPlanPanel = useApp((s) => s.openPlanPanel)
  const togglePanel = useApp((s) => s.togglePanel)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const panelOpen = useApp((s) => s.panelOpen)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const sendMessage = useApp((s) => s.sendMessage)
  const interrupt = useApp((s) => s.interrupt)
  const setChatOptions = useApp((s) => s.setChatOptions)
  const renameChat = useApp((s) => s.renameChat)
  const deleteChat = useApp((s) => s.deleteChat)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  const [showJump, setShowJump] = React.useState(false)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')

  const busy = status !== 'idle'

  const scrollToBottom = React.useCallback((smooth = false): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }

  // Follow the stream while the user is pinned to the bottom. One animation
  // frame coalesces message, status and permission updates that land together.
  React.useEffect(() => {
    if (!pinnedRef.current) return
    const frame = requestAnimationFrame(() => scrollToBottom())
    return () => cancelAnimationFrame(frame)
  }, [messages, permissions, status, scrollToBottom])

  // Jump to the bottom when switching chats.
  React.useEffect(() => {
    pinnedRef.current = true
    requestAnimationFrame(() => scrollToBottom())
  }, [chat.id, scrollToBottom])

  // The live turn's message — only the *last* message counts, so a just-sent user
  // message (before the reply starts) isn't mistaken for the previous reply.
  const lastMsg = messages[messages.length - 1]
  const liveAssistant = busy && lastMsg?.role === 'assistant' ? lastMsg : undefined
  // Has the live turn shown anything yet? Empty parts (a thinking block whose first
  // token hasn't arrived) don't count.
  const producedSomething =
    liveAssistant?.parts.some((p) => p && (p.type === 'tool' || p.text.length > 0)) ?? false
  // The tail of the live turn: a running tool card and a streaming thinking block
  // already animate on their own, so a second indicator under them is just noise.
  const tail = liveAssistant
    ? [...liveAssistant.parts].reverse().find((p) => Boolean(p))
    : undefined
  const tailAnimatesItself =
    (tail?.type === 'tool' && (tail.status === 'pending' || tail.status === 'running')) ||
    // A thinking block only shimmers once its first token lands; an empty one
    // renders nothing, so keep the indicator up until then.
    (tail?.type === 'thinking' && tail.text.length > 0)
  // Show a working indicator the whole time the agent is busy — before the first
  // token, while streaming text, and in the gaps between tool calls — not just at
  // the very start. Hide it only while a permission prompt awaits the user, or when
  // the tail is already animating itself.
  const showActivity = busy && permissions.length === 0 && !tailAnimatesItself
  // "Thinking…" until the model has produced something this turn; "Working…" after.
  const activityLabel = producedSomething ? 'Working…' : 'Thinking…'

  const pendingPlanRequest = permissions.find((r) => r.toolName === 'ExitPlanMode')

  // The most recent TodoWrite is the live task list; earlier ones collapse.
  // A full backward scan per stream token is wasteful — a chat with no todos
  // would re-walk its whole history on every token. Streaming keeps earlier
  // message objects by reference (only the live message mutates / new ones
  // append — the same assumption MessageHistory's memo relies on), so we scan
  // parts only in the suffix that changed since the last render and reuse the
  // cached answer for the untouched prefix.
  const todoScanCache = React.useRef<{
    messages: ChatMessage[]
    id: string | null
    index: number
  } | null>(null)
  const latestTodoId = React.useMemo<string | null>(() => {
    const cache = todoScanCache.current
    // First index at which this render's messages diverge from the last scan.
    let diverge = 0
    if (cache) {
      const min = Math.min(cache.messages.length, messages.length)
      while (diverge < min && cache.messages[diverge] === messages[diverge]) diverge++
    }
    // A newer TodoWrite can only be in the changed/appended suffix.
    let found = findLatestTodo(messages, diverge, messages.length)
    if (!found && cache && cache.index >= 0 && cache.index < diverge) {
      // Nothing newer, and the cached answer still lives in the untouched prefix.
      found = { id: cache.id as string, index: cache.index }
    } else if (!found) {
      // The prefix changed under the cached answer (rewind / chat switch, or no
      // cache yet) — scan it too. `diverge` is 0 on a chat switch, so the suffix
      // scan above already covered everything and this range is empty.
      found = findLatestTodo(messages, 0, diverge)
    }
    const next = found ?? { id: null, index: -1 }
    todoScanCache.current = { messages, id: next.id, index: next.index }
    return next.id
  }, [messages])

  // Publish the live-todo id to its own store so only the affected TodoCards
  // re-render — see latestTodoStore. Kept out of the history render path.
  const setLatestTodoId = useLatestTodo((s) => s.setLatestTodoId)
  React.useEffect(() => {
    setLatestTodoId(latestTodoId)
  }, [latestTodoId, setLatestTodoId])

  const openPlan = React.useCallback(
    (plan: string) => {
      openPlanPanel({ chatId: chat.id, plan, requestId: pendingPlanRequest?.id ?? null })
    },
    [openPlanPanel, chat.id, pendingPlanRequest?.id]
  )
  const historyEnd = liveAssistant ? messages.length - 1 : messages.length
  const historyCtx = React.useMemo<RenderCtx>(
    () => ({
      cwd: chat.cwd,
      busy,
      onOpenPlan: openPlan
    }),
    [chat.cwd, busy, openPlan]
  )

  return (
    <div className="relative flex h-full min-w-[420px] flex-1 flex-col">
      {/* Header */}
      <header
        className={cn(
          'drag flex h-[38px] shrink-0 items-center gap-2 border-b border-border px-4',
          !sidebarOpen && 'pl-[84px]'
        )}
      >
        {!sidebarOpen && (
          <WithTooltip label="Show sidebar  ⌘B">
            <Button size="icon-sm" variant="ghost" onClick={toggleSidebar} aria-label="Show sidebar">
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">
            {chat.title || 'New chat'}
          </div>
        </div>
        <BackgroundJobs />
        {/* When the panel is open its own header hosts the collapse button. */}
        {!panelOpen && (
          <WithTooltip label="Show files">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={togglePanel}
              aria-label="Show file panel"
            >
              <PanelRight />
            </Button>
          </WithTooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label="Chat options">
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setRenameValue(chat.title)
                setRenameOpen(true)
              }}
            >
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          <MessageHistory messages={messages} end={historyEnd} ctx={historyCtx} />
          {liveAssistant && (
            <AssistantBlock
              message={liveAssistant}
              cwd={chat.cwd}
              streaming
              onOpenPlan={openPlan}
            />
          )}
          {permissions.map((request) => {
            if (request.toolName === 'AskUserQuestion')
              return <QuestionCard key={request.id} request={request} />
            if (request.toolName === 'ExitPlanMode')
              return (
                <div
                  key={request.id}
                  className="flex animate-enter items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5"
                >
                  <span className="text-[13px]">
                    {chat.provider === 'codex' ? 'Codex' : 'Claude'} prepared a plan for your review.
                  </span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const plan = (request.input as { plan?: string } | null)?.plan
                      if (typeof plan === 'string') openPlan(plan)
                    }}
                  >
                    Review plan
                  </Button>
                </div>
              )
            return <PermissionCard key={request.id} request={request} />
          })}
          {showActivity && <StreamingIndicator label={activityLabel} />}
          <div className="h-2" />
        </div>
      </div>

      {/* Jump to bottom */}
      {showJump && (
        <div className="pointer-events-none absolute right-0 bottom-32 left-0 flex justify-center">
          <Button
            size="icon-sm"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-lg"
            onClick={() => scrollToBottom(true)}
            aria-label="Scroll to bottom"
          >
            <ArrowDown />
          </Button>
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-3xl">
          {/* Repo · branch · working-tree changes — context for what you're about
              to send, sitting with the composer instead of the crowded top bar. */}
          <div className="mb-2 flex items-center gap-2">
            <WithTooltip label={chat.cwd}>
              <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground">
                <Folder className="size-3 shrink-0" />
                <span className="max-w-44 truncate">{basename(chat.cwd)}</span>
                {git?.isRepo && git.branch && (
                  <>
                    <span className="text-border">/</span>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="max-w-32 truncate">{git.branch}</span>
                  </>
                )}
              </div>
            </WithTooltip>
            {git?.isRepo && git.changes.length > 0 && (
              <WithTooltip
                label={`Review changes — ${git.changes.length} file${git.changes.length === 1 ? '' : 's'}`}
              >
                <button
                  type="button"
                  onClick={() => void reviewChanges()}
                  aria-label="Review changes"
                  className="flex items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent hover:text-foreground"
                >
                  <FileDiff className="size-3 text-muted-foreground" />
                  {git.additions === 0 && git.deletions === 0 ? (
                    <span className="text-muted-foreground">{git.changes.length}</span>
                  ) : (
                    <>
                      <span className="text-success">+{git.additions}</span>
                      <span className="text-destructive">−{git.deletions}</span>
                    </>
                  )}
                </button>
              </WithTooltip>
            )}
            <div className="flex-1" />
          </div>
          {queued.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {queued.map((q) => (
                <div
                  key={q.id}
                  className="flex animate-enter items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground"
                >
                  <Clock className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {q.text || q.attachments?.map((a) => a.name).join(', ')}
                  </span>
                  <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
                    queued
                  </span>
                  <button
                    type="button"
                    onClick={() => void sendQueuedNow(chat.id, q.id)}
                    aria-label="Send now"
                    title="Send now — interrupts the current turn"
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQueued(chat.id, q.id)}
                    aria-label="Remove queued message"
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Composer
            onSend={(text, attachments) => void sendMessage(text, attachments)}
            streaming={busy}
            onStop={() => void interrupt()}
            model={chat.model ?? ''}
            onModelChange={(model) => void setChatOptions({ model })}
            effort={chat.effort ?? ''}
            onEffortChange={(effort) => void setChatOptions({ effort })}
            permissionMode={chat.permissionMode}
            onPermissionModeChange={(permissionMode) => void setChatOptions({ permissionMode })}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            provider={chat.provider}
            lockProvider
            cwd={chat.cwd}
            commands={commands}
            placeholder={chat.provider === 'codex' ? 'Ask Codex anything…' : undefined}
          />
        </div>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>Rename chat</DialogTitle>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (renameValue.trim()) {
                void renameChat(chat.id, renameValue.trim())
                setRenameOpen(false)
              }
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              placeholder="Chat title"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            “{chat.title || 'New chat'}” and its history will be removed permanently.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false)
                void deleteChat(chat.id)
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

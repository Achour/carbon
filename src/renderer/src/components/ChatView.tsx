import * as React from 'react'
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Clock,
  FileDiff,
  Folder,
  GitBranch,
  GitMerge,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  RefreshCw,
  Trash,
  Trash2,
  X
} from 'lucide-react'
import type { AssistantMessage, ChatMessage, ChatMeta, ToolPart } from '@shared/types'
import { PROVIDER_SHORT_LABELS, projectRoot } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
import { useTaskList } from '@/taskListStore'
import { TASK_LIST_TOOLS, foldTaskParts, reconcileSnapshots } from '@/lib/taskList'
import type { TaskSnapshots, TranscriptItem } from '@/lib/taskList'
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
import { ContextStrip } from '@/components/ContextStrip'
import {
  MergeIntoMainDialog,
  WorktreeFinishDialog,
  WorktreeHandoffDialog
} from '@/components/BranchActions'
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

/** An assistant message that renders nothing — the CLI ships thinking blocks
 *  with their text withheld, and each one arrives as its own message. Left in
 *  the list it would both split a run of groupable tool calls in two and, being
 *  a zero-height flex item, open a message-sized gap where no message is. */
function isBlankMsg(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    m.parts.every((p) => !p || ((p.type === 'text' || p.type === 'thinking') && !p.text))
  )
}

interface RenderCtx {
  cwd: string
  busy: boolean
  lastAssistantId?: string
  onOpenPlan?: (plan: string) => void
  /** Switch divider currently mid-handoff (brief still generating), if any. */
  switchPendingId?: string
}

/**
 * Most-recent checklist call in `messages[from, to)`, scanning backward. Returns
 * its `toolUseId` and array index, or null. Pulled out so the id can be
 * recomputed incrementally (see the `latestTodoId` memo) instead of re-walking
 * the whole conversation on every stream token.
 *
 * Either provider's spelling counts — Codex's `TodoWrite`, or one of Claude
 * Code's `Task*` calls. A `Task*` call only counts once the fold gave it a
 * snapshot: a failed one renders as an ordinary tool card, and letting it claim
 * "latest" would collapse the real list above it with nothing taking its place.
 */
function findLatestTodo(
  messages: ChatMessage[],
  from: number,
  to: number,
  snapshots: TaskSnapshots
): { id: string; index: number } | null {
  for (let i = to - 1; i >= from; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (let j = m.parts.length - 1; j >= 0; j--) {
      // Streamed part arrays can be sparse — indexes may arrive out of order.
      const p = m.parts[j]
      if (p?.type !== 'tool') continue
      if (p.name === 'TodoWrite') return { id: p.toolUseId, index: i }
      if (TASK_LIST_TOOLS.has(p.name) && snapshots.has(p.toolUseId)) {
        return { id: p.toolUseId, index: i }
      }
    }
  }
  return null
}

/**
 * Everything the loaded window renders, in order, for the task-list fold. Not
 * just the tool parts: prose and user turns have to come through too, because
 * the fold collapses only checklist calls that are genuinely back to back, and
 * anything on screen between two of them ends that run.
 */
function* streamItems(messages: ChatMessage[]): Generator<TranscriptItem> {
  for (const m of messages) {
    if (m.role !== 'assistant') {
      yield { type: m.role }
      continue
    }
    for (const p of m.parts) {
      if (!p) continue
      if (p.type === 'tool') yield p
      // An empty text/thinking part renders nothing, so it breaks no run.
      else if (p.text) yield { type: p.type }
    }
  }
}

/**
 * App Server builds before native plan-item support persisted the proposed plan
 * as assistant prose. While that plan is still awaiting review, replace only
 * the matching trailing block at render time with the same compact Plan row new
 * turns use. The stored transcript stays untouched.
 */
function withCompactLegacyCodexPlan(
  messages: ChatMessage[],
  plan: string,
  requestId: string
): ChatMessage[] {
  const expected = plan.trim()
  if (!expected) return messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]
      if (!part || part.type !== 'text') continue
      const planIndex = part.text.lastIndexOf(expected)
      if (planIndex < 0 || part.text.slice(planIndex + expected.length).trim()) continue
      const prefix = part.text.slice(0, planIndex).trim()
      const replacement: AssistantMessage['parts'] = [
        ...(prefix ? [{ type: 'text' as const, text: prefix }] : []),
        {
          type: 'tool',
          toolUseId: `legacy-codex-plan-${requestId}`,
          name: 'ExitPlanMode',
          input: { plan: expected },
          status: 'success'
        }
      ]
      const nextMessage: AssistantMessage = {
        ...message,
        parts: [
          ...message.parts.slice(0, partIndex),
          ...replacement,
          ...message.parts.slice(partIndex + 1)
        ]
      }
      const next = [...messages]
      next[messageIndex] = nextMessage
      return next
    }
  }
  return messages
}

/**
 * Renders the message list, collapsing runs of consecutive read/search-only
 * assistant messages into a single ToolGroup ("Read 12 files"). Since every tool
 * call is its own assistant message, a task that reads many files would otherwise
 * bury the conversation under a wall of identical cards.
 */
function renderMessages(all: ChatMessage[], ctx: RenderCtx): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let run: AssistantMessage[] = []
  const messages = all.filter((m) => !isBlankMsg(m))
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
    else out.push(<EventRow key={m.id} message={m} pending={m.id === ctx.switchPendingId} />)
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
      prev.ctx.onOpenPlan !== next.ctx.onOpenPlan ||
      prev.ctx.switchPendingId !== next.ctx.switchPendingId
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
  const hiddenBefore = useApp((s) => s.hiddenBefore)
  const loadingOlder = useApp((s) => s.loadingOlder)
  const loadOlderMessages = useApp((s) => s.loadOlderMessages)
  const status = useApp((s) => s.statuses[chat.id] ?? 'idle')
  // Fall back to a stable constant — a fresh `[]` per render makes zustand's
  // snapshot comparison always fail and loops React into a crash.
  const lockedElsewhere = useApp((s) => !!s.lockedChats[chat.id])
  const permissions = useApp((s) => s.permissions[chat.id] ?? NO_PERMISSIONS)
  const queued = useApp((s) => s.queued[chat.id] ?? NO_QUEUED)
  const removeQueued = useApp((s) => s.removeQueued)
  const sendQueuedNow = useApp((s) => s.sendQueuedNow)
  const git = useApp((s) => s.git)
  const commands = useApp((s) => s.commands)
  const openPlanPanel = useApp((s) => s.openPlanPanel)
  const togglePanel = useApp((s) => s.togglePanel)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const runGitAction = useApp((s) => s.runGitAction)
  const setupMissing = useApp((s) => s.setupMissingFor === chat.id)
  const dismissSetupNotice = useApp((s) => s.dismissSetupNotice)
  const panelOpen = useApp((s) => s.panelOpen)
  const terminalBusy = useApp((s) => s.terminalBusy)
  const busyTerminals = Object.values(terminalBusy)
  const busyLabel =
    busyTerminals.length === 1 ? busyTerminals[0] : `${busyTerminals.length} processes`
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const sendMessage = useApp((s) => s.sendMessage)
  const interrupt = useApp((s) => s.interrupt)
  const setChatOptions = useApp((s) => s.setChatOptions)
  const saveChatDraft = useApp((s) => s.saveChatDraft)
  // Read imperatively, not subscribed: the composer writes a debounced copy back
  // a couple of times a second while you type, and a subscription here would
  // re-render the whole transcript on every one of them. `App` keys this
  // component by chat id, so a mount *is* a chat switch — which is the only
  // moment the draft needs reading.
  const initialDraft = React.useMemo(() => useApp.getState().chatDrafts[chat.id], [chat.id])
  const modelEfforts = useApp((s) => s.defaults?.modelEfforts)
  // A cross-provider pick is only armed until the next send; the composer
  // previews its provider (efforts, placeholder, labels) while the chat itself
  // stays on the current backend.
  const composerProvider =
    chat.pendingModel !== undefined ? (chat.pendingProvider ?? chat.provider) : chat.provider
  const renameChat = useApp((s) => s.renameChat)
  const deleteChat = useApp((s) => s.deleteChat)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  /**
   * Distance from the BOTTOM of the scroller, captured just before older
   * messages are prepended. Anchoring on the bottom rather than on scrollTop is
   * what keeps the message under the cursor still: prepending changes
   * scrollHeight, and the gap below the viewport is the part that doesn't move.
   */
  const bottomAnchor = React.useRef<number | null>(null)
  const [showJump, setShowJump] = React.useState(false)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')
  const [handoffOpen, setHandoffOpen] = React.useState(false)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [finishOpen, setFinishOpen] = React.useState(false)

  const busy = status !== 'idle'

  // Merging is only ever offered off the default branch — on it there is
  // nothing to land, and the ladder's job there is to branch off instead.
  // `git.defaultBranch` is the same field the ↓n chip and the merge dialog
  // read, so the label always names the branch the operation actually targets.
  const defaultBranch = git?.defaultBranch ?? 'main'
  const canMerge = !!git?.defaultBranch && git.branch !== git.defaultBranch

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

  const loadEarlier = React.useCallback((): void => {
    const el = scrollRef.current
    bottomAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    // Asking for older messages is a statement that you want to read up, not
    // follow the stream — otherwise the follow-the-tail effect below would
    // immediately undo the restore.
    pinnedRef.current = false
    setShowJump(true)
    void loadOlderMessages()
  }, [loadOlderMessages])

  // Restore the reading position after a prepend, before the browser paints.
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = bottomAnchor.current
    if (!el || anchor === null) return
    bottomAnchor.current = null
    el.scrollTop = el.scrollHeight - anchor
  }, [hiddenBefore])

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
  const pendingPlan = (pendingPlanRequest?.input as { plan?: unknown } | null)?.plan
  const displayedMessages = React.useMemo(
    () =>
      chat.provider === 'codex' &&
      pendingPlanRequest &&
      typeof pendingPlan === 'string'
        ? withCompactLegacyCodexPlan(messages, pendingPlan, pendingPlanRequest.id)
        : messages,
    [chat.provider, messages, pendingPlan, pendingPlanRequest]
  )

  // Claude Code's checklist arrives as incremental TaskCreate/TaskUpdate calls
  // that carry no list of their own, so it is folded out of the whole loaded
  // window here — the fold has to span messages, since a TaskUpdate's matching
  // TaskCreate is never in the same one. Cheap in practice: the window is
  // HYDRATE_TAIL-bounded, and a chat with no Task* calls costs one name check
  // per part. `reconcileSnapshots` keeps unchanged arrays at their old identity
  // so cards don't re-render on every token.
  const snapshotsRef = React.useRef<TaskSnapshots>(new Map())
  const taskFold = React.useMemo(() => {
    const fold = foldTaskParts(streamItems(messages))
    fold.snapshots = reconcileSnapshots(snapshotsRef.current, fold.snapshots)
    snapshotsRef.current = fold.snapshots
    return fold
  }, [messages])
  const taskSnapshots = taskFold.snapshots

  // The most recent checklist call is the live task list; earlier ones collapse.
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
    // A newer checklist call can only be in the changed/appended suffix.
    let found = findLatestTodo(messages, diverge, messages.length, taskSnapshots)
    if (!found && cache && cache.index >= 0 && cache.index < diverge) {
      // Nothing newer, and the cached answer still lives in the untouched prefix.
      found = { id: cache.id as string, index: cache.index }
    } else if (!found) {
      // The prefix changed under the cached answer (rewind / chat switch, or no
      // cache yet) — scan it too. `diverge` is 0 on a chat switch, so the suffix
      // scan above already covered everything and this range is empty.
      found = findLatestTodo(messages, 0, diverge, taskSnapshots)
    }
    const next = found ?? { id: null, index: -1 }
    todoScanCache.current = { messages, id: next.id, index: next.index }
    return next.id
  }, [messages, taskSnapshots])

  // Publish the live id and the folded lists to their own store so only the
  // affected cards re-render — see taskListStore. Kept out of the history
  // render path.
  const setLatestId = useTaskList((s) => s.setLatestId)
  const setFold = useTaskList((s) => s.setFold)
  React.useEffect(() => {
    setLatestId(latestTodoId)
  }, [latestTodoId, setLatestId])
  React.useEffect(() => {
    setFold(taskFold.snapshots, taskFold.superseded)
  }, [taskFold, setFold])

  const openPlan = React.useCallback(
    (plan: string) => {
      openPlanPanel({ chatId: chat.id, plan, requestId: pendingPlanRequest?.id ?? null })
    },
    [openPlanPanel, chat.id, pendingPlanRequest?.id]
  )
  const historyEnd = liveAssistant ? messages.length - 1 : messages.length
  // A live message that is itself only tool calls joins the trailing run of
  // tool-only history messages in ONE live ToolGroup — the same row history
  // will render once the turn ends. Without this, each new search/read/agent
  // streams as its own card and only collapses after the fact (each call is
  // its own assistant message on the Claude side, unlike Codex's single
  // accumulating message).
  const liveRun = React.useMemo(() => {
    if (!liveAssistant || !isGroupableMsg(liveAssistant)) return null
    let start = historyEnd
    while (start > 0) {
      const prev = displayedMessages[start - 1]
      if (prev.role === 'assistant' && (isGroupableMsg(prev) || isBlankMsg(prev))) start -= 1
      else break
    }
    const parts = [...displayedMessages.slice(start, historyEnd), liveAssistant].flatMap((m) =>
      m.role === 'assistant'
        ? m.parts.filter((p): p is ToolPart => !!p && p.type === 'tool')
        : []
    )
    return parts.length >= GROUP_MIN ? { start, parts } : null
  }, [liveAssistant, displayedMessages, historyEnd])
  // The most recent switch divider renders live ("writing handoff brief…")
  // exactly while main reports the handoff in flight; the busy gate means a
  // crash or restart can never leave a divider shimmering forever.
  const switchPendingId = React.useMemo(() => {
    if (!busy || !chat.switchingNote) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'event' && m.kind === 'switch') return m.id
    }
    return undefined
  }, [busy, chat.switchingNote, messages])
  const historyCtx = React.useMemo<RenderCtx>(
    () => ({
      cwd: chat.cwd,
      busy,
      onOpenPlan: openPlan,
      switchPendingId
    }),
    [chat.cwd, busy, openPlan, switchPendingId]
  )

  return (
    <div className="relative flex h-full min-w-[420px] flex-1 flex-col">
      {/* Header */}
      <header
        className={cn(
          // pr matches the panel header's px-2.5 so the panel toggle sits at the
          // same inset whether it renders here or over there.
          'drag flex h-[38px] shrink-0 items-center gap-2 pl-4 pr-2.5',
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
            {/* How the branch ends: keep it current, land it here, or — in a
                worktree — move out of it or retire it once the work landed
                through a PR. Merging rewrites the chat's own directory when
                there's no worktree, so that one waits for idle. */}
            {(chat.worktree || canMerge) && <DropdownMenuSeparator />}
            {canMerge && (
              <>
                <DropdownMenuItem onClick={() => void runGitAction('update-from-main')}>
                  <RefreshCw /> Update from {defaultBranch}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setMergeOpen(true)} disabled={busy}>
                  <GitMerge /> Merge into {defaultBranch}
                </DropdownMenuItem>
              </>
            )}
            {chat.worktree && (
              <>
                <DropdownMenuItem onClick={() => setHandoffOpen(true)}>
                  <ArrowLeftRight /> Continue in local checkout
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFinishOpen(true)}>
                  <Trash /> Remove worktree
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Last icon, deliberately: when the panel is open its own header hosts
            the collapse button at the same inset, so open and close are one
            unmoving target rather than two positions with the ⋯ menu between. */}
        {!panelOpen && (
          <WithTooltip label={busyTerminals.length ? `${busyLabel} running` : 'Show files'}>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={togglePanel}
              aria-label="Show file panel"
              className="relative"
            >
              <PanelRight />
              {/* A dev server left running in a collapsed panel is invisible
                  otherwise — it only shows up later as memory. */}
              {busyTerminals.length > 0 && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
              )}
            </Button>
          </WithTooltip>
        )}
      </header>

      {/* userData is shared between the dev and packaged builds on purpose, so
          the same chat can be open twice. The other instance owns the write
          lock; this one still works, it just is not persisting. */}
      {lockedElsewhere && (
        <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-200/90">
          This chat is open in another Carbon instance, which owns it. Changes made here
          are <span className="font-medium">not being saved</span>. Close it there, then reopen this chat.
        </div>
      )}

      {/* A fresh worktree has none of the repo's gitignored files, and with no
          setup script nothing installed them — say so, or the agent's first
          "command not found" looks like a bug in the project. */}
      {setupMissing && (
        <div className="flex items-start gap-2 border-b border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            This worktree is a fresh checkout with no dependencies installed — the project has no{' '}
            <code className="font-mono text-[11px] text-foreground">.karbun/setup.sh</code>. Add one
            (or run your install command in a terminal tab) if the agent needs them.
          </span>
          <button
            type="button"
            onClick={dismissSetupNotice}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {hiddenBefore > 0 && (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={loadEarlier}
                disabled={loadingOlder}
              >
                {loadingOlder
                  ? 'Loading…'
                  : `Load earlier messages (${hiddenBefore.toLocaleString()})`}
              </Button>
            </div>
          )}
          <MessageHistory
            messages={displayedMessages}
            end={liveRun ? liveRun.start : historyEnd}
            ctx={historyCtx}
          />
          {liveRun ? (
            <ToolGroup parts={liveRun.parts} cwd={chat.cwd} />
          ) : (
            liveAssistant && (
              <AssistantBlock
                message={liveAssistant}
                cwd={chat.cwd}
                streaming
                onOpenPlan={openPlan}
              />
            )
          )}
          {permissions.map((request) => {
            if (request.toolName === 'AskUserQuestion')
              return (
                <QuestionCard key={request.id} request={request} provider={chat.provider} />
              )
            if (request.toolName === 'ExitPlanMode')
              return (
                <div
                  key={request.id}
                  className="flex animate-enter items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5"
                >
                  <span className="text-[13px]">
                    {PROVIDER_SHORT_LABELS[chat.provider]} prepared a plan for your review.
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
          <ContextStrip
            cwd={chat.cwd}
            project={projectRoot(chat)}
            git={git}
            onReviewChanges={() => void reviewChanges()}
            onUpdateFromDefault={() => void runGitAction('update-from-main')}
          />
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
            // Returned, not voided: the composer needs the promise so a failed
            // send restores the draft instead of discarding it.
            onSend={(text, attachments) => sendMessage(text, attachments)}
            draft={initialDraft}
            onDraftChange={(next) => saveChatDraft(chat.id, next)}
            streaming={busy}
            onStop={() => void interrupt()}
            // A cross-provider pick is only armed until the next send; the
            // composer previews it (chip, efforts, placeholder) while the chat
            // itself stays on its current backend.
            model={chat.pendingModel ?? chat.model ?? ''}
            onModelChange={(model, modelProvider) =>
              void setChatOptions({ model, modelProvider })
            }
            effort={chat.effort ?? ''}
            onEffortChange={(effort, opts) => void setChatOptions({ effort, ...opts })}
            modelEfforts={modelEfforts}
            serviceTier={chat.serviceTier ?? 'standard'}
            onServiceTierChange={(serviceTier, opts) =>
              void setChatOptions({ serviceTier, ...opts })
            }
            permissionMode={chat.permissionMode}
            onPermissionModeChange={(permissionMode) => void setChatOptions({ permissionMode })}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            provider={composerProvider}
            cwd={chat.cwd}
            commands={commands}
            // Busy-gated so a note left behind by a crash can never stick.
            switchingNote={busy ? chat.switchingNote : undefined}
            placeholder={
              composerProvider === 'claude'
                ? undefined
                : `Ask ${PROVIDER_SHORT_LABELS[composerProvider]} anything…`
            }
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

      {chat.worktree && (
        <>
          <WorktreeHandoffDialog chat={chat} open={handoffOpen} onOpenChange={setHandoffOpen} />
          <WorktreeFinishDialog chat={chat} open={finishOpen} onOpenChange={setFinishOpen} />
        </>
      )}
      {canMerge && <MergeIntoMainDialog chat={chat} open={mergeOpen} onOpenChange={setMergeOpen} />}

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

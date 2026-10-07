import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import {
  ArrowLeftRight,
  ArrowUpLeft,
  Bot,
  Columns3,
  GitMerge,
  LayoutGrid,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Trash,
  Trash2,
  X
} from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_LABELS, modelDisplayName, projectRoot } from '@shared/types'
import {
  agentColumnId,
  agentRunOf,
  formatAgentDuration,
  isAgentColumn,
  parseAgentColumn,
  untrackedBackground
} from '@shared/agentRuns'
import { useAgents } from '@/agentsStore'
import { AgentStreamBody } from '@/components/AgentsPanel'
import { TranscriptChat, useAgentPart, useElapsed } from '@/components/messages/AgentRows'
import { cn } from '@/lib/utils'
import { chatActivityKind } from '@/lib/chatActivity'
import { focusComposer } from '@/lib/composerFocus'
import { orderByHint } from '@/lib/tabOrder'
import {
  COLUMN_DRAG_MIME,
  draggedThread,
  setDraggedColumn,
  THREAD_DRAG_MIME
} from '@/lib/threadDrag'
import {
  chatMeta,
  isClosedSideChat,
  threadFull,
  MAX_THREAD_CHATS,
  panelFloats,
  severalChatsShown,
  threadJoinCheck,
  threadLayoutFor,
  useApp
} from '@/store'
import { ChatView } from '@/components/ChatView'
import { BackgroundJobs, isAgentJob } from '@/components/BackgroundJobs'
import { ContextStrip } from '@/components/ContextStrip'
import { ProviderMark } from '@/components/ui/provider-mark'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  MergeIntoMainDialog,
  WorktreeFinishDialog,
  WorktreeHandoffDialog
} from '@/components/BranchActions'

/**
 * A thread: one chat and the side chats opened beside it, drawn as up to
 * `MAX_THREAD_CHATS` columns that share the right panel.
 *
 * The thread's own chat is the one the sidebar shows, and it owns everything
 * that acts on the thread as a whole — its title, its ⋯ menu, its worktree and
 * branch. Each column is a full `ChatView`: its own transcript, prompts and
 * composer, on whatever model was picked for it.
 *
 * With one chat nothing here draws beyond the header, so a chat that never grew
 * a second column looks exactly as it always has.
 */
export function ThreadView({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const sideColumns = useApp((s) => s.sideColumns)
  // In the order the columns were last dragged into — see `threadOrder`.
  const order = useApp((s) => s.threadOrder[chat.id])
  const ids = React.useMemo(
    () => orderByHint(order, [chat.id, ...sideColumns]),
    [order, chat.id, sideColumns]
  )
  useThreadKeys(ids)
  const join = useThreadJoinDrop()

  return (
    // The frosted main column: one wash under every column, so a thread reads
    // as one surface rather than four tinted panes.
    <div data-chatview className="relative flex h-full min-w-0 flex-1 flex-col" {...join.handlers}>
      <ThreadHeader chat={chat} ids={ids} />
      {ids.length === 1 ? (
        <div className="flex min-h-0 flex-1">
          <ChatView chat={chat} />
        </div>
      ) : (
        <ThreadColumns ids={ids} threadId={chat.id} />
      )}
      {join.state && <JoinOverlay state={join.state} />}
    </div>
  )
}

type JoinState = NonNullable<ReturnType<typeof threadJoinCheck>>

/**
 * The thread as a drop target for a chat dragged from the sidebar, which joins
 * it as a column. The verdict is worked out while hovering — the dragged id
 * comes from `threadDrag`, since the payload is unreadable until the drop — so
 * a full thread or another folder says so before the drop, not after it.
 */
function useThreadJoinDrop(): {
  state: JoinState | null
  handlers: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
} {
  const [state, setState] = React.useState<JoinState | null>(null)
  // A drag released anywhere — including over this thread with the drop
  // refused, which fires no `drop` — ends the overlay.
  React.useEffect(() => {
    const clear = (): void => setState(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])
  const isThreadDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes(THREAD_DRAG_MIME)
  return {
    state,
    handlers: {
      onDragOver: (e) => {
        if (!isThreadDrag(e)) return
        const id = draggedThread()
        const check = id ? threadJoinCheck(useApp.getState(), id) : null
        if (!check) return
        e.preventDefault()
        e.dataTransfer.dropEffect = check.ok ? 'move' : 'none'
        setState((prev) =>
          prev &&
          prev.ok === check.ok &&
          (prev.ok ? prev.title : prev.reason) === (check.ok ? check.title : check.reason)
            ? prev
            : check
        )
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setState(null)
      },
      onDrop: (e) => {
        setState(null)
        if (!isThreadDrag(e)) return
        e.preventDefault()
        const id = draggedThread() ?? e.dataTransfer.getData(THREAD_DRAG_MIME)
        if (id) void useApp.getState().joinThread(id)
      }
    }
  }
}

function JoinOverlay({ state }: { state: JoinState }): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none absolute inset-x-3 top-[46px] bottom-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed backdrop-blur-[1px]',
        state.ok ? 'border-primary/60 bg-primary/5' : 'border-border bg-background/60'
      )}
    >
      <span
        className={cn(
          'rounded-md bg-popover px-3 py-1.5 text-[13px] shadow-lg',
          state.ok ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {state.ok ? (
          <>
            Add <span className="font-medium">“{state.title}”</span> to this thread
          </>
        ) : (
          state.reason
        )}
      </span>
    </div>
  )
}

/**
 * ⌘1–⌘4 focus a column (and move the caret into its composer); ⌘⇧↵ expands the
 * focused one, or restores the thread; Esc steps back out of a floating panel or
 * an expansion. Window-level so they work from anywhere in the thread, including
 * a composer that has the caret.
 */
function useThreadKeys(ids: readonly string[]): void {
  const idsRef = React.useRef(ids)
  idsRef.current = ids
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return
      const list = idsRef.current
      if (list.length < 2) return
      const st = useApp.getState()
      if (!e.shiftKey && /^[1-4]$/.test(e.key)) {
        const id = list[Number(e.key) - 1]
        if (!id) return
        e.preventDefault()
        st.focusChat(id, { caret: true })
        return
      }
      if (e.shiftKey && e.key === 'Enter' && st.focusedChatId) {
        e.preventDefault()
        st.toggleExpandedChat(st.focusedChatId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Esc steps back one layer: a floating panel first, then an expanded column.
  //
  // On `document` in the bubble phase, which is the one slot that orders this
  // correctly against everything else Esc means. React's handlers run at the
  // root, below `document`, so an open slash menu or mention list has already
  // closed itself and marked the key handled; the prompt dock listens on
  // `window`, above it, so with a pending prompt the first Esc closes the panel
  // and only the second denies. Keys inside the panel stay the panel's — a
  // terminal, the editor and the find bar all have their own use for Esc — and
  // so do keys inside any open popup.
  React.useEffect(() => {
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-right-panel], [role="dialog"], [role="menu"], [role="listbox"]')) {
        return
      }
      const st = useApp.getState()
      if (st.panelOpen && panelFloats(st)) {
        e.preventDefault()
        st.togglePanel()
        return
      }
      if (st.expandedChatId) {
        e.preventDefault()
        st.toggleExpandedChat(st.expandedChatId)
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [])
}

function ThreadHeader({ chat, ids }: { chat: ChatMeta; ids: readonly string[] }): React.JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const panelOpen = useApp((s) => s.panelOpen)
  const togglePanel = useApp((s) => s.togglePanel)
  const terminalBusy = useApp((s) => s.terminalBusy)
  const focused = useApp((s) => s.focusedChatId) ?? chat.id
  const threadLayout = useApp((s) => s.threadLayout)
  const expanded = useApp((s) => s.expandedChatId !== null)
  const setThreadLayout = useApp((s) => s.setThreadLayout)
  const severalChats = useApp(severalChatsShown)
  const git = useApp((s) => s.git)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const runGitAction = useApp((s) => s.runGitAction)
  const busyTerminals = Object.values(terminalBusy)
  const busyLabel =
    busyTerminals.length === 1 ? busyTerminals[0] : `${busyTerminals.length} processes`
  const layout = threadLayoutFor(ids.length, threadLayout)
  // The thread's closed chats, newest first — drawn beside the open ones so a
  // put-away agent or side chat is one click from coming back, rather than
  // behind ＋. Selected by identity and derived here, like `AddChatControl`.
  const chats = useApp((s) => s.chats)
  const sideColumns = useApp((s) => s.sideColumns)
  const closed = React.useMemo(
    () =>
      chats
        // A killed delegate is put away, not merely closed — it stays
        // reachable from its card and the ＋ list, but not from the strip.
        .filter((c) => isClosedSideChat(c, chat.id, sideColumns) && !c.delegation?.dismissedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [chats, chat.id, sideColumns]
  )

  return (
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
      <div
        className={cn(
          'min-w-0 truncate text-[13px] font-semibold',
          ids.length === 1 && 'flex-1'
        )}
      >
        {chat.title || 'New chat'}
      </div>
      {(ids.length > 1 || closed.length > 0) && (
        <>
          <div
            role="tablist"
            aria-label="Chats in this thread"
            className="no-drag ml-1 flex shrink-0 items-center gap-0.5 border-l border-border pl-2"
          >
            {/* Chats only — a delegate is a chat and has its pill; a spawned
                sub-agent is reached from the robot menu at the right, so a
                busy turn's fan-out does not crowd this strip. */}
            {ids.length > 1 &&
              ids.map((id, i) =>
                isAgentColumn(id) ? null : (
                  <ThreadPill key={id} id={id} threadId={chat.id} index={i} focused={id === focused} />
                )
              )}
            {closed.slice(0, CLOSED_PILLS).map((c) => (
              <ClosedPill key={c.id} chat={c} full={ids.length >= MAX_THREAD_CHATS} />
            ))}
          </div>
          <div className="min-w-2 flex-1" />
        </>
      )}
      {/* Where the thread runs and what it has changed, once for every column.
          With one conversation showing it sits above that composer instead. */}
      {severalChats && (
        <ContextStrip
          cwd={chat.cwd}
          project={projectRoot(chat)}
          git={git}
          onReviewChanges={() => void reviewChanges()}
          onUpdateFromDefault={() => void runGitAction('update-from-main')}
          className="no-drag mb-0 shrink-0"
        />
      )}
      <BackgroundJobs chatId={parseAgentColumn(focused)?.parentId ?? focused} />
      {ids.length >= 3 && (
        <div
          role="group"
          aria-label="Layout"
          className="no-drag flex shrink-0 items-center gap-0.5 rounded-md bg-secondary/60 p-0.5"
        >
          <LayoutButton
            label="Columns"
            active={!expanded && layout === 'columns'}
            onClick={() => setThreadLayout('columns')}
          >
            <Columns3 />
          </LayoutButton>
          <LayoutButton
            label="Grid"
            active={!expanded && layout === 'grid'}
            onClick={() => setThreadLayout('grid')}
          >
            <LayoutGrid />
          </LayoutButton>
        </div>
      )}
      <SubagentsMenu chatIds={ids.filter((id) => !isAgentColumn(id))} openIds={ids} />
      <AddChatControl count={ids.length} threadId={chat.id} />
      <ThreadMenu chat={chat} />
      {/* Open — docked or floating over this header — the panel's own header
          holds the collapse at this same inset, so open and close stay one
          unmoving target. */}
      {!panelOpen && (
        <WithTooltip label={busyTerminals.length ? `${busyLabel} running` : 'Show panel'}>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={togglePanel}
            aria-label="Show panel"
            className="no-drag relative"
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
  )
}

function LayoutButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex h-5.5 w-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors [&_svg]:size-3.5',
          active ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'
        )}
      >
        {children}
      </button>
    </WithTooltip>
  )
}

const isChatDrag = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(COLUMN_DRAG_MIME)

/**
 * Drag handlers for chat `id`'s handle — its column header or its pill. Dropped
 * on another column it reorders; dropped on the sidebar it leaves the thread.
 */
function chatDragHandlers(
  id: string
): Pick<React.HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragEnd'> {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(COLUMN_DRAG_MIME, id)
      e.dataTransfer.effectAllowed = 'move'
      setDraggedColumn(id)
    },
    onDragEnd: () => setDraggedColumn(null)
  }
}

/**
 * Make an element a drop target for reordering the thread's chats: which edge
 * the dragged chat would land on, and the handlers that track and apply it.
 * Left or right half, whatever the layout — a grid reads left to right, top to
 * bottom, so "after" the top-left cell is the top-right one.
 */
function useChatDrop(
  threadId: string,
  id: string
): {
  over: 'before' | 'after' | null
  handlers: Pick<
    React.HTMLAttributes<HTMLElement>,
    'onDragOver' | 'onDragLeave' | 'onDrop'
  >
} {
  const [over, setOver] = React.useState<'before' | 'after' | null>(null)
  const sideOf = (e: React.DragEvent<HTMLElement>): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
  }
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        if (!isChatDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const side = sideOf(e)
        if (side !== over) setOver(side)
      },
      onDragLeave: (e) => {
        // Crossing into a child fires leave on the parent; only a real exit clears.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
      },
      onDrop: (e) => {
        setOver(null)
        if (!isChatDrag(e)) return
        e.preventDefault()
        const dragged = e.dataTransfer.getData(COLUMN_DRAG_MIME)
        if (dragged && dragged !== id) useApp.getState().moveThreadChat(threadId, dragged, id, sideOf(e))
      }
    }
  }
}

/** The bar a reorder drop would land on: the dragged chat goes on this edge. */
function DropEdge({ side, inset }: { side: 'before' | 'after' | null; inset: string }): React.JSX.Element | null {
  if (!side) return null
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute z-20 w-0.5 rounded-full bg-primary',
        inset,
        side === 'before' ? 'left-0' : 'right-0'
      )}
    />
  )
}

/**
 * One chat of the thread in the header: its number (what ⌘1–⌘4 name), its
 * provider, and whether it is working, waiting on you, or finished while you
 * were in another column. Its own component so the header subscribes to one
 * chat's status at a time, as a primitive.
 */
function ThreadPill({
  id,
  threadId,
  index,
  focused
}: {
  id: string
  threadId: string
  index: number
  focused: boolean
}): React.JSX.Element | null {
  const meta = useApp((s) => chatMeta(s, id))
  const drop = useChatDrop(threadId, id)
  if (isAgentColumn(id)) return null
  if (!meta) return null
  const title = meta.title?.trim() || 'New chat'
  const onClick = (): void => useApp.getState().focusChat(id, { caret: true })
  return (
    <WithTooltip label={`${title}  ⌘${index + 1}`} side="bottom">
      <button
        type="button"
        role="tab"
        aria-selected={focused}
        aria-label={`Chat ${index + 1}: ${title}`}
        onClick={onClick}
        // Pills reorder the columns too: the strip is the one place every chat
        // is in reach at once, expanded or not.
        {...chatDragHandlers(id)}
        {...drop.handlers}
        className={cn(
          'relative flex h-6.5 items-center gap-1.5 rounded-md border px-1.5 transition-colors',
          focused
            ? 'border-border bg-background text-foreground shadow-sm'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <ChatNumber index={index} focused={focused} />
        <ProviderMark provider={meta.provider} className="size-3" />
        <ChatMark id={id} />
        <DropEdge side={drop.over} inset="inset-y-1 -mx-[3px]" />
      </button>
    </WithTooltip>
  )
}

/**
 * The thread's spawned sub-agents — every chat's on screen, Claude's `Task`s
 * and the other providers' `Agent`s — behind one robot icon at the right of
 * the header, rather than as pills. A working session spins up many of them,
 * and a pill each crowded out the chats the strip is for; delegates are chats
 * and keep their pills. Read off `agentsStore` (each `ChatView` publishes its
 * fold there, carried forward by identity), so the menu moves when an agent
 * does and not on every token. A row opens the agent as a column, or folds an
 * open one back. A backgrounded agent is also a live job in the CLI's task set,
 * and its Stop lives here rather than in the "running" pill, which leaves
 * agents to this menu so one fan-out is not counted twice.
 */
function SubagentsMenu({
  chatIds,
  openIds
}: {
  chatIds: readonly string[]
  openIds: readonly string[]
}): React.JSX.Element | null {
  const byChat = useAgents((s) => s.byChat)
  const chats = useApp((s) => s.chats)
  const toggleAgentColumn = useApp((s) => s.toggleAgentColumn)
  const backgroundJobs = useApp((s) => s.backgroundJobs)
  const stopBackgroundJob = useApp((s) => s.stopBackgroundJob)
  const full = useApp(threadFull)
  const [open, setOpen] = React.useState(false)
  const rows = React.useMemo(
    () =>
      chatIds.flatMap((chatId) =>
        (byChat[chatId]?.runs ?? []).map((run) => ({
          chatId,
          run,
          provider: chats.find((c) => c.id === chatId)?.provider ?? 'claude'
        }))
      ),
    [chatIds, byChat, chats]
  )
  const working = rows.filter((r) => r.run.status === 'running').length
  const now = useNow(working > 0 && open)
  if (!rows.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="no-drag relative h-6.5 shrink-0 gap-1 px-1.5"
            aria-label={`Sub-agents: ${rows.length}${working ? `, ${working} working` : ''}`}
            data-subagents-menu={rows.length}
          >
            <Bot className={cn(working > 0 && 'text-primary')} />
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {working > 0 ? `${working}/${rows.length}` : rows.length}
            </span>
            {working > 0 && (
              <span className="absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-primary" />
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-1">
        <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/70">
          Sub-agents{working ? ` · ${working} working` : ''}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {rows.map(({ chatId, run, provider }) => {
            const columnOpen = openIds.includes(agentColumnId(chatId, run.id))
            const end = run.status === 'running' ? now : run.endedAt
            const elapsed =
              run.startedAt != null && end != null ? formatAgentDuration(end - run.startedAt) : null
            // `callId` is the spawning call's id, which is what a run is keyed by.
            const job =
              run.status === 'running'
                ? backgroundJobs[chatId]?.find((j) => isAgentJob(j.type) && j.callId === run.id)
                : undefined
            return (
              <div key={`${chatId}:${run.id}`} className="group flex items-center rounded-md hover:bg-accent">
                <button
                  type="button"
                  data-subagent-row={run.id}
                  disabled={!columnOpen && full}
                  title={!columnOpen && full ? 'The thread already shows four chats — close one to open this agent.' : undefined}
                  onClick={() => toggleAgentColumn(chatId, run.id)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] disabled:opacity-50',
                    run.depth > 0 && 'pl-6'
                  )}
                >
                  <span className="relative shrink-0">
                    <ProviderMark provider={provider} className="size-3.5 text-muted-foreground" />
                    <span
                      className={cn(
                        'absolute -right-1 -bottom-1 size-1.5 rounded-full',
                        run.status === 'running'
                          ? 'animate-pulse bg-primary'
                          : run.status === 'failed'
                            ? 'bg-destructive'
                            : 'bg-success'
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {run.type && <span className="text-muted-foreground">{run.type}: </span>}
                    {run.description || 'Sub-agent'}
                  </span>
                  {elapsed && (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">{elapsed}</span>
                  )}
                  {columnOpen && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" title="Open" />}
                </button>
                {job && job.stoppable !== false && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mr-1 h-6 shrink-0 px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={() => stopBackgroundJob(chatId, job.id)}
                  >
                    Stop
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A clock for the menu, ticking only while it is open and something runs. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

/**
 * The prompt the parent agent wrote, as the first message of the agent's
 * column — marked as sent by another agent, and folded past a few lines: a
 * brief is often pages long, and the work below it is what was opened.
 */
function AgentPrompt({ text }: { text: string }): React.JSX.Element {
  const [full, setFull] = React.useState(false)
  const long = text.length > 420 || text.split('\n').length > 8
  return (
    <div className="mb-4 flex flex-col items-end gap-1">
      <span className="pr-1 text-[11px] text-muted-foreground">Sent by another agent</span>
      <div className="relative max-w-[92%] rounded-2xl bg-secondary/70 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
        <div className={cn('whitespace-pre-wrap break-words', !full && long && 'max-h-40 overflow-hidden')}>{text}</div>
        {long && (
          <button
            type="button"
            onClick={() => setFull((v) => !v)}
            className="mt-1.5 block w-full text-right text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {full ? 'Show less' : 'Show full message'}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * A native sub-agent opened as a thread column — Claude's `Task`, Codex's,
 * Grok's and Antigravity's `Agent` alike. Its stream is read live out of the
 * parent chat's transcript (the spawning call's `children`), so it needs no
 * storage of its own and cannot drift from the row it was opened from.
 *
 * What it shows is what the provider reports: Claude and Codex stream the
 * agent's whole work; Grok and Antigravity report only that it ran and its
 * final result, so their column is the prompt, the clock and the report.
 *
 * There is no composer, because there is nobody to type to — no provider
 * offers a way to message a sub-agent it is running — and the footer says so:
 * "Runs on its own", with the way back to the parent.
 */
function AgentColumn({
  id,
  index,
  focused,
  expanded,
  className
}: {
  id: string
  index: number
  focused: boolean
  expanded: boolean
  className: string
}): React.JSX.Element | null {
  const ref = parseAgentColumn(id)
  const parentId = ref?.parentId ?? ''
  const parent = useApp((s) => chatMeta(s, parentId))
  // The part by reference — see `useAgentPart`: an open column re-renders when
  // its agent moves, not on every token the parent streams.
  const part = useAgentPart(parentId, ref?.toolUseId ?? '')
  const toggleExpandedChat = useApp((s) => s.toggleExpandedChat)
  const closeSideChat = useApp((s) => s.closeSideChat)
  const provider = parent?.provider ?? 'claude'
  const transcriptChat = React.useMemo(() => ({ chatId: parentId, provider }), [parentId, provider])
  const run = React.useMemo(() => (part ? agentRunOf(part) : undefined), [part])
  const running = run?.status === 'running'
  // Held running for the agent's whole life — see `AgentDetail`'s `live`.
  const live = part?.status === 'running' || part?.status === 'pending'
  const elapsed = useElapsed(run?.startedAt, run?.endedAt, running)
  const input = (part?.input ?? {}) as Record<string, unknown>
  const prompt =
    (typeof input.prompt === 'string' && input.prompt) ||
    (typeof input.description === 'string' && input.description) ||
    run?.description ||
    ''
  const title = run?.description || 'Subagent'
  // Stable across renders, so the memoized stream body below is skipped when
  // nothing it draws has moved.
  const lead = React.useMemo(
    () => (
      <>
        <div className="mb-3 truncate text-[13px] font-medium text-foreground">{title}</div>
        {prompt && <AgentPrompt text={prompt} />}
      </>
    ),
    [title, prompt]
  )
  if (!ref) return null
  const model = run?.model ? modelDisplayName(run.model, provider) : PROVIDER_LABELS[provider]
  const claimFocus = (): void => useApp.getState().focusChat(id)
  // Back to the chat that spawned it — and if this column was the expanded
  // one, the expansion moves there with the focus (`focusChat`'s rule).
  const openParent = (): void => useApp.getState().focusChat(parentId, { caret: true })

  return (
    <section
      data-thread-column={id}
      data-agent-column={ref.toolUseId}
      aria-label={`Chat ${index + 1}`}
      // Focusable, so ⌘1–⌘4 onto it takes the keyboard away from the composer
      // it left — there is no composer here to take it.
      tabIndex={-1}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      className={cn('relative flex min-h-0 min-w-0 flex-col outline-none', className)}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <ChatNumber index={index} focused={focused} />
        <ProviderMark provider={provider} className="size-3 shrink-0 text-muted-foreground" />
        <Bot className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs text-muted-foreground">Subagent of</span>
        <span
          title={parent?.title}
          className={cn('min-w-0 truncate text-xs font-medium', focused ? 'text-foreground' : 'text-muted-foreground')}
        >
          {parent?.title?.trim() || 'New chat'}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          <WithTooltip label={expanded ? 'Show all chats  esc' : 'Expand  ⌘⇧↵'}>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => toggleExpandedChat(id)}
              aria-label={expanded ? 'Show all chats' : `Expand chat ${index + 1}`}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </WithTooltip>
          <WithTooltip label="Close">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void closeSideChat(id)}
              aria-label={`Close chat ${index + 1}`}
            >
              <X />
            </Button>
          </WithTooltip>
        </div>
      </div>
      <TranscriptChat.Provider value={transcriptChat}>
        {part ? (
          <AgentStreamBody
            part={part}
            cwd={parent?.cwd ?? ''}
            live={live}
            running={running}
            className="px-4"
            lead={lead}
          />
        ) : (
          <div className="flex-1 px-4 py-6 text-[13px] text-muted-foreground">
            This agent is not in the part of its chat that is loaded. Scroll that chat up to load
            it, or close this column.
          </div>
        )}
      </TranscriptChat.Provider>
      <div className="@container mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-2xl border border-border bg-card/60 px-3.5 py-2 text-[13px]">
        <ProviderMark provider={provider} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-foreground">{model}</span>
        {run?.effort && <span className="shrink-0 text-muted-foreground">{run.effort}</span>}
        <span className={cn('shrink-0 text-muted-foreground', running && 'shimmer-text')}>
          {running
            ? `Working${elapsed ? ` ${elapsed}` : ''}`
            : run?.status === 'failed'
              ? 'Failed'
              : part && untrackedBackground(part)
                ? 'Started in the background'
                : `Finished${elapsed ? ` in ${elapsed}` : ''}`}
        </span>
        <span className="flex-1" />
        <span className="hidden shrink-0 text-muted-foreground @[420px]:inline">Runs on its own</span>
        <button
          type="button"
          onClick={openParent}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ArrowUpLeft className="size-3.5" />
          Open parent
        </button>
      </div>
    </section>
  )
}

/** How many closed chats get a pill; the rest stay in ＋'s list. */
const CLOSED_PILLS = 6

/**
 * A closed chat of the thread: the same pill as an open one, dimmed — its
 * provider, the activity mark a closed chat mid-turn has nowhere else to show,
 * and a click that reopens its column. One design for both, on purpose: a
 * dashed, labelled variant read as a second control rather than the same chat
 * put away. No number — numbers are ⌘1–⌘4 for what is on screen — and the
 * name lives in the tooltip.
 */
function ClosedPill({ chat, full }: { chat: ChatMeta; full: boolean }): React.JSX.Element {
  const reopenSideChat = useApp((s) => s.reopenSideChat)
  const name = chat.delegation?.name
  const title = chat.title?.trim() || 'New chat'
  const label = full
    ? `${name ? `${name} · ` : ''}${title} — the thread shows ${MAX_THREAD_CHATS} chats; close one to reopen this`
    : `${name ? `${name} · ` : ''}${title} — closed, click to reopen`
  return (
    <WithTooltip label={label} side="bottom">
      <button
        type="button"
        data-closed-pill={chat.id}
        aria-label={`Reopen ${name ?? title}`}
        disabled={full}
        onClick={() => void reopenSideChat(chat.id)}
        className="relative flex h-6.5 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-muted-foreground opacity-50 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
      >
        <ProviderMark provider={chat.provider} className="size-3" />
        <ChatMark id={chat.id} />
      </button>
    </WithTooltip>
  )
}

function ChatNumber({ index, focused }: { index: number; focused: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] leading-none font-semibold tabular-nums',
        focused ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground'
      )}
    >
      {index + 1}
    </span>
  )
}

/**
 * What a chat is doing, as the header draws it: waiting on you, working, a
 * background agent, finished while you were in another column — or nothing.
 * A primitive, from a non-allocating read, because it runs for every column on
 * every streamed delta.
 */
function useChatMark(id: string): 'needs-input' | 'working' | 'background' | 'unread' | null {
  return useApp((s) => {
    const kind = chatActivityKind(s.statuses[id], s.backgroundJobs[id], s.permissions[id])
    if (kind !== 'idle') return kind
    return s.unreadChats[id] ? 'unread' : null
  })
}

/**
 * A chat's status, drawn with the sidebar row's icons. `labelled` adds the words
 * a column header has room for; a pill has room for the icon alone.
 */
function ChatMark({ id, labelled = false }: { id: string; labelled?: boolean }): React.JSX.Element | null {
  const mark = useChatMark(id)
  if (mark === 'needs-input') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning" aria-label="Needs your input">
        <MessageCircleQuestion className="size-3" />
        {labelled && 'Needs input'}
      </span>
    )
  }
  if (mark === 'background') {
    return <Bot aria-label="Background jobs running" className="size-3 shrink-0 animate-pulse-soft text-primary" />
  }
  if (mark === 'working') {
    return <DotSpinner aria-label="Working" className="size-3 shrink-0 text-primary" />
  }
  if (mark === 'unread') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-success" aria-label="Finished">
        <span className="size-1.5 rounded-full bg-success" />
        {labelled && 'Done'}
      </span>
    )
  }
  return null
}

/**
 * `+`: a new chat in this thread, or one closed earlier back into it.
 *
 * A plain button until a side chat has been closed — the common case needs no
 * menu — and a popover once there is something to reopen. Closing a column
 * keeps the conversation, so without this list ✕ would be indistinguishable
 * from discarding it.
 */
function AddChatControl({ count, threadId }: { count: number; threadId: string }): React.JSX.Element {
  const addThreadChat = useApp((s) => s.addThreadChat)
  // Selected by identity and derived here, so the scan runs when `chats` or the
  // columns change — not on every streamed delta, as a selector would.
  const chats = useApp((s) => s.chats)
  const sideColumns = useApp((s) => s.sideColumns)
  const hasClosed = React.useMemo(
    () => chats.some((c) => isClosedSideChat(c, threadId, sideColumns)),
    [chats, threadId, sideColumns]
  )
  const [open, setOpen] = React.useState(false)
  const full = count >= MAX_THREAD_CHATS
  const label = full ? `A thread holds ${MAX_THREAD_CHATS} chats` : 'New chat in this thread'
  const trigger = (
    <Button
      size="sm"
      variant="ghost"
      className="no-drag h-6.5 shrink-0 gap-1 px-1.5"
      aria-label={label}
      disabled={full && !hasClosed}
      onClick={hasClosed ? undefined : () => void addThreadChat()}
    >
      <Plus />
      {count > 1 && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {count}/{MAX_THREAD_CHATS}
        </span>
      )}
    </Button>
  )
  if (!hasClosed) return <WithTooltip label={label}>{trigger}</WithTooltip>
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="end" className="w-72 p-1">
        <button
          type="button"
          disabled={full}
          onClick={() => {
            setOpen(false)
            void addThreadChat()
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-4 text-muted-foreground" />
          <span className="flex-1">New chat in this thread</span>
          {full && (
            <span className="text-[11px] text-muted-foreground">
              {MAX_THREAD_CHATS} of {MAX_THREAD_CHATS}
            </span>
          )}
        </button>
        <ClosedSideChats threadId={threadId} full={full} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Side chats of this thread with no column open — where a closed one comes back
 * from. Its own component because it reads `chats` and `statuses`, which move
 * on every turn; here that cost exists only while the popover is open.
 */
function ClosedSideChats({
  threadId,
  full,
  onDone
}: {
  threadId: string
  full: boolean
  onDone: () => void
}): React.JSX.Element | null {
  const chats = useApp((s) => s.chats)
  const sideColumns = useApp((s) => s.sideColumns)
  const statuses = useApp((s) => s.statuses)
  const reopenSideChat = useApp((s) => s.reopenSideChat)
  const confirmSideChatDelete = useApp((s) => s.confirmSideChatDelete)
  // A side chat carries the thread it belongs to (`sideOf`), which is the only
  // handle a *closed* one leaves. Sorted on `updatedAt` rather than on array
  // position: the array is the sidebar's hand-made order (`ChatMeta.sortKey`),
  // so position says nothing about recency.
  const closed = React.useMemo(
    () =>
      chats
        .filter((c) => isClosedSideChat(c, threadId, sideColumns))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [chats, threadId, sideColumns]
  )
  if (closed.length === 0) return null
  return (
    <>
      <div className="mt-1 border-t border-border pt-1.5 pb-1 pl-2 text-[11px] font-medium text-muted-foreground/70">
        {full ? 'Closed chats — close a column to reopen one' : 'Closed chats'}
      </div>
      <div className="max-h-72 overflow-y-auto">
        {closed.map((c) => (
          <div
            key={c.id}
            className="group flex w-full items-center gap-2.5 rounded-md pr-1 transition-colors hover:bg-accent"
          >
            <button
              type="button"
              disabled={full}
              onClick={() => {
                onDone()
                void reopenSideChat(c.id)
              }}
              className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left text-[13px] disabled:opacity-50"
            >
              <ProviderMark provider={c.provider} className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{c.title?.trim() || 'New chat'}</span>
              {/* A closed chat mid-turn has no column to carry its status, so
                  its answer would otherwise land with nothing saying so. */}
              {(statuses[c.id] ?? 'idle') !== 'idle' && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                // The popover closes on the click, so the question has to be
                // asked somewhere that outlives it — `App` renders the dialog.
                onDone()
                confirmSideChatDelete(c)
              }}
              aria-label={`Delete ${c.title?.trim() || 'chat'}`}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * The thread chat's ⋯ menu and the dialogs it opens. Everything here acts on the
 * thread as a whole — its name in the sidebar, its branch, its worktree, and
 * deleting it (which takes its side chats with it).
 */
function ThreadMenu({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const git = useApp((s) => s.git)
  const busy = useApp((s) => (s.statuses[chat.id] ?? 'idle') !== 'idle')
  const runGitAction = useApp((s) => s.runGitAction)
  const renameChat = useApp((s) => s.renameChat)
  const deleteChat = useApp((s) => s.deleteChat)
  const [renameOpen, setRenameOpen] = React.useState(false)
  // Whether the delete takes other chats with it, read when the dialog opens
  // rather than subscribed: it only changes the dialog's wording.
  const [deleteOpen, setDeleteOpen] = React.useState<{ withSideChats: boolean } | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [handoffOpen, setHandoffOpen] = React.useState(false)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [finishOpen, setFinishOpen] = React.useState(false)

  // Merging is only ever offered off the default branch — on it there is
  // nothing to land, and the ladder's job there is to branch off instead.
  // `git.defaultBranch` is the same field the ↓n chip and the merge dialog
  // read, so the label always names the branch the operation actually targets.
  const defaultBranch = git?.defaultBranch ?? 'main'
  const canMerge = !!git?.defaultBranch && git.branch !== git.defaultBranch

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="ghost" className="no-drag" aria-label="Chat options">
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
          <DropdownMenuItem
            destructive
            onClick={() =>
              setDeleteOpen({
                withSideChats: useApp.getState().chats.some((c) => c.sideOf === chat.id)
              })
            }
          >
            <Trash2 /> Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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

      <Dialog open={deleteOpen !== null} onOpenChange={(o) => !o && setDeleteOpen(null)}>
        <DialogContent>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            “{chat.title || 'New chat'}” and its history will be removed permanently
            {deleteOpen?.withSideChats ? ', along with the other chats in its thread.' : '.'}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(null)
                void deleteChat(chat.id)
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The columns themselves: side by side, as a grid, or one expanded to the full
 * width.
 *
 * Every column stays mounted across all three. A column is a live transcript —
 * unmounting one to expand another would restart its stream reveal, drop its
 * scroll position and replay its rows' enter animations on the way back — so an
 * expansion *hides* the others rather than removing them. Nothing stands in for
 * them on screen: the header's pills already name every chat, carry its status,
 * and switch the expansion to it.
 */
function ThreadColumns({
  ids,
  threadId
}: {
  ids: readonly string[]
  threadId: string
}): React.JSX.Element {
  const threadLayout = useApp((s) => s.threadLayout)
  const expandedChatId = useApp((s) => s.expandedChatId)
  const focusedChatId = useApp((s) => s.focusedChatId)
  const layout = threadLayoutFor(ids.length, threadLayout)
  const grid = !expandedChatId && layout === 'grid'
  const n = ids.length

  return (
    <div
      className={cn(
        'min-h-0 flex-1 border-t border-border',
        grid
          ? 'grid grid-cols-2 grid-rows-2'
          : cn('flex', !expandedChatId && 'overflow-x-auto')
      )}
    >
      {ids.map((id, i) => {
        const hidden = expandedChatId !== null && expandedChatId !== id
        return (
          <ThreadColumn
            key={id}
            id={id}
            threadId={threadId}
            index={i}
            focused={focusedChatId === id}
            expanded={expandedChatId === id}
            className={cn(
              grid
                ? gridCell(i, n)
                : hidden
                  ? // Hidden, not unmounted — see `ThreadColumns`.
                    'hidden'
                  : expandedChatId
                    ? 'min-w-0 flex-1'
                    : // THREAD_COLUMN_MIN_PX, spelled out for Tailwind.
                      'min-w-[340px] flex-[1_0_340px]',
              !grid && !expandedChatId && i > 0 && 'border-l border-border'
            )}
          />
        )
      })}
    </div>
  )
}

/** Borders and spans for cell `i` of a two-column grid of `n` chats. */
function gridCell(i: number, n: number): string {
  if (n === 3) {
    return i === 0 ? 'row-span-2 border-r border-border' : i === 1 ? 'border-b border-border' : ''
  }
  return cn(i % 2 === 0 && 'border-r border-border', i < 2 && 'border-b border-border')
}

function ThreadColumn({
  id,
  threadId,
  index,
  focused,
  expanded,
  className
}: {
  id: string
  threadId: string
  index: number
  focused: boolean
  expanded: boolean
  className: string
}): React.JSX.Element | null {
  if (isAgentColumn(id)) {
    return <AgentColumn id={id} index={index} focused={focused} expanded={expanded} className={className} />
  }
  return <ChatColumn id={id} threadId={threadId} index={index} focused={focused} expanded={expanded} className={className} />
}

function ChatColumn({
  id,
  threadId,
  index,
  focused,
  expanded,
  className
}: {
  id: string
  threadId: string
  index: number
  focused: boolean
  expanded: boolean
  className: string
}): React.JSX.Element | null {
  // Its own meta by id, so a `meta` patch to another chat leaves this column's
  // props identical and the memoized `ChatView` skips it.
  const chat = useApp((s) => chatMeta(s, id))
  // The whole column is the drop target, not just its header: a 32px strip is
  // too small to aim a drag at across a grid.
  const drop = useChatDrop(threadId, id)
  if (!chat) return null
  // The thread's own chat can be dragged anywhere, but it is still the thread:
  // not closable, and its transcript lives in the store's singular slice.
  const side = id !== threadId
  // Pointer or keyboard entering the column — its header or its transcript —
  // makes it the thread's focused chat. Imperative, so a focus change re-renders
  // no transcript, and without the caret: clicking to read is not asking to type.
  const claimFocus = (): void => useApp.getState().focusChat(id)
  return (
    <section
      data-thread-column={id}
      aria-label={`Chat ${index + 1}`}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      {...drop.handlers}
      className={cn('relative flex min-h-0 min-w-0 flex-col', className)}
    >
      <ColumnHeader chat={chat} index={index} side={side} focused={focused} expanded={expanded} />
      <div className="flex min-h-0 flex-1">
        <ChatView chat={chat} side={side} />
      </div>
      <DropEdge side={drop.over} inset="inset-y-0" />
    </section>
  )
}

function ColumnHeader({
  chat,
  index,
  side,
  focused,
  expanded
}: {
  chat: ChatMeta
  index: number
  /** Every column but the thread's own chat can close. */
  side: boolean
  focused: boolean
  expanded: boolean
}): React.JSX.Element {
  const toggleExpandedChat = useApp((s) => s.toggleExpandedChat)
  const leaveThread = useApp((s) => s.leaveThread)
  const closeSideChat = useApp((s) => s.closeSideChat)
  // No confirmation: closing deletes nothing — the chat keeps running if it
  // was, and its pill in the thread header (or its card in a parent's
  // transcript) brings it back in one click. A question in front of an
  // undoable act was a toll on every close.
  const close = (): void => void closeSideChat(chat.id)
  const title = chat.title?.trim() || 'New chat'
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              onDoubleClick={() => toggleExpandedChat(chat.id)}
              // The header is the column's handle: drag it onto another column to
              // swap places, or onto the sidebar to take it out of the thread.
              {...chatDragHandlers(chat.id)}
              className="flex h-8 shrink-0 cursor-grab items-center gap-2 pr-1.5 pl-3 active:cursor-grabbing"
            />
        }
      >
          <ChatNumber index={index} focused={focused} />
          <ProviderMark provider={chat.provider} className="size-3 shrink-0 text-muted-foreground" />
          <span
            title={title}
            className={cn(
              'min-w-0 truncate text-xs font-medium',
              focused ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {title}
          </span>
          {chat.delegation && <DelegationBadge chat={chat} />}
          <ChatMark id={chat.id} labelled />
          <div className="ml-auto flex shrink-0 items-center">
            <WithTooltip label={expanded ? 'Show all chats  esc' : 'Expand  ⌘⇧↵'}>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => toggleExpandedChat(chat.id)}
                aria-label={expanded ? 'Show all chats' : `Expand chat ${index + 1}`}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </WithTooltip>
            {side && (
              <WithTooltip label="Close chat">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={close}
                  aria-label={`Close chat ${index + 1}`}
                >
                  <X />
                </Button>
              </WithTooltip>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => toggleExpandedChat(chat.id)}>
            {expanded ? <Minimize2 /> : <Maximize2 />} {expanded ? 'Show all chats' : 'Expand'}
          </ContextMenuItem>
          {side && (
            <>
              {/* The same move as dragging the header onto the sidebar. */}
              <ContextMenuItem onClick={() => void leaveThread(chat.id)}>
                <PanelLeftOpen /> Move to its own chat
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={close}>
                <X /> Close chat
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </>
  )
}

const DELEGATION_STATE: Record<NonNullable<ChatMeta['delegation']>['status'], string> = {
  running: 'Working on it',
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted when Carbon quit'
}

/**
 * Marks a column another chat's agent opened with `agents_delegate`: its name
 * — the word both the user and the parent use for it ("tell codex-b…") — and
 * on hover the role, the task and whether its outcome has gone back. The task is what the column's first message shows too, but a
 * reader scanning headers needs to know this chat was not started by them.
 */
function DelegationBadge({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const d = chat.delegation!
  const parentTitle = useApp((s) => s.chats.find((c) => c.id === d.parentId)?.title?.trim())
  const state = DELEGATION_STATE[d.status]
  const reported = d.deliveredAt ? ' · reported back' : ''
  return (
    <WithTooltip
      label={
        <span className="flex flex-col gap-1">
          <span className="font-medium">
            {d.name ? `${d.name} · ` : ''}Delegated{parentTitle ? ` by “${parentTitle}”` : ''}
            {d.role ? `, role ${d.role}` : ''} — {state}
            {reported}
          </span>
          {d.name && (
            <span className="text-muted-foreground">
              Tell the agent that started it “tell {d.name} …” to give it more work.
            </span>
          )}
          <span className="line-clamp-6 text-muted-foreground">{d.task}</span>
        </span>
      }
    >
      <span
        data-delegation={d.status}
        className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
      >
        {d.name ?? d.role ?? 'Delegated'}
      </span>
    </WithTooltip>
  )
}


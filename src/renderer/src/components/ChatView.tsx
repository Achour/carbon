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
import type { ChatMeta } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
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
import { PermissionCard } from '@/components/messages/PermissionCard'
import { QuestionCard } from '@/components/messages/QuestionCard'
import { BackgroundJobs } from '@/components/BackgroundJobs'

const NO_PERMISSIONS: never[] = []
const NO_QUEUED: never[] = []

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

  // Follow the stream while the user is pinned to the bottom.
  React.useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [messages, permissions, status, scrollToBottom])

  // Jump to the bottom when switching chats.
  React.useEffect(() => {
    pinnedRef.current = true
    requestAnimationFrame(() => scrollToBottom())
  }, [chat.id, scrollToBottom])

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
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
  const latestTodoId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      for (let j = m.parts.length - 1; j >= 0; j--) {
        // Streamed part arrays can be sparse — indexes may arrive out of order.
        const p = m.parts[j]
        if (p?.type === 'tool' && p.name === 'TodoWrite') return p.toolUseId
      }
    }
    return null
  }, [messages])

  const openPlan = React.useCallback(
    (plan: string) => {
      openPlanPanel({ chatId: chat.id, plan, requestId: pendingPlanRequest?.id ?? null })
    },
    [openPlanPanel, chat.id, pendingPlanRequest?.id]
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
          {messages.map((m) => {
            if (m.role === 'user') return <UserBubble key={m.id} message={m} />
            if (m.role === 'assistant')
              return (
                <AssistantBlock
                  key={m.id}
                  message={m}
                  cwd={chat.cwd}
                  streaming={busy && m.id === lastAssistant?.id}
                  onOpenPlan={openPlan}
                  latestTodoId={latestTodoId}
                />
              )
            return <EventRow key={m.id} message={m} />
          })}
          {permissions.map((request) => {
            if (request.toolName === 'AskUserQuestion')
              return <QuestionCard key={request.id} request={request} />
            if (request.toolName === 'ExitPlanMode')
              return (
                <div
                  key={request.id}
                  className="flex animate-enter items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5"
                >
                  <span className="text-[13px]">Claude prepared a plan for your review.</span>
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
            cwd={chat.cwd}
            commands={commands}
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

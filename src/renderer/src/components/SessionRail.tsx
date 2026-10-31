import * as React from 'react'
import { ArrowDown, ArrowUp, FileDiff, Folder, GitBranch, Laptop, Plus, Split, Trash2, X } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { isAgentColumn, parseAgentColumn } from '@shared/agentRuns'
import { chatMeta, isClosedSideChat, MAX_THREAD_CHATS, severalChatsShown, useApp } from '@/store'
import { JobRow, useBackgroundJobs } from '@/components/BackgroundJobs'
import { AgentRoster, useAgentRoster } from '@/components/SubagentRow'
import { basename, formatTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import { GitActionButton } from '@/components/GitPanel'
import { PanelLaunchList } from '@/components/PanelActions'
import { BranchMenu } from '@/components/BranchActions'
import { ChatMark, threadChatTitle } from '@/components/ChatMark'
import { ProviderMark } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * The chat's own state, kept beside it while it runs: where it works, how full
 * its context is, what it has changed, the other chats in its thread, the agents
 * and jobs it has running, and what the panel can open. Pinned and
 * unpinned from the thread's top bar (`quickRail`). Each block is a card of the
 * depth system (`docs/depth.md`), so it reads as the same furniture as
 * Settings and the panel rather than a new kind of surface.
 */
export function SessionRail({
  chat: thread,
  ids
}: {
  chat: ChatMeta
  /** The thread's columns, chats and agents, as `ThreadView` orders them. */
  ids: readonly string[]
}): React.JSX.Element {
  // The focused column's chat, subscribed here rather than in `ThreadView` so a
  // side chat's meta changing re-renders the rail and not every column.
  const chat = useApp((s) => {
    const id = s.focusedChatId
    return (id && s.chats.find((c) => c.id === id)) || thread
  })
  // Unlike `chat`, an agent column's id: its jobs are its parent chat's.
  const focused = useApp((s) => s.focusedChatId) ?? thread.id
  const ref = React.useRef<HTMLElement>(null)
  // With the panel open, or too little width beside the chat, there is no room
  // to give: the chat would be squeezed. The rail floats over the chat's right
  // edge instead, only as tall as its cards, and drops the launch card when the
  // panel is up, since the panel already is that list.
  const panelOpen = useApp((s) => s.panelOpen)
  // Several chats already share the width; a docked rail would take a column's
  // worth of it from them, so with more than one on screen it only floats.
  const several = useApp(severalChatsShown)
  const narrow = useNarrow(ref)
  const floating = panelOpen || several || narrow
  const setRailHidden = useApp((s) => s.setRailHidden)
  // Floating, it covers the chat's edge, so it behaves like anything else laid
  // over the work: a click or focus anywhere else — the composer, the
  // transcript — puts it away, and so does Escape. The top bar's button is
  // exempt, or its own click would dismiss the rail it is about to toggle.
  React.useEffect(() => {
    if (!floating) return
    // A menu or dialog the rail opened is portaled out of it, and still the
    // rail's: closing the rail under it would unmount it mid-click — or
    // mid-Tab, since the dialog's focus guards are siblings of its popup, not
    // inside it. So while any is open, nothing outside dismisses the rail.
    const overlayOpen = (): boolean =>
      !!document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      !ref.current?.contains(target) &&
      !(target instanceof Element && target.closest('[data-rail-toggle]')) &&
      !overlayOpen()
    const onPointer = (e: PointerEvent): void => {
      if (outside(e.target)) setRailHidden(true)
    }
    const onFocus = (e: FocusEvent): void => {
      if (outside(e.target)) setRailHidden(true)
    }
    const onKey = (e: KeyboardEvent): void => {
      // Escape closes the open menu or dialog first, not the rail under it.
      if (e.key === 'Escape' && !overlayOpen()) setRailHidden(true)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [floating, setRailHidden])
  return (
    <aside
      ref={ref}
      data-quick-rail
      data-floating={floating || undefined}
      aria-label="Session details"
      className={cn(
        'flex w-72 shrink-0 flex-col gap-3 overflow-y-auto p-3',
        // Box shadows on the cards, not a `drop-shadow` filter on the column: a
        // filter re-rasterizes the whole rail on every change inside it.
        floating && 'absolute top-0 right-0 z-20 max-h-full [&>section]:shadow-[var(--elevation-2)]'
      )}
    >
      <EnvironmentCard chat={chat} thread={thread} />
      <ContextCard chat={chat} />
      <ChangesCard />
      <ChatsCard thread={thread} ids={ids} />
      <AgentsCard threadId={thread.id} ids={ids} />
      <BackgroundCard chatId={parseAgentColumn(focused)?.parentId ?? focused} />
      {!panelOpen && <PanelLaunchList title="Open in panel" />}
    </aside>
  )
}

/**
 * Whether the chat beside the rail would drop under a readable width. Measured
 * on the rail's parent (the thread's body), and only the crossing is stored, so
 * a window drag re-renders the rail twice at most rather than every frame.
 */
const NARROW_PX = 1040

function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = React.useState(false)
  React.useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

function Card({
  title,
  aside,
  children
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="surface-card p-2">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {aside && <span className="ml-auto flex items-center">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

const ROW = 'flex min-w-0 items-center gap-2.5 px-2 py-1.5 text-[13px]'

function Row({
  icon: Icon,
  children,
  title
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div title={title} className={ROW}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {children}
    </div>
  )
}

function EnvironmentCard({ chat, thread }: { chat: ChatMeta; thread: ChatMeta }): React.JSX.Element {
  const git = useApp((s) => s.git)
  const shown = git?.isRepo ? git.branch : undefined
  return (
    <Card title="Environment" aside={<span className="text-[11px] text-muted-foreground/70">{PROVIDER_SHORT_LABELS[chat.provider]}</span>}>
      <div className="surface-group flex flex-col py-0.5">
        <Row icon={Folder} title={chat.cwd}>
          <span className="truncate">{basename(chat.cwd)}</span>
        </Row>
        {shown && (
          // The branch's actions — update, merge, the worktree exits — on the
          // row that names it; they act on the thread, whose chat carries the
          // worktree.
          <BranchMenu
            chatId={thread.id}
            tooltip={shown}
            className={ROW}
            actionClassName={cn(ROW, 'rounded-[9px] text-left transition-colors hover:bg-accent')}
          >
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{shown}</span>
            {/* Against its own upstream: what a push or pull would move. */}
            {(git!.ahead > 0 || git!.behind > 0) && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                {git!.ahead > 0 && (
                  <span className="flex items-center">
                    <ArrowUp className="size-3" />
                    {git!.ahead}
                  </span>
                )}
                {git!.behind > 0 && (
                  <span className="flex items-center">
                    <ArrowDown className="size-3" />
                    {git!.behind}
                  </span>
                )}
              </span>
            )}
          </BranchMenu>
        )}
        {/* The thread's: a side chat runs in its worktree without carrying it. */}
        <Row icon={thread.worktree ? Split : Laptop}>
          <span className="truncate">{thread.worktree ? 'Worktree' : 'This Mac'}</span>
        </Row>
      </div>
    </Card>
  )
}

function ContextCard({ chat }: { chat: ChatMeta }): React.JSX.Element | null {
  const used = chat.contextTokens
  if (!used) return null
  const win = chat.contextWindow ?? 200_000
  const pct = Math.min(1, used / win)
  return (
    <Card
      title="Context"
      aside={
        <span
          className={cn(
            'text-xs tabular-nums',
            pct > 0.9 ? 'text-destructive' : pct > 0.7 ? 'text-amber-500' : 'text-muted-foreground'
          )}
        >
          {Math.round(pct * 100)}%
        </span>
      }
    >
      <div className="px-1.5 pb-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              pct > 0.9 ? 'bg-destructive' : pct > 0.7 ? 'bg-amber-500' : 'bg-primary'
            )}
            style={{ width: `${Math.max(2, pct * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{formatTokens(used)} used</span>
          <span>of {formatTokens(win)}</span>
        </div>
      </div>
    </Card>
  )
}

function ChangesCard(): React.JSX.Element | null {
  const git = useApp((s) => s.git)
  const reviewChanges = useApp((s) => s.reviewChanges)
  if (!git?.isRepo) return null
  const files = git.changes.length
  return (
    <Card title="Changes">
      <div className="surface-group flex flex-col py-0.5">
        {files === 0 ? (
          <div className="px-2 py-1.5 text-[13px] text-muted-foreground">No uncommitted changes</div>
        ) : (
          <button
            type="button"
            onClick={() => void reviewChanges()}
            className="flex min-w-0 items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
          >
            <FileDiff className="size-4 shrink-0 text-muted-foreground" />
            <span className="tabular-nums">
              <span className="text-success">+{git.additions}</span>{' '}
              <span className="text-destructive">−{git.deletions}</span>
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {files} {files === 1 ? 'file' : 'files'}
            </span>
          </button>
        )}
      </div>
      {/* Under the changes rather than in the title row, where the longer
          rungs ("Create Branch & Commit") ran out of the card. */}
      {files > 0 && (
        <div className="mt-2 flex justify-end">
          <GitActionButton />
        </div>
      )}
    </Card>
  )
}


/**
 * The thread's chats — its own and the side chats beside it, open or closed —
 * as their own list, apart from the agents. Delegates are side chats under the
 * hood, but an agent started them, so they stay in the Agents card; this one
 * is the chats *you* opened, which otherwise had no list but ＋'s closed ones.
 * Open chats come in column order, a click focusing the column; closed ones
 * follow, newest first, a click reopening one. Drawn only once the thread has
 * more than its own chat.
 */
function ChatsCard({ thread, ids }: { thread: ChatMeta; ids: readonly string[] }): React.JSX.Element | null {
  // `chats` and the columns by identity, derived in a memo, so the list is
  // rebuilt when a chat or a column changes — not on every streamed delta.
  // Each row's `ChatMark` reads its own status.
  const chats = useApp((s) => s.chats)
  const sideColumns = useApp((s) => s.sideColumns)
  const focused = useApp((s) => s.focusedChatId) ?? thread.id
  const focusChat = useApp((s) => s.focusChat)
  const reopenSideChat = useApp((s) => s.reopenSideChat)
  const closeSideChat = useApp((s) => s.closeSideChat)
  const confirmSideChatDelete = useApp((s) => s.confirmSideChatDelete)
  const addThreadChat = useApp((s) => s.addThreadChat)
  const { open, closed } = React.useMemo(() => {
    const open = ids
      .filter((id) => !isAgentColumn(id))
      .map((id) => chatMeta({ chats }, id))
      .filter((c): c is ChatMeta => !!c && !c.delegation)
    const closed = chats
      .filter((c) => isClosedSideChat(c, thread.id, sideColumns))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { open, closed }
  }, [chats, ids, thread.id, sideColumns])
  if (open.length + closed.length <= 1) return null
  const full = ids.filter((id) => !isAgentColumn(id)).length >= MAX_THREAD_CHATS
  return (
    <Card
      title="Chats"
      aside={
        <WithTooltip label={full ? `A thread holds ${MAX_THREAD_CHATS} chats` : 'New chat in this thread'}>
          <button
            type="button"
            disabled={full}
            onClick={() => void addThreadChat()}
            aria-label="New chat in this thread"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </WithTooltip>
      }
    >
      <div data-rail-chats className="surface-group flex flex-col gap-px p-0.5">
        {open.map((c) => (
          <ChatRow
            key={c.id}
            chat={c}
            active={c.id === focused}
            onOpen={() => focusChat(c.id, { caret: true })}
            // The thread's own chat is the thread: it has no column to close.
            action={
              c.id === thread.id
                ? undefined
                : { label: 'Close chat', icon: X, run: () => void closeSideChat(c.id) }
            }
          />
        ))}
      </div>
      {closed.length > 0 && (
        <>
          <div className="px-1.5 pt-2.5 pb-1.5 text-[11px] text-muted-foreground/70">
            {full ? 'Closed — close a column to reopen one' : 'Closed'}
          </div>
          <div className="surface-group flex flex-col gap-px p-0.5">
            {closed.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                dim
                disabled={full}
                onOpen={() => void reopenSideChat(c.id)}
                action={{ label: 'Delete chat', icon: Trash2, run: () => confirmSideChatDelete(c) }}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

function ChatRow({
  chat,
  active = false,
  dim = false,
  disabled = false,
  onOpen,
  action
}: {
  chat: ChatMeta
  active?: boolean
  dim?: boolean
  disabled?: boolean
  onOpen: () => void
  action?: { label: string; icon: React.ComponentType<{ className?: string }>; run: () => void }
}): React.JSX.Element {
  const title = threadChatTitle(chat)
  const Icon = action?.icon
  return (
    <div
      className={cn(
        'group flex min-w-0 items-center rounded-md pr-1 transition-colors hover:bg-accent',
        active && 'bg-accent'
      )}
    >
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-[13px] disabled:opacity-50',
          dim && !active && 'text-muted-foreground'
        )}
      >
        <ProviderMark provider={chat.provider} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChatMark id={chat.id} labelled />
      </button>
      {action && Icon && (
        <button
          type="button"
          onClick={action.run}
          aria-label={`${action.label}: ${title}`}
          title={action.label}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary hover:text-foreground focus-visible:opacity-100"
        >
          <Icon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Finished agents shown before the rest fold behind "Show N earlier". */
const SETTLED_ROWS = 6

/**
 * Every agent working for this thread: the delegates its chats handed tasks to
 * (`agents_delegate`, each a chat on its own provider) and the sub-agents their
 * agents spawned, as one sorted list — waiting on you, then working, then
 * finished, each newest first
 * (`useAgentRoster`). It stands in for the header's robot menu while the rail
 * is up — `ThreadHeader` drops the menu then — so a fan-out is on screen
 * without a click. A row opens the agent in place of the chat
 * (`openAgentView`).
 */
function AgentsCard({ threadId, ids }: { threadId: string; ids: readonly string[] }): React.JSX.Element | null {
  const chatIds = React.useMemo(() => ids.filter((id) => !isAgentColumn(id)), [ids])
  const { working, finished } = useAgentRoster(threadId, chatIds)
  if (working.length + finished.length === 0) return null
  return (
    <Card
      title="Agents"
      aside={
        <span className={cn('text-[11px] tabular-nums', working.length ? 'text-foreground' : 'text-muted-foreground/70')}>
          {working.length ? `${working.length} working` : 'All finished'}
        </span>
      }
    >
      <div data-rail-agents>
        <AgentRoster working={working} finished={finished} limit={SETTLED_ROWS} />
      </div>
    </Card>
  )
}

/**
 * The focused chat's live background work that is not an agent — shells,
 * monitors, workflows — each with its Stop. The header's "N running" pill,
 * opened and kept open while the rail is up.
 */
function BackgroundCard({ chatId }: { chatId: string }): React.JSX.Element | null {
  const jobs = useBackgroundJobs(chatId)
  if (jobs.length === 0) return null
  return (
    <Card title="Background jobs" aside={<span className="text-[11px] text-primary tabular-nums">{jobs.length} running</span>}>
      <div className="surface-group flex flex-col gap-px p-0.5">
        {jobs.map((job) => (
          <JobRow key={job.id} chatId={chatId} job={job} className="rounded-md px-2 py-1.5" />
        ))}
      </div>
    </Card>
  )
}

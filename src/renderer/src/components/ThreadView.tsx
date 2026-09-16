import * as React from 'react'
import {
  ArrowLeftRight,
  Bot,
  Columns3,
  GitMerge,
  LayoutGrid,
  Loader2,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash,
  Trash2,
  X
} from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { projectRoot } from '@shared/types'
import { cn } from '@/lib/utils'
import { chatActivityKind } from '@/lib/chatActivity'
import { focusComposer } from '@/lib/composerFocus'
import {
  chatMeta,
  isClosedSideChat,
  isUnusedSideChat,
  MAX_THREAD_CHATS,
  panelFloats,
  severalChatsShown,
  threadLayoutFor,
  useApp
} from '@/store'
import { ChatView } from '@/components/ChatView'
import { BackgroundJobs } from '@/components/BackgroundJobs'
import { ContextStrip } from '@/components/ContextStrip'
import { ProviderMark } from '@/components/ui/provider-mark'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
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
  const ids = React.useMemo(() => [chat.id, ...sideColumns], [chat.id, sideColumns])
  useThreadKeys(ids)

  return (
    // The frosted main column: one wash under every column, so a thread reads
    // as one surface rather than four tinted panes.
    <div data-chatview className="relative flex h-full min-w-0 flex-1 flex-col">
      <ThreadHeader chat={chat} ids={ids} />
      {ids.length === 1 ? (
        <div className="flex min-h-0 flex-1">
          <ChatView chat={chat} />
        </div>
      ) : (
        <ThreadColumns ids={ids} />
      )}
    </div>
  )
}

/**
 * ⌘1–⌘4 focus a column (and move the caret into its composer); ⌘⇧↵ expands the
 * focused one, or restores the thread; Esc steps back out of a floating panel or
 * an expansion. Window-level so they work from anywhere in the thread, including
 * a composer that has the caret.
 */
function useThreadKeys(ids: string[]): void {
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

function ThreadHeader({ chat, ids }: { chat: ChatMeta; ids: string[] }): React.JSX.Element {
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
      {ids.length > 1 && (
        <>
          <div
            role="tablist"
            aria-label="Chats in this thread"
            className="no-drag ml-1 flex shrink-0 items-center gap-0.5 border-l border-border pl-2"
          >
            {ids.map((id, i) => (
              <ThreadPill key={id} id={id} index={i} focused={id === focused} />
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
      <BackgroundJobs chatId={focused} />
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

/**
 * One chat of the thread in the header: its number (what ⌘1–⌘4 name), its
 * provider, and whether it is working, waiting on you, or finished while you
 * were in another column. Its own component so the header subscribes to one
 * chat's status at a time, as a primitive.
 */
function ThreadPill({
  id,
  index,
  focused
}: {
  id: string
  index: number
  focused: boolean
}): React.JSX.Element | null {
  const meta = useApp((s) => chatMeta(s, id))
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
        className={cn(
          'flex h-6.5 items-center gap-1.5 rounded-md border px-1.5 transition-colors',
          focused
            ? 'border-border bg-background text-foreground shadow-sm'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <ChatNumber index={index} focused={focused} />
        <ProviderMark provider={meta.provider} className="size-3" />
        <ChatMark id={id} />
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
    return <Loader2 aria-label="Working" className="size-3 shrink-0 animate-spin text-primary" />
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
  // position: metas restored at boot arrive newest-first and `hoistChat` moves
  // a row on every turn start, so position says nothing about recency.
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
function ThreadColumns({ ids }: { ids: string[] }): React.JSX.Element {
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
  // Its own meta by id, so a `meta` patch to another chat leaves this column's
  // props identical and the memoized `ChatView` skips it.
  const chat = useApp((s) => chatMeta(s, id))
  if (!chat) return null
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
      className={cn('relative flex min-h-0 min-w-0 flex-col', className)}
    >
      <ColumnHeader chat={chat} index={index} focused={focused} expanded={expanded} />
      <div className="flex min-h-0 flex-1">
        <ChatView chat={chat} side={index > 0} />
      </div>
    </section>
  )
}

function ColumnHeader({
  chat,
  index,
  focused,
  expanded
}: {
  chat: ChatMeta
  index: number
  focused: boolean
  expanded: boolean
}): React.JSX.Element {
  const toggleExpandedChat = useApp((s) => s.toggleExpandedChat)
  const [confirmClose, setConfirmClose] = React.useState(false)
  // Every column but the thread's own chat can close.
  const side = index > 0
  const title = chat.title?.trim() || 'New chat'
  return (
    <>
      <div
        onDoubleClick={() => toggleExpandedChat(chat.id)}
        className="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3"
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
                onClick={() => setConfirmClose(true)}
                aria-label={`Close chat ${index + 1}`}
              >
                <X />
              </Button>
            </WithTooltip>
          )}
        </div>
      </div>
      {/* Outside the header: a portal still bubbles React events to its
          ancestors, and the header's double-click expands the column. Mounted
          only while asking, so its selectors do not run on every delta. */}
      {side && confirmClose && <CloseChatDialog chat={chat} onClose={() => setConfirmClose(false)} />}
    </>
  )
}

/**
 * Asks before a column closes. A close keeps the conversation, but it still
 * takes a live chat off the screen — mid-turn, or with a prompt waiting — and
 * the ✕ sits beside the expand button in a 32px header, so a stray click was
 * too cheap. The body says what actually happens to *this* chat: an untouched
 * one is discarded rather than kept, and a running turn goes on in the
 * background.
 */
function CloseChatDialog({
  chat,
  onClose
}: {
  chat: ChatMeta
  onClose: () => void
}): React.JSX.Element {
  const closeSideChat = useApp((s) => s.closeSideChat)
  const busy = useApp((s) => (s.statuses[chat.id] ?? 'idle') !== 'idle')
  // The test `closeSideChat` itself applies, so the wording matches the outcome.
  const unused = useApp((s) => isUnusedSideChat(s, chat.id))
  const title = chat.title?.trim()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Close this chat?</DialogTitle>
        <DialogDescription>
          {title ? <span className="text-foreground">“{title}”</span> : 'This chat'}{' '}
          {unused
            ? 'has no messages yet, so closing it discards it.'
            : busy
              ? 'is still working. Its turn keeps running in the background, and you can reopen it from ＋.'
              : 'moves to Closed chats under ＋, where you can reopen it. Nothing is deleted.'}
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            autoFocus
            onClick={() => {
              onClose()
              void closeSideChat(chat.id)
            }}
          >
            Close chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

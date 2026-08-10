import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  MessageCircleQuestion,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import type { ChatMeta, WorktreeStatus } from '@shared/types'
import { PROVIDER_LABELS, projectRoot } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename, dateGroup, relativeTime, shortenPath } from '@/lib/format'
import { REVEAL_LABEL } from '@/lib/platform'
import { chatActivity, projectActivity, type ChatActivity } from '@/lib/chatActivity'
import { draftSummary, sortedProjectDrafts, type ProjectDraft } from '@/lib/drafts'
import { useApp } from '@/store'
import { UpdateBanner } from '@/components/UpdateBanner'
import { UsagePanel } from '@/components/UsagePanel'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'

/** "3 uncommitted files and 2 unmerged commits" — what a force-delete destroys, '' when nothing is. */
function describeAtRisk({ dirtyFiles, unmergedCommits }: WorktreeStatus): string {
  const parts: string[] = []
  if (dirtyFiles > 0) parts.push(`${dirtyFiles} uncommitted file${dirtyFiles === 1 ? '' : 's'}`)
  if (unmergedCommits && unmergedCommits > 0) {
    parts.push(`${unmergedCommits} unmerged commit${unmergedCommits === 1 ? '' : 's'}`)
  }
  return parts.join(' and ')
}

/**
 * The line a detailed row carries under its title — what makes the row stand on
 * its own without a project heading above it.
 *
 * In a repo that is the project and the branch, because the branch is the thing
 * that differs between two chats that otherwise look identical (same project,
 * same title stem, one on a worktree branch and one on main). Outside a repo it
 * is just the folder path: the project name is the last segment of it, so
 * printing both would say the same word twice.
 */
interface ChatDetail {
  kind: 'branch' | 'path'
  /** Project the chat belongs to; absent when `text` already names the folder. */
  project?: string
  text: string
}

function ChatItem({
  chat,
  active,
  activity,
  titling,
  detail,
  projectMenu,
  onOpen,
  onRename,
  onDelete,
  onTogglePin,
  onNewInWorktree
}: {
  chat: ChatMeta
  active: boolean
  activity: ChatActivity
  titling: boolean
  /** Second line for a detailed row; null renders the compact single-line row. */
  detail: ChatDetail | null
  /**
   * This chat's *project* actions, appended to the right-click menu. Detailed
   * mode has no project rows to carry them, and a mode where archiving or
   * hiding a project silently disappears is not a mode — so the row the project
   * is named on carries them instead. Null in compact mode, where the project
   * row's own menu already does.
   */
  projectMenu: React.ReactNode
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  /** Move the chat to (or out of) the Pinned section at the top of the sidebar. */
  onTogglePin: () => void
  /** Start another chat — possibly on the other provider — in the same worktree. */
  onNewInWorktree: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const pinned = chat.pinnedAt !== undefined
  // Cursor-style: inactive chats are muted, the open one is bright — the
  // brightness gap (plus the filled highlight) marks the active chat.
  // Bright, NOT bold — Cursor keeps regular weight, which reads cleaner.
  const titleClass = cn(
    'min-w-0 flex-1 truncate text-[13px] transition-colors',
    active
      ? 'text-sidebar-foreground'
      : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground/90',
    titling && 'title-forming'
  )
  // The timestamp yields to the ⋯ button on hover; both occupy the same corner.
  const trailing = (
    <span
      className={cn(
        'flex shrink-0 items-center text-[11px] text-muted-foreground/80 transition-opacity group-hover:opacity-0',
        menuOpen && 'opacity-0'
      )}
    >
      {activity.kind !== 'idle' ? (
        <ActivityIndicator activity={activity} />
      ) : (
        relativeTime(chat.updatedAt)
      )}
    </span>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group relative rounded-md transition-colors',
              // Active fill is a foreground-tinted overlay, not the sidebar-accent
              // token — the latter is barely lighter than the sidebar and vanishes
              // over the frost. This reliably reads as a raised pill in both themes.
              active ? 'bg-sidebar-foreground/[0.14] dark:bg-sidebar-foreground/[0.16]' : 'hover:bg-sidebar-accent/60'
            )}
          />
        }
      >
      {detail ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left outline-none"
        >
          <WithTooltip label={PROVIDER_LABELS[chat.provider]} side="right">
            {/* Identity, not state — so it keeps its color on every row and the
                brightness ladder that marks the active chat stays the title's
                job. Inactive rows only take the edge off it. */}
            <ProviderAvatar
              provider={chat.provider}
              className={cn(
                'mt-px transition-opacity',
                !active && 'opacity-75 group-hover:opacity-100'
              )}
            />
          </WithTooltip>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={titleClass}>{chat.title || 'New chat'}</span>
              {trailing}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground/65">
              {detail.project && (
                <>
                  <span className="min-w-0 truncate">{detail.project}</span>
                  <span className="shrink-0 opacity-45">·</span>
                </>
              )}
              <span className="flex min-w-0 items-center gap-1">
                {detail.kind === 'branch' ? (
                  <GitBranch className="size-3 shrink-0" />
                ) : (
                  <Folder className="size-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">{detail.text}</span>
              </span>
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left outline-none"
        >
          {chat.worktree && (
            <WithTooltip label={`${chat.worktree.branch} · ${chat.cwd}`}>
              <GitBranch
                className={cn(
                  'size-3 shrink-0 transition-colors',
                  active ? 'text-sidebar-foreground/70' : 'text-sidebar-foreground/40'
                )}
              />
            </WithTooltip>
          )}
          <span className={titleClass}>{chat.title || 'New chat'}</span>
          {trailing}
        </button>
      )}
      <div
        className={cn(
          'absolute right-1 opacity-0 transition-opacity group-hover:opacity-100',
          // Sits where the timestamp it replaces was, which on a two-line row is
          // the first line rather than the middle.
          detail ? 'top-1' : 'top-1/2 -translate-y-1/2',
          menuOpen && 'opacity-100'
        )}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" className="bg-sidebar-accent/80 backdrop-blur" aria-label="Chat options">
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={onTogglePin}>
              {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRename}>
              <Pencil /> Rename
            </DropdownMenuItem>
            {chat.worktree && (
              <DropdownMenuItem onClick={onNewInWorktree}>
                <GitBranch /> New chat in this worktree
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onTogglePin}>
          {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onClick={onRename}>
          <Pencil /> Rename
        </ContextMenuItem>
        {chat.worktree && (
          <ContextMenuItem onClick={onNewInWorktree}>
            <GitBranch /> New chat in this worktree
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem destructive onClick={onDelete}>
          <Trash2 /> Delete
        </ContextMenuItem>
        {projectMenu}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * How many chats the detailed mode's flat list shows at a time. Per-batch
 * rather than per-project (the compact mode's `chatsPerProject`) because the
 * list has no projects to divide by — same idea, different unit.
 */
const FLAT_BATCH = 40

// Drag bounds for the sidebar width.
const SIDEBAR_DEFAULT = 264
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 420

/** A command-palette-style modal to search chats across every project. */
function SearchChatsDialog({
  open,
  onOpenChange,
  chats,
  onOpen
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chats: ChatMeta[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [q, setQ] = React.useState('')
  const [idx, setIdx] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const projectNames = useApp((s) => s.projectNames)

  React.useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    // Base UI moves focus into the popup; nudge it to the input.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  const results = React.useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? chats.filter((c) => (c.title || 'New chat').toLowerCase().includes(term))
      : chats
    return list.slice(0, 50)
  }, [q, chats])

  React.useEffect(() => setIdx(0), [q])

  const choose = (c: ChatMeta): void => {
    onOpen(c.id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[14%] max-w-lg translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (results[idx]) choose(results[idx])
              }
            }}
            placeholder="Search chats across projects…"
            spellCheck={false}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground/70">
              {q.trim() ? 'No chats match your search.' : 'No chats yet.'}
            </div>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(c)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                  i === idx && 'bg-accent'
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.title || 'New chat'}</span>
                <span className="max-w-32 shrink-0 truncate text-[11px] text-muted-foreground/70">
                  {projectNames[projectRoot(c)]?.trim() || basename(projectRoot(c))}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground/50">
                  {relativeTime(c.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Which project?" — the one question starting a chat has always had, and the
 * one it never asked. `New chat` (and ⌘N) used to drop you into whatever folder
 * happened to be selected, which is invisible state; the per-project ＋ in
 * compact mode was the only place the answer was ever explicit, and detailed
 * mode has no project rows to put one on.
 *
 * Same palette shape as the chat search above: type to narrow, arrows to move,
 * Enter to start. Ordered by recency (the chat list arrives newest-first), so
 * the project you were last in is the default pick and the common case is
 * ⌘N-Enter.
 *
 * It is also where projects get **pruned**, because it is the only place the
 * whole list appears as rows — detailed mode has no project rows, so removal
 * otherwise means finding a chat that happens to belong to the project you want
 * gone. The ✕ hands off to the same confirm dialog the sidebar menu opens; a
 * palette where Enter starts a chat has no business deleting anything on one
 * click.
 */
function NewChatDialog({
  open,
  onOpenChange,
  projects,
  onPick,
  onBrowse,
  onRemove
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: { cwd: string; label: string; count: number }[]
  onPick: (cwd: string) => void
  onBrowse: () => void
  onRemove: (cwd: string, count: number) => void
}): React.JSX.Element {
  const [q, setQ] = React.useState('')
  const [idx, setIdx] = React.useState(0)
  const [missing, setMissing] = React.useState<Record<string, boolean>>({})
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // Which folders are gone. Checked on open rather than held in the store: it's
  // one stat per project against a list this size, and a folder can vanish
  // between two openings of the same dialog. A project whose folder is missing
  // is never *hidden* — its chats are still readable, and the row is the only
  // handle for deleting them.
  React.useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all(
      projects.map(async (p) => [p.cwd, (await window.api.statPath(p.cwd)) !== 'dir'] as const)
    ).then((pairs) => {
      if (alive) setMissing(Object.fromEntries(pairs.filter(([, gone]) => gone)))
    })
    return () => {
      alive = false
    }
    // Deliberately keyed on `open` alone: re-running per keystroke would stat
    // the same folders on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const results = React.useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return projects
    // Path as well as label: a project renamed in the sidebar is still findable
    // by the folder it actually is. "missing" matches the dead ones as a group,
    // which is the whole reason someone opens this list to prune it.
    const byWord = term.length >= 3 && 'missing'.startsWith(term)
    return projects.filter(
      (p) =>
        p.label.toLowerCase().includes(term) ||
        p.cwd.toLowerCase().includes(term) ||
        (byWord && missing[p.cwd])
    )
  }, [q, projects, missing])

  React.useEffect(() => setIdx(0), [q])

  // "Open another folder…" is the last row, so it takes part in the keyboard
  // walk instead of being a mouse-only escape hatch.
  const rows = results.length + 1
  const choose = (i: number): void => {
    onOpenChange(false)
    if (i >= results.length) onBrowse()
    else onPick(results[i].cwd)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[14%] max-w-lg translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Start a new chat</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(i + 1, rows - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(idx)
              } else if ((e.key === 'Backspace' || e.key === 'Delete') && e.metaKey) {
                // ⌘⌫ on the selected row: the ✕ is visible on it, so a keyboard
                // walk down the list can prune without reaching for the mouse.
                const p = results[idx]
                if (p) {
                  e.preventDefault()
                  onRemove(p.cwd, p.count)
                }
              }
            }}
            placeholder="Start a chat in…"
            spellCheck={false}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.map((p, i) => (
            <div
              key={p.cwd}
              onMouseEnter={() => setIdx(i)}
              className={cn(
                'flex w-full items-center rounded-md transition-colors',
                i === idx && 'bg-accent'
              )}
            >
              <button
                type="button"
                onClick={() => choose(i)}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 text-left"
              >
                <Folder
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground',
                    missing[p.cwd] && 'text-muted-foreground/50'
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 truncate text-[13px]',
                    missing[p.cwd] && 'text-muted-foreground'
                  )}
                >
                  {p.label}
                </span>
                {missing[p.cwd] && (
                  <span
                    className="shrink-0 rounded bg-warning/10 px-1.5 py-px text-[10px] text-warning"
                    title="This folder no longer exists on disk"
                  >
                    missing
                  </span>
                )}
                <span className="flex-1" />
                <span className="max-w-56 shrink-0 truncate text-[11px] text-muted-foreground/60">
                  {shortenPath(p.cwd, window.api.home)}
                </span>
                <span className="w-6 shrink-0 text-right text-[11px] text-muted-foreground/50">
                  {p.count}
                </span>
              </button>
              <WithTooltip label="Remove project  ⌘⌫">
                <button
                  type="button"
                  aria-label={`Remove ${p.label}`}
                  onClick={() => onRemove(p.cwd, p.count)}
                  className={cn(
                    'mr-1.5 ml-1 shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:bg-secondary hover:text-destructive',
                    i === idx ? 'opacity-100' : 'opacity-0'
                  )}
                >
                  <X className="size-3.5" />
                </button>
              </WithTooltip>
            </div>
          ))}
          <button
            type="button"
            onMouseEnter={() => setIdx(results.length)}
            onClick={() => choose(results.length)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
              idx === results.length && 'bg-accent'
            )}
          >
            <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[13px]">Open another folder…</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ActivityIndicator({ activity }: { activity: ChatActivity }): React.JSX.Element | null {
  if (activity.kind === 'idle') return null

  return (
    <WithTooltip label={activity.label} side="right">
      <span
        role="status"
        aria-label={activity.label}
        className="inline-flex h-4 shrink-0 items-center gap-0.5 tabular-nums"
      >
        {activity.kind === 'needs-input' ? (
          <MessageCircleQuestion className="size-3.5 text-warning" />
        ) : activity.kind === 'background' ? (
          <Bot className="size-3.5 animate-pulse-soft text-primary" />
        ) : (
          <Loader2 className="size-3 animate-spin text-primary" />
        )}
      </span>
    </WithTooltip>
  )
}

/**
 * A prompt typed on the home screen and never sent.
 *
 * Deliberately not a `ChatItem`: there is no chat behind it, and creating one
 * eagerly would freeze a provider/model pair and — for a `new` worktree target —
 * leave a real checkout and branch on disk for a message that was never sent.
 * See `lib/drafts.ts`.
 */
function DraftItem({
  draft,
  project,
  onOpen,
  onDiscard
}: {
  draft: ProjectDraft
  /** Folder this belongs to; null when the header above already names it. */
  project: string | null
  onOpen: () => void
  onDiscard: () => void
}): React.JSX.Element {
  return (
    <div
      data-draft={draft.cwd}
      className="group relative rounded-md transition-colors hover:bg-sidebar-accent/60"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-2 py-1.5 pr-7 pl-2.5 text-left outline-none"
      >
        <PencilLine className="mt-px size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="min-w-0 truncate text-[13px] text-sidebar-foreground/55 transition-colors group-hover:text-sidebar-foreground/90">
            {/* Attachments with no text are still a draft worth coming back to,
                and there is nothing to quote for them. */}
            {draftSummary(draft.text) || 'Attachment'}
          </span>
          {project && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] leading-tight text-muted-foreground/65">
              <Folder className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{project}</span>
            </span>
          )}
        </span>
      </button>
      {/* No confirm, like the queued-message ✕ in ChatView: one unsent line, and
          the row is only reachable by hovering it. */}
      <WithTooltip label="Discard draft">
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Discard draft"
          className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </WithTooltip>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const activeId = useApp((s) => s.activeId)
  const statuses = useApp((s) => s.statuses)
  const permissions = useApp((s) => s.permissions)
  const backgroundJobs = useApp((s) => s.backgroundJobs)
  const titling = useApp((s) => s.titling)
  const openChat = useApp((s) => s.openChat)
  const renameChat = useApp((s) => s.renameChat)
  const deleteChat = useApp((s) => s.deleteChat)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const chatsPerProject = useApp((s) => s.chatsPerProject)
  // Hidden projects are removed from the sidebar entirely (unlike archived, which
  // stay in a collapsed section) but keep all their chats. Re-opening the folder
  // un-hides it (handled in the store's setSelectedCwd). Distinct from Delete,
  // which discards the chats.
  const hiddenProjects = useApp((s) => s.hiddenProjects)
  const setProjectHidden = useApp((s) => s.setProjectHidden)
  // Custom project display names (keyed by cwd); falls back to the folder basename.
  const projectNames = useApp((s) => s.projectNames)
  const setProjectName = useApp((s) => s.setProjectName)
  const projectLabel = (cwd: string): string => projectNames[cwd]?.trim() || basename(cwd)

  const projectDrafts = useApp((s) => s.projectDrafts)
  const openDraft = useApp((s) => s.openDraft)
  const discardProjectDraft = useApp((s) => s.discardProjectDraft)

  const detailed = useApp((s) => s.sidebarDensity) === 'detailed'
  const sidebarProject = useApp((s) => s.sidebarProject)
  const setSidebarProject = useApp((s) => s.setSidebarProject)
  const chatBranches = useApp((s) => s.chatBranches)
  const refreshChatBranches = useApp((s) => s.refreshChatBranches)
  // Branches are read for every chat's folder at once, so the trigger is the set
  // of folders — not each chat. Turn endings and worktree moves refresh it from
  // the store; this covers a cold start and a project appearing or leaving.
  const branchKey = detailed ? [...new Set(chats.map((c) => c.cwd))].sort().join('\n') : ''
  React.useEffect(() => {
    if (detailed) void refreshChatBranches()
  }, [detailed, branchKey, refreshChatBranches])

  // `withProject` is false once the list is filtered to one project — the
  // filter chip already names it, and repeating it on every row is exactly the
  // noise dropping the project grouping was meant to remove.
  const chatDetail = (chat: ChatMeta, withProject: boolean): ChatDetail => {
    // A worktree carries its branch on the chat itself, so those rows are
    // labelled before any git read lands.
    const branch = chat.worktree?.branch ?? chatBranches[chat.cwd]
    if (!branch) return { kind: 'path', text: shortenPath(chat.cwd, window.api.home) }
    return {
      kind: 'branch',
      project: withProject ? projectLabel(projectRoot(chat)) : undefined,
      text: branch
    }
  }

  const newChatIn = (cwd: string | null): void => {
    if (cwd) setSelectedCwd(cwd)
    void openChat(null)
  }

  const openProject = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) {
      setSelectedCwd(dir)
      void openChat(null)
    }
  }

  const openSettings = useApp((s) => s.openSettings)
  const openUsage = useApp((s) => s.openUsage)
  const searchOpen = useApp((s) => s.searchOpen)
  const setSearchOpen = useApp((s) => s.setSearchOpen)
  const newChatOpen = useApp((s) => s.newChatOpen)
  const setNewChatOpen = useApp((s) => s.setNewChatOpen)
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null)
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null)
  const [deletingWt, setDeletingWt] = React.useState<WorktreeStatus | null>(null)
  // git's refusal when worktree cleanup failed, shown after the dialog closes.
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  // Fetch the dirty/unmerged report when a worktree chat's delete dialog opens,
  // so the confirm can say what would actually be lost.
  React.useEffect(() => {
    setDeletingWt(null)
    if (!deleting?.worktree) return
    let cancelled = false
    void window.api.worktreeStatus(deleting.id).then((s) => {
      if (!cancelled) setDeletingWt(s)
    })
    return () => {
      cancelled = true
    }
  }, [deleting])

  // What a force-delete would destroy ('' when nothing), and whether the report
  // is still in flight — both derived, so the predicate lives in one place.
  const atRisk = deletingWt ? describeAtRisk(deletingWt) : ''
  const wtLoading = !!deleting?.worktree && !deletingWt
  const [renameValue, setRenameValue] = React.useState('')
  // Project being renamed (its cwd) and the working input value.
  const [renamingProject, setRenamingProject] = React.useState<string | null>(null)
  const [projectNameValue, setProjectNameValue] = React.useState('')
  const removeProject = useApp((s) => s.removeProject)
  const setChatPinned = useApp((s) => s.setChatPinned)
  const startInWorktree = useApp((s) => s.startInWorktree)
  const [removingProject, setRemovingProject] = React.useState<{
    cwd: string
    count: number
  } | null>(null)
  const [collapsedProjects, setCollapsedProjects] = React.useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('collapsedProjects') ?? '{}') as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })
  const [revealedChatBatches, setRevealedChatBatches] = React.useState<Record<string, number>>({})
  // The same "show more" counter for the detailed mode's single flat list.
  const [flatBatches, setFlatBatches] = React.useState(0)

  // Stored value: true = collapsed, false = expanded. Archived projects
  // default to collapsed, active ones to expanded.
  const toggleProject = (cwd: string, collapsed: boolean): void => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [cwd]: !collapsed }
      localStorage.setItem('collapsedProjects', JSON.stringify(next))
      return next
    })
  }

  const [archivedProjects, setArchivedProjects] = React.useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('archivedProjects') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })

  const setArchived = (cwd: string, archived: boolean): void => {
    setArchivedProjects((prev) => {
      const next = { ...prev }
      if (archived) next[cwd] = true
      else delete next[cwd]
      localStorage.setItem('archivedProjects', JSON.stringify(next))
      return next
    })
  }

  // User-controlled project order (array of cwds). Persisted; a project not yet
  // listed keeps its discovery order. `dragCwd`/`dropCwd` drive drag-to-reorder.
  const [projectOrder, setProjectOrder] = React.useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('projectOrder') ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const persistOrder = (next: string[]): void => {
    setProjectOrder(next)
    localStorage.setItem('projectOrder', JSON.stringify(next))
  }
  const [dragCwd, setDragCwd] = React.useState<string | null>(null)
  const [dropCwd, setDropCwd] = React.useState<string | null>(null)
  // Whether the drop lands after (below) the target row vs before (above it).
  const [dropAfter, setDropAfter] = React.useState(false)

  const [width, setWidth] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'))
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX
      ? saved
      : SIDEBAR_DEFAULT
  })
  // State (not just a ref) because the width transition is disabled while dragging.
  const [dragging, setDragging] = React.useState(false)
  const draggingRef = React.useRef(false)

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events have no active pointer to capture
    }
  }

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    setWidth(Math.max(SIDEBAR_MIN, Math.min(Math.round(e.clientX), SIDEBAR_MAX)))
  }

  const onHandlePointerUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    setWidth((w) => {
      localStorage.setItem('sidebarWidth', String(w))
      return w
    })
  }

  const resetWidth = (): void => {
    draggingRef.current = false
    setDragging(false)
    setWidth(SIDEBAR_DEFAULT)
    localStorage.removeItem('sidebarWidth')
  }

  // Group chats by project folder. Chats within a project keep the order they
  // arrive in — `chats` *is* the sidebar order (store.ts `hoistChat`), which
  // moves only when a turn starts — and the PROJECT order is fixed by the
  // user's saved order, so a chat bump yanks neither the row nor its project to
  // the top. Projects not yet in the saved order keep their discovery order.
  // Pinned chats are pulled out into a section of their own at the top, so they
  // render once, not twice — but they stay in `group.chats`, which is what the
  // delete-project count means. `unpinned` is what the group actually lists;
  // keeping both is also what keeps a project whose only chat is pinned from
  // disappearing from the sidebar entirely.
  const groups: { cwd: string; chats: ChatMeta[]; unpinned: ChatMeta[] }[] = []
  for (const chat of chats) {
    const key = projectRoot(chat)
    let group = groups.find((g) => g.cwd === key)
    if (!group) {
      group = { cwd: key, chats: [], unpinned: [] }
      groups.push(group)
    }
    group.chats.push(chat)
    if (chat.pinnedAt === undefined) group.unpinned.push(chat)
  }
  // Oldest pin first, so pinning appends to the bottom of the section instead of
  // the order shuffling every time one of them is used.
  const pinnedChats = chats
    .filter((c) => c.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
  const orderRank = (cwd: string): number => {
    const i = projectOrder.indexOf(cwd)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  groups.sort((a, b) => orderRank(a.cwd) - orderRank(b.cwd))
  // Drag-to-reorder: move `from` just before `to`, then persist the full order.
  const moveProject = (from: string, to: string, after: boolean): void => {
    if (from === to) return
    const ordered = groups.map((g) => g.cwd).filter((c) => c !== from)
    const i = ordered.indexOf(to)
    const at = i === -1 ? ordered.length : after ? i + 1 : i
    ordered.splice(at, 0, from)
    persistOrder(ordered)
  }
  const visibleGroups = groups.filter((g) => !hiddenProjects[g.cwd])

  // "Show me one project" — the same question in both modes, so the same
  // control answers it. Detailed has no project rows and nothing else to ask
  // with; compact's answer used to be collapsing the other rows by hand. A
  // saved filter naming a project that no longer exists reads as null rather
  // than an empty sidebar — the project can be deleted from elsewhere.
  const filterProject =
    sidebarProject && visibleGroups.some((g) => g.cwd === sidebarProject) ? sidebarProject : null
  // Filtering to a project explicitly reaches an archived one; the unfiltered
  // list leaves them out, which is what archiving means. Compact still heads it
  // with the "Archived" divider, which is the only thing left saying so once
  // the list is down to that one project.
  const shownGroups = filterProject
    ? visibleGroups.filter((g) => g.cwd === filterProject)
    : visibleGroups
  const activeGroups = shownGroups.filter((g) => !archivedProjects[g.cwd])
  const archivedGroups = shownGroups.filter((g) => archivedProjects[g.cwd])

  // The new-chat chooser's rows, in *recency* order rather than the sidebar's
  // manual project order — `chats` arrives newest-first, so the project you
  // were last in is the first row, and ⌘N-Enter is the common case. Archived
  // projects are included: choosing one by name is a deliberate act, unlike
  // browsing the list they were archived out of.
  const newChatProjects: { cwd: string; label: string; count: number }[] = []
  for (const chat of chats) {
    const root = projectRoot(chat)
    if (hiddenProjects[root] || newChatProjects.some((p) => p.cwd === root)) continue
    newChatProjects.push({
      cwd: root,
      label: projectLabel(root),
      count: groups.find((g) => g.cwd === root)?.chats.length ?? 0
    })
  }

  // Detailed mode is a flat, recency-ordered list, not a project tree: a row
  // already names its project and branch, so grouping by project would print
  // the same folder — and, in a repo where nothing is isolated, the same branch
  // — once per row. Date buckets structure the list by the thing that actually
  // varies down it. Everything else about a row is identical between modes.
  const flatSource = filterProject ? shownGroups : activeGroups
  // A filter scopes the whole sidebar, pins included — a pin from another
  // project showing through would make the list a half-truth. This is the one
  // part that was already shared: compact reads `pinnedShown` too, so before
  // the filter appeared in both modes a pick made in detailed silently scoped
  // compact's pins with nothing on screen to clear it.
  const pinnedShown = filterProject
    ? pinnedChats.filter((c) => projectRoot(c) === filterProject)
    : pinnedChats
  // Home-screen prompts never sent. Scoped by the same filter as the pins, for
  // the same reason — a draft from another project showing through a filtered
  // sidebar makes the whole list a half-truth. Hidden projects stay hidden.
  const draftsShown = sortedProjectDrafts(projectDrafts).filter(
    (draft) => !hiddenProjects[draft.cwd] && (!filterProject || draft.cwd === filterProject)
  )
  // Take the rows from `chats` rather than from the groups: `chats` is already
  // in sidebar order (store.ts `hoistChat`) and flattening the groups would
  // impose the project grouping this mode exists to not have. Order is the
  // store's business — the list re-sorts when a turn starts, and at no other
  // time, so a streaming chat no longer walks up and down the sidebar.
  const flatCwds = new Set(flatSource.map((g) => g.cwd))
  const flatChats = chats.filter((c) => c.pinnedAt === undefined && flatCwds.has(projectRoot(c)))
  const flatShown = flatChats.slice(0, FLAT_BATCH * (flatBatches + 1))
  const flatHidden = flatChats.length - flatShown.length
  // Keyed by label, not by adjacency: order is frozen between turns while
  // `updatedAt` keeps moving, so a chat can outlive its bucket (a turn running
  // across midnight) and print a second "Yesterday" under the first.
  const flatSections: { label: string; chats: ChatMeta[] }[] = []
  for (const chat of flatShown) {
    const label = dateGroup(chat.updatedAt)
    const section = flatSections.find((s) => s.label === label)
    if (section) section.chats.push(chat)
    else flatSections.push({ label, chats: [chat] })
  }

  // Everything you can do to a project, in one definition — the project row's
  // menu in compact mode, and the tail of a chat row's menu in detailed mode,
  // which has no project rows.
  const projectMenuItems = (cwd: string, archived: boolean): React.JSX.Element => (
    <>
      <ContextMenuItem
        onClick={() => {
          setProjectNameValue(projectLabel(cwd))
          setRenamingProject(cwd)
        }}
      >
        <Pencil /> Rename project…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void window.api.revealPath(cwd)}>
        <FolderOpen /> {REVEAL_LABEL}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {archived ? (
        <ContextMenuItem onClick={() => setArchived(cwd, false)}>
          <ArchiveRestore /> Unarchive project
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => setArchived(cwd, true)}>
          <Archive /> Archive project
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => setProjectHidden(cwd, true)}>
        <EyeOff /> Hide project
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        destructive
        onClick={() =>
          setRemovingProject({
            cwd,
            count: groups.find((g) => g.cwd === cwd)?.chats.length ?? 0
          })
        }
      >
        <Trash2 /> Delete project…
      </ContextMenuItem>
    </>
  )

  // A chat row is identical wherever it appears — in its project group or in the
  // Pinned section — so both sites render through here.
  const renderChatItem = (chat: ChatMeta): React.JSX.Element => (
    <ChatItem
      key={chat.id}
      chat={chat}
      active={chat.id === activeId}
      activity={chatActivity(statuses[chat.id], backgroundJobs[chat.id], permissions[chat.id])}
      titling={!!titling[chat.id]}
      detail={detailed ? chatDetail(chat, !filterProject) : null}
      projectMenu={
        // Whenever no project row is on screen to carry them — always in
        // detailed, and in compact once a filter has collapsed the list to one
        // project and its row along with it.
        detailed || filterProject ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{projectLabel(projectRoot(chat))}</ContextMenuLabel>
              <ContextMenuItem onClick={() => newChatIn(projectRoot(chat))}>
                <Plus /> New chat here
              </ContextMenuItem>
              {projectMenuItems(projectRoot(chat), !!archivedProjects[projectRoot(chat)])}
            </ContextMenuGroup>
          </>
        ) : null
      }
      onOpen={() => void openChat(chat.id)}
      onRename={() => {
        setRenameValue(chat.title)
        setRenaming(chat)
      }}
      onDelete={() => setDeleting(chat)}
      onTogglePin={() => void setChatPinned(chat.id, chat.pinnedAt === undefined)}
      onNewInWorktree={() => {
        // Drops to the composer with the worktree preselected; the model picker
        // there chooses the provider, so a Codex chat can pick up a worktree
        // Claude started.
        if (chat.worktree) void startInWorktree(chat.cwd, chat.worktree)
      }}
    />
  )

  return (
    <aside
      data-sidebar
      style={{ width: sidebarOpen ? width : 0 }}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar',
        !dragging && 'transition-[width] duration-200 ease-out',
        !sidebarOpen && 'border-r-0'
      )}
    >
      <div className="flex h-full flex-col" style={{ width }}>
      {/* Traffic-light strip; window controls live on its right, Cursor-style */}
      <div className="drag flex h-[38px] shrink-0 items-center justify-end gap-0.5 px-2.5">
        <WithTooltip label="Hide sidebar  ⌘B">
          <Button size="icon-sm" variant="ghost" aria-label="Hide sidebar" onClick={toggleSidebar}>
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>

      {/* Primary actions, Cursor-style rows */}
      <div className="flex flex-col gap-0.5 px-2 pb-1">
        <button
          type="button"
          // Asks which project, in both modes. The instant path stays where the
          // answer is already on screen: compact mode's per-project ＋ and the
          // "New chat here" on a detailed row's menu.
          onClick={() => setNewChatOpen(true)}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
          New chat
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">⌘N</Kbd>
        </button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          Search
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">⌘K</Kbd>
        </button>
      </div>

      {/* Unsent prompts, at the very top and above even the pins: this is the
          one section whose contents exist nowhere else, and a draft you can't
          see is a draft you've lost. There is at most one per project, so it
          costs the pins a row or two and never a screenful. */}
      {draftsShown.length > 0 && (
        <div className="flex max-h-[25vh] shrink-0 flex-col">
          <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground/70">
              Drafts
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto px-3">
            <div className="space-y-px">
              {draftsShown.map((draft) => (
                <DraftItem
                  key={draft.cwd}
                  draft={draft}
                  // A filter has already named the project in the header.
                  project={filterProject ? null : projectLabel(draft.cwd)}
                  onOpen={() => openDraft(draft.cwd)}
                  onDiscard={() => discardProjectDraft(draft.cwd)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Pinned chats, above the projects and outside their scroller so they
          stay reachable no matter how far down the project list you are. */}
      {pinnedShown.length > 0 && (
        <div className="flex max-h-[35vh] shrink-0 flex-col">
          <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground/70">
              Pinned
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto px-3">
            {/* Matches whatever the list below does: compact indents under its
                project rows, and has none to indent under once filtered. */}
            <div className={cn('space-y-px', !detailed && !filterProject && 'ml-[22px]')}>
              {pinnedShown.map(renderChatItem)}
            </div>
          </div>
        </div>
      )}

      {/* Section header, and the project filter is it in BOTH modes.
          Detailed mode has no project rows, so the filter is the only project
          control it has — but "show me one project" is not a thing only a flat
          list wants, and compact's answer to it was collapsing the other nine
          rows by hand. The two modes were also already sharing the *state*:
          `sidebarProject` persists, and the Pinned section reads it either way,
          so a filter set in detailed used to quietly scope compact's pins with
          no control on screen to clear it.

          It's sized to be clicked — 13px, matching the chat titles beneath it
          rather than the divider text — because it is a control, not the
          section label it replaces. */}
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Filter by project"
                className={cn(
                  '-ml-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium transition-colors hover:bg-sidebar-accent hover:text-foreground',
                  filterProject ? 'text-sidebar-foreground' : 'text-sidebar-foreground/65'
                )}
              />
            }
          >
            <span className="truncate">
              {filterProject ? projectLabel(filterProject) : 'All projects'}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-80 overflow-y-auto">
            <DropdownMenuItem onClick={() => setSidebarProject(null)}>
              <Check className={cn(!filterProject && 'opacity-100', filterProject && 'invisible')} />
              All projects
            </DropdownMenuItem>
            {visibleGroups.length > 0 && <DropdownMenuSeparator />}
            {visibleGroups.map((g) => (
              <DropdownMenuItem key={g.cwd} onClick={() => setSidebarProject(g.cwd)}>
                <Check className={cn(filterProject !== g.cwd && 'invisible')} />
                <span className="min-w-0 truncate">{projectLabel(g.cwd)}</span>
                <span className="ml-auto pl-3 text-[11px] text-muted-foreground/60">
                  {g.chats.length}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <WithTooltip label="Add a project folder">
          {/* One control, one size in both modes. It sits next to a section
              label in compact and a 13px filter in detailed, but it is the same
              button doing the same thing — sizing it off whatever happens to be
              beside it is how you get a target that shrinks when you switch
              modes. Labels are free to differ; controls are not. */}
          <button
            type="button"
            onClick={() => void openProject()}
            aria-label="Add project"
            className="-mr-1.5 rounded-md p-1.5 text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            {/* A folder, not a bare plus: the plus alone is the new-*chat* verb
                everywhere else in this sidebar, and the two sat one row apart. */}
            <FolderPlus className="size-4" />
          </button>
        </WithTooltip>
      </div>

      {/* Detailed mode: one flat list, newest first, bucketed by date */}
      {detailed && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {flatChats.length === 0 && pinnedShown.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground">
              {filterProject
                ? `No chats in ${projectLabel(filterProject)} yet.`
                : 'Open a project to get started.'}
            </div>
          )}
          {flatSections.map((section, i) => (
            <React.Fragment key={section.label}>
              {/* "Today" goes unlabelled: the top of a newest-first list is today
                  by definition, so the heading would cost a row to say nothing. */}
              {section.label !== 'Today' && (
                <div className={cn('flex items-center gap-2 px-1.5 pb-0.5', i === 0 ? 'pt-1' : 'pt-4')}>
                  <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
                    {section.label}
                  </span>
                  <div className="h-px flex-1 bg-sidebar-border" />
                </div>
              )}
              <div className="space-y-px">{section.chats.map(renderChatItem)}</div>
            </React.Fragment>
          ))}
          {flatHidden > 0 && (
            <button
              type="button"
              onClick={() => setFlatBatches((n) => n + 1)}
              className="mt-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
            >
              <ChevronRight className="size-3 shrink-0" />
              Show {Math.min(FLAT_BATCH, flatHidden)} more
            </button>
          )}
        </div>
      )}

      {/* Compact mode: chats grouped by project */}
      {!detailed && (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {activeGroups.length === 0 && archivedGroups.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            Open a project to get started.
          </div>
        )}
        {[
          ...activeGroups.map((g) => ({ group: g, archived: false })),
          ...archivedGroups.map((g) => ({ group: g, archived: true }))
        ].map(({ group, archived }, i) => {
          // Filtered to this project, the header already names it — a row
          // repeating it below is the sidebar saying "ai-gui" twice in 30px.
          // Its collapse toggle would empty the sidebar, its drag handle has
          // nothing to trade places with, and the two things it does carry
          // (New chat here, the project menu) move onto the chat rows via
          // `projectMenu` — the mechanism detailed mode already uses for
          // exactly this, having no project rows either.
          const headed = !filterProject
          // Archived projects default to collapsed. Collapse can't apply with
          // no row to click, and would otherwise hide the list you just
          // filtered down to.
          const isCollapsed = headed && (collapsedProjects[group.cwd] ?? archived)
          // Pinned chats show their own indicator up top, so rolling them into
          // the collapsed project's would just say the same thing twice.
          const collapsedActivity = projectActivity(
            group.unpinned.map((chat) =>
              chatActivity(statuses[chat.id], backgroundJobs[chat.id], permissions[chat.id])
            )
          )
          const firstArchived = archived && i === activeGroups.length
          // Cap to the most-recent chats (search shows all matches). Keep the
          // open chat visible even when it's older than the cap.
          const revealedBatches = revealedChatBatches[group.cwd] ?? 0
          const chatListLimit = chatsPerProject * (revealedBatches + 1)
          const cappedChats = (() => {
            if (group.unpinned.length <= chatListLimit) return group.unpinned
            const top = group.unpinned.slice(0, chatListLimit)
            const activeInGroup = group.unpinned.find((c) => c.id === activeId)
            return activeInGroup && !top.some((c) => c.id === activeId)
              ? [...top, activeInGroup]
              : top
          })()
          const hiddenChatCount = group.unpinned.length - cappedChats.length
          return (
            <React.Fragment key={group.cwd}>
              {firstArchived && (
                <div className="flex items-center gap-2 px-1.5 pt-4 pb-0.5">
                  <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
                    Archived
                  </span>
                  <div className="h-px flex-1 bg-sidebar-border" />
                </div>
              )}
              <div className={cn('relative', archived && 'opacity-70')}>
                {/* Insertion line: shows exactly where the dragged project lands
                    (above or below this row) — reads as reorder, not nesting. */}
                {headed && dropCwd === group.cwd && dragCwd && dragCwd !== group.cwd && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-primary',
                      dropAfter ? '-bottom-0.5' : '-top-0.5'
                    )}
                  />
                )}
                {headed && (
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <div
                        className={cn(
                          'group/project flex items-center gap-0.5 rounded-md',
                          dragCwd === group.cwd && 'opacity-50'
                        )}
                        draggable
                        onDragStart={(e) => {
                          setDragCwd(group.cwd)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(e) => {
                          if (!dragCwd || dragCwd === group.cwd) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          const rect = e.currentTarget.getBoundingClientRect()
                          const after = e.clientY > rect.top + rect.height / 2
                          if (dropCwd !== group.cwd || dropAfter !== after) {
                            setDropCwd(group.cwd)
                            setDropAfter(after)
                          }
                        }}
                        onDragLeave={() =>
                          setDropCwd((c) => (c === group.cwd ? null : c))
                        }
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragCwd) moveProject(dragCwd, group.cwd, dropAfter)
                          setDragCwd(null)
                          setDropCwd(null)
                        }}
                        onDragEnd={() => {
                          setDragCwd(null)
                          setDropCwd(null)
                        }}
                      />
                    }
                  >
                    <WithTooltip label={group.cwd}>
                      <button
                        type="button"
                        onClick={() => toggleProject(group.cwd, isCollapsed)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60"
                        aria-expanded={!isCollapsed}
                      >
                        {/* One icon slot: folder at rest, chevron on row hover (Cursor-style). */}
                        <span className="relative size-3.5 shrink-0">
                          <Folder className="absolute inset-0 size-3.5 text-muted-foreground/80 transition-all duration-150 group-hover/project:scale-75 group-hover/project:opacity-0" />
                          <ChevronRight
                            className={cn(
                              'absolute inset-0 size-3.5 scale-75 text-muted-foreground/80 opacity-0 transition-all duration-150 group-hover/project:scale-100 group-hover/project:opacity-100',
                              !isCollapsed && 'rotate-90'
                            )}
                          />
                        </span>
                        <span className="truncate text-[13px] font-medium text-sidebar-foreground">
                          {projectLabel(group.cwd)}
                        </span>
                        {isCollapsed && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/70">
                            {group.chats.length}
                          </span>
                        )}
                        {isCollapsed && collapsedActivity.kind !== 'idle' && (
                          <ActivityIndicator activity={collapsedActivity} />
                        )}
                      </button>
                    </WithTooltip>
                    {!archived && (
                      <WithTooltip label={`New chat in ${projectLabel(group.cwd)}`}>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-5 shrink-0 opacity-0 transition-opacity group-hover/project:opacity-100"
                          onClick={() => newChatIn(group.cwd)}
                          aria-label={`New chat in ${projectLabel(group.cwd)}`}
                        >
                          <Plus />
                        </Button>
                      </WithTooltip>
                    )}
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {!archived && (
                      <>
                        <ContextMenuItem onClick={() => newChatIn(group.cwd)}>
                          <Plus /> New chat
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    {projectMenuItems(group.cwd, archived)}
                  </ContextMenuContent>
                </ContextMenu>
                )}
                {!isCollapsed && (
                  // The indent is the project row's hanging indent; with no row
                  // above them the chats sit flush, exactly as detailed's do.
                  <div className={cn('space-y-px pb-1', headed && 'ml-[22px]')}>
                    {cappedChats.map(renderChatItem)}
                    {(hiddenChatCount > 0 || revealedBatches > 0) && (
                      <div className="flex items-center">
                        {hiddenChatCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedChatBatches((prev) => ({
                                ...prev,
                                [group.cwd]: revealedBatches + 1
                              }))
                            }
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
                          >
                            <ChevronRight className="size-3 shrink-0" />
                            Show {Math.min(chatsPerProject, hiddenChatCount)} more
                          </button>
                        )}
                        {revealedBatches > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedChatBatches((prev) => ({ ...prev, [group.cwd]: 0 }))
                            }
                            className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })}
      </div>
      )}

      <UpdateBanner />

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-sidebar-border px-3 py-2">
        <UsagePanel />
        <div className="flex items-center">
          {/* Next to the plan-limits chip on purpose: same corner, two halves of
              one question — what's left right now, and where it has been going. */}
          <WithTooltip label="Usage over time">
            <Button size="icon-sm" variant="ghost" onClick={openUsage} aria-label="Open usage">
              <ChartColumn />
            </Button>
          </WithTooltip>
          <WithTooltip label="Settings  ⌘,">
            <Button size="icon-sm" variant="ghost" onClick={openSettings} aria-label="Open settings">
              <Settings />
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Search chats across projects */}
      <SearchChatsDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        chats={chats}
        onOpen={(id) => void openChat(id)}
      />

      {/* Which project a new chat starts in */}
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        projects={newChatProjects}
        onPick={(cwd) => newChatIn(cwd)}
        onBrowse={() => void openProject()}
        onRemove={(cwd, count) => setRemovingProject({ cwd, count })}
      />

      {/* Rename dialog */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogTitle>Rename chat</DialogTitle>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (renaming && renameValue.trim()) {
                void renameChat(renaming.id, renameValue.trim())
                setRenaming(null)
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
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename project dialog */}
      <Dialog
        open={renamingProject !== null}
        onOpenChange={(open) => !open && setRenamingProject(null)}
      >
        <DialogContent>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            A display name for this project in the sidebar. Leave blank to use the folder name. The
            folder on disk is not renamed.
          </DialogDescription>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (renamingProject) {
                // An empty value (or one equal to the folder name) clears the override.
                const next =
                  projectNameValue.trim() === basename(renamingProject) ? '' : projectNameValue
                setProjectName(renamingProject, next)
                setRenamingProject(null)
              }
            }}
          >
            <Input
              value={projectNameValue}
              onChange={(e) => setProjectNameValue(e.target.value)}
              autoFocus
              placeholder={renamingProject ? basename(renamingProject) : 'Project name'}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenamingProject(null)}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove project dialog */}
      <Dialog
        open={removingProject !== null}
        onOpenChange={(open) => !open && setRemovingProject(null)}
      >
        <DialogContent>
          <DialogTitle>Remove “{removingProject ? projectLabel(removingProject.cwd) : ''}”?</DialogTitle>
          <DialogDescription>
            The project is removed from the sidebar and its{' '}
            {removingProject?.count === 1 ? 'chat is' : `${removingProject?.count} chats are`}{' '}
            deleted permanently. Files on disk are not touched.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemovingProject(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removingProject) void removeProject(removingProject.cwd)
                setRemovingProject(null)
              }}
            >
              Remove project
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Worktree cleanup failed — the chat is already gone, so this reports
          what was left behind rather than blocking anything. */}
      <Dialog open={deleteError !== null} onOpenChange={(open) => !open && setDeleteError(null)}>
        <DialogContent>
          <DialogTitle>The worktree couldn’t be removed</DialogTitle>
          <DialogDescription>
            The chat was deleted, but its worktree is still on disk. Git said:
          </DialogDescription>
          <p className="mt-3 rounded-md bg-secondary/50 p-2 font-mono text-[11px] break-words text-destructive">
            {deleteError}
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setDeleteError(null)}>
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            “{deleting?.title || 'New chat'}” and its history will be removed permanently.
            {deleting?.worktree && (
              <>
                {' '}
                It runs in the worktree{' '}
                <span className="font-medium text-foreground">{deleting.worktree.branch}</span>.
                {deletingWt
                  ? atRisk
                    ? ` It has ${atRisk} that deleting the worktree would destroy.`
                    : ' The worktree is clean and safe to delete.'
                  : ' Checking for uncommitted work…'}
              </>
            )}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            {deleting?.worktree && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (deleting) void deleteChat(deleting.id, 'keep')
                  setDeleting(null)
                }}
              >
                Keep worktree
              </Button>
            )}
            <Button
              variant="destructive"
              // Deleting is blocked only while we don't yet know what's at risk.
              disabled={wtLoading}
              onClick={() => {
                if (!deleting) return
                // Nothing at risk → a plain remove (git still refuses if it
                // disagrees). Otherwise the user has read the warning and forces.
                const disposition = !deleting.worktree ? undefined : atRisk ? 'force' : 'remove'
                void deleteChat(deleting.id, disposition).then((res) => {
                  // The chat is gone either way; a worktree git refused to
                  // remove is reported here, where the user asked for it.
                  if (!res.ok) setDeleteError(res.error)
                })
                setDeleting(null)
              }}
            >
              {!deleting?.worktree ? 'Delete' : atRisk ? 'Delete anyway' : 'Delete with worktree'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
      {/* Resize handle — drag to resize, double-click to reset */}
      {sidebarOpen && (
        <div
          data-sidebar-resize
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onLostPointerCapture={onHandlePointerUp}
          onDoubleClick={resetWidth}
          className="no-drag absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
        />
      )}
    </aside>
  )
}

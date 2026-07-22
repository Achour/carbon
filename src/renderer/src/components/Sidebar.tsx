import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  EyeOff,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2
} from 'lucide-react'
import type { ChatMeta, WorktreeStatus } from '@shared/types'
import { projectRoot } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename, relativeTime } from '@/lib/format'
import { REVEAL_LABEL } from '@/lib/platform'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
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

function ChatItem({
  chat,
  active,
  streaming,
  titling,
  onOpen,
  onRename,
  onDelete,
  onNewInWorktree
}: {
  chat: ChatMeta
  active: boolean
  streaming: boolean
  titling: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  /** Start another chat — possibly on the other provider — in the same worktree. */
  onNewInWorktree: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
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
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] transition-colors',
            // Cursor-style: inactive chats are muted, the open one is bright — the
            // brightness gap (plus the filled highlight) marks the active chat.
            // Bright, NOT bold — Cursor keeps regular weight, which reads cleaner.
            active
              ? 'text-sidebar-foreground'
              : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground/90',
            titling && 'title-forming'
          )}
        >
          {chat.title || 'New chat'}
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center text-[11px] text-muted-foreground/80 transition-opacity group-hover:opacity-0',
            menuOpen && 'opacity-0'
          )}
        >
          {streaming ? (
            <Loader2 className="size-3 animate-spin text-primary" />
          ) : (
            relativeTime(chat.updatedAt)
          )}
        </span>
      </button>
      <div
        className={cn(
          'absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
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
      </ContextMenuContent>
    </ContextMenu>
  )
}

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

export function Sidebar(): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const activeId = useApp((s) => s.activeId)
  const statuses = useApp((s) => s.statuses)
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
  const searchOpen = useApp((s) => s.searchOpen)
  const setSearchOpen = useApp((s) => s.setSearchOpen)
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

  // Group chats by project folder. Chats within a project stay sorted by
  // updatedAt (the chat list is pre-sorted), but the PROJECT order is fixed by
  // the user's saved order — so a chat bump no longer yanks its project to the
  // top. Projects not yet in the saved order keep their discovery order.
  const groups: { cwd: string; chats: ChatMeta[] }[] = []
  for (const chat of chats) {
    const key = projectRoot(chat)
    const group = groups.find((g) => g.cwd === key)
    if (group) group.chats.push(chat)
    else groups.push({ cwd: key, chats: [chat] })
  }
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
  const activeGroups = visibleGroups.filter((g) => !archivedProjects[g.cwd])
  const archivedGroups = visibleGroups.filter((g) => archivedProjects[g.cwd])

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
          onClick={() => newChatIn(null)}
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

      {/* Projects section header with an add-project button */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground/70">
          Projects
        </span>
        <div className="flex-1" />
        <WithTooltip label="Add a project folder">
          <button
            type="button"
            onClick={() => void openProject()}
            aria-label="Add project"
            className="-mr-1 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        </WithTooltip>
      </div>

      {/* Chats grouped by project */}
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
          // Archived projects default to collapsed.
          const isCollapsed = collapsedProjects[group.cwd] ?? archived
          const hasStreaming = group.chats.some((c) => (statuses[c.id] ?? 'idle') !== 'idle')
          const firstArchived = archived && i === activeGroups.length
          // Cap to the most-recent chats (search shows all matches). Keep the
          // open chat visible even when it's older than the cap.
          const revealedBatches = revealedChatBatches[group.cwd] ?? 0
          const chatListLimit = chatsPerProject * (revealedBatches + 1)
          const cappedChats = (() => {
            if (group.chats.length <= chatListLimit) return group.chats
            const top = group.chats.slice(0, chatListLimit)
            const activeInGroup = group.chats.find((c) => c.id === activeId)
            return activeInGroup && !top.some((c) => c.id === activeId)
              ? [...top, activeInGroup]
              : top
          })()
          const hiddenChatCount = group.chats.length - cappedChats.length
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
                {dropCwd === group.cwd && dragCwd && dragCwd !== group.cwd && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-primary',
                      dropAfter ? '-bottom-0.5' : '-top-0.5'
                    )}
                  />
                )}
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
                        {isCollapsed && hasStreaming && (
                          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
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
                    <ContextMenuItem
                      onClick={() => {
                        setProjectNameValue(projectLabel(group.cwd))
                        setRenamingProject(group.cwd)
                      }}
                    >
                      <Pencil /> Rename project…
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void window.api.revealPath(group.cwd)}>
                      <FolderOpen /> {REVEAL_LABEL}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {archived ? (
                      <ContextMenuItem onClick={() => setArchived(group.cwd, false)}>
                        <ArchiveRestore /> Unarchive project
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem onClick={() => setArchived(group.cwd, true)}>
                        <Archive /> Archive project
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onClick={() => setProjectHidden(group.cwd, true)}>
                      <EyeOff /> Hide project
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      destructive
                      onClick={() => setRemovingProject({ cwd: group.cwd, count: group.chats.length })}
                    >
                      <Trash2 /> Delete project…
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {!isCollapsed && (
                  <div className="ml-[22px] space-y-px pb-1">
                    {cappedChats.map((chat) => (
                      <ChatItem
                        key={chat.id}
                        chat={chat}
                        active={chat.id === activeId}
                        streaming={(statuses[chat.id] ?? 'idle') !== 'idle'}
                        titling={!!titling[chat.id]}
                        onOpen={() => void openChat(chat.id)}
                        onRename={() => {
                          setRenameValue(chat.title)
                          setRenaming(chat)
                        }}
                        onDelete={() => setDeleting(chat)}
                        onNewInWorktree={() => {
                          // Drops to the composer with the worktree preselected;
                          // the model picker there chooses the provider, so a
                          // Codex chat can pick up a worktree Claude started.
                          if (chat.worktree) void startInWorktree(chat.cwd, chat.worktree)
                        }}
                      />
                    ))}
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

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end border-t border-sidebar-border px-3 py-2">
        <WithTooltip label="Settings  ⌘,">
          <Button size="icon-sm" variant="ghost" onClick={openSettings} aria-label="Open settings">
            <Settings />
          </Button>
        </WithTooltip>
      </div>

      {/* Search chats across projects */}
      <SearchChatsDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        chats={chats}
        onOpen={(id) => void openChat(id)}
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

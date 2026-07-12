import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
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
import type { ChatMeta } from '@shared/types'
import { cn } from '@/lib/utils'
import { basename, relativeTime } from '@/lib/format'
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
import { WithTooltip } from '@/components/ui/tooltip'

function ChatItem({
  chat,
  active,
  streaming,
  onOpen,
  onRename,
  onDelete
}: {
  chat: ChatMeta
  active: boolean
  streaming: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group relative rounded-md transition-colors',
              active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
            )}
          />
        }
      >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-[7px] text-left outline-none"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-sidebar-foreground">
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

export function Sidebar(): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const activeId = useApp((s) => s.activeId)
  const statuses = useApp((s) => s.statuses)
  const openChat = useApp((s) => s.openChat)
  const renameChat = useApp((s) => s.renameChat)
  const deleteChat = useApp((s) => s.deleteChat)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)

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
  const [filter, setFilter] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null)
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const removeProject = useApp((s) => s.removeProject)
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

  // Hidden projects are fully removed from the list (unlike archived, which stay
  // visible in a section) but keep all their chats, and can be restored from the
  // footer. Distinct from Delete, which discards the chats.
  const [hiddenProjects, setHiddenProjects] = React.useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('hiddenProjects') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })

  const setHidden = (cwd: string, hidden: boolean): void => {
    setHiddenProjects((prev) => {
      const next = { ...prev }
      if (hidden) next[cwd] = true
      else delete next[cwd]
      localStorage.setItem('hiddenProjects', JSON.stringify(next))
      return next
    })
  }

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

  const filtered = filter
    ? chats.filter((c) => (c.title || 'New chat').toLowerCase().includes(filter.toLowerCase()))
    : chats

  // Group chats by project folder; groups ordered by most recent activity
  // (the chat list is already sorted by updatedAt descending).
  const groups: { cwd: string; chats: ChatMeta[] }[] = []
  for (const chat of filtered) {
    const group = groups.find((g) => g.cwd === chat.cwd)
    if (group) group.chats.push(chat)
    else groups.push({ cwd: chat.cwd, chats: [chat] })
  }
  const visibleGroups = groups.filter((g) => !hiddenProjects[g.cwd])
  const activeGroups = visibleGroups.filter((g) => !archivedProjects[g.cwd])
  const archivedGroups = visibleGroups.filter((g) => archivedProjects[g.cwd])
  const hiddenGroups = groups.filter((g) => hiddenProjects[g.cwd])

  return (
    <aside
      style={{ width: sidebarOpen ? width : 0 }}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar',
        !dragging && 'transition-[width] duration-200 ease-out',
        !sidebarOpen && 'border-r-0'
      )}
    >
      <div className="flex h-full flex-col" style={{ width }}>
      {/* Traffic-light strip; window controls live on its right, Cursor-style */}
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-0.5 px-2.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Search chats"
          onClick={() => {
            setSearchOpen((open) => {
              if (open) setFilter('')
              return !open
            })
          }}
          className={cn(searchOpen && 'bg-sidebar-accent text-foreground')}
        >
          <Search />
        </Button>
        <WithTooltip label="Hide sidebar  ⌘B">
          <Button size="icon-sm" variant="ghost" aria-label="Hide sidebar" onClick={toggleSidebar}>
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>

      <div className="flex flex-col gap-2 px-3 pb-2">
        {searchOpen && (
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('')
                setSearchOpen(false)
              }
            }}
            autoFocus
            placeholder="Search chats"
            className="h-7.5 border-transparent bg-sidebar-accent/50 text-[13px] focus-visible:border-ring"
          />
        )}
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            className="flex-1 justify-start gap-2 border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent"
            onClick={() => newChatIn(null)}
          >
            <MessageSquarePlus className="size-4 text-primary" />
            New chat
            <kbd className="ml-auto rounded border border-border bg-background/50 px-1 font-mono text-[10px] text-muted-foreground">
              ⌘N
            </kbd>
          </Button>
          <WithTooltip label="Open a project folder">
            <Button
              variant="secondary"
              size="icon"
              className="border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent"
              onClick={() => void openProject()}
              aria-label="Open project"
            >
              <FolderOpen />
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Chats grouped by project */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {activeGroups.length === 0 && archivedGroups.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            {filter
              ? 'No chats match your search.'
              : hiddenGroups.length > 0
                ? 'All projects are hidden. Restore one from the footer.'
                : 'Open a project to get started.'}
          </div>
        )}
        {[
          ...activeGroups.map((g) => ({ group: g, archived: false })),
          ...archivedGroups.map((g) => ({ group: g, archived: true }))
        ].map(({ group, archived }, i) => {
          // Search results always show, even in collapsed projects.
          // Archived projects default to collapsed.
          const isCollapsed =
            !filter && (collapsedProjects[group.cwd] ?? archived)
          const hasStreaming = group.chats.some((c) => (statuses[c.id] ?? 'idle') !== 'idle')
          const firstArchived = archived && i === activeGroups.length
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
              <div className={cn(archived && 'opacity-70')}>
                <ContextMenu>
                  <ContextMenuTrigger
                    render={<div className="group/project flex items-center gap-0.5" />}
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
                          {basename(group.cwd)}
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
                      <WithTooltip label={`New chat in ${basename(group.cwd)}`}>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-5 shrink-0 opacity-0 transition-opacity group-hover/project:opacity-100"
                          onClick={() => newChatIn(group.cwd)}
                          aria-label={`New chat in ${basename(group.cwd)}`}
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
                    {archived ? (
                      <ContextMenuItem onClick={() => setArchived(group.cwd, false)}>
                        <ArchiveRestore /> Unarchive project
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem onClick={() => setArchived(group.cwd, true)}>
                        <Archive /> Archive project
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onClick={() => setHidden(group.cwd, true)}>
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
                    {group.chats.map((chat) => (
                      <ChatItem
                        key={chat.id}
                        chat={chat}
                        active={chat.id === activeId}
                        streaming={(statuses[chat.id] ?? 'idle') !== 'idle'}
                        onOpen={() => void openChat(chat.id)}
                        onRename={() => {
                          setRenameValue(chat.title)
                          setRenaming(chat)
                        }}
                        onDelete={() => setDeleting(chat)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-sidebar-border px-3 py-2">
        {hiddenGroups.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
                  aria-label="Hidden projects"
                >
                  <EyeOff className="size-3.5" />
                  {hiddenGroups.length} hidden
                </Button>
              }
            />
            <DropdownMenuContent align="start" side="top" className="min-w-52">
              <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
                Hidden projects
              </div>
              {hiddenGroups.map((g) => (
                <DropdownMenuItem key={g.cwd} onClick={() => setHidden(g.cwd, false)}>
                  <Eye />
                  <span className="min-w-0 flex-1 truncate">{basename(g.cwd)}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">
                    {g.chats.length}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => hiddenGroups.forEach((g) => setHidden(g.cwd, false))}>
                <ArchiveRestore /> Show all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span />
        )}
        <WithTooltip label="Settings  ⌘,">
          <Button size="icon-sm" variant="ghost" onClick={openSettings} aria-label="Open settings">
            <Settings />
          </Button>
        </WithTooltip>
      </div>

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

      {/* Remove project dialog */}
      <Dialog
        open={removingProject !== null}
        onOpenChange={(open) => !open && setRemovingProject(null)}
      >
        <DialogContent>
          <DialogTitle>Remove “{removingProject ? basename(removingProject.cwd) : ''}”?</DialogTitle>
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

      {/* Delete dialog */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            “{deleting?.title || 'New chat'}” and its history will be removed permanently.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) void deleteChat(deleting.id)
                setDeleting(null)
              }}
            >
              Delete
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

import * as React from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
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
    <div
      className={cn(
        'group relative rounded-md transition-colors',
        active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-[7px] text-left outline-none"
      >
        {streaming && (
          <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-primary" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-sidebar-foreground">
          {chat.title || 'New chat'}
        </span>
        <span
          className={cn(
            'shrink-0 text-[11px] text-muted-foreground/80 transition-opacity group-hover:opacity-0',
            menuOpen && 'opacity-0'
          )}
        >
          {relativeTime(chat.updatedAt)}
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
    </div>
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

  const toggleProject = (cwd: string): void => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [cwd]: !prev[cwd] }
      localStorage.setItem('collapsedProjects', JSON.stringify(next))
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
        {groups.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            {filter ? 'No chats match your search.' : 'Open a project to get started.'}
          </div>
        )}
        {groups.map((group) => {
          // Search results always show, even in collapsed projects.
          const isCollapsed = !filter && Boolean(collapsedProjects[group.cwd])
          const hasStreaming = group.chats.some((c) => (statuses[c.id] ?? 'idle') !== 'idle')
          return (
            <div key={group.cwd} className="mb-1.5">
              <div className="group/project flex items-center gap-0.5 pt-2 pb-0.5">
                <WithTooltip label={group.cwd}>
                  <button
                    type="button"
                    onClick={() => toggleProject(group.cwd)}
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
                      <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-primary" />
                    )}
                  </button>
                </WithTooltip>
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
                <WithTooltip label="Remove project and its chats">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-5 shrink-0 opacity-0 transition-opacity group-hover/project:opacity-100 hover:text-destructive"
                    onClick={() =>
                      setRemovingProject({ cwd: group.cwd, count: group.chats.length })
                    }
                    aria-label={`Remove ${basename(group.cwd)} from sidebar`}
                  >
                    <Trash2 />
                  </Button>
                </WithTooltip>
              </div>
              {!isCollapsed && (
                <div className="ml-[22px] space-y-px">
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

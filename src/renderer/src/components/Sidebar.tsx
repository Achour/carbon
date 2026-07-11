import * as React from 'react'
import {
  Folder,
  FolderOpen,
  MessageSquarePlus,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Sun,
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

function useTheme(): [string, () => void] {
  const [theme, setTheme] = React.useState(
    () => localStorage.getItem('theme') ?? 'dark'
  )
  const toggle = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
    document.documentElement.classList.toggle('dark', next === 'dark')
  }
  return [theme, toggle]
}

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
        'group relative rounded-lg transition-colors',
        active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full min-w-0 px-2.5 py-2 text-left outline-none"
      >
        <div className="flex items-center gap-1.5">
          {streaming && (
            <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-primary" />
          )}
          <span className="truncate text-[13px] font-medium text-sidebar-foreground">
            {chat.title || 'New chat'}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {relativeTime(chat.updatedAt)}
        </div>
      </button>
      <div
        className={cn(
          'absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100',
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

  const [theme, toggleTheme] = useTheme()
  const [filter, setFilter] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null)
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null)
  const [renameValue, setRenameValue] = React.useState('')

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
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out',
        sidebarOpen ? 'w-[264px]' : 'w-0 border-r-0'
      )}
    >
      <div className="flex h-full w-[264px] flex-col">
      {/* Traffic-light strip */}
      <div className="drag h-[52px] shrink-0" />

      {/* Brand + search */}
      <div className="drag flex shrink-0 items-center justify-between pr-2.5 pb-1.5 pl-4">
        <span className="text-[17px] font-semibold tracking-tight text-sidebar-foreground">
          AI GUI
        </span>
        <div className="flex items-center gap-0.5">
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
        {groups.map((group) => (
          <div key={group.cwd} className="mb-1.5">
            <div className="group/project flex items-center gap-1.5 px-2.5 pt-2.5 pb-1">
              <Folder className="size-3 shrink-0 text-muted-foreground/70" />
              <WithTooltip label={group.cwd}>
                <span className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {basename(group.cwd)}
                </span>
              </WithTooltip>
              <div className="flex-1" />
              <WithTooltip label={`New chat in ${basename(group.cwd)}`}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-5 opacity-0 transition-opacity group-hover/project:opacity-100"
                  onClick={() => newChatIn(group.cwd)}
                  aria-label={`New chat in ${basename(group.cwd)}`}
                >
                  <Plus />
                </Button>
              </WithTooltip>
            </div>
            <div className="space-y-0.5">
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
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end border-t border-sidebar-border px-3 py-2">
        <WithTooltip label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
          <Button size="icon-sm" variant="ghost" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun /> : <Moon />}
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
    </aside>
  )
}

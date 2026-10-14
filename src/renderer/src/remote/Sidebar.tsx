import * as React from 'react'
import { Bell, BellOff, ChevronRight, MessageCircleQuestion, MessageSquarePlus, Pin, Plus, Search, X } from 'lucide-react'
import { projectRoot, type ChatMeta } from '@shared/types'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { chatActivity } from '@/lib/chatActivity'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import { navigate } from './App'
import { baseName, chatTitle, listedChats } from './format'
import { PUSH_HINT, usePush } from './push'

/** Rows a project shows before "Show more" — the desktop sidebar's fold. */
const FOLD = 5
const COLLAPSED_KEY = 'carbon.remote.collapsed'

function readCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

/**
 * The desktop sidebar, at thumb size: New chat and Search on top, pinned chats,
 * then each project with its mark and its chats hanging under the name — the
 * same rows, marks and activity glyphs, the open chat lifted on a pill. A chat
 * waiting on an answer is also lifted into "Needs you" above it all: on a phone
 * that is usually why the app was opened.
 */
export function Sidebar({ activeId, onNavigate }: { activeId: string | null; onNavigate: () => void }): React.JSX.Element {
  const chats = useRemote((s) => s.chats)
  const permissions = useRemote((s) => s.permissions)
  const hostname = useRemote((s) => s.hostname)
  const connection = useRemote((s) => s.connection)
  const [query, setQuery] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState<string[]>(readCollapsed)
  const searchInput = React.useRef<HTMLInputElement>(null)

  const go = (hash: string): void => {
    navigate(hash)
    onNavigate()
  }

  const toggle = (root: string): void =>
    setCollapsed((prev) => {
      const next = prev.includes(root) ? prev.filter((r) => r !== root) : [...prev, root]
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        /* per-viewer convenience only */
      }
      return next
    })

  const { waiting, pinned, groups } = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = listedChats(chats).filter(
      (c) => !q || `${c.title} ${baseName(projectRoot(c))}`.toLowerCase().includes(q)
    )
    const asking = (c: ChatMeta): boolean => (permissions[c.id]?.length ?? 0) > 0
    const waiting = all.filter(asking)
    const pinned = all.filter((c) => !asking(c) && c.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!)
    const byProject = new Map<string, { chats: ChatMeta[]; latest: number }>()
    for (const c of all) {
      if (asking(c) || c.pinnedAt) continue
      const root = projectRoot(c)
      const g = byProject.get(root) ?? { chats: [], latest: 0 }
      g.chats.push(c)
      g.latest = Math.max(g.latest, c.updatedAt)
      byProject.set(root, g)
    }
    const groups = [...byProject.entries()].sort((a, b) => b[1].latest - a[1].latest)
    return { waiting, pinned, groups }
  }, [chats, permissions, query])

  const searchingNow = searching || !!query
  const empty = waiting.length === 0 && pinned.length === 0 && groups.length === 0

  return (
    <aside className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 px-2 pt-[calc(env(safe-area-inset-top)+10px)] pb-1">
        <NavRow icon={<MessageSquarePlus />} label="New chat" onClick={() => go('#/')} />
        {searchingNow ? (
          <div className="flex h-11 items-center gap-3 rounded-lg bg-sidebar-accent px-3">
            <Search className="size-[18px] shrink-0 text-muted-foreground" />
            <input
              ref={searchInput}
              autoFocus
              type="search"
              value={query}
              placeholder="Search chats"
              onChange={(e) => setQuery(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={() => {
                setQuery('')
                setSearching(false)
              }}
              className="-mr-1 flex size-8 items-center justify-center rounded-full text-muted-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <NavRow icon={<Search />} label="Search" onClick={() => setSearching(true)} />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-4">
        {waiting.length > 0 && (
          <Section label="Needs you" warn>
            {waiting.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} project />
            ))}
          </Section>
        )}
        {pinned.length > 0 && (
          <Section>
            {pinned.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} pinned />
            ))}
          </Section>
        )}
        {groups.map(([root, g]) => (
          <ProjectGroup
            key={root}
            root={root}
            chats={g.chats}
            activeId={activeId}
            collapsed={!searchingNow && collapsed.includes(root)}
            expanded={searchingNow}
            onToggle={() => toggle(root)}
            onOpen={go}
          />
        ))}
        {empty && (
          <div className="px-6 py-12 text-center text-[14px] text-muted-foreground">
            {query ? 'No chats match.' : 'No chats yet.'}
          </div>
        )}
      </div>

      <div className="relative shrink-0 border-t border-sidebar-border pb-[max(env(safe-area-inset-bottom),12px)] text-[13px] text-muted-foreground">
        <div className="flex items-center gap-2.5 pt-1.5 pr-2 pl-5">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              connection === 'live' ? 'bg-success' : connection === 'down' ? 'bg-warning' : 'bg-muted-foreground/50'
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {connection === 'live' ? hostname || 'Connected' : connection === 'down' ? 'Reconnecting…' : 'Connecting…'}
          </span>
          <NotificationsButton />
        </div>
      </div>
    </aside>
  )
}

/**
 * The bell: turns this phone's notifications on and off. Where they cannot
 * work yet, it is still there, and tapping it says what to do instead.
 */
function NotificationsButton(): React.JSX.Element | null {
  const { state, busy, toggle } = usePush()
  const setError = useRemote((s) => s.setError)
  const [hint, setHint] = React.useState(false)
  React.useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(false), 8000)
    return () => clearTimeout(t)
  }, [hint])
  if (state === 'loading') return <span className="size-10" />
  const on = state === 'on'
  const text = PUSH_HINT[state]
  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-label={on ? 'Turn off notifications' : 'Turn on notifications'}
        aria-pressed={on}
        onClick={() => {
          if (text) return setHint((h) => !h)
          toggle().catch((err) => setError(err instanceof Error ? err.message : String(err)))
        }}
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full active:bg-sidebar-accent disabled:opacity-50',
          on ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {on ? <Bell className="size-[18px] fill-current" /> : <BellOff className="size-[18px]" />}
      </button>
      {hint && text && (
        <div className="absolute inset-x-3 bottom-full z-50 mb-2 animate-in rounded-2xl border border-border bg-popover px-4 py-3 text-[13.5px] leading-snug text-popover-foreground shadow-lg fade-in slide-in-from-bottom-2">
          {text}
        </div>
      )}
    </>
  )
}

function NavRow({ icon, label, onClick }: { icon: React.ReactElement; label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-[15.5px] text-sidebar-foreground active:bg-sidebar-accent [&_svg]:size-[18px] [&_svg]:shrink-0"
    >
      {icon}
      {label}
    </button>
  )
}

function Section({ label, warn, children }: { label?: string; warn?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-3">
      {label && (
        <div className={cn('px-3 pt-1 pb-1 text-[12.5px] font-medium', warn ? 'text-warning' : 'text-muted-foreground')}>
          {label}
        </div>
      )}
      {children}
    </section>
  )
}

function ProjectGroup({
  root,
  chats,
  activeId,
  collapsed,
  expanded,
  onToggle,
  onOpen
}: {
  root: string
  chats: ChatMeta[]
  activeId: string | null
  collapsed: boolean
  /** Searching: every match shows, with no fold. */
  expanded: boolean
  onToggle: () => void
  onOpen: (hash: string) => void
}): React.JSX.Element {
  const icon = useRemote((s) => s.icons[root] ?? null)
  const [more, setMore] = React.useState(false)
  // The open chat always shows, even past the fold.
  const activeIndex = chats.findIndex((c) => c.id === activeId)
  const limit = expanded || more ? chats.length : Math.max(FOLD, activeIndex + 1)
  const shown = chats.slice(0, limit)
  const name = baseName(root)
  return (
    <section className="mb-2">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 active:bg-sidebar-accent"
        >
          <ProjectAvatar root={root} name={name} icon={icon} size="sm" className="size-[18px]" />
          <span className="min-w-0 truncate text-[15px] font-medium">{name}</span>
          {collapsed && <span className="text-[13px] text-muted-foreground tabular-nums">{chats.length}</span>}
        </button>
        <button
          type="button"
          aria-label={`New chat in ${name}`}
          onClick={() => onOpen(`#/new/${encodeURIComponent(root)}`)}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-sidebar-accent"
        >
          <Plus className="size-[18px]" />
        </button>
      </div>
      {!collapsed && (
        <>
          {shown.map((c) => (
            <ChatRow key={c.id} chat={c} active={c.id === activeId} onOpen={onOpen} indent />
          ))}
          {shown.length < chats.length && (
            <button
              type="button"
              onClick={() => setMore(true)}
              className="flex h-9 items-center gap-1.5 pl-[38px] text-[14px] text-muted-foreground"
            >
              <ChevronRight className="size-3.5" /> Show {chats.length - shown.length} more
            </button>
          )}
        </>
      )}
    </section>
  )
}

const ChatRow = React.memo(function ChatRow({
  chat,
  active,
  onOpen,
  indent,
  pinned,
  project
}: {
  chat: ChatMeta
  active: boolean
  onOpen: (hash: string) => void
  indent?: boolean
  pinned?: boolean
  /** Say which project — for rows lifted out of their group. */
  project?: boolean
}) {
  const status = useRemote((s) => s.statuses[chat.id])
  const requests = useRemote((s) => s.permissions[chat.id])
  const activity = chatActivity(status, undefined, requests)
  return (
    <button
      type="button"
      onClick={() => onOpen(`#/c/${encodeURIComponent(chat.id)}`)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg py-2.5 pr-3 text-left transition-colors',
        indent ? 'pl-[38px]' : 'pl-3',
        active ? 'bg-sidebar-accent' : 'active:bg-sidebar-accent/60'
      )}
    >
      {pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[15px] leading-tight',
            active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/60'
          )}
        >
          {chatTitle(chat)}
        </span>
        {project && (
          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{baseName(projectRoot(chat))}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center text-[12.5px] text-muted-foreground/80 tabular-nums">
        {activity.kind === 'needs-input' ? (
          <MessageCircleQuestion className="size-4 text-warning" aria-label={activity.label} />
        ) : activity.kind === 'working' ? (
          <DotSpinner className="text-primary" />
        ) : (
          relativeTime(chat.updatedAt)
        )}
      </span>
    </button>
  )
})

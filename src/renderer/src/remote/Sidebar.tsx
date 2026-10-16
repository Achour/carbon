import * as React from 'react'
import {
  Bell,
  BellOff,
  ChevronRight,
  Folder,
  GitBranch,
  MessageCircleQuestion,
  MessageSquarePlus,
  Pin,
  Plus,
  Search,
  Settings2,
  X
} from 'lucide-react'
import { PROVIDER_LABELS, projectRoot, type ChatMeta } from '@shared/types'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { ProviderMark, PROVIDER_COLOR } from '@/components/ui/provider-mark'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { chatActivity } from '@/lib/chatActivity'
import { relativeTime, shortenPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import { navigate } from './App'
import { baseName, chatTitle, listedChats } from './format'
import { PUSH_HINT, usePush } from './push'
import { SettingsSheet } from './Settings'
import { usePrefs } from './prefs'

/**
 * Rows the detailed sidebar's flat list shows before "Show more" — per batch
 * rather than per project, since that list has no projects to divide by.
 */
const FLAT_BATCH = 40
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
 * then the chats in one of the desktop's two shapes (Settings → Sidebar,
 * `docs/sidebar.md`). Compact hangs each project's chats under its mark and
 * name; detailed is one flat list in the user's order, each row naming its
 * project, branch and backend. Same rows, marks and activity glyphs as the
 * Mac, the open chat lifted on a pill. A chat waiting on an answer is also
 * lifted into "Needs you" above it all: on a phone that is usually why the app
 * was opened.
 */
export function Sidebar({ activeId, onNavigate }: { activeId: string | null; onNavigate: () => void }): React.JSX.Element {
  const chats = useRemote((s) => s.chats)
  const permissions = useRemote((s) => s.permissions)
  const hostname = useRemote((s) => s.hostname)
  const connection = useRemote((s) => s.connection)
  const [query, setQuery] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState<string[]>(readCollapsed)
  const [settings, setSettings] = React.useState(false)
  const detailed = usePrefs((s) => s.sidebarDensity) === 'detailed'
  const [flatShown, setFlatShown] = React.useState(FLAT_BATCH)
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

  const { waiting, pinned, groups, flat } = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = listedChats(chats).filter(
      (c) => !q || `${c.title} ${baseName(projectRoot(c))}`.toLowerCase().includes(q)
    )
    const asking = (c: ChatMeta): boolean => (permissions[c.id]?.length ?? 0) > 0
    const waiting = all.filter(asking)
    const pinned = all.filter((c) => !asking(c) && c.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!)
    const flat = all.filter((c) => !asking(c) && !c.pinnedAt)
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
    return { waiting, pinned, groups, flat }
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
            {waiting.map((c) =>
              detailed ? (
                <DetailedRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} />
              ) : (
                <ChatRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} project />
              )
            )}
          </Section>
        )}
        {pinned.length > 0 && (
          <Section>
            {pinned.map((c) =>
              detailed ? (
                <DetailedRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} />
              ) : (
                <ChatRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} pinned />
              )
            )}
          </Section>
        )}
        {detailed && flat.length > 0 && (
          <Section>
            {/* The open chat always shows, even past the batch. */}
            {flat
              .slice(0, searchingNow ? flat.length : Math.max(flatShown, flat.findIndex((c) => c.id === activeId) + 1))
              .map((c) => (
                <DetailedRow key={c.id} chat={c} active={c.id === activeId} onOpen={go} />
              ))}
            {!searchingNow && flat.length > Math.max(flatShown, flat.findIndex((c) => c.id === activeId) + 1) && (
              <button
                type="button"
                onClick={() => setFlatShown((n) => n + FLAT_BATCH)}
                className="flex h-10 items-center gap-1.5 px-3 text-[14px] text-muted-foreground"
              >
                <ChevronRight className="size-3.5" /> Show more
              </button>
            )}
          </Section>
        )}
        {!detailed && groups.map(([root, g]) => (
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
          <button
            type="button"
            aria-label="Settings"
            onClick={() => {
              // The drawer steps aside, so the chat behind the sheet shows each change.
              setSettings(true)
              onNavigate()
            }}
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-sidebar-accent"
          >
            <Settings2 className="size-[18px]" />
          </button>
        </div>
      </div>
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
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
  const fold = usePrefs((s) => s.chatsPerProject)
  const [more, setMore] = React.useState(false)
  // The open chat always shows, even past the fold.
  const activeIndex = chats.findIndex((c) => c.id === activeId)
  const limit = expanded || more ? chats.length : Math.max(fold, activeIndex + 1)
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

/**
 * A detailed row: the desktop's three lines at thumb size. Context first,
 * small and muted (the project and when), then the title on a line of its
 * own as the row's headline, then where the work happens (the branch, or the
 * folder outside a repo) with the backend's mark at the right edge. Grouping
 * by project would repeat the same folder down the list, so each row names
 * its own.
 */
const DetailedRow = React.memo(function DetailedRow({
  chat,
  active,
  onOpen
}: {
  chat: ChatMeta
  active: boolean
  onOpen: (hash: string) => void
}) {
  const status = useRemote((s) => s.statuses[chat.id])
  const requests = useRemote((s) => s.permissions[chat.id])
  const root = projectRoot(chat)
  const icon = useRemote((s) => s.icons[root] ?? null)
  const home = useRemote((s) => s.home)
  // A worktree carries its branch on the chat itself, so its row is labelled
  // before the branch read lands.
  const branch = useRemote((s) => chat.worktree?.branch ?? s.branches[chat.cwd] ?? null)
  const activity = chatActivity(status, undefined, requests)
  const name = baseName(root)
  return (
    <button
      type="button"
      onClick={() => onOpen(`#/c/${encodeURIComponent(chat.id)}`)}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
        active ? 'bg-sidebar-accent' : 'active:bg-sidebar-accent/60'
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-[12.5px] leading-tight text-muted-foreground">
        <ProjectAvatar root={root} name={name} icon={icon} size="sm" className="size-[18px] rounded-[6px]" />
        <span className="min-w-0 truncate">{name}</span>
        {chat.pinnedAt && <Pin className="size-3 shrink-0" />}
        <span className="ml-auto flex shrink-0 items-center pl-2 text-muted-foreground/80 tabular-nums">
          {activity.kind === 'needs-input' ? (
            <MessageCircleQuestion className="size-4 text-warning" aria-label={activity.label} />
          ) : activity.kind === 'working' ? (
            <DotSpinner className="text-primary" />
          ) : (
            relativeTime(chat.updatedAt)
          )}
        </span>
      </span>
      <span
        className={cn(
          'min-w-0 truncate text-[15.5px] leading-snug',
          active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85'
        )}
      >
        {chatTitle(chat)}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-muted-foreground/70">
        {branch ? <GitBranch className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{branch ?? shortenPath(chat.cwd, home || undefined)}</span>
        <span
          className="ml-auto flex shrink-0 items-center pl-2"
          style={{ color: PROVIDER_COLOR[chat.provider] }}
          aria-label={PROVIDER_LABELS[chat.provider]}
        >
          <ProviderMark provider={chat.provider} className="size-[13px]" />
        </span>
      </span>
    </button>
  )
})

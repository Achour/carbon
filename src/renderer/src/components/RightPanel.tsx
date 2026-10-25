import * as React from 'react'
import {
  Bot,
  ClipboardList,
  Code2,
  Eye,
  FileDiff,
  FileText,
  FolderTree,
  GitCompare,
  Globe,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  PenLine,
  Pin,
  PinOff,
  Plus,
  Search,
  Shapes,
  SquareTerminal,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/lib/fileIcon'
import { CanvasDoc, CanvasPanel } from '@/components/CanvasPanel'
import {
  inActiveThread,
  panelFloats,
  severalChatsShown,
  shownPreviews,
  THREAD_COLUMN_MIN_PX,
  useApp,
  type OpenTab
} from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PlanContent } from '@/components/PlanPanel'
import { AgentsPanel } from '@/components/AgentsPanel'
import { anyRunning, anyRuns, useAgents } from '@/agentsStore'
import { FileViewer, MARKDOWN_RE } from '@/components/FileViewer'
import { FileTree } from '@/components/FileTree'
import { GitPanel } from '@/components/GitPanel'
import { DiffView, FULL_CONTEXT, type ExpandDiff } from '@/components/DiffView'
import { MultiDiffView } from '@/components/MultiDiffView'
import { ReviewBar } from '@/components/ReviewBar'
import { languageForPath } from '@/lib/highlight'
import { BrowserPane } from '@/components/BrowserPane'
import { PanelActionRow, PanelLaunchList, usePanelActions } from '@/components/PanelActions'

/**
 * xterm is ~410 KB and matters only once a terminal tab exists — which for many
 * sessions is never. Preloaded on idle like the editor, so opening a tab does
 * not wait on a fetch.
 */
const TerminalPane = React.lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({
    default: m.TerminalPane
  }))
)


// The drag payload's own type, so the composer's file-drop highlight — which
// keys on `Files` in `dataTransfer.types` — stays dark while a tab crosses it.
const TAB_DRAG_MIME = 'application/x-carbon-tab'

/**
 * A preview tab's icon: the site's own mark where it has one, the globe where
 * it hasn't.
 *
 * Every preview drawing the same globe is what this replaces — with three panes
 * open the strip said "Preview 1/2/3" three times over one glyph. The mark is a
 * `data:` URI resolved by `BrowserPane` from what the guest page declared, so
 * there is nothing to fetch here and nothing to wait for: a tab either has one
 * by the time it draws or does not.
 *
 * The failed URI is held rather than a flag — a tab that navigates on to
 * another site must not stay globed because the last site's bytes didn't
 * decode.
 */
function SiteMark({ uri, inkDark }: { uri?: string; inkDark?: boolean }): React.JSX.Element {
  const [bad, setBad] = React.useState<string | null>(null)
  if (!uri || uri === bad) return <Globe className="size-3.5" />
  return (
    <img
      src={uri}
      alt=""
      aria-hidden
      onError={() => setBad(uri)}
      className={cn(
        'size-3.5 shrink-0 rounded-[2px] object-contain',
        // Dark mode only: on a light ground the mark is already right, and it
        // is the site's own drawing wherever it can be.
        inkDark && 'dark:invert'
      )}
    />
  )
}

function Tab({
  icon,
  label,
  active,
  attention = false,
  preview = false,
  dirty = false,
  busy,
  dragId,
  onReorder,
  onSelect,
  onDoubleClick,
  onClose
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  attention?: boolean
  preview?: boolean
  /** Unsaved edits — the close button becomes a dot until hover. */
  dirty?: boolean
  /** Foreground process name; renders the activity dot when set. */
  busy?: string
  /** Set on a tab that can be dragged into a new position; its identity. */
  dragId?: string
  /** A tab was dropped on this one: put `id` on `side` of it. */
  onReorder?: (id: string, side: 'before' | 'after') => void
  onSelect: () => void
  onDoubleClick?: () => void
  /** Omitted by tabs that are derived state rather than something opened — the
      Agents roster exists exactly while the chat has agents, so there is nothing
      a close button could do that the next spawn would not undo. */
  onClose?: () => void
}): React.JSX.Element {
  // Which edge the dragged tab would land on, drawn as a bar at that edge. Held
  // here rather than in the strip: it is one tab's own hover state.
  const [over, setOver] = React.useState<'before' | 'after' | null>(null)
  const sideOf = (e: React.DragEvent<HTMLDivElement>): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
  }
  const isTabDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)
  return (
    <div
      className={cn(
        'group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1.5 pl-2 text-xs transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      // Middle-click closes, the way every tabbed editor and browser does. Only
      // a tab that *has* a close — the derived one (Agents) ignores it rather
      // than doing something else.
      onAuxClick={(e) => {
        if (e.button === 1 && onClose) {
          e.preventDefault()
          onClose()
        }
      }}
      draggable={dragId !== undefined}
      onDragStart={(e) => {
        if (dragId === undefined) return
        e.dataTransfer.setData(TAB_DRAG_MIME, dragId)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!onReorder || !isTabDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const side = sideOf(e)
        if (side !== over) setOver(side)
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        setOver(null)
        if (!onReorder || !isTabDrag(e)) return
        e.preventDefault()
        const id = e.dataTransfer.getData(TAB_DRAG_MIME)
        if (id && id !== dragId) onReorder(id, sideOf(e))
      }}
      role="tab"
      aria-selected={active}
    >
      {over && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary',
            over === 'before' ? '-left-[3px]' : '-right-[3px]'
          )}
        />
      )}
      <span className={cn(attention && 'text-warning')}>{icon}</span>
      <span className={cn('max-w-36 truncate', preview && 'italic')}>{label}</span>
      {/* One fixed-size slot for everything that can appear at the end of a tab:
          the unsaved dot, the running-process dot, and the close button, which
          sits on top of either and takes over on hover. Sizing the slot rather
          than the contents is what actually keeps the width constant — a bare
          dot next to a `display:none` button made a dirty tab *narrower* than a
          clean one and left the dot crowding the tab's right edge. */}
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {(busy || dirty) && (
          <span
            className={cn(
              'size-1.5 rounded-full group-hover:hidden',
              busy ? 'bg-primary' : 'bg-foreground/70'
            )}
            title={busy ? `${busy} is running` : 'Unsaved changes'}
          />
        )}
        {onClose && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            aria-label={`Close ${label}`}
            className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary"
          >
            <X className="size-3" />
          </button>
        )}
      </span>
    </div>
  )
}

// Keep the panel between these bounds: never narrower than the tab strip +
// tree can bear, never so wide the chat column becomes unusable.
const PANEL_MIN_PX = 448
const CHAT_RESERVED_PX = 480
/**
 * How much of the thread a floating panel leaves uncovered at its widest: enough
 * to see a column's edge and click back into it.
 */
const FLOAT_EXPOSED_PX = 160
/** The preview pop-up over a closed panel: its width range, where it sits, its corners. */
const POPUP_MIN_W = 300
const POPUP_MAX_W = 460
const POPUP_TOP = 52
const POPUP_INSET = 16
const POPUP_RADIUS = 12
const PANEL_TRANSITION_MS = 200

// File-tree dock bounds: never below a readable tree, never so wide the
// viewer disappears.
const DOCK_DEFAULT_PX = 224
const DOCK_MIN_PX = 170
const VIEWER_RESERVED_PX = 260

function PathBar({ entry, cwd }: { entry: OpenTab; cwd: string | null }): React.JSX.Element {
  const rel = entry.diff
    ? entry.diff.file
    : cwd && entry.path.startsWith(`${cwd}/`)
      ? entry.path.slice(cwd.length + 1)
      : entry.path
  const segments = rel.split('/').filter(Boolean)
  const name = segments[segments.length - 1] ?? rel
  const dirs = segments.slice(0, -1)
  const fullPath = entry.diff ? `${entry.diff.cwd}/${entry.diff.file}` : entry.path
  return (
    <div className="flex min-w-0 items-center text-[11px]">
      <WithTooltip label={fullPath}>
        <div className="flex min-w-0 items-center">
          {dirs.length > 0 && (
            <span className="truncate text-muted-foreground/60">{dirs.join('  ›  ')}&ensp;›&ensp;</span>
          )}
          <span className="shrink-0 font-medium text-muted-foreground">{name}</span>
        </div>
      </WithTooltip>
      {entry.diff && (
        <span className="ml-2 shrink-0 rounded bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-500">
          {entry.diff.staged ? 'staged' : 'working tree'}
        </span>
      )}
    </div>
  )
}

/**
 * The "+" button: a quick-open. Type to fuzzy-search files (opens
 * one as a tab), or pick one of the panel's actions (`PanelActions`).
 * This is how you open files regardless of which tab is active, so the file tree
 * never needs to sit beside the browser.
 */
function QuickOpen(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const openFile = useApp((s) => s.openFile)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<{ rel: string; path: string }[]>([])
  const [idx, setIdx] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setIdx(0)
      return
    }
    // Base UI moves focus into the popup; nudge it to the input.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  React.useEffect(() => {
    if (!open || !cwd || !query.trim()) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchFiles(cwd, query.trim()).then((res) => {
        if (alive) {
          setResults(res)
          setIdx(0)
        }
      })
    }, 80)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, open, cwd])

  const pickFile = (r: { rel: string; path: string }): void => {
    void openFile(r.path)
    setOpen(false)
  }

  const actions = usePanelActions()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag shrink-0"
            aria-label="Open a file or tab"
          >
            <Plus />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (results.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIdx((i) => (i + 1) % results.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIdx((i) => (i - 1 + results.length) % results.length)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  pickFile(results[idx])
                }
              }
            }}
            placeholder="Open a file…"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {results.length > 0 ? (
            results.map((r, i) => {
              const name = r.rel.split('/').pop() ?? r.rel
              const dir = r.rel.slice(0, r.rel.length - name.length).replace(/\/$/, '')
              return (
                <button
                  key={r.path}
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => pickFile(r)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    i === idx && 'bg-accent'
                  )}
                >
                  <FileIcon path={r.rel} />
                  <span className="min-w-0 truncate text-xs">
                    <span className="text-foreground">{name}</span>
                    {dir && <span className="ml-1.5 text-muted-foreground/60">{dir}</span>}
                  </span>
                </button>
              )
            })
          ) : query.trim() ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground/60">
              No files match “{query}”.
            </div>
          ) : (
            <>
              {actions.map(({ id, ...a }) => (
                <PanelActionRow key={id} {...a} onDone={() => setOpen(false)} />
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Horizontally-scrolling tab strip with an overlay scrollbar: the native bar is
 * hidden (so it never steals height and shoves the tabs up), and a thin bar
 * fades in over the tabs' bottom edge while scrolling.
 */
function TabScroller({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = React.useState<{
    left: number
    width: number
  } | null>(null)
  const [active, setActive] = React.useState(false)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const update = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const { scrollWidth, clientWidth, scrollLeft } = el
    if (scrollWidth <= clientWidth + 1) {
      setThumb(null)
      return
    }
    setThumb({
      width: (clientWidth / scrollWidth) * clientWidth,
      left: (scrollLeft / scrollWidth) * clientWidth
    })
  }, [])

  React.useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update, children])

  // The scroll hide-timer can outlive the strip (panel closes mid-fade).
  React.useEffect(() => () => clearTimeout(hideTimer.current), [])

  const onScroll = (): void => {
    update()
    setActive(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setActive(false), 900)
  }

  return (
    // Not flex-1: the strip is only as wide as its tabs, so the "+" that follows
    // it sits right after the last tab. It shrinks (min-w-0) and scrolls once the
    // tabs would overflow, which pins the "+" at the strip's end instead of
    // pushing it off-screen.
    <div className="relative flex min-w-0 shrink items-center">
      <div
        ref={ref}
        onScroll={onScroll}
        role="tablist"
        className="no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {thumb && (
        <div
          className={cn(
            'pointer-events-none absolute bottom-0 left-0 h-[3px] rounded-full bg-foreground/25 transition-opacity duration-300',
            active ? 'opacity-100' : 'opacity-0'
          )}
          style={{
            transform: `translateX(${thumb.left}px)`,
            width: thumb.width
          }}
        />
      )}
    </div>
  )
}

/**
 * Shown in the viewer when the panel is open but nothing is: the same list the
 * new-chat rail draws, so opening the panel beside it hands the list over.
 */
function EmptyLauncher(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <PanelLaunchList className="w-full max-w-64" />
    </div>
  )
}

/** The body of an Untitled tab: an inline file picker; choosing one replaces it. */
function UntitledView({ tabPath }: { tabPath: string }): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const openFile = useApp((s) => s.openFile)
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<{ rel: string; path: string }[]>([])
  const [idx, setIdx] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [])

  React.useEffect(() => {
    if (!cwd || !query.trim()) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchFiles(cwd, query.trim()).then((res) => {
        if (alive) {
          setResults(res)
          setIdx(0)
        }
      })
    }, 80)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, cwd])

  const pick = (r: { rel: string; path: string }): void => {
    void openFile(r.path, { replace: tabPath })
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      <FileText className="size-8 text-muted-foreground/30" />
      <p className="text-sm text-muted-foreground">Open a file</p>
      <div className="w-full max-w-sm overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (!results.length) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => (i + 1) % results.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => (i - 1 + results.length) % results.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(results[idx])
              }
            }}
            placeholder="Search files by name…"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        {results.length > 0 && (
          <div className="max-h-64 overflow-y-auto p-1">
            {results.map((r, i) => {
              const name = r.rel.split('/').pop() ?? r.rel
              const dir = r.rel.slice(0, r.rel.length - name.length).replace(/\/$/, '')
              return (
                <button
                  key={r.path}
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => pick(r)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    i === idx && 'bg-accent'
                  )}
                >
                  <FileIcon path={r.rel} />
                  <span className="min-w-0 truncate text-xs">
                    <span className="text-foreground">{name}</span>
                    {dir && <span className="ml-1.5 text-muted-foreground/60">{dir}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function RightPanel(): React.JSX.Element | null {
  const panelOpen = useApp((s) => s.panelOpen)
  const planPanel = useApp((s) => s.planPanel)
  const openFiles = useApp((s) => s.openFiles)
  const fileContents = useApp((s) => s.fileContents)
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const reorderTab = useApp((s) => s.reorderTab)
  const closeFile = useApp((s) => s.closeFile)
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const saveFile = useApp((s) => s.saveFile)
  // Closing a tab with unsaved edits is the one destructive thing the tab strip
  // can do, and the buffer is the only copy — nothing on disk holds it.
  const [confirmClose, setConfirmClose] = React.useState<string | null>(null)
  const requestCloseFile = React.useCallback(
    (path: string): void => {
      if (useApp.getState().dirtyFiles[path]) setConfirmClose(path)
      else closeFile(path)
    },
    [closeFile]
  )
  const promoteTab = useApp((s) => s.promoteTab)
  const closePlanPanel = useApp((s) => s.closePlanPanel)
  const dockOpen = useApp((s) => s.explorerOpen)
  const toggleDock = useApp((s) => s.toggleExplorer)
  const terminals = useApp((s) => s.terminals)
  const terminalBusy = useApp((s) => s.terminalBusy)
  const closeTerminal = useApp((s) => s.closeTerminal)
  const previews = useApp((s) => s.previews)
  // The strip lists this thread's project's previews (`shownPreviews`); every
  // pane stays mounted below, since agents in other chats drive theirs hidden.
  const sideColumns = useApp((s) => s.sideColumns)
  const selectedCwd = useApp((s) => s.selectedCwd)
  const activeChatId = useApp((s) => s.activeId)
  const shown = React.useMemo(
    () => shownPreviews({ previews, selectedCwd, activeId: activeChatId, sideColumns }),
    [previews, selectedCwd, activeChatId, sideColumns]
  )
  // A delegate's pane is named for the agent driving it, so five agents'
  // tabs are not five indistinguishable "Preview N"s.
  const chats = useApp((s) => s.chats)
  const previewLabel = (p: { n: number; owner?: string }): string => {
    const name = p.owner ? chats.find((c) => c.id === p.owner)?.delegation?.name : undefined
    return name ? `Preview · ${name}` : `Preview ${p.n}`
  }
  const closePreview = useApp((s) => s.closePreview)
  // The chat whose agent is driving a preview this turn: the tab's activity dot.
  const previewActivity = useApp((s) => s.previewActivity)
  const driverOf = (paneId: string): string | undefined => {
    const a = previewActivity[paneId]
    if (!a) return undefined
    const chat = chats.find((c) => c.id === a.chatId)
    return (chat?.delegation?.name ?? chat?.title) || 'An agent'
  }
  const diffContents = useApp((s) => s.diffContents)
  const diffWrap = useApp((s) => s.diffWrap)
  const panelMaximized = useApp((s) => s.panelMaximized)
  const togglePanelMaximized = useApp((s) => s.togglePanelMaximized)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const togglePanel = useApp((s) => s.togglePanel)
  const togglePanelFloating = useApp((s) => s.togglePanelFloating)
  // Floating is for several chats on screen, where docking takes the width two
  // of them need. One conversation on screen — a single chat, or one column
  // expanded — has that width to spare, so the panel docks beside it whatever
  // the setting says, and the pin that would float it is not offered.
  const severalChats = useApp(severalChatsShown)
  const floating = useApp(panelFloats)
  // Docked, the panel leaves the thread room for its chats: one column's worth
  // for one conversation, two side by side for several.
  const chatReserve = severalChats ? 2 * THREAD_COLUMN_MIN_PX : CHAT_RESERVED_PX
  const hasSuggestions = useApp((s) => {
    if (!s.planPanel?.requestId) return false
    return (s.permissions[s.planPanel.chatId] ?? []).some(
      (r) => r.id === s.planPanel!.requestId && r.hasSuggestions
    )
  })
  // Keep terminals and previews mounted until the closing width transition
  // finishes, then release them just as the previous conditional render did.
  const [contentsMounted, setContentsMounted] = React.useState(panelOpen)
  React.useEffect(() => {
    if (panelOpen) {
      setContentsMounted(true)
      return undefined
    }
    const timer = window.setTimeout(() => setContentsMounted(false), PANEL_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [panelOpen])
  // What the panel shows lives and dies with it; preview tabs outlive a close.
  // The agent drives its pane whether or not the panel is open, and a pane that
  // only existed while it was open forced each `preview_*` call to reopen it —
  // the panel sliding back over the chat the user had just closed it to read.
  // So a closed panel keeps its previews mounted (`parked`, below), and the
  // user's close sticks.
  const showViewer = panelOpen || contentsMounted
  const showContents = showViewer || previews.length > 0

  // Markdown preview vs source; the choice sticks across files.
  const [mdMode, setMdMode] = React.useState<'preview' | 'source'>('preview')

  const [dockWidth, setDockWidth] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem('rightDockWidth'))
    return Number.isFinite(saved) && saved >= DOCK_MIN_PX ? saved : DOCK_DEFAULT_PX
  })
  const dockDraggingRef = React.useRef(false)

  const onDockPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dockDraggingRef.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events have no active pointer to capture
    }
  }

  const onDockPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dockDraggingRef.current) return
    const aside = e.currentTarget.closest('aside')
    if (!aside) return
    const rect = aside.getBoundingClientRect()
    const next = Math.round(rect.right - e.clientX)
    setDockWidth(Math.max(DOCK_MIN_PX, Math.min(next, Math.round(rect.width) - VIEWER_RESERVED_PX)))
  }

  const onDockPointerUp = (): void => {
    if (!dockDraggingRef.current) return
    dockDraggingRef.current = false
    setDockWidth((w) => {
      localStorage.setItem('rightDockWidth', String(w))
      return w
    })
  }

  const resetDockWidth = (): void => {
    dockDraggingRef.current = false
    setDockWidth(DOCK_DEFAULT_PX)
    localStorage.removeItem('rightDockWidth')
  }

  // 0 = default width (52%); anything else is a user-dragged pixel width.
  const [width, setWidth] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem('rightPanelWidth'))
    return Number.isFinite(saved) && saved >= PANEL_MIN_PX ? saved : 0
  })
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
    const panel = e.currentTarget.closest<HTMLElement>('[data-right-panel]')
    const rect = panel?.getBoundingClientRect()
    const next = Math.round((rect?.right ?? window.innerWidth) - e.clientX)
    // The same cap the render applies (`room`), so a drag stops exactly where
    // the panel would be clamped anyway.
    setWidth(Math.max(PANEL_MIN_PX, Math.min(next, room ?? Infinity)))
  }

  const onHandlePointerUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    setWidth((w) => {
      if (w) localStorage.setItem('rightPanelWidth', String(w))
      return w
    })
  }

  const resetWidth = (): void => {
    draggingRef.current = false
    setDragging(false)
    setWidth(0)
    localStorage.removeItem('rightPanelWidth')
  }

  // The plan belongs to whichever column opened it. Gated on `activeId` alone,
  // a side chat entering plan mode set `activeTab: 'plan'` for a tab the strip
  // refused to show — so the plan appeared nowhere.
  const showPlan = useApp((s) => s.planPanel !== null && inActiveThread(s, s.planPanel.chatId))
  // The Agents tab is a property of the chat: it exists exactly while the chat
  // has spawned something. It is never auto-selected — a spawn mid-read would
  // otherwise take the file you are looking at off screen — so the way in is the
  // activity bar above the composer, or the tab itself.
  // Any chat in the thread: the tab is the way into every column's roster, and
  // which one it shows is `AgentsPanel`'s question.
  const showAgents = useAgents(anyRuns)
  const agentsRunning = useAgents(anyRunning)
  // Browse mode's tab: opened state, so it survives being left. See `filesTab`.
  const filesTab = useApp((s) => s.filesTab)
  const closeFilesTab = useApp((s) => s.closeFilesTab)
  // The Canvas library exists exactly while it is the active tab. It was
  // pinned for as long as the project had a canvas, which
  // made it the one tab in the strip with no close: a project keeps its
  // documents for good, so the library sat beside a dozen file tabs with no
  // way to give its space back. The ways in are the + menu, the launcher and
  // the List button in an open document's header, none of which needs the tab
  // to be standing already.
  const canvasTabs = useApp((s) => s.canvasTabs)
  const canvasList = useApp((s) => s.canvases)
  const closeCanvas = useApp((s) => s.closeCanvas)
  const showCanvas = activeTab === 'canvas'
  const current =
    activeTab === 'files' && filesTab
      ? 'files'
      : terminals.some((t) => t.id === activeTab)
      ? activeTab!
      : shown.some((p) => p.id === activeTab)
        ? activeTab!
        : activeTab === 'plan' && showPlan
          ? 'plan'
          : activeTab === 'agents' && showAgents
          ? 'agents'
          : activeTab === 'canvas' && showCanvas
          ? 'canvas'
          : canvasTabs.some((id) => `canvas:${id}` === activeTab)
          ? activeTab!
          : openFiles.some((f) => f.path === activeTab)
            ? activeTab!
            : showPlan
              ? 'plan'
              : (openFiles[openFiles.length - 1]?.path ??
                shown[shown.length - 1]?.id ??
                terminals[terminals.length - 1]?.id ??
                // Browse mode is last, but it is still a tab: with it standing
                // in the strip and nothing else open, falling through to `null`
                // would draw the launcher's "nothing is open" under it.
                (filesTab ? 'files' : null))
  const currentIsTerminal = terminals.some((t) => t.id === current)
  const currentIsPreview = shown.some((p) => p.id === current)
  const currentIsChanges = typeof current === 'string' && current.startsWith('changes:')
  const currentIsPlan = current === 'plan'
  const currentIsAgents = current === 'agents'
  const currentIsCanvas = current === 'canvas'
  // `canvas:<id>` — one open document. Its own tab rather than a mode of the
  // list, because two canvases are read side by side.
  const currentCanvasId =
    typeof current === 'string' && current.startsWith('canvas:') ? current.slice(7) : null
  const activeEntry = openFiles.find((f) => f.path === current)
  // A diff tab can open its own folds — same re-fetch the stacked review uses.
  const diffMeta = activeEntry?.diff
  const diffExpand = React.useMemo<ExpandDiff | undefined>(() => {
    // An untracked file's diff is its whole content already; nothing is folded.
    if (!diffMeta || diffMeta.untracked) return undefined
    const { cwd, file, staged, base } = diffMeta
    return () =>
      window.api.gitDiff(cwd, {
        path: file,
        staged,
        base,
        context: FULL_CONTEXT
      })
  }, [diffMeta])
  const activeIsMarkdown = !!activeEntry && !activeEntry.diff && MARKDOWN_RE.test(activeEntry.name)
  const isUntitled = !!activeEntry?.untitled
  // Nothing open at all → show the launcher (vs. `current === 'files'`, which is
  // browse mode with the tree docked).
  const isEmpty = current === null
  // Terminal, preview and the stacked-changes tab each carry their own toolbar;
  // the plan has no path to show and docks no tree to toggle.
  const showBreadcrumb =
    !currentIsPlan &&
    !currentIsAgents &&
    !currentIsCanvas &&
    !currentCanvasId &&
    !currentIsTerminal &&
    !currentIsPreview &&
    !currentIsChanges &&
    !isEmpty &&
    !isUntitled
  // ⌘W. What "close" means is decided here, where `current` is resolved and
  // where the unsaved-edits question lives — a file tab goes through
  // `requestCloseFile`, so ⌘W on a dirty buffer asks the same question the ✕
  // does rather than discarding silently. The Agents roster has no close (it
  // is derived state) and so ⌘W is a no-op on it; anything else closes, and
  // with nothing open the window does, which
  // is what the key used to mean unconditionally. Everything is read through a
  // ref so the effect keys on the tick alone: `current` in its deps would run
  // the close on every tab switch.
  const closeTabTick = useApp((s) => s.closeTabTick)
  const closeCurrent = React.useRef<() => void>(() => {})
  closeCurrent.current = () => {
    if (!panelOpen || current === null) {
      void window.api.closeWindow()
      return
    }
    if (current === 'files') closeFilesTab()
    else if (current === 'canvas') setActiveTab(null)
    else if (current === 'plan') closePlanPanel()
    else if (currentCanvasId) closeCanvas(currentCanvasId)
    else if (currentIsTerminal) closeTerminal(current)
    else if (currentIsPreview) closePreview(current)
    else if (activeEntry) requestCloseFile(current)
  }
  const handledTick = React.useRef(closeTabTick)
  React.useEffect(() => {
    if (handledTick.current === closeTabTick) return
    handledTick.current = closeTabTick
    closeCurrent.current()
  }, [closeTabTick])

  // How wide the panel may be without pushing past the window: the content
  // pane's width (`avail`), less what the chats keep (`reserve`). Measured off
  // the parent
  // rather than written as `100vw - reserved`, which forgot the sidebar to the
  // chat's left — at a 1008px window the cap came out *wider* than the space
  // it was capping, the chat held its own minimum, and the panel's right half
  // ran off the edge of the window with the launcher tiles cut in two.
  const asideRef = React.useRef<HTMLElement>(null)
  const [avail, setAvail] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    const parent = asideRef.current?.parentElement
    if (!parent) return
    const measure = (): void => setAvail(Math.round(parent.getBoundingClientRect().width))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])
  // The floor yields before the window does: a panel narrower than its
  // minimum is still a panel, where one that overflows the window is not.
  // Docked, the chat column's reservation comes off the top; floating, only a
  // strip of the chats has to stay visible beside it.
  const reserve = floating ? FLOAT_EXPOSED_PX : chatReserve
  const room = avail === null ? null : Math.max(0, avail - reserve)
  const minPx = room === null ? PANEL_MIN_PX : Math.min(PANEL_MIN_PX, room)
  const cap = room === null ? `calc(100vw - ${reserve}px)` : `${room}px`
  // Same default either way: floating and docked are one panel in two places,
  // and pinning should not change its size.
  const targetWidth = width ? `min(${width}px, ${cap})` : `min(52%, ${cap})`
  // Closed with previews alive: the contents are taken out of the shut aside
  // and laid at the width the panel would open to — in the window, unclipped
  // and fully transparent, inert to the pointer. A guest clipped to nothing or
  // pushed off-screen is throttled as hidden: its capture never resolves and
  // input sent to it goes nowhere (measured), and at the panel's minimum the
  // agent would test a page reflowed narrower than the one the user sees.
  const parked = !showViewer && previews.length > 0 && !panelMaximized
  const parkedWidth = Math.max(
    minPx,
    Math.round(Math.min(width || (avail ?? PANEL_MIN_PX) * 0.52, room ?? Infinity))
  )

  // **The pop-up.** While the panel is closed and a chat on screen has its
  // agent in a preview, that pane is shown small in the corner, until the turn
  // ends or the user hides it. It is the parked contents themselves, scaled
  // and cropped to the page — a `<webview>` moved to another parent reloads,
  // and a child cannot escape the parked layer's `opacity: 0` — so the page
  // keeps the exact size the agent has been testing at and never reflows.
  const popupPane = useApp((s) => {
    for (const [id, a] of Object.entries(s.previewActivity)) {
      if (!a.hidden && inActiveThread(s, a.chatId) && s.previews.some((p) => p.id === id)) return id
    }
    return null
  })
  const hidePreviewPopup = useApp((s) => s.hidePreviewPopup)
  const popup = parked ? popupPane : null
  const contentsRef = React.useRef<HTMLDivElement>(null)
  // The parked layer's size and where the pane's page sits in it, in layout px
  // (transforms aside), so the crop and the scale are exact. The page is the
  // pane's frame: the whole stage when it fills, the device when a preset is
  // set — cropping to the stage put a small device in a field of backdrop.
  const [popGeo, setPopGeo] = React.useState<{
    w: number
    h: number
    left: number
    top: number
    frameW: number
    frameH: number
    device: boolean
  } | null>(null)
  React.useLayoutEffect(() => {
    if (!popup) {
      setPopGeo(null)
      return
    }
    const box = contentsRef.current
    const frame = box?.querySelector<HTMLElement>(`[data-preview-pane="${CSS.escape(popup)}"] [data-preview-frame]`)
    if (!box || !frame) return
    const measure = (): void => {
      let left = 0
      let top = 0
      for (let el: HTMLElement | null = frame; el && el !== box; el = el.offsetParent as HTMLElement | null) {
        left += el.offsetLeft
        top += el.offsetTop
      }
      const next = {
        w: box.offsetWidth,
        h: box.offsetHeight,
        left,
        top,
        frameW: frame.offsetWidth,
        frameH: frame.offsetHeight,
        device: frame.dataset.previewFrame === 'device'
      }
      setPopGeo((g) =>
        g && (Object.keys(next) as (keyof typeof next)[]).every((k) => g[k] === next[k]) ? g : next
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    ro.observe(frame)
    const mo = new MutationObserver(measure)
    mo.observe(frame, { attributes: true, attributeFilter: ['data-preview-frame', 'style'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [popup])
  const pop =
    popup && popGeo && popGeo.frameW > 0 && popGeo.frameH > 0
      ? (() => {
          const maxW = Math.round(Math.max(POPUP_MIN_W, Math.min(POPUP_MAX_W, (avail ?? POPUP_MAX_W) * 0.34)))
          const maxH = popGeo.h * 0.56
          // A filled page is scaled to the card's width and cropped, not
          // squeezed, past a little over half the window's height. A device is
          // shown whole — its outline is the point of picking one — so a
          // phone makes a narrow card rather than a cropped one.
          const scale = popGeo.device
            ? Math.min(maxW / popGeo.frameW, maxH / popGeo.frameH)
            : maxW / popGeo.frameW
          const w = Math.round(popGeo.frameW * scale)
          const h = Math.round(Math.min(popGeo.frameH * scale, maxH))
          const right = popGeo.w - popGeo.left - popGeo.frameW
          const radius = POPUP_RADIUS / scale
          // Floating, the shut aside sits one panel width (plus its gap) off
          // the right edge; the pop-up undoes that, as the parked layer does.
          const undo = floating ? `translateX(calc(-${popGeo.w}px - 2rem))` : undefined
          return {
            card: { top: POPUP_TOP, right: POPUP_INSET, width: w, height: h, transform: undo } satisfies React.CSSProperties,
            layer: {
              transform: `${floating ? 'translateX(calc(-100% - 2rem)) ' : ''}translate(${right * scale - POPUP_INSET}px, ${POPUP_TOP - popGeo.top * scale}px) scale(${scale})`,
              transformOrigin: 'top right',
              clipPath: `inset(${popGeo.top}px ${right}px ${popGeo.h - popGeo.top - h / scale}px ${popGeo.left}px round ${radius}px)`
            } satisfies React.CSSProperties
          }
        })()
      : null
  const openPopup = (): void => {
    if (!popup) return
    setActiveTab(popup)
    if (!panelOpen) togglePanel()
  }

  return (
    <aside
      ref={asideRef}
      data-right-panel
      data-floating={floating || undefined}
      aria-hidden={!panelOpen && !pop}
      style={
        panelMaximized
          ? undefined
          : // A floating panel slides out at full width; a docked one collapses.
            {
              width: floating || panelOpen ? targetWidth : 0,
              minWidth: floating || panelOpen ? `${minPx}px` : 0
            }
      }
      className={cn(
        floating
          ? // The docked panel's own geometry laid over the chats: it slides
            // rather than growing, so the chats beneath never reflow.
            'absolute inset-y-0 right-0 z-30 overflow-hidden bg-background shadow-2xl shadow-black/30 dark:shadow-black/70'
          : 'relative h-full overflow-hidden bg-background',
        parked && 'overflow-visible',
        !dragging &&
          (floating
            ? 'transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none'
            : 'transition-[width,min-width] duration-200 ease-out'),
        floating && !panelOpen && 'translate-x-[calc(100%+2rem)]',
        floating && !panelOpen && !pop && 'opacity-0',
        pop && !floating && 'z-40',
        !panelOpen && 'pointer-events-none',
        // Not shrink-0: when space runs out the panel yields before the chat
        // column (which has its own min-width) gets crushed.
        panelMaximized && 'flex-1'
      )}
    >
      {/* The contents keep the panel's open width while the aside animates
          shut, so a diff view is clipped by the slide rather than reflowed on
          every frame of it. That floor is the *same* floor the aside has —
          spelled as a fixed 28rem it exceeded a panel that had already
          yielded, and the overflow was hidden past the panel's own edge. */}
      {pop && (
        // The pop-up is three layers in one rectangle: this card beneath (its
        // shadow, and a surface while the page paints), the page itself — the
        // parked layer below, scaled and cropped — and the controls over both.
        <div
          aria-hidden
          style={pop.card}
          className="absolute rounded-xl bg-card shadow-[0_24px_60px_-16px_rgb(0_0_0/0.55),0_4px_14px_-6px_rgb(0_0_0/0.3)] transition-opacity duration-200 starting:opacity-0"
        />
      )}
      {showContents && (
      <div
        ref={contentsRef}
        style={
          panelMaximized
            ? undefined
            : parked
              ? {
                  ...(floating
                    ? // Undo the aside's own slide; its opacity-0 still applies.
                      { transform: 'translateX(calc(-100% - 2rem))' }
                    : { position: 'absolute', insetBlock: 0, right: 0, width: `${parkedWidth}px` }),
                  ...(pop?.layer ?? {})
                }
              : { minWidth: `${minPx}px` }
        }
        className={cn(
          'relative flex h-full w-full flex-col border-l border-border bg-card/30',
          // `invisible` as well as transparent: opacity leaves the tab strip's
          // no-drag holes punched in the title bar and its buttons in the Tab
          // order. The pane under it still exposes itself (`expose`).
          parked && 'pointer-events-none',
          parked && (pop ? 'transition-opacity duration-200' : 'invisible opacity-0')
        )}
      >
      {/* Resize handle — drag to resize, double-click to reset */}
      {!panelMaximized && (
        <div
          data-resize-handle
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onLostPointerCapture={onHandlePointerUp}
          onDoubleClick={resetWidth}
          className="no-drag absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
        />
      )}
      {/* Tab strip */}
      <header
        className={cn(
          'drag flex h-[38px] shrink-0 items-center gap-1 px-2.5',
          panelMaximized && !sidebarOpen && 'pl-[84px]'
        )}
      >
        {panelMaximized && !sidebarOpen && (
          <WithTooltip label="Show sidebar  ⌘B">
            <Button
              size="icon-sm"
              variant="ghost"
              className="no-drag shrink-0"
              aria-label="Show sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <TabScroller>
          {showPlan && planPanel && (
            <Tab
              icon={<ClipboardList className="size-3.5" />}
              label="Plan"
              active={current === 'plan'}
              attention={planPanel.requestId !== null}
              onSelect={() => setActiveTab('plan')}
              onClose={closePlanPanel}
            />
          )}
          {showAgents && (
            <Tab
              icon={<Bot className="size-3.5" />}
              label="Agents"
              active={current === 'agents'}
              busy={agentsRunning ? 'Agent' : undefined}
              onSelect={() => setActiveTab('agents')}
            />
          )}
          {showCanvas && (
            <Tab
              icon={<Shapes className="size-3.5" />}
              label="Canvas"
              active={current === 'canvas'}
              onSelect={() => setActiveTab('canvas')}
              onClose={() => setActiveTab(null)}
            />
          )}
          {/* Browse mode — the tree docked with nothing selected. It is a state
              the user chose from the launcher or the + menu, so it gets a tab
              like anything else opened, and the tab is what lets it be left:
              without one the panel showed a docked tree under an empty pane
              with no strip entry and no close. Drawn off `filesTab` rather than
              off `activeTab === 'files'`: derived, it closed itself on the way
              to any other tab, so opening a file — or glancing at the Working
              Tree — silently ended browsing. Now it is left and returned to
              like every other tab, and only the ✕ (or ⌘W) closes it. */}
          {filesTab && (
            <Tab
              icon={<FolderTree className="size-3.5" />}
              label="Files"
              active={current === 'files'}
              onSelect={() => setActiveTab('files')}
              onClose={closeFilesTab}
            />
          )}
          {canvasTabs.map((id) => (
            <Tab
              key={id}
              icon={<PenLine className="size-3.5" />}
              label={canvasList.find((c) => c.id === id)?.title ?? 'Canvas'}
              active={current === `canvas:${id}`}
              dragId={id}
              onReorder={(from, side) => reorderTab(from, id, side)}
              onSelect={() => setActiveTab(`canvas:${id}`)}
              onClose={() => closeCanvas(id)}
            />
          ))}
          {openFiles.map((file) => (
            <Tab
              key={file.path}
              icon={
                file.path.startsWith('changes:') ? (
                  <GitCompare className="size-3.5 text-primary" />
                ) : file.diff ? (
                  <FileDiff className="size-3.5 text-amber-500" />
                ) : (
                  <FileIcon path={file.name} />
                )
              }
              label={file.name}
              active={current === file.path}
              preview={file.preview}
              dirty={!!dirtyFiles[file.path]}
              dragId={file.path}
              onReorder={(from, side) => reorderTab(from, file.path, side)}
              onSelect={() => setActiveTab(file.path)}
              onDoubleClick={file.preview ? () => promoteTab(file.path) : undefined}
              onClose={() => requestCloseFile(file.path)}
            />
          ))}
          {terminals.map((t) => (
            <Tab
              key={t.id}
              icon={<SquareTerminal className="size-3.5" />}
              label={t.label ?? `Terminal ${t.n}`}
              active={current === t.id}
              busy={terminalBusy[t.id]}
              dragId={t.id}
              onReorder={(from, side) => reorderTab(from, t.id, side)}
              onSelect={() => setActiveTab(t.id)}
              onClose={() => closeTerminal(t.id)}
            />
          ))}
          {shown.map((p) => (
            <Tab
              key={p.id}
              icon={<SiteMark uri={p.favicon} inkDark={p.faviconInkDark} />}
              label={previewLabel(p)}
              active={current === p.id}
              busy={driverOf(p.id)}
              dragId={p.id}
              onReorder={(from, side) => reorderTab(from, p.id, side)}
              onSelect={() => setActiveTab(p.id)}
              onClose={() => closePreview(p.id)}
            />
          ))}
        </TabScroller>
        <QuickOpen />
        {/* Pushes the panel controls to the far right; collapses to 0 when the
            tab strip fills the width, so "+" pins beside these controls. */}
        <div className="min-w-2 flex-1" />
        {/* Only where there is a choice: beside one conversation the panel
            always docks, and a toggle there would do nothing. */}
        {!panelMaximized && severalChats && (
          <WithTooltip label={floating ? 'Pin beside the chats' : 'Float over the chats'}>
            <Button
              size="icon-sm"
              variant="ghost"
              className="no-drag shrink-0"
              aria-label={floating ? 'Pin panel beside the chats' : 'Float panel over the chats'}
              aria-pressed={!floating}
              onClick={togglePanelFloating}
            >
              {floating ? <Pin /> : <PinOff />}
            </Button>
          </WithTooltip>
        )}
        <WithTooltip label={panelMaximized ? 'Restore panel' : 'Maximize panel'}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag shrink-0"
            aria-label={panelMaximized ? 'Restore panel' : 'Maximize panel'}
            onClick={togglePanelMaximized}
          >
            {panelMaximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </WithTooltip>
        <WithTooltip label="Hide panel">
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag shrink-0"
            aria-label="Hide panel"
            onClick={togglePanel}
          >
            <PanelRight />
          </Button>
        </WithTooltip>
      </header>

      {/* The review's own bar, spanning the diffs *and* the dock beside them —
          so the panel has one strip across the top rather than one per column. */}
      {currentIsChanges && selectedCwd && <ReviewBar cwd={selectedCwd} />}

      {/* Breadcrumb row with the file-tree toggle at its right. */}
      {showBreadcrumb && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
          <div className="min-w-0 flex-1">
            {activeEntry && <PathBar entry={activeEntry} cwd={selectedCwd} />}
          </div>
          {activeIsMarkdown && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
              {(['preview', 'source'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMdMode(m)}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize transition-colors [&_svg]:size-3',
                    mdMode === m
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {m === 'preview' ? <Eye /> : <Code2 />}
                  {m}
                </button>
              ))}
            </div>
          )}
          <WithTooltip label={dockOpen ? 'Hide file tree' : 'Show file tree'}>
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn('no-drag shrink-0', dockOpen && 'bg-accent text-foreground')}
              aria-label={dockOpen ? 'Hide file tree' : 'Show file tree'}
              aria-pressed={dockOpen}
              onClick={toggleDock}
            >
              <FolderTree />
            </Button>
          </WithTooltip>
        </div>
      )}

      {/* Viewer + file tree / source control docked on the right */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {showViewer && (
          <div
            id="editor-find-scope"
            className={cn(
              'min-h-0 flex-1',
              (currentIsTerminal || currentIsPreview) && 'hidden'
            )}
          >
            {current === 'plan' && planPanel ? (
              <PlanContent panel={planPanel} hasSuggestions={hasSuggestions} />
            ) : currentIsAgents ? (
              <AgentsPanel />
            ) : currentIsCanvas ? (
              <CanvasPanel />
            ) : currentCanvasId ? (
              <CanvasDoc id={currentCanvasId} />
            ) : currentIsChanges && selectedCwd ? (
              <MultiDiffView cwd={selectedCwd} />
            ) : activeEntry?.diff ? (
              <DiffView
                text={diffContents[current!]}
                language={languageForPath(activeEntry.diff.file)}
                wrap={diffWrap}
                expand={diffExpand}
              />
            ) : isUntitled ? (
              <UntitledView tabPath={current!} />
            ) : activeEntry ? (
              <FileViewer
                content={fileContents[current!]}
                name={activeEntry.name}
                path={current!}
                cwd={selectedCwd}
                mode={mdMode}
              />
            ) : isEmpty ? (
              <EmptyLauncher />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Select a file from the tree
              </div>
            )}
          </div>
          )}
          {/* Each terminal stays mounted while its tab exists so scrollback
              survives switching tabs; hidden (not unmounted) when not active. */}
          {showViewer && terminals.map((t) => (
            <div
              key={t.id}
              className={cn(
                'absolute inset-0',
                current !== t.id && 'invisible pointer-events-none'
              )}
            >
              <React.Suspense fallback={null}>
                <TerminalPane id={t.id} active={current === t.id} />
              </React.Suspense>
            </div>
          ))}
          {/* Every preview stays mounted while its tab exists, like a browser's
              background tabs: history, scroll, form state and the agent's
              handle on the page survive a tab switch. A hidden guest is
              throttled the way a background tab is — measured: timers drop to
              ~1/s and requestAnimationFrame stops — so a background preview
              costs no frames. `visibility`, not `display:none`, which reloads
              a <webview> when it comes back. While the panel is closed every
              pane is hidden; the agent exposes one for the input it sends
              (`expose` in BrowserPane). */}
          {previews.map((p) => (
            <div
              key={p.id}
              data-preview-pane={p.id}
              className={cn(
                'absolute inset-0',
                (current !== p.id || !showViewer) && !(pop && popup === p.id) && 'invisible pointer-events-none'
              )}
            >
              <BrowserPane id={p.id} active={current === p.id} cwd={p.cwd} popup={!!pop && popup === p.id} />
            </div>
          ))}
        </div>
        {showViewer &&
          dockOpen &&
          !isEmpty &&
          !currentIsPlan &&
          !currentIsAgents &&
          !currentIsCanvas &&
          !currentCanvasId &&
          !currentIsTerminal &&
          !currentIsPreview && (
        <div
          data-right-dock
          style={{ width: `min(${dockWidth}px, calc(100% - ${VIEWER_RESERVED_PX}px))` }}
          className="relative flex shrink-0 flex-col border-l border-border bg-card/40"
        >
          {/* Resize handle — drag to resize, double-click to reset */}
          <div
            data-dock-resize
            onPointerDown={onDockPointerDown}
            onPointerMove={onDockPointerMove}
            onPointerUp={onDockPointerUp}
            onLostPointerCapture={onDockPointerUp}
            onDoubleClick={resetDockWidth}
            className="no-drag absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
          />
          {/* The dock follows the active tab: the changes tree
              while reviewing the Working Tree, the project file tree otherwise. */}
          {currentIsChanges ? <GitPanel /> : <FileTree />}
        </div>
        )}
      </div>
      </div>
      )}
      {pop && (
        // Over the page and inert to it: a click into a page the agent is
        // driving would race the agent's own input, so the card's body opens
        // the panel instead, and the two controls show on hover.
        <div
          style={pop.card}
          className="group pointer-events-auto absolute rounded-xl ring-1 ring-black/10 ring-inset transition-opacity duration-200 starting:opacity-0 dark:ring-white/12"
        >
          <button
            type="button"
            aria-label="Open the preview in the panel"
            className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={openPopup}
          />
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <WithTooltip label="Open in the panel">
              <button
                type="button"
                aria-label="Open in the panel"
                onClick={openPopup}
                className="grid size-6 place-items-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-md transition-colors hover:bg-black/75 [&_svg]:size-3"
              >
                <Maximize2 />
              </button>
            </WithTooltip>
            <WithTooltip label="Hide until this turn ends">
              <button
                type="button"
                aria-label="Hide"
                onClick={() => hidePreviewPopup(popup!)}
                className="grid size-6 place-items-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-md transition-colors hover:bg-black/75 [&_svg]:size-3"
              >
                <X />
              </button>
            </WithTooltip>
          </div>
        </div>
      )}

      {/* Unsaved edits live only in the CodeMirror buffer — closing the tab is
          what destroys them, so this is where the question belongs. Save keeps
          the ladder short: the common answer is "yes, keep it". */}
      <Dialog open={confirmClose !== null} onOpenChange={(open) => !open && setConfirmClose(null)}>
        <DialogContent>
          <DialogTitle>
            Save changes to “{openFiles.find((f) => f.path === confirmClose)?.name}”?
          </DialogTitle>
          <DialogDescription>
            This file has edits that have not been written to disk. Closing the tab discards them.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmClose(null)}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (confirmClose) closeFile(confirmClose)
                setConfirmClose(null)
              }}
            >
              Discard
            </Button>
            <Button
              onClick={() => {
                const path = confirmClose
                setConfirmClose(null)
                if (!path) return
                void saveFile(path).then(() => {
                  // A conflict means the save did not land; leaving the tab open
                  // is what lets the user answer the bar instead of losing the
                  // edits to a close they thought had saved them.
                  if (!useApp.getState().fileConflicts[path]) closeFile(path)
                })
              }}
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

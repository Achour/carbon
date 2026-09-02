import * as React from 'react'
import {
  Bot,
  ClipboardList,
  Code2,
  Eye,
  FileDiff,
  FileText,
  FolderTree,
  GitBranch,
  GitCompare,
  Globe,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  PenLine,
  Plus,
  Search,
  Shapes,
  SquareTerminal,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/lib/fileIcon'
import { CanvasDoc, CanvasPanel } from '@/components/CanvasPanel'
import { useApp, type OpenTab } from '@/store'
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
import { useAgents } from '@/agentsStore'
import { FileViewer, MARKDOWN_RE } from '@/components/FileViewer'
import { FileTree } from '@/components/FileTree'
import { GitPanel } from '@/components/GitPanel'
import { DiffView, FULL_CONTEXT, type ExpandDiff } from '@/components/DiffView'
import { MultiDiffView } from '@/components/MultiDiffView'
import { ReviewBar } from '@/components/ReviewBar'
import { languageForPath } from '@/lib/highlight'
import { BrowserPane } from '@/components/BrowserPane'

/**
 * xterm is ~410 KB and matters only once a terminal tab exists — which for many
 * sessions is never. Preloaded on idle like the editor, so opening a tab does
 * not wait on a fetch.
 */
const TerminalPane = React.lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.TerminalPane }))
)


function Tab({
  icon,
  label,
  active,
  attention = false,
  preview = false,
  dirty = false,
  busy,
  onSelect,
  onDoubleClick,
  onClose
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  attention?: boolean
  preview?: boolean
  /** Unsaved edits — the close button becomes a dot until hover, like VS Code. */
  dirty?: boolean
  /** Foreground process name; renders the activity dot when set. */
  busy?: string
  onSelect: () => void
  onDoubleClick?: () => void
  /** Omitted by tabs that are derived state rather than something opened — the
      Agents roster exists exactly while the chat has agents, so there is nothing
      a close button could do that the next spawn would not undo. */
  onClose?: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1.5 pl-2 text-xs transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      role="tab"
      aria-selected={active}
    >
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
 * The "+" button: a Cursor-style quick-open. Type to fuzzy-search files (opens
 * one as a tab), or pick an action — Browser preview, Terminal, Review changes.
 * This is how you open files regardless of which tab is active, so the file tree
 * never needs to sit beside the browser.
 */
function QuickOpen(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const openFile = useApp((s) => s.openFile)
  const openPreview = useApp((s) => s.openPreview)
  const openTerminal = useApp((s) => s.openTerminal)
  const reviewChangesAction = useApp((s) => s.reviewChanges)
  const browseFiles = useApp((s) => s.browseFiles)
  const openCanvas = useApp((s) => s.openCanvas)

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

  const reviewChanges = (): void => {
    void reviewChangesAction()
    setOpen(false)
  }

  const actions = [
    {
      icon: <FolderTree className="size-4" />,
      label: 'Browse files',
      run: () => {
        browseFiles()
        setOpen(false)
      }
    },
    {
      // `Shapes` is the library's own mark (the tab, and its empty state);
      // `PenLine` names a single document. This row opens the library.
      icon: <Shapes className="size-4" />,
      label: 'Canvas',
      run: () => {
        void openCanvas(null)
        setOpen(false)
      }
    },
    {
      icon: <Globe className="size-4" />,
      label: 'Browser preview',
      run: () => {
        openPreview()
        setOpen(false)
      }
    },
    {
      icon: <SquareTerminal className="size-4" />,
      label: 'Terminal',
      run: () => {
        openTerminal()
        setOpen(false)
      }
    },
    { icon: <GitBranch className="size-4" />, label: 'Review changes', run: reviewChanges }
  ]

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
        <div className="max-h-72 overflow-y-auto p-1">
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
            actions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.run}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent"
              >
                <span className="text-muted-foreground">{a.icon}</span>
                {a.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Horizontally-scrolling tab strip with an overlay scrollbar: the native bar is
 * hidden (so it never steals height and shoves the tabs up), and a thin bar
 * fades in over the tabs' bottom edge while scrolling, Cursor-style.
 */
function TabScroller({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = React.useState<{ left: number; width: number } | null>(null)
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
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
        />
      )}
    </div>
  )
}

/**
 * Shown in the viewer when the panel is open but nothing is: a Cursor-style
 * launcher grid. "File" opens a blank Untitled tab (a picker until you choose).
 */
function EmptyLauncher(): React.JSX.Element {
  const reviewChanges = useApp((s) => s.reviewChanges)
  const openPreview = useApp((s) => s.openPreview)
  const openTerminal = useApp((s) => s.openTerminal)
  const browseFiles = useApp((s) => s.browseFiles)
  const openCanvas = useApp((s) => s.openCanvas)

  const items = [
    { icon: <GitBranch />, label: 'Changes', run: () => void reviewChanges() },
    { icon: <Globe />, label: 'Browser', run: () => openPreview() },
    { icon: <SquareTerminal />, label: 'Terminal', run: () => openTerminal() },
    { icon: <FolderTree />, label: 'Files', run: () => browseFiles() },
    { icon: <Shapes />, label: 'Canvas', run: () => void openCanvas(null) }
  ]
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="grid grid-cols-2 gap-3">
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            onClick={it.run}
            className="flex size-32 flex-col items-center justify-center gap-2.5 rounded-xl border border-border/60 text-muted-foreground transition-colors hover:border-border hover:bg-accent/50 hover:text-foreground [&_svg]:size-6"
          >
            {it.icon}
            <span className="text-[13px]">{it.label}</span>
          </button>
        ))}
      </div>
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
  const activeId = useApp((s) => s.activeId)
  const openFiles = useApp((s) => s.openFiles)
  const fileContents = useApp((s) => s.fileContents)
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
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
  const closePreview = useApp((s) => s.closePreview)
  const selectedCwd = useApp((s) => s.selectedCwd)
  const diffContents = useApp((s) => s.diffContents)
  const diffWrap = useApp((s) => s.diffWrap)
  const panelMaximized = useApp((s) => s.panelMaximized)
  const togglePanelMaximized = useApp((s) => s.togglePanelMaximized)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const togglePanel = useApp((s) => s.togglePanel)
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
  const showContents = panelOpen || contentsMounted

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
    // Reserve space for the chat column measured from where it actually
    // starts — the sidebar may be open to its left.
    const panel = e.currentTarget.closest<HTMLElement>('[data-right-panel]')
    const chatLeft = panel?.previousElementSibling?.getBoundingClientRect().left ?? 0
    const maxW = Math.round(window.innerWidth - chatLeft - CHAT_RESERVED_PX)
    const next = Math.round(window.innerWidth - e.clientX)
    setWidth(Math.max(PANEL_MIN_PX, Math.min(next, maxW)))
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

  const showPlan = planPanel !== null && planPanel.chatId === activeId
  // The Agents tab is a property of the chat: it exists exactly while the chat
  // has spawned something. It is never auto-selected — a spawn mid-read would
  // otherwise take the file you are looking at off screen — so the way in is the
  // activity bar above the composer, or the tab itself.
  const showAgents = useAgents((s) => s.runs.length > 0)
  const agentsRunning = useAgents((s) => s.totals.running > 0)
  // The Canvas tab is a property of the *project*, not the chat — every chat in
  // a folder sees the same documents. `activeTab` is OR-ed in so the launcher
  // can open an empty one: without it, a project with no canvas yet has no way
  // in, and the tab it opened would vanish under it.
  const canvasCount = useApp((s) => s.canvases.length)
  const canvasTabs = useApp((s) => s.canvasTabs)
  const canvasList = useApp((s) => s.canvases)
  const closeCanvas = useApp((s) => s.closeCanvas)
  const showCanvas = canvasCount > 0 || activeTab === 'canvas'
  const current =
    activeTab === 'files'
      ? 'files'
      : terminals.some((t) => t.id === activeTab)
      ? activeTab!
      : previews.some((p) => p.id === activeTab)
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
                previews[previews.length - 1]?.id ??
                terminals[terminals.length - 1]?.id ??
                null)
  const currentIsTerminal = terminals.some((t) => t.id === current)
  const currentIsPreview = previews.some((p) => p.id === current)
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
    return () => window.api.gitDiff(cwd, { path: file, staged, base, context: FULL_CONTEXT })
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
  // does rather than discarding silently. The Agents roster and the Canvas
  // library have no close (they are derived state) and so ⌘W is a no-op on
  // them; anything else closes, and with nothing open the window does, which
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
    if (current === 'files') setActiveTab(null)
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

  const targetWidth = width
    ? `min(${width}px, calc(100vw - ${CHAT_RESERVED_PX}px))`
    : '52%'

  return (
    <aside
      data-right-panel
      aria-hidden={!panelOpen}
      style={
        panelMaximized
          ? undefined
          : {
              width: panelOpen ? targetWidth : 0,
              minWidth: panelOpen ? `${PANEL_MIN_PX}px` : 0
            }
      }
      className={cn(
        'relative h-full overflow-hidden bg-background',
        !dragging && 'transition-[width,min-width] duration-200 ease-out',
        !panelOpen && 'pointer-events-none',
        // Not shrink-0: when space runs out the panel yields before the chat
        // column (which has its own min-width) gets crushed.
        panelMaximized && 'flex-1'
      )}
    >
      {showContents && (
      <div
        className={cn(
          'relative flex h-full w-full min-w-[28rem] flex-col border-l border-border bg-card/30',
          panelMaximized && 'min-w-0'
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
          className="no-drag absolute inset-y-0 -left-[3px] z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
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
            />
          )}
          {/* Browse mode — the tree docked with nothing selected. It is a state
              the user chose from the launcher or the + menu, so it gets a tab
              like anything else opened, and the tab is what lets it be left:
              without one the panel showed a docked tree under an empty pane
              with no strip entry and no close. It exists exactly while it is
              the active tab, the way the Canvas tab does when OR-ed in — the
              moment a file is picked, the file's own tab takes over. */}
          {current === 'files' && (
            <Tab
              icon={<FolderTree className="size-3.5" />}
              label="Files"
              active
              onSelect={() => setActiveTab('files')}
              onClose={() => setActiveTab(null)}
            />
          )}
          {canvasTabs.map((id) => (
            <Tab
              key={id}
              icon={<PenLine className="size-3.5" />}
              label={canvasList.find((c) => c.id === id)?.title ?? 'Canvas'}
              active={current === `canvas:${id}`}
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
              onSelect={() => setActiveTab(t.id)}
              onClose={() => closeTerminal(t.id)}
            />
          ))}
          {previews.map((p) => (
            <Tab
              key={p.id}
              icon={<Globe className="size-3.5" />}
              label={`Preview ${p.n}`}
              active={current === p.id}
              onSelect={() => setActiveTab(p.id)}
              onClose={() => closePreview(p.id)}
            />
          ))}
        </TabScroller>
        <QuickOpen />
        {/* Pushes the panel controls to the far right; collapses to 0 when the
            tab strip fills the width, so "+" pins beside these controls. */}
        <div className="min-w-2 flex-1" />
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

      {/* Breadcrumb row with the file-tree toggle at its right, Cursor-style. */}
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

      {/* Viewer + file tree / source control docked on the right, Cursor-style */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            id="editor-find-scope"
            className={cn('min-h-0 flex-1', (currentIsTerminal || currentIsPreview) && 'hidden')}
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
          {/* Each terminal stays mounted while its tab exists so scrollback
              survives switching tabs; hidden (not unmounted) when not active. */}
          {terminals.map((t) => (
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
          {/* A hidden webview remains a live Chromium renderer. Mount only the
              selected preview so background tabs cannot run timers/WebGL. */}
          {currentIsPreview &&
            previews
              .filter((p) => p.id === current)
              .map((p) => (
                <div key={p.id} className="absolute inset-0">
                  <BrowserPane id={p.id} active cwd={p.cwd} />
                </div>
              ))}
        </div>
        {dockOpen &&
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
          {/* The dock follows the active tab, Cursor-style: the changes tree
              while reviewing the Working Tree, the project file tree otherwise. */}
          {currentIsChanges ? <GitPanel /> : <FileTree />}
        </div>
        )}
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

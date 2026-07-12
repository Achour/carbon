import * as React from 'react'
import {
  ClipboardList,
  FileDiff,
  FileText,
  Files,
  GitBranch,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp, type OpenTab } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { PlanContent } from '@/components/PlanPanel'
import { FileViewer } from '@/components/FileViewer'
import { FileTree } from '@/components/FileTree'
import { GitPanel } from '@/components/GitPanel'
import { DiffView } from '@/components/DiffView'

function Tab({
  icon,
  label,
  active,
  attention = false,
  preview = false,
  onSelect,
  onDoubleClick,
  onClose
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  attention?: boolean
  preview?: boolean
  onSelect: () => void
  onDoubleClick?: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs transition-colors',
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
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${label}`}
        className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

// Keep the panel between these bounds: never narrower than the tab strip +
// tree can bear, never so wide the chat column becomes unusable.
const PANEL_MIN_PX = 448
const CHAT_RESERVED_PX = 480

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
    <div className="flex h-7 shrink-0 items-center border-b border-border/60 px-3 text-[11px]">
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

export function RightPanel(): React.JSX.Element | null {
  const panelOpen = useApp((s) => s.panelOpen)
  const planPanel = useApp((s) => s.planPanel)
  const activeId = useApp((s) => s.activeId)
  const openFiles = useApp((s) => s.openFiles)
  const fileContents = useApp((s) => s.fileContents)
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeFile = useApp((s) => s.closeFile)
  const promoteTab = useApp((s) => s.promoteTab)
  const closePlanPanel = useApp((s) => s.closePlanPanel)
  const rightView = useApp((s) => s.rightView)
  const setRightView = useApp((s) => s.setRightView)
  const selectedCwd = useApp((s) => s.selectedCwd)
  const changeCount = useApp((s) => s.git?.changes.length ?? 0)
  const diffContents = useApp((s) => s.diffContents)
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

  // 0 = default width (52%); anything else is a user-dragged pixel width.
  const [width, setWidth] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem('rightPanelWidth'))
    return Number.isFinite(saved) && saved >= PANEL_MIN_PX ? saved : 0
  })
  const draggingRef = React.useRef(false)

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    draggingRef.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events have no active pointer to capture
    }
  }

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    const next = Math.round(window.innerWidth - e.clientX)
    setWidth(Math.max(PANEL_MIN_PX, Math.min(next, window.innerWidth - CHAT_RESERVED_PX)))
  }

  const onHandlePointerUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setWidth((w) => {
      if (w) localStorage.setItem('rightPanelWidth', String(w))
      return w
    })
  }

  const resetWidth = (): void => {
    draggingRef.current = false
    setWidth(0)
    localStorage.removeItem('rightPanelWidth')
  }

  if (!panelOpen) return null

  const showPlan = planPanel !== null && planPanel.chatId === activeId
  const current =
    activeTab === 'plan' && showPlan
      ? 'plan'
      : openFiles.some((f) => f.path === activeTab)
        ? activeTab!
        : showPlan
          ? 'plan'
          : (openFiles[openFiles.length - 1]?.path ?? null)
  const activeEntry = current ? openFiles.find((f) => f.path === current) : undefined

  return (
    <aside
      style={
        panelMaximized
          ? undefined
          : { width: width ? `min(${width}px, calc(100vw - ${CHAT_RESERVED_PX}px))` : '52%' }
      }
      className={cn(
        'relative flex h-full min-w-[28rem] flex-col border-l border-border bg-card/30',
        panelMaximized ? 'min-w-0 flex-1' : 'shrink-0'
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
          'drag flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-2.5',
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
        <div
          className="no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
        >
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
          {openFiles.map((file) => (
            <Tab
              key={file.path}
              icon={
                file.diff ? (
                  <FileDiff className="size-3.5 text-amber-500" />
                ) : (
                  <FileText className="size-3.5" />
                )
              }
              label={file.name}
              active={current === file.path}
              preview={file.preview}
              onSelect={() => setActiveTab(file.path)}
              onDoubleClick={file.preview ? () => promoteTab(file.path) : undefined}
              onClose={() => closeFile(file.path)}
            />
          ))}
        </div>
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

      {/* Viewer + file tree / source control docked on the right, Cursor-style */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {activeEntry && <PathBar entry={activeEntry} cwd={selectedCwd} />}
          <div className="min-h-0 flex-1">
            {current === 'plan' && planPanel ? (
              <PlanContent panel={planPanel} hasSuggestions={hasSuggestions} />
            ) : activeEntry?.diff ? (
              <DiffView text={diffContents[current!]} />
            ) : current ? (
              <FileViewer content={fileContents[current]} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Select a file from the tree
              </div>
            )}
          </div>
        </div>
        <div className="flex w-56 shrink-0 flex-col border-l border-border bg-card/40">
          {/* Files / Source control switcher */}
          <div className="mx-2 mt-1.5 mb-1 grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-secondary/60 p-0.5">
            <button
              type="button"
              onClick={() => setRightView('files')}
              className={cn(
                'flex h-6 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors',
                rightView === 'files'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Files className="size-3" /> Files
            </button>
            <button
              type="button"
              onClick={() => setRightView('git')}
              className={cn(
                'flex h-6 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors',
                rightView === 'git'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <GitBranch className="size-3" /> Source
              {changeCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1 text-[9px] font-semibold text-primary">
                  {changeCount}
                </span>
              )}
            </button>
          </div>
          {rightView === 'git' ? <GitPanel /> : <FileTree />}
        </div>
      </div>
    </aside>
  )
}

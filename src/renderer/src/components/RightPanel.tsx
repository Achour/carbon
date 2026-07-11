import * as React from 'react'
import { ClipboardList, FileDiff, FileText, Files, GitBranch, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
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
  onSelect,
  onClose
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  attention?: boolean
  onSelect: () => void
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
      role="tab"
      aria-selected={active}
    >
      <span className={cn(attention && 'text-warning')}>{icon}</span>
      <span className="max-w-36 truncate">{label}</span>
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

export function RightPanel(): React.JSX.Element | null {
  const panelOpen = useApp((s) => s.panelOpen)
  const planPanel = useApp((s) => s.planPanel)
  const activeId = useApp((s) => s.activeId)
  const openFiles = useApp((s) => s.openFiles)
  const fileContents = useApp((s) => s.fileContents)
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeFile = useApp((s) => s.closeFile)
  const closePlanPanel = useApp((s) => s.closePlanPanel)
  const rightView = useApp((s) => s.rightView)
  const setRightView = useApp((s) => s.setRightView)
  const changeCount = useApp((s) => s.git?.changes.length ?? 0)
  const diffContents = useApp((s) => s.diffContents)
  const hasSuggestions = useApp((s) => {
    if (!s.planPanel?.requestId) return false
    return (s.permissions[s.planPanel.chatId] ?? []).some(
      (r) => r.id === s.planPanel!.requestId && r.hasSuggestions
    )
  })

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

  return (
    <aside className="flex h-full w-[52%] max-w-4xl min-w-[28rem] shrink-0 flex-col border-l border-border bg-card/30">
      {/* Tab strip */}
      <header className="drag flex h-[52px] shrink-0 items-center border-b border-border px-2.5">
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
                file.diff ? <FileDiff className="size-3.5" /> : <FileText className="size-3.5" />
              }
              label={file.name}
              active={current === file.path}
              onSelect={() => setActiveTab(file.path)}
              onClose={() => closeFile(file.path)}
            />
          ))}
        </div>
      </header>

      {/* Viewer + file tree / source control docked on the right, Cursor-style */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {current === 'plan' && planPanel ? (
            <PlanContent panel={planPanel} hasSuggestions={hasSuggestions} />
          ) : current && openFiles.find((f) => f.path === current)?.diff ? (
            <DiffView text={diffContents[current]} />
          ) : current ? (
            <FileViewer content={fileContents[current]} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a file from the tree
            </div>
          )}
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

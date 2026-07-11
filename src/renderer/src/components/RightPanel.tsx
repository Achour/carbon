import * as React from 'react'
import { ClipboardList, FileText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { PlanContent } from '@/components/PlanPanel'
import { FileViewer } from '@/components/FileViewer'
import { FileTree } from '@/components/FileTree'

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
              icon={<FileText className="size-3.5" />}
              label={file.name}
              active={current === file.path}
              onSelect={() => setActiveTab(file.path)}
              onClose={() => closeFile(file.path)}
            />
          ))}
        </div>
      </header>

      {/* Viewer + file tree docked on the right, Cursor-style */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {current === 'plan' && planPanel ? (
            <PlanContent panel={planPanel} hasSuggestions={hasSuggestions} />
          ) : current ? (
            <FileViewer content={fileContents[current]} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a file from the tree
            </div>
          )}
        </div>
        <div className="flex w-56 shrink-0 flex-col border-l border-border bg-card/40 pt-1.5">
          <FileTree />
        </div>
      </div>
    </aside>
  )
}

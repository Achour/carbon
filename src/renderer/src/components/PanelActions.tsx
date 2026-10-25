import * as React from 'react'
import { FileDiff, Folder, FolderTree, GitBranch, Globe, Search, Shapes, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
import { Kbd } from '@/components/ui/kbd'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * What the right panel can open, in one order and under one name. The new-chat
 * rail, the empty panel and the tab strip's "+" all list these; each used to
 * keep its own copy, and opening the panel beside the rail swapped a list for a
 * grid of the same actions in another order under shorter names.
 */
export interface PanelAction {
  id: 'changes' | 'files' | 'browser' | 'terminal' | 'canvas'
  icon: React.ReactNode
  label: string
  run: () => void
  disabled?: boolean
  /** Drawn at the row's trailing edge: a shortcut. */
  meta?: React.ReactNode
}

export function usePanelActions(): PanelAction[] {
  const git = useApp((s) => s.git)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const browseFiles = useApp((s) => s.browseFiles)
  const openPreview = useApp((s) => s.openPreview)
  const openTerminal = useApp((s) => s.openTerminal)
  const openCanvas = useApp((s) => s.openCanvas)
  // ⌘J is `toggleTerminal`, which opens a terminal only while there is none
  // and otherwise shows the last one. The row always opens a new one, so the
  // hint is offered only while the two do the same thing.
  const noTerminals = useApp((s) => s.terminals.length === 0)
  const hasChanges = !!git?.isRepo && git.changes.length > 0

  return [
    {
      id: 'changes',
      icon: <FileDiff />,
      label: 'Review changes',
      run: () => void reviewChanges(),
      // No count here: the context strip's diff chip says it, and it is on
      // screen beside every place this list is drawn. The row only has to say
      // whether there is anything to review.
      disabled: !hasChanges
    },
    { id: 'files', icon: <FolderTree />, label: 'Files', run: browseFiles },
    { id: 'browser', icon: <Globe />, label: 'Browser preview', run: () => openPreview() },
    {
      id: 'terminal',
      icon: <SquareTerminal />,
      label: 'Terminal',
      run: () => openTerminal(),
      meta: noTerminals ? <HoverKbd>⌘J</HoverKbd> : undefined
    },
    { id: 'canvas', icon: <Shapes />, label: 'Canvas', run: () => void openCanvas(null) }
  ]
}

/** A shortcut hint that shows on the row's hover, as the sidebar's do. */
function HoverKbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Kbd className="opacity-0 transition-opacity group-hover/action:opacity-100 group-focus-visible/action:opacity-100">
      {children}
    </Kbd>
  )
}

/** One row of the list, shared by every place that draws it. */
export function PanelActionRow({
  icon,
  label,
  run,
  disabled = false,
  meta,
  onDone
}: Omit<PanelAction, 'id'> & { onDone?: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        run()
        onDone?.()
      }}
      disabled={disabled}
      className={cn(
        'group/action flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors [&_svg]:size-4',
        disabled ? 'cursor-default text-muted-foreground/40' : 'text-foreground hover:bg-accent'
      )}
    >
      <span className={cn('shrink-0', !disabled && 'text-muted-foreground')}>{icon}</span>
      <span className="truncate whitespace-nowrap">{label}</span>
      {meta && <span className="ml-auto flex shrink-0 items-center pl-2">{meta}</span>}
    </button>
  )
}

/**
 * The whole launcher: where it is (project and branch), a way to a file, and
 * the actions. The new-chat rail and the empty panel draw this same block, so
 * opening the panel beside the rail hands the list over rather than redrawing
 * it in another shape.
 */
export function PanelLaunchList({ className }: { className?: string }): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const git = useApp((s) => s.git)
  const setFileSearchOpen = useApp((s) => s.setFileSearchOpen)
  const actions = usePanelActions()

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {cwd && (
        <WithTooltip label={cwd}>
          <div className="mb-2 flex items-center gap-1.5 px-2 text-xs text-muted-foreground/70">
            <Folder className="size-3 shrink-0" />
            <span className="truncate">{basename(cwd)}</span>
            {git?.isRepo && git.branch && (
              <>
                <span className="text-border">/</span>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{git.branch}</span>
              </>
            )}
          </div>
        </WithTooltip>
      )}
      {/* Points at the ⌘P dialog rather than searching in place: one file
          search, and the row teaches its shortcut. */}
      <button
        type="button"
        onClick={() => setFileSearchOpen(true)}
        className="mb-2 flex w-full items-center gap-2.5 rounded-md border border-border/70 bg-background/40 px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:border-border hover:text-foreground [&_svg]:size-4"
      >
        <Search className="shrink-0" />
        <span className="truncate">Open a file…</span>
        <Kbd className="ml-auto bg-transparent">⌘P</Kbd>
      </button>
      {actions.map(({ id, ...a }) => (
        <PanelActionRow key={id} {...a} />
      ))}
    </div>
  )
}

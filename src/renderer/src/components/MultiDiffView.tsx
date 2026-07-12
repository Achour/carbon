import * as React from 'react'
import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderTree,
  Minus,
  Plus
} from 'lucide-react'
import type { GitFileChange } from '@shared/types'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { DiffTable } from '@/components/DiffView'
import { languageForPath } from '@/lib/highlight'

const STATUS_COLORS: Record<string, string> = {
  M: 'text-amber-500',
  T: 'text-amber-500',
  A: 'text-emerald-500',
  '?': 'text-emerald-500',
  D: 'text-red-500',
  R: 'text-sky-500',
  C: 'text-sky-500',
  U: 'text-orange-500'
}

const NO_CHANGES: GitFileChange[] = []
const keyOf = (c: GitFileChange): string => `${c.staged ? 's' : 'w'}:${c.path}`

/**
 * The whole working tree as one scrollable view: every changed file's diff
 * stacked with a sticky, collapsible header. Clicking a file in the source-
 * control tree scrolls here (via the store's `changesScroll` signal).
 */
export function MultiDiffView({ cwd }: { cwd: string }): React.JSX.Element {
  const changes = useApp((s) => s.git?.changes ?? NO_CHANGES)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const openDiff = useApp((s) => s.openDiff)
  const scroll = useApp((s) => s.changesScroll)
  const dockOpen = useApp((s) => s.explorerOpen)
  const toggleDock = useApp((s) => s.toggleExplorer)

  const [texts, setTexts] = React.useState<Record<string, string | undefined>>({})
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const sectionRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const handledScroll = React.useRef(0)

  // Fetch every file's diff (in parallel) whenever the change set shifts.
  React.useEffect(() => {
    let alive = true
    Promise.all(
      changes.map(async (c) => {
        const text = await window.api.gitDiff(cwd, {
          path: c.path,
          staged: c.staged,
          untracked: c.status === '?'
        })
        return [keyOf(c), text] as const
      })
    ).then((entries) => {
      if (alive) setTexts(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [cwd, changes])

  // Scroll to the file the tree asked for — retry across renders until its
  // section has mounted, then mark this request handled.
  React.useEffect(() => {
    if (!scroll || scroll.n === handledScroll.current) return
    const el = sectionRefs.current[scroll.key]
    if (!el) return
    handledScroll.current = scroll.n
    setCollapsed((p) => (p[scroll.key] ? { ...p, [scroll.key]: false } : p))
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [scroll, changes, texts])

  const allCollapsed = changes.length > 0 && changes.every((c) => collapsed[keyOf(c)])
  const toggleAll = (): void => {
    setCollapsed(allCollapsed ? {} : Object.fromEntries(changes.map((c) => [keyOf(c), true])))
  }

  if (changes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5 text-emerald-500" /> Working tree clean
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 pr-3 pl-2 text-[11px] text-muted-foreground">
        <WithTooltip label={dockOpen ? 'Hide file tree' : 'Show file tree'}>
          <Button
            size="icon-sm"
            variant="ghost"
            className={cn('size-5', dockOpen && 'bg-accent text-foreground')}
            aria-label={dockOpen ? 'Hide file tree' : 'Show file tree'}
            aria-pressed={dockOpen}
            onClick={toggleDock}
          >
            <FolderTree />
          </Button>
        </WithTooltip>
        <span>
          {changes.length} file{changes.length === 1 ? '' : 's'} changed
        </span>
        <div className="flex-1" />
        <WithTooltip label={allCollapsed ? 'Expand all files' : 'Collapse all files'}>
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-3" />
            ) : (
              <ChevronsDownUp className="size-3" />
            )}
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </WithTooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {changes.map((c) => {
          const k = keyOf(c)
          const open = !collapsed[k]
          const name = c.path.split('/').pop() ?? c.path
          const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''
          const text = texts[k]
          return (
            <div
              key={k}
              ref={(el) => {
                sectionRefs.current[k] = el
              }}
              className="border-b border-border/40 last:border-b-0"
            >
              <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/40 bg-card/95 px-2 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
                <button
                  type="button"
                  onClick={() => setCollapsed((p) => ({ ...p, [k]: open }))}
                  onDoubleClick={() => void openDiff(c)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={c.origPath ? `${c.origPath} → ${c.path}` : c.path}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground/70 transition-transform',
                      open && 'rotate-90'
                    )}
                  />
                  <span
                    className={cn(
                      'w-3 shrink-0 text-center font-mono text-[11px] font-bold',
                      STATUS_COLORS[c.status] ?? 'text-muted-foreground'
                    )}
                  >
                    {c.status === '?' ? 'U' : c.status}
                  </span>
                  <span className="shrink-0 truncate text-[12.5px] font-medium">{name}</span>
                  {dir && (
                    <span className="min-w-0 truncate text-[10.5px] text-muted-foreground/55">
                      {dir}
                    </span>
                  )}
                  {c.staged && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[9px] text-amber-500">
                      staged
                    </span>
                  )}
                </button>
                <WithTooltip label={c.staged ? 'Unstage' : 'Stage'}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-5 shrink-0"
                    aria-label={c.staged ? `Unstage ${name}` : `Stage ${name}`}
                    onClick={() =>
                      c.staged ? void unstagePaths([c.path]) : void stagePaths([c.path])
                    }
                  >
                    {c.staged ? <Minus /> : <Plus />}
                  </Button>
                </WithTooltip>
              </div>
              {open &&
                (text === undefined ? (
                  <div className="px-3 py-2.5 text-xs text-muted-foreground/60">
                    <span className="shimmer-text">Loading diff…</span>
                  </div>
                ) : (
                  <DiffTable text={text} language={languageForPath(c.path)} />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

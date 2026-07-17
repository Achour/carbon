import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus
} from 'lucide-react'
import type { GitFileChange } from '@shared/types'
import { cn } from '@/lib/utils'
import { useStableChanges } from '@/lib/useStableChanges'
import { scopedChanges, useApp, type ChangeScope } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { DiffTable } from '@/components/DiffView'
import { LineDeltas } from '@/components/GitPanel'
import { languageForPath } from '@/lib/highlight'

const SCOPES: { id: ChangeScope; label: string; hint: string }[] = [
  { id: 'last-turn', label: 'Last Turn', hint: "This chat's last turn's changes" },
  { id: 'uncommitted', label: 'Uncommitted', hint: 'All working-tree changes' },
  { id: 'branch', label: 'Branch', hint: 'Everything on this branch vs its base' }
]

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
  const git = useApp((s) => s.git)
  const changeScope = useApp((s) => s.changeScope)
  const branchChanges = useApp((s) => s.branchChanges)
  const activeId = useApp((s) => s.activeId)
  const chats = useApp((s) => s.chats)
  const messages = useApp((s) => s.messages)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const openDiff = useApp((s) => s.openDiff)
  const scroll = useApp((s) => s.changesScroll)
  const explorerOpen = useApp((s) => s.explorerOpen)
  const toggleExplorer = useApp((s) => s.toggleExplorer)

  const setChangeScope = useApp((s) => s.setChangeScope)
  const isBranch = changeScope === 'branch'
  const branchBase = isBranch ? (branchChanges?.base ?? undefined) : undefined
  const rawChanges = React.useMemo(
    () =>
      scopedChanges({ changeScope, git, branchChanges, activeId, chats, messages }, cwd) ?? NO_CHANGES,
    [changeScope, git, branchChanges, activeId, chats, messages, cwd]
  )
  const changes = useStableChanges(rawChanges)
  const scopeMeta = SCOPES.find((s) => s.id === changeScope) ?? SCOPES[1]
  const totalAdd = changes.reduce((n, c) => n + (c.additions ?? 0), 0)
  const totalDel = changes.reduce((n, c) => n + (c.deletions ?? 0), 0)
  const branchLoading = isBranch && !branchChanges
  const emptyLabel =
    changeScope === 'last-turn'
      ? 'No changes in the last turn'
      : isBranch
        ? branchChanges?.baseBranch
          ? `No changes vs ${branchChanges.baseBranch}`
          : 'No base branch to compare against'
        : 'Working tree clean'

  const [texts, setTexts] = React.useState<Record<string, string | undefined>>({})
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const sectionRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const handledScroll = React.useRef(0)

  // `changes` is a fresh array on every refreshGit() (many of them unrelated to
  // the diffs), so key the fetch on a stable signature: refetch only when the
  // set of files or their line counts actually shift, not on every refresh.
  const sig = React.useMemo(
    () =>
      `${branchBase ?? ''}|` +
      changes.map((c) => `${keyOf(c)}:${c.status}:${c.additions}:${c.deletions}`).join('|'),
    [changes, branchBase]
  )

  // Fetch every file's diff (in parallel) whenever the change set shifts.
  React.useEffect(() => {
    let alive = true
    Promise.all(
      changes.map(async (c) => {
        const untracked = c.status === '?'
        const text = await window.api.gitDiff(cwd, {
          path: c.path,
          staged: c.staged,
          untracked,
          // Branch scope: diff the whole delta vs base (untracked files have no base blob).
          base: untracked ? undefined : branchBase
        })
        return [keyOf(c), text] as const
      })
    ).then((entries) => {
      if (alive) setTexts(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
    // `changes` is intentionally read through the stable `sig` signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sig])

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

  return (
    <div className="flex h-full flex-col">
      {/* Scope selector at the top of the review, Codex/Cursor-style */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 pr-2 pl-2.5 text-[11px] text-muted-foreground">
        <DropdownMenu>
          <WithTooltip label={scopeMeta.hint}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="-ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-semibold text-foreground/90 outline-none transition-colors hover:bg-accent"
                >
                  {scopeMeta.label}
                  <ChevronDown className="size-3 text-muted-foreground" />
                </button>
              }
            />
          </WithTooltip>
          <DropdownMenuContent align="start" className="min-w-52">
            {SCOPES.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => setChangeScope(s.id)}>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-[13px]', s.id === changeScope && 'text-primary')}>
                    {s.label}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">{s.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <LineDeltas additions={totalAdd} deletions={totalDel} />
        {isBranch && branchChanges?.baseBranch && (
          <span className="truncate text-[10px] text-muted-foreground/60">
            vs {branchChanges.baseBranch}
          </span>
        )}
        <div className="flex-1" />
        {changes.length > 0 && (
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
        )}
        <WithTooltip label={explorerOpen ? 'Hide file tree' : 'Show file tree'}>
          <button
            type="button"
            onClick={toggleExplorer}
            aria-label={explorerOpen ? 'Hide file tree' : 'Show file tree'}
            aria-pressed={explorerOpen}
            className={cn(
              'flex items-center rounded p-1 transition-colors hover:bg-accent hover:text-foreground',
              explorerOpen && 'text-foreground'
            )}
          >
            {explorerOpen ? (
              <PanelRightClose className="size-3.5" />
            ) : (
              <PanelRightOpen className="size-3.5" />
            )}
          </button>
        </WithTooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {branchLoading ? (
          <div className="flex h-full items-center justify-center text-xs">
            <span className="shimmer-text">Reading branch…</span>
          </div>
        ) : changes.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 text-emerald-500" /> {emptyLabel}
          </div>
        ) : (
          changes.map((c) => {
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
              <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/40 bg-card px-2 py-1.5">
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
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
                      {dir}
                    </span>
                  )}
                  {!isBranch && c.staged && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[9px] text-amber-500">
                      staged
                    </span>
                  )}
                  {isBranch && c.committed && (
                    <span className="shrink-0 rounded bg-primary/10 px-1 text-[9px] text-primary">
                      committed
                    </span>
                  )}
                </button>
                <LineDeltas additions={c.additions} deletions={c.deletions} />
                {!isBranch && (
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
                )}
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
          })
        )}
      </div>
    </div>
  )
}

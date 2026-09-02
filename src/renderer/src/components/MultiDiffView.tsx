import * as React from 'react'
import { Check, ChevronRight, ExternalLink, Minus, Plus } from 'lucide-react'
import type { GitFileChange } from '@shared/types'
import { cn } from '@/lib/utils'
import { useStableChanges } from '@/lib/useStableChanges'
import { scopedChanges, useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { DiffTable, FULL_CONTEXT, MAX_ROWS, type ExpandDiff } from '@/components/DiffView'
import { LineDeltas } from '@/components/GitPanel'
import { countRows } from '@/lib/diffRows'
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
export const keyOf = (c: GitFileChange): string => `${c.staged ? 's' : 'w'}:${c.path}`

/** How far outside the scroller a file's body is still worth having in the DOM.
 *  Generous on purpose: mounting costs a frame, and a review is read by
 *  scrolling, so the next file should already be there when it arrives. */
const MOUNT_MARGIN = '1600px 0px'

/** How long a scroll-to-file request stays live while it waits for the body it
 *  was aimed at. Past this the user has moved on, and honouring it would be a
 *  scroll they did not ask for. */
const SCROLL_REQUEST_TTL = 2000

/**
 * One file's diff body, in the DOM only while it is near the viewport.
 *
 * A review is the one place in the app where the amount of markup is set by
 * someone else's work rather than by the design: 40 files at 26,880 changed
 * lines is ~30,000 rows, ~304,000 nodes and megabytes of highlighter markup,
 * and all of it used to mount at once — five seconds of frozen window on
 * "expand all", and a sixth of a second to *collapse*. Collapse is the
 * diagnostic: it parses nothing and highlights nothing, so the only thing it
 * can have been paying for is the DOM.
 *
 * The **header stays mounted** and only the body is lazy, which is what keeps
 * the source-control tree's scroll-to-file working: it scrolls to a section
 * that is always there, and the body arrives on the way.
 *
 * The placeholder is the whole trick. Left to collapse, an unmounted body would
 * pull everything below it upward and scrolling back would jump. So a file that
 * has been on screen remembers the height it measured — read off the
 * `IntersectionObserver` entry's own rect, which is computed at exactly the
 * moment the body is leaving, while it is still laid out, and free, because the
 * observer has already measured it. One that has never been mounted sizes
 * itself from `countRows` at the row height the CSS already defines, so the
 * placeholder is a `calc()` on `--code-font-size` rather than a number JS went
 * and measured.
 *
 * `forceMount` is `findOpen`. ⌘F collects its matches by walking the DOM
 * (`FindBar`), so viewport-only rendering would quietly narrow every search to
 * the files on screen — the same objection that keeps this view off CodeMirror.
 * Mounting everything while the find bar is open is the honest answer: the one
 * gesture that needs the whole document in the DOM is also the one that asks.
 */
function LazyDiffBody({
  sectionKey,
  scroller,
  rows,
  forceMount,
  onMount,
  children
}: {
  sectionKey: string
  scroller: React.RefObject<HTMLDivElement | null>
  rows: number
  forceMount: boolean
  /** Called once the body is actually in the DOM — the moment a scroll aimed at
   *  this file can be re-asserted against its real height. Takes the key rather
   *  than closing over it so the caller's callback stays identity-stable and
   *  this does not re-fire on every render of a mounted body. */
  onMount: (key: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [near, setNear] = React.useState(false)
  const measured = React.useRef<number | undefined>(undefined)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        // The *last* entry, not the first: a fast scroll that crosses the margin
        // and back inside one frame delivers both crossings at once, and acting
        // on the older one leaves the body's state a frame behind the scroller.
        const e = entries[entries.length - 1]
        // Its rect is the body's real height while it is still mounted — the
        // last moment it can be read, and free here because the observer has
        // already measured it.
        if (!e.isIntersecting && e.boundingClientRect.height > 0) {
          measured.current = e.boundingClientRect.height
        }
        setNear(e.isIntersecting)
      },
      { root: scroller.current, rootMargin: MOUNT_MARGIN }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scroller])

  const mounted = near || forceMount
  React.useLayoutEffect(() => {
    if (mounted) onMount(sectionKey)
  }, [mounted, onMount, sectionKey])

  return (
    <div
      ref={ref}
      style={
        mounted
          ? undefined
          : {
              height:
                measured.current !== undefined
                  ? `${measured.current}px`
                  : `calc(var(--code-font-size) * 1.5 * ${rows})`
            }
      }
    >
      {mounted ? children : null}
    </div>
  )
}

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
  const diffWrap = useApp((s) => s.diffWrap)
  const openFile = useApp((s) => s.openFile)
  const findOpen = useApp((s) => s.findOpen)

  const isBranch = changeScope === 'branch'
  const branchBase = isBranch ? (branchChanges?.base ?? undefined) : undefined
  const rawChanges = React.useMemo(
    () =>
      scopedChanges({ changeScope, git, branchChanges, activeId, chats, messages }, cwd) ?? NO_CHANGES,
    [changeScope, git, branchChanges, activeId, chats, messages, cwd]
  )
  const changes = useStableChanges(rawChanges)
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
  const collapsed = useApp((s) => s.diffCollapsed)
  const setDiffCollapsed = useApp((s) => s.setDiffCollapsed)
  const toggleDiffFile = useApp((s) => s.toggleDiffFile)
  const sectionRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const handledScroll = React.useRef(0)

  // `changes` is a fresh array on every refreshGit() (many of them unrelated to
  // the diffs), so the *expanders* below key on a stable signature of the set
  // of files. The texts deliberately do not: a signature of status and line
  // counts cannot see an edit that keeps the counts — an agent rewriting a line
  // in place is +1/−1 before and after — and the review then showed the old
  // line for as long as the file stayed +1/−1. The fetch instead follows the
  // status object itself, which main replaces on every refresh (a turn's end
  // included), and only entries whose text actually changed are re-set, so an
  // unchanged file keeps its string and `DiffTable`'s memo holds.
  const sig = React.useMemo(
    () =>
      `${branchBase ?? ''}|` +
      changes.map((c) => `${keyOf(c)}:${c.status}:${c.additions}:${c.deletions}`).join('|'),
    [changes, branchBase]
  )
  // The scope's own source of truth — the object a refresh replaces.
  const source = isBranch ? branchChanges : git

  // Fetch every file's diff (in parallel) whenever the working tree may have
  // moved. `changes` is derived from `source`, so it is current here.
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
      if (!alive) return
      setTexts((prev) => {
        const keys = Object.keys(prev)
        const same =
          keys.length === entries.length && entries.every(([k, t]) => prev[k] === t)
        return same ? prev : Object.fromEntries(entries)
      })
    })
    return () => {
      alive = false
    }
    // `changes` is read through `source` (and `sig`, for the file set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sig, source])

  // One stable expander per file. Identity matters: `DiffTable` is memoized, and
  // a fresh callback each render would re-render (and re-highlight) every open
  // diff on any store change.
  const expanders = React.useMemo(() => {
    const m: Record<string, ExpandDiff> = {}
    for (const c of changes) {
      const untracked = c.status === '?'
      // An untracked file's diff is its whole content already — nothing to open.
      if (untracked) continue
      m[keyOf(c)] = () =>
        window.api.gitDiff(cwd, {
          path: c.path,
          staged: c.staged,
          base: branchBase,
          context: FULL_CONTEXT
        })
    }
    return m
    // Keyed on the same stable signature as the fetch above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sig])


  // Scroll to the file the tree asked for — retry across renders until its
  // section has mounted, then mark this request handled.
  const wanted = React.useRef<{ key: string; at: number } | null>(null)
  React.useEffect(() => {
    if (!scroll || scroll.n === handledScroll.current) return
    const el = sectionRefs.current[scroll.key]
    if (!el) return
    handledScroll.current = scroll.n
    if (collapsed[scroll.key]) setDiffCollapsed({ ...collapsed, [scroll.key]: false })
    wanted.current = { key: scroll.key, at: performance.now() }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [scroll, changes, texts])

  // Aiming at a file whose body is still a placeholder aims at an *estimated*
  // height, and every neighbour that mounts on the way there moves the target.
  // So the scroll is re-issued once the body it was aimed at actually arrives:
  // a smooth scroll already in flight retargets rather than restarting, which
  // is why this corrects the landing without a visible second hop.
  //
  // The request **expires**, and that is not belt-and-braces. Clicking a file
  // whose body is already mounted never fires this, so the key would sit here
  // indefinitely — until that file scrolled out of range and back, or ⌘F
  // force-mounted everything, at which point the view would yank to a file the
  // user picked minutes ago. Two seconds covers the smooth scroll plus the
  // observer and the mount; nothing legitimate arrives later than that.
  const scrollArrived = React.useCallback((key: string) => {
    const w = wanted.current
    if (w?.key !== key) return
    wanted.current = null
    if (performance.now() - w.at > SCROLL_REQUEST_TTL) return
    sectionRefs.current[key]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollerRef}
        data-changes-scroller
        className="min-h-0 flex-1 overflow-auto"
      >
        {branchLoading ? (
          <div className="flex h-full items-center justify-center text-[length:var(--ui-row)]">
            <span className="shimmer-text">Reading branch…</span>
          </div>
        ) : changes.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-1.5 text-[length:var(--ui-row)] text-muted-foreground">
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
              className="group/file border-b border-border/40 last:border-b-0"
            >
              <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/40 bg-card px-2 py-[3px] text-[length:var(--ui-row)]">
                <button
                  type="button"
                  onClick={() => toggleDiffFile(k)}
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
                      'w-3.5 shrink-0 text-center font-mono',
                      STATUS_COLORS[c.status] ?? 'text-muted-foreground'
                    )}
                  >
                    {c.status === '?' ? 'U' : c.status}
                  </span>
                  {/* Not `font-medium`: at one size a heavier weight reads as a larger
                      one, which is exactly how this header came to look bigger
                      than the same file's row in the tree. The sticky card
                      background and the dimmed directory beside it are what
                      make it a header. */}
                  <span className="shrink-0 truncate">{name}</span>
                  {dir && (
                    <span className="min-w-0 truncate text-muted-foreground/80">
                      {dir}
                    </span>
                  )}
                  {!isBranch && c.staged && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1 text-amber-500">
                      staged
                    </span>
                  )}
                  {isBranch && c.committed && (
                    <span className="shrink-0 rounded bg-primary/10 px-1 text-primary">
                      committed
                    </span>
                  )}
                </button>
                <LineDeltas additions={c.additions} deletions={c.deletions} />
                {c.status !== 'D' && (
                  <WithTooltip label="Open file">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-5 shrink-0 opacity-0 transition-opacity group-hover/file:opacity-100 focus-visible:opacity-100"
                      aria-label={`Open ${name}`}
                      onClick={() => void openFile(`${cwd}/${c.path}`)}
                    >
                      <ExternalLink />
                    </Button>
                  </WithTooltip>
                )}
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
                  <div className="px-3 py-2.5 text-[length:var(--ui-row)] text-muted-foreground/60">
                    <span className="shimmer-text">Loading diff…</span>
                  </div>
                ) : (
                  <LazyDiffBody
                    sectionKey={k}
                    scroller={scrollerRef}
                    rows={Math.max(1, Math.min(countRows(text), MAX_ROWS))}
                    forceMount={findOpen}
                    onMount={scrollArrived}
                  >
                    {/* Each file scrolls sideways on its own, below its header —
                        one shared horizontal scroll would carry the sticky
                        headers off the left edge with the code. */}
                    <div className={cn('min-w-0', !diffWrap && 'overflow-x-auto')}>
                      <DiffTable
                        text={text}
                        language={languageForPath(c.path)}
                        wrap={diffWrap}
                        expand={expanders[k]}
                      />
                    </div>
                  </LazyDiffBody>
                ))}
            </div>
          )
          })
        )}
      </div>
    </div>
  )
}

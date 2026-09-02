import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { highlightCode } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  diffItems,
  expandStep,
  mergeRanges,
  parseDiff,
  type LineRange
} from '@/lib/diffRows'

/** The most rows one file's diff will ever draw. Exported because the changes
 *  view sizes an unmounted file's placeholder from its line count, and a
 *  placeholder for rows that are never going to be drawn is simply wrong. */
export const MAX_ROWS = 5000

/**
 * Ask git for the same diff with enough context to cover the whole file, so a
 * fold can be opened. Returns undefined when the caller has no target to
 * re-fetch (the plain `text`-only uses), which leaves gaps unexpandable.
 */
export type ExpandDiff = () => Promise<string | undefined>

/**
 * `-U` for a fold expansion: more lines than any file has, so one re-fetch
 * covers every gap in it. Asking git again rather than reading the file is what
 * makes this correct for a *staged* diff, whose new side is the index.
 */
export const FULL_CONTEXT = 1_000_000

/** Shared gutter metrics — the change bar is the cell's own left border, which
 *  puts it at the row's outer edge and stretches it to the row's full height. */
const GUTTER =
  'w-12 min-w-12 border-l-2 pr-2.5 pl-1 text-right align-top ' +
  'text-[length:calc(var(--code-font-size)-1px)] tabular-nums select-none'

/** The fold row's two directional expanders. `icon-sm` is 26px and two of them
 *  do not fit the 48px gutter, so they take the gutter's own scale — the point
 *  is that they sit where a line number would, reading as part of the ruler. */
const gapLabel = (count: number): string =>
  `⋯ ${count} unmodified line${count === 1 ? '' : 's'}`

const EXPANDER =
  'size-4 rounded-sm text-muted-foreground/35 group-hover/gap:text-muted-foreground/70 [&_svg]:size-3'

/** The bare diff table (no scroll wrapper) — used standalone and stacked in the
 *  multi-file changes view. */
export const DiffTable = React.memo(function DiffTable({
  text,
  language,
  wrap = false,
  expand
}: {
  text: string
  /** highlight.js language id; when set, code lines are syntax-highlighted. */
  language?: string
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean
  expand?: ExpandDiff
}): React.JSX.Element {
  // The full-context diff, once a fold has been opened. Until then we render
  // git's own `-U3` text and its gaps are counts rather than lines in hand.
  const [full, setFull] = React.useState<string | undefined>(undefined)
  const [revealed, setRevealed] = React.useState<LineRange[]>([])
  const [busy, setBusy] = React.useState(false)

  // A *different* diff (the working tree moved under us) invalidates both: the
  // reveals name line numbers that no longer mean the same thing.
  React.useEffect(() => {
    setFull(undefined)
    setRevealed([])
  }, [text])

  const parsed = React.useMemo(() => parseDiff(full ?? text), [full, text])
  // A file deleted outright has no new side at all, so the ruler below would be
  // blank from top to bottom. There the old numbers are the only ones there are.
  const oldRuler = React.useMemo(
    () => parsed.rows.length > 0 && parsed.rows.every((r) => r.kind === 'del' || r.kind === 'note'),
    [parsed]
  )
  const items = React.useMemo(
    () => diffItems(parsed, { full: full !== undefined, revealed, maxRows: MAX_ROWS }),
    [parsed, full, revealed]
  )
  // Per-line hljs HTML, computed over what is *drawn* — a full-context diff of a
  // large file is mostly folded away, and highlighting the folded rows would be
  // the expensive half of a view that never shows them.
  const html = React.useMemo(
    () =>
      language
        ? items.map((it) =>
            it.kind === 'row' && it.row.kind !== 'note' ? highlightCode(it.row.text, language) : ''
          )
        : null,
    [items, language]
  )

  const reveal = React.useCallback(
    (lines: LineRange) => {
      setRevealed((p) => mergeRanges([...p, lines]))
      if (full !== undefined || !expand) return
      setBusy(true)
      void expand()
        .then((t) => {
          // `gitDiff` reports a failure as its return value, so a refetch can
          // come back as an error string — which parses to nothing and would
          // blank the file. Anything shorter than what is already on screen
          // hides lines rather than revealing them, the one outcome an expand
          // must never produce, so it is dropped and the fold simply stays shut.
          if (t === undefined || parseDiff(t).rows.length < parsed.rows.length) return
          setFull(t)
        })
        .finally(() => setBusy(false))
    },
    [full, expand, parsed]
  )

  // `gitDiff` reports failure as its return value. It parses to no rows, and
  // a file whose diff could not be read must not look like a file with nothing
  // in it — the two call for opposite actions.
  if (text.startsWith('error: ')) {
    return (
      <div className="px-3 py-2.5 font-mono text-xs break-words whitespace-pre-wrap text-destructive">
        {text.slice('error: '.length)}
      </div>
    )
  }
  if (items.length === 0) {
    return <div className="px-3 py-2.5 text-xs text-muted-foreground/70">No textual changes.</div>
  }

  return (
    <table
      className={cn(
        'border-collapse font-mono text-[length:var(--code-font-size)] leading-[1.5]',
        wrap ? 'w-full' : 'w-max min-w-full'
      )}
    >
      <tbody>
        {items.map((item, i) => {
          if (item.kind === 'note') {
            return (
              <tr key={i}>
                <td colSpan={2} className="px-3 py-1 text-[length:var(--code-font-size)] text-muted-foreground">
                  {item.text}
                </td>
              </tr>
            )
          }

          // A fold: quiet, the height of a line and a half, with the count in
          // the code column and the two directional expanders in the gutter —
          // where a line number would be, so they read as part of the ruler.
          if (item.kind === 'gap') {
            const { lines, count } = item
            return (
              <tr key={i} className="group/gap">
                <td className={cn(GUTTER, 'border-l-transparent')}>
                  {expand && (
                    <span className="flex items-center justify-end gap-0.5">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className={EXPANDER}
                        aria-label={`Show the lines above line ${lines[1] + 1}`}
                        title="Show 20 lines above"
                        onClick={() => reveal(expandStep(lines, 'bottom'))}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className={EXPANDER}
                        aria-label={`Show the lines below line ${lines[0] - 1}`}
                        title="Show 20 lines below"
                        onClick={() => reveal(expandStep(lines, 'top'))}
                      >
                        <ChevronDown />
                      </Button>
                    </span>
                  )}
                </td>
                <td className="py-[3px] pl-3 align-middle whitespace-pre">
                  {/* With no re-fetch target this is not a control at all, so it
                      renders as the label it is rather than a disabled button. */}
                  {expand ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => reveal(lines)}
                      className={cn(
                        'h-5 rounded px-1 text-[length:var(--code-font-size)] font-normal text-muted-foreground/45',
                        busy && 'shimmer-text'
                      )}
                    >
                      {gapLabel(count)}
                    </Button>
                  ) : (
                    <span className="px-1 text-[length:var(--code-font-size)] text-muted-foreground/45">
                      {gapLabel(count)}
                    </span>
                  )}
                </td>
              </tr>
            )
          }

          const { row } = item
          return (
            <tr
              key={i}
              // The anchor the review's next/previous-change buttons jump to.
              data-diff-hunk={item.hunkStart ? '' : undefined}
              className={
                row.kind === 'add'
                  ? 'bg-[var(--diff-add-bg)]'
                  : row.kind === 'del'
                    ? 'bg-[var(--diff-del-bg)]'
                    : undefined
              }
            >
              {/* One line-number gutter that doubles as the change indicator: a
                  colored bar at the row's outer edge plus a tinted number, so no
                  second column and no +/− glyph is needed.

                  The numbers are the *new* file's, and a deleted line therefore
                  has none — it is not in that file. Printing its old number
                  instead is what a one-column unified diff usually does, and it
                  reads as a fault: a deletion at old line 70 between new lines
                  96 and 97 makes the ruler count 96, 70, 71, 97. Blank keeps the
                  column monotonic, which is the only thing a reader uses it for;
                  the bar and the tint already say the line was removed. The one
                  exception is a file deleted outright, where there is no new
                  side and blanking every row would leave no ruler at all. */}
              <td
                className={cn(
                  GUTTER,
                  row.kind === 'del'
                    ? 'border-l-[var(--diff-del-bar)] text-muted-foreground/45'
                    : row.kind === 'add'
                      ? 'border-l-[var(--diff-add-bar)] text-[var(--diff-add-num)]'
                      : 'border-l-transparent text-muted-foreground/45'
                )}
              >
                {row.kind === 'del' ? (oldRuler ? row.old : '') : (row.new ?? '')}
              </td>
              <td
                className={cn(
                  'pr-4 pl-3 align-top',
                  wrap ? '[overflow-wrap:anywhere] whitespace-pre-wrap' : 'whitespace-pre'
                )}
              >
                {row.kind === 'note' ? (
                  <span className="text-muted-foreground">{row.text}</span>
                ) : !row.text ? (
                  ' '
                ) : html ? (
                  <span dangerouslySetInnerHTML={{ __html: html[i] }} />
                ) : (
                  row.text
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
})

export const DiffView = React.memo(function DiffView({
  text,
  language,
  wrap,
  expand
}: {
  text: string | undefined
  language?: string
  wrap?: boolean
  expand?: ExpandDiff
}): React.JSX.Element {
  if (text === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <span className="shimmer-text">Loading diff…</span>
      </div>
    )
  }
  return (
    <div className="h-full overflow-auto">
      <DiffTable text={text} language={language} wrap={wrap} expand={expand} />
    </div>
  )
})

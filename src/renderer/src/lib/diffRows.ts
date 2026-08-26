/**
 * Unified-diff text → the rows a review renders, plus the fold math that turns
 * a *full-context* diff back into a folded one.
 *
 * Two shapes of "hidden lines" meet here and they are not the same thing:
 *
 * - Git elided them (`-U3`), so the diff text simply does not contain them.
 *   All we know is which line numbers they were — `@@` headers carry them, and
 *   the space between two headers is the gap. Such a gap can only be opened by
 *   asking git again with more context.
 * - *We* folded them, out of a diff fetched with enough context to cover the
 *   file. Those rows are in hand, so opening the gap is render state.
 *
 * `parseDiff` answers the first (`gaps`), `foldRanges` the second, and
 * `diffItems` merges them into one list so the view never has to know which
 * kind it is looking at: every gap names the new-file lines it hides, and
 * revealing them is one call either way.
 *
 * **Reveals are stored as line ranges, not row indices**, because the row list
 * is replaced wholesale the moment the full-context diff lands — the indices
 * the user clicked would name different lines in the array that answers them.
 * Line numbers mean the same thing in both.
 *
 * Dependency-free (no imports at all) so `node --test` runs the `.ts` directly.
 */

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'note'
  /** Line number in the old file — deletions and context. */
  old: number | null
  /** Line number in the new file — additions and context. */
  new: number | null
  text: string
}

/** An inclusive `[from, to]` span of new-file line numbers. */
export type LineRange = [number, number]
/** A half-open `[start, end)` window over a row list. */
export type RowRange = [number, number]

export interface ParsedDiff {
  rows: DiffRow[]
  /** Lines git elided, keyed by the row index the gap sits *before*. */
  gaps: Record<number, LineRange>
}

export type DiffItem =
  | { kind: 'row'; row: DiffRow; index: number; hunkStart: boolean }
  | { kind: 'gap'; count: number; lines: LineRange }
  | { kind: 'note'; text: string }

/** Context kept around a change when we fold a full-context diff ourselves. */
export const FOLD_CONTEXT = 3
/** Never fold away fewer lines than this — a two-line gap costs more than it saves. */
export const MIN_FOLD = 4
/** How many lines one directional expander reveals. */
export const EXPAND_STEP = 20

export function parseDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = []
  const gaps: Record<number, LineRange> = {}
  let oldN = 0
  let newN = 0
  let lastNew = 0 // highest new-file line number emitted so far
  // Track whether we're inside a hunk. Content lines only appear inside one, and
  // the `--- `/`+++ ` file headers only appear in a file's preamble — so a body
  // line like `-- comment` (diff line `--- comment`) must NOT be mistaken for a
  // header (which would drop it and desync every following line number).
  let inHunk = false
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '' && i === lines.length - 1) break
    if (line.startsWith('diff --git')) {
      // Start of a(nother) file: back into preamble.
      inHunk = false
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldN = Number(m[1])
        newN = Number(m[2])
        // Unchanged lines git elided between the last shown line and this hunk.
        if (newN - 1 > lastNew) gaps[rows.length] = [lastNew + 1, newN - 1]
      }
      inHunk = true
    } else if (!inHunk) {
      // Preamble: keep a binary-file notice; skip all other header noise.
      if (line.startsWith('Binary files')) {
        rows.push({ kind: 'note', old: null, new: null, text: line })
      }
    } else if (line.startsWith('+')) {
      const n = newN++
      lastNew = n
      rows.push({ kind: 'add', old: null, new: n, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', old: oldN++, new: null, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', old: null, new: null, text: line })
    } else if (line.startsWith(' ')) {
      const o = oldN++
      const n = newN++
      lastNew = n
      rows.push({ kind: 'ctx', old: o, new: n, text: line.slice(1) })
    } else {
      rows.push({ kind: 'note', old: null, new: null, text: line })
    }
  }
  return { rows, gaps }
}

/**
 * How many rows `parseDiff` will produce, without producing them.
 *
 * The changes view mounts a file's diff only when it is near the viewport, and
 * the placeholder standing in for the rest has to be the right height or the
 * scrollbar lies and scrolling back up jumps. Parsing every file to find out
 * would allocate a row object per line of a review that is mostly never looked
 * at, so this counts lines instead.
 *
 * It tracks `inHunk` for the same reason `parseDiff` does, and the trap is the
 * same one: `---` / `+++` are file headers in the preamble and body lines
 * inside a hunk. Deciding by marker instead — "three of its own marker in a row
 * must be a header" — is wrong, because the marker is stripped, so a deleted
 * Markdown rule is `----` on the wire and a deleted C++ `--x` is `---x`. Only
 * position tells them apart. Inside a hunk *every* line is a row, including the
 * blank ones and the `\ No newline` note; outside one, only a binary notice is.
 *
 * Pinned against `parseDiff` in `test/diffRows.test.ts`: the two must agree, or
 * the placeholder is a different size from the thing it stands in for.
 */
export function countRows(diff: string): number {
  let n = 0
  let inHunk = false
  let i = 0
  while (i <= diff.length) {
    // A trailing newline leaves an empty final line that is not a line at all —
    // `parseDiff` drops it, so this must too.
    if (i === diff.length && diff.length > 0) break
    const nl = diff.indexOf('\n', i)
    if (diff.startsWith('diff --git', i)) inHunk = false
    else if (diff.startsWith('@@', i)) inHunk = true
    else if (!inHunk) {
      if (diff.startsWith('Binary files', i)) n++
    } else n++
    if (nl === -1) break
    i = nl + 1
  }
  return n
}

/**
 * Merge overlapping or touching line spans so a reveal list cannot grow
 * unbounded. Spans are *inclusive*, so `[1,5]` and `[6,10]` are touching —
 * deliberately not shared with the half-open row windows, where the same
 * arithmetic would swallow the row between two adjacent ranges.
 */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: LineRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * The rows covering a set of new-file line spans. Deletions carry no new-file
 * line and so split a span into several windows — harmless, since a deletion is
 * a change and is never folded away in the first place.
 */
export function rowRangesForLines(rows: DiffRow[], lines: LineRange[]): RowRange[] {
  const out: RowRange[] = []
  for (const [lo, hi] of mergeRanges(lines)) {
    let start = -1
    for (let i = 0; i < rows.length; i++) {
      const n = rows[i].new
      const inside = n !== null && n >= lo && n <= hi
      if (inside && start === -1) start = i
      else if (!inside && start !== -1) {
        out.push([start, i])
        start = -1
      }
    }
    if (start !== -1) out.push([start, rows.length])
  }
  return out
}

/**
 * Which stretches of a full-context row list to hide: context rows further than
 * `context` from any change, minus everything the user has revealed, minus runs
 * too short to be worth folding.
 */
export function foldRanges(
  rows: DiffRow[],
  revealed: RowRange[] = [],
  context = FOLD_CONTEXT,
  minFold = MIN_FOLD
): RowRange[] {
  const keep = new Array<boolean>(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'ctx') continue
    // A change (or a `\ No newline` note) and everything within `context` of it.
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep[j] = true
    }
  }
  for (const [start, end] of revealed) {
    for (let i = Math.max(0, start); i < Math.min(rows.length, end); i++) keep[i] = true
  }

  const out: RowRange[] = []
  let run = -1
  for (let i = 0; i <= rows.length; i++) {
    const hidden = i < rows.length && !keep[i]
    if (hidden && run === -1) run = i
    else if (!hidden && run !== -1) {
      if (i - run >= minFold) out.push([run, i])
      run = -1
    }
  }
  return out
}

/** The line span a fold hides, read off the rows at its edges. */
function foldLines(rows: DiffRow[], [start, end]: RowRange): LineRange {
  const first = rows[start]?.new ?? 0
  const last = rows[end - 1]?.new ?? first
  return [first, last]
}

/**
 * The render list: rows interleaved with gaps, capped at `maxRows` *rendered*
 * rows. The cap counts what is drawn rather than what was parsed — a
 * full-context diff of a large file is mostly folded away, and truncating the
 * parse would drop rows nothing was going to render anyway.
 */
export function diffItems(
  parsed: ParsedDiff,
  opts: {
    /** True once the diff was refetched with enough context to cover the file. */
    full: boolean
    /** New-file line spans the user has opened. */
    revealed?: LineRange[]
    context?: number
    maxRows?: number
  }
): DiffItem[] {
  const { rows, gaps } = parsed
  const folds = opts.full
    ? foldRanges(rows, rowRangesForLines(rows, opts.revealed ?? []), opts.context)
    : []
  const foldAt = new Map<number, RowRange>()
  for (const f of folds) foldAt.set(f[0], f)

  const max = opts.maxRows ?? 5000
  const items: DiffItem[] = []
  // Whether the row emitted immediately before this one was itself a change —
  // read off what was *drawn*, not off `rows[i - 1]`, so a fold between two
  // changed runs correctly starts a second hunk.
  let prevChanged = false
  let drawn = 0
  let i = 0
  while (i < rows.length) {
    // Git's own elision first: its lines are not in `rows` at all, so a fold
    // starting at the same index describes a different set of lines.
    const elided = gaps[i]
    if (elided) {
      items.push({ kind: 'gap', count: elided[1] - elided[0] + 1, lines: elided })
      prevChanged = false
    }
    const fold = foldAt.get(i)
    if (fold) {
      items.push({ kind: 'gap', count: fold[1] - fold[0], lines: foldLines(rows, fold) })
      prevChanged = false
      i = fold[1]
      continue
    }
    if (drawn >= max) {
      items.push({ kind: 'note', text: '… diff truncated' })
      return items
    }
    const row = rows[i]
    const changed = row.kind === 'add' || row.kind === 'del'
    // A hunk starts at the first changed row of a run — the anchor the review's
    // next/previous-change buttons jump between.
    items.push({ kind: 'row', row, index: i, hunkStart: changed && !prevChanged })
    prevChanged = changed
    drawn++
    i++
  }
  return items
}

/** The slice one directional expander opens, from either end of a gap. */
export function expandStep(
  lines: LineRange,
  side: 'top' | 'bottom' | 'all',
  step = EXPAND_STEP
): LineRange {
  const [from, to] = lines
  if (side === 'all' || to - from + 1 <= step) return [from, to]
  return side === 'top' ? [from, from + step - 1] : [to - step + 1, to]
}

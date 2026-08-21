/**
 * Mapping a text selection in the file viewer onto a line range.
 *
 * The viewer renders the file as one highlight.js blob, so there is no per-line
 * element to read a number off — the only durable anchor is the *character
 * offset* into the file's own text, which the highlighted `<span>` structure
 * cannot change. Offsets come from the DOM (`offsetsInNode`), everything after
 * that is arithmetic on the source string and is pinned by tests.
 *
 * Dependency-free on purpose: `test/codeSelection.test.ts` runs this `.ts`
 * directly under `node --test`, with no bundler.
 */

export interface LineSelection {
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** The whole lines the selection touched, verbatim. */
  text: string
  /** `text` was cut at the cap; the line range still names every line. */
  truncated: boolean
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * Widen a raw character range to the whole lines it touches.
 *
 * Selecting half an identifier should still hand the agent a runnable line, and
 * a range reported as "lines 12-14" has to *be* lines 12-14 or the reference
 * lies. Two edges matter:
 *
 * - A drag that ends on the next line's first column includes the newline that
 *   terminates the last line the user actually saw highlighted. Counting it
 *   would report one line too many, so trailing newlines are backed off first.
 * - A collapsed or reversed range is not a selection; callers get null rather
 *   than a one-line range they would have to special-case.
 */
export function lineSelection(
  text: string,
  from: number,
  to: number,
  cap = Infinity
): LineSelection | null {
  const start = Math.max(0, Math.min(from, to))
  let end = Math.min(text.length, Math.max(from, to))
  if (end <= start) return null

  // Back off the newlines a downward drag swept up on its way to column 0 of
  // the following line. Guarded at `start` so a selection of nothing but blank
  // lines still resolves to the line it began on.
  while (end > start && text.charCodeAt(end - 1) === 10) end--

  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak

  const startLine = countNewlines(text, 0, lineStart) + 1
  const endLine = startLine + countNewlines(text, lineStart, lineEnd)

  const full = text.slice(lineStart, lineEnd)
  if (full.length <= cap) return { startLine, endLine, text: full, truncated: false }

  // Cut on a line boundary where one exists in range: half a line of code reads
  // as a syntax error rather than as an excerpt.
  const cut = full.lastIndexOf('\n', cap)
  return {
    startLine,
    endLine,
    text: full.slice(0, cut > 0 ? cut : cap),
    truncated: true
  }
}

/** `foo.ts:12` for one line, `foo.ts:12-30` for a run. */
export function selectionLabel(name: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${name}:${startLine}` : `${name}:${startLine}-${endLine}`
}

/**
 * Character offsets of `range` within `node`'s text, clamped to it.
 *
 * A drag that begins in the line-number gutter (a sibling `<pre>`) or ends past
 * the end of the code produces boundary points outside `node`; comparing
 * against the node's own range is what turns those into 0 / length instead of a
 * `setEnd` that throws.
 */
export function offsetsInNode(node: Node, range: Range): { from: number; to: number } | null {
  const whole = document.createRange()
  whole.selectNodeContents(node)
  // No overlap at all — the selection is somewhere else on the page entirely.
  if (
    range.compareBoundaryPoints(Range.START_TO_END, whole) < 0 ||
    range.compareBoundaryPoints(Range.END_TO_START, whole) > 0
  ) {
    return null
  }
  const length = whole.toString().length
  // Text from the node's start up to a boundary point *is* that point's offset.
  const offsetOf = (container: Node, offset: number, fallback: number): number => {
    const probe = document.createRange()
    probe.selectNodeContents(node)
    try {
      probe.setEnd(container, offset)
    } catch {
      return fallback
    }
    return probe.toString().length
  }
  const from =
    range.compareBoundaryPoints(Range.START_TO_START, whole) < 0
      ? 0
      : offsetOf(range.startContainer, range.startOffset, 0)
  const to =
    range.compareBoundaryPoints(Range.END_TO_END, whole) > 0
      ? length
      : offsetOf(range.endContainer, range.endOffset, length)
  return { from, to }
}

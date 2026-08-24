/**
 * Mapping a text selection in the editor onto a line range.
 *
 * The anchor is the *character offset* into the file's own text. That was
 * originally the only thing that survived highlight.js's `<span>` structure,
 * which had no per-line element to read a number off; CodeMirror reports its
 * selection in exactly the same units, so the arithmetic below outlived the DOM
 * it was written for and the `offsetsInNode` half that measured it is gone.
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

/**
 * Back off the newlines a downward drag swept up on its way to column 0 of the
 * following line — counting them would report one line too many. Guarded at
 * `from` so a selection of nothing but blank lines still resolves to the line it
 * began on.
 *
 * The character accessor is a parameter so this module stays dependency-free
 * (`test/codeSelection.test.ts` runs the `.ts` directly under `node --test`).
 * That is also what lets the editor share the rule: it reads characters off
 * CodeMirror's rope rather than off a string, because materializing the
 * document to apply four lines of arithmetic is the per-frame allocation the
 * selection pill exists to avoid.
 */
export function trimTrailingNewlines(
  from: number,
  to: number,
  charCodeAt: (index: number) => number
): number {
  let end = to
  while (end > from && charCodeAt(end - 1) === 10) end--
  return end
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
  const raw = Math.min(text.length, Math.max(from, to))
  if (raw <= start) return null
  const end = trimTrailingNewlines(start, raw, (i) => text.charCodeAt(i))

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

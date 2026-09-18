/**
 * A passage selected in the transcript, as prompt text and as a chip label.
 *
 * The two halves are deliberately different shapes. What goes to the model is
 * the selection **verbatim** — its line breaks, its indentation, the code fence
 * it was dragged across — because that is what the reader was pointing at. What
 * goes on the chip is one flat line, because a chip sized to its lines would
 * push the composer's own controls off the row (the same rule the file
 * selection's chip already follows).
 *
 * Dependency-free on purpose, like `codeSelection.ts`:
 * `test/quoteSelection.test.ts` runs this `.ts` directly under `node --test`,
 * with no bundler. The cap is a parameter rather than an import for the same
 * reason — `QUOTE_MAX_CHARS` lives on the contract in `@shared/types`.
 */

export interface Quote {
  /** The passage verbatim, with its outer whitespace trimmed, cut at the cap. */
  text: string
  /** `text` was cut. Unlike a file selection this loses the rest for good. */
  truncated: boolean
}

/**
 * How far back a cut will walk to land on whitespace rather than mid-word.
 *
 * A cap that lands inside the last word reads as a typo rather than as a cut;
 * walking back the whole string to find a space would drop most of a passage
 * that legitimately has none (one long path, one minified line), so the search
 * is bounded and a cut with no whitespace in reach is simply taken where it
 * fell.
 */
const BACKOFF = 200

/**
 * Normalize what `Selection.toString()` gave us into a quotable passage.
 *
 * Only the *ends* are trimmed. Collapsing the inside would be wrong twice over:
 * a passage dragged across a code block loses its indentation, and a passage
 * spanning paragraphs loses the blank lines that say where one ended — and the
 * model is being asked about the text as it was read.
 *
 * Whitespace alone is not a selection. A click that lands between two blocks
 * can leave a range holding one newline, and quoting that would put an empty
 * fence in the prompt; callers get `null` rather than a quote of nothing.
 */
export function quoteText(raw: string, cap = Infinity): Quote | null {
  const text = raw.trim()
  if (!text) return null
  if (text.length <= cap) return { text, truncated: false }

  const cut = text.slice(0, cap)
  // The start of the whitespace run before the last (part-)word in the cut.
  // `> 0` as well as in reach: a cut with no whitespace at all reports -1, and
  // -1 is in reach of every cap smaller than the backoff.
  const space = cut.search(/\s+\S*$/)
  const at = space > 0 && space > cap - BACKOFF ? space : cap
  const kept = text.slice(0, at).trimEnd()
  // A cap shorter than the first word leaves nothing to back off to; the hard
  // cut is then the honest answer, and `truncated` is what says so.
  return { text: kept || cut, truncated: true }
}

/**
 * The chip's label: one line, short enough to sit beside the composer's other
 * chips and long enough to recognize which passage it is.
 *
 * A label that was cut says so with an ellipsis: one that silently stops reads
 * as the whole quote, and the whole quote is the thing the reader is about to
 * ask a question about. Flattening is not cutting — a short passage that ran
 * over two lines is shown entire, on one.
 */
export function quoteLabel(text: string, max = 34): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

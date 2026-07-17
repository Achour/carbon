/**
 * Splits streaming markdown into sealed chunks plus a live tail, so the
 * renderer can keep the parse of everything that can no longer change
 * memoized and re-parse only the tail on each streaming commit.
 *
 * A seal boundary is the start of a line that
 *  - follows at least one blank line,
 *  - is outside any fenced code block, and
 *  - starts a block that cannot merge backwards into the previous one:
 *    indented lines never qualify and a list item qualifies only when the
 *    previous block wasn't itself a list (a loose list or indented code block
 *    would render differently if split mid-block); everything else —
 *    paragraphs, headings, fences, quotes, tables — starts fresh after a
 *    blank line, so a whole list seals as one piece.
 *
 * Boundaries only ever move forward as the text grows (the split is greedy
 * from the start, and streamed text is append-only), so a sealed chunk's
 * string is stable and a memoized renderer keyed on it never re-parses.
 * The split is re-derived from the full text every call, so a misjudged
 * boundary can only cost an extra parse, never a wrong final render — and the
 * turn's end swaps in a single full-text parse anyway (which also resolves
 * cross-chunk link/footnote references).
 */

/** Below this many characters a chunk keeps accumulating blocks before sealing. */
const MIN_CHUNK_CHARS = 1200

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
// An opening backtick fence's info string cannot contain a backtick; tilde
// fences allow anything. More than 3 leading spaces is indented code, not a fence.
const FENCE_OPEN = /^ {0,3}(`{3,}[^`]*|~{3,}.*)$/

const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(\s|$)/

export function splitMarkdownStream(
  text: string,
  minChunk = MIN_CHUNK_CHARS
): { chunks: string[]; tail: string } {
  const chunks: string[] = []
  let chunkStart = 0
  let fence: { char: string; len: number } | null = null
  let prevBlank = false
  // Whether the last non-blank line (outside fences) was a list marker or
  // indented — i.e. a following list item / indented line could still belong
  // to the same block, across any number of blank lines (loose lists).
  let prevListish = false
  let pos = 0
  while (pos < text.length) {
    let end = text.indexOf('\n', pos)
    if (end === -1) end = text.length
    const line = text.slice(pos, end)
    const blank = line.trim() === ''
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null
      // Blank lines inside a fence are content, never boundaries.
      prevBlank = false
    } else {
      const indented = /^\s/.test(line)
      const listish = !blank && (indented || LIST_MARKER.test(line))
      const sealSafe = !indented && (!listish || !prevListish)
      if (prevBlank && !blank && pos - chunkStart >= minChunk && sealSafe) {
        chunks.push(text.slice(chunkStart, pos))
        chunkStart = pos
      }
      const open = FENCE_OPEN.exec(line)
      if (open) {
        const char = open[1][0] as '`' | '~'
        let len = 1
        while (len < open[1].length && open[1][len] === char) len++
        fence = { char, len }
      }
      prevBlank = blank
      if (!blank) prevListish = listish
    }
    pos = end + 1
  }
  return { chunks, tail: text.slice(chunkStart) }
}

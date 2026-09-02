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
 *
 * **An open code fence is reported separately, because it can never seal.**
 * Nothing inside a fence is a boundary — that is what keeps the split correct
 * — so a fence is the one block whose live tail grows without bound, and an
 * agent writing a file into chat is precisely that case: a 400-line block is
 * ~16 KB of markdown re-parsed, re-highlighted and rebuilt into thousands of
 * token spans on *every* commit. `code` hands the caller the fence's body as
 * opaque text so it can render it as code directly, bypassing the markdown
 * parse entirely (a fence's content has no markdown in it by definition) and
 * letting it keep finished lines untouched. The four pieces partition the
 * input, so a caller that declines the offer — a `mermaid` fence, whose block
 * renders a diagram rather than code — restores the original text exactly by
 * appending `open` and `body` back onto `tail`.
 *
 * Only a fence at column 0 is offered. An indented one is a list item's
 * content, and lifting it out would render the code block outside the list it
 * belongs to; a fence *after* a list is still offered, since a column-0 fence
 * cannot be list content — which is why the gate reads `indented` alone and
 * deliberately not the `prevListish` the sealing rule needs. They are two
 * different questions, and sharing one answer is how the next change to the
 * seal heuristic would silently move this gate.
 */

/** Below this many characters a chunk keeps accumulating blocks before sealing. */
const MIN_CHUNK_CHARS = 1200

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
// An opening backtick fence's info string cannot contain a backtick; tilde
// fences allow anything. More than 3 leading spaces is indented code, not a fence.
const FENCE_OPEN = /^ {0,3}(`{3,}[^`]*|~{3,}.*)$/

const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(\s|$)/

/** A fenced code block that is still open at the end of the streamed text. */
export interface OpenFence {
  /** The info string verbatim (`ts`, `896:905:src/a.ts`, or empty). */
  info: string
  /** The fence-open line and its newline. */
  open: string
  /** The code streamed so far, excluding the opening fence line. */
  body: string
}

interface MarkdownStreamSplit {
  chunks: string[]
  tail: string
  code: OpenFence | null
}

/** A fence being tracked mid-scan; every fact about it is captured where it opens. */
interface Fence {
  char: string
  len: number
  start: number
  bodyStart: number
  info: string
  /**
   * Whether this fence can be lifted out of the markdown parse: only one at
   * column 0, since an indented fence is a list item's content and lifting it
   * would re-render the list around it.
   */
  liftable: boolean
}

export function splitMarkdownStream(
  text: string,
  minChunk = MIN_CHUNK_CHARS
): MarkdownStreamSplit {
  const chunks: string[] = []
  let chunkStart = 0
  let fence: Fence | null = null
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
      const opened = FENCE_OPEN.exec(line)
      if (opened) {
        const marker = opened[1]
        const char = marker[0] as '`' | '~'
        let len = 1
        while (len < marker.length && marker[len] === char) len++
        // Everything this fence needs is known here, where the line is already
        // parsed — reading it back off `text` afterwards parses it a second
        // time and gives the two readings a chance to disagree.
        fence = {
          char,
          len,
          start: pos,
          // `slice` clamps, so a fence line with no newline yet yields no body.
          bodyStart: end + 1,
          info: marker.slice(len).trim(),
          liftable: !indented
        }
      }
      prevBlank = blank
      if (!blank) prevListish = listish
    }
    pos = end + 1
  }

  if (fence?.liftable) {
    // The fence-open line belongs to neither side, so it rides `open` and the
    // four pieces partition the input: chunks + tail + open + body === text.
    return {
      chunks,
      tail: text.slice(chunkStart, fence.start),
      code: {
        info: fence.info,
        open: text.slice(fence.start, fence.bodyStart),
        body: text.slice(fence.bodyStart)
      }
    }
  }

  return { chunks, tail: text.slice(chunkStart), code: null }
}

// A link or footnote *definition* — `[id]: url`, `[^1]: note` — anywhere in
// the text. Its references may sit in another chunk, and a chunk parsed alone
// cannot see a definition it does not hold.
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/m
// The HTML block kinds CommonMark lets run across blank lines (types 1 and 2),
// so a seal boundary inside one would cut the block in half.
const SPANNING_HTML_BLOCK = /^ {0,3}<(?:pre|script|style|textarea)\b|^ {0,3}<!--/im

/**
 * Whether *settled* text has to be parsed whole rather than as the chunks it
 * streamed in as.
 *
 * A finished reply keeps the chunked render it streamed with — same
 * component, same chunk strings, so the moment it stops streaming changes
 * nothing on screen — and that leaves the seal heuristic without the single
 * full parse that used to catch what it cannot see. The heuristic is right
 * about everything that is local to a line (a fence, a list, a heading, a
 * table), and wrong about exactly two things that are not: a reference
 * definition, which resolves links and footnotes in *other* chunks, and an
 * HTML block that may span a blank line. Both are visible in the text itself,
 * so this is the one test that decides which render a settled message gets.
 * A false positive costs one whole parse at settle — the old behaviour — and
 * never a wrong render.
 */
export function needsWholeParse(text: string): boolean {
  return REFERENCE_DEFINITION.test(text) || SPANNING_HTML_BLOCK.test(text)
}

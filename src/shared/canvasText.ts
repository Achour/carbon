/**
 * A canvas as readable text, for handing to a model.
 *
 * A canvas is an HTML *document* — its own `<style>`, often its own `<script>`,
 * and markup written to be looked at rather than parsed. Pasting that verbatim
 * into a prompt spends thousands of tokens on CSS the model cannot act on and
 * buries the twelve rows of the table that were the point. So the attachment
 * carries the *content*, extracted the way a reader sees it, and the canvas id
 * beside it (see `describeCanvas`) for when the answer is "revise it" and the
 * full HTML is genuinely needed.
 *
 * That is `describeSelection`'s bargain exactly: the snippet answers "what does
 * this say" with no tool call, the reference is how the agent finds it again.
 *
 * Regex over a parser because this file must stay dependency-free — the
 * renderer builds the attachment, `node --test` runs the test directly, and
 * neither may pull in a DOM. The output is read by a model rather than
 * rendered, so the bar is "the words in the right order", not fidelity.
 */

/**
 * Block-level tags whose close is a line break in the reading. A canvas is
 * mostly headings, rows and list items, so without this the whole document
 * arrives as one paragraph of run-together words.
 */
const BLOCK_CLOSE =
  /<\/(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|tr|table|thead|tbody|blockquote|pre|figure|figcaption|dt|dd|dl|form|fieldset|details|summary)\s*>/gi

/** Self-closing breaks, which end a line without closing anything. */
const BREAKS = /<(?:br|hr)\s*\/?>/gi

/**
 * A cell boundary is a *column* boundary, not a line one.
 *
 * This is the case that decides whether the extraction is worth having: a
 * comparison table is the single most common thing a canvas holds, and
 * stripping its tags without this turns "Vite 2.1s | webpack 14.8s" into
 * "Vite2.1swebpack14.8s" — every number silently reassigned to the wrong row.
 */
const CELL_CLOSE = /<\/(?:td|th)\s*>/gi

/**
 * Elements whose *content* is not prose: markup, styling, code the reader never
 * sees — and `<title>`, which is not read as part of the document at all. A
 * canvas almost always repeats its `<title>` as its `<h1>`, and the attachment
 * carries the title separately, so keeping it opens every extraction with the
 * name said twice.
 */
const OPAQUE = /<(script|style|template|noscript|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

const COMMENT = /<!--[\s\S]*?-->/g

const TAG = /<[^>]*>/g

/**
 * One table cell, so the breaks *inside* it can be flattened before the general
 * pass runs.
 *
 * A cell is frequently richer than a word — `<td><p>Fast</p><small>see note
 * 3</small></td>` is ordinary authored HTML — and its `</p>` is a block close
 * like any other, so without this the row it belongs to is cut in half and its
 * remaining columns land on a line of their own, unlabelled. A break inside a
 * cell is layout within one value, not a new row.
 */
const CELL_BODY = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi

/** The handful that actually appear in authored HTML, plus numeric escapes. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  times: '×',
  middot: '·',
  bull: '•',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  check: '✓',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      // A bad escape stays as it was written rather than becoming a replacement
      // character: it is more likely to be literal text than a broken entity.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * The readable text of a canvas, capped.
 *
 * Returns `truncated` rather than silently cutting, so the caller can say so —
 * a document that stops mid-sentence with no note reads to the model as the
 * whole document, and it will answer about a table whose last rows it never saw.
 */
export function canvasText(html: string, cap: number): { text: string; truncated: boolean } {
  // Sentinels rather than the characters themselves, because HTML's own
  // whitespace rule has to be applied *between* the two steps: every run of
  // whitespace in a text node collapses to one space, so the newlines in the
  // source (the indentation between `</tr>` and the next `<tr>`) carry no
  // meaning and must not survive. Injecting `\n` directly makes the two kinds
  // indistinguishable, and a table then arrives double-spaced — a blank line
  // between every row of the comparison the canvas exists to show.
  const BREAK = '\u0000'
  const CELL = '\u0001'
  const stripped = (html ?? '')
    .replace(COMMENT, ' ')
    .replace(OPAQUE, ' ')
    // Flatten breaks within a cell first, so the row survives a rich one.
    .replace(CELL_BODY, (whole, tag: string, body: string) =>
      `<${tag}>${body.replace(BLOCK_CLOSE, ' ').replace(BREAKS, ' ')}</${tag}>`
    )
    .replace(CELL_CLOSE, CELL)
    .replace(BLOCK_CLOSE, BREAK)
    .replace(BREAKS, BREAK)
    .replace(TAG, ' ')

  const text = decodeEntities(stripped)
    // HTML's rule, applied to everything that is not one of our own breaks.
    .replace(/[^\S\u0000\u0001]+/g, ' ')
    .split(BREAK)
    .map((line) =>
      line
        .split(CELL)
        .map((cell) => cell.trim())
        // A row ends with a cell close, so its last segment is empty — there is
        // no column after the final one to separate.
        .filter((cell, i, all) => cell !== '' || (i > 0 && i < all.length - 1))
        .join(' | ')
        .trim()
    )
    .filter((line) => line !== '')
    .join('\n')
    .trim()

  if (text.length <= cap) return { text, truncated: false }
  // Cut on a line boundary when one is near, so the tail isn't half a table row.
  const head = text.slice(0, cap)
  const nl = head.lastIndexOf('\n')
  return { text: (nl > cap * 0.6 ? head.slice(0, nl) : head).trimEnd(), truncated: true }
}

/**
 * Cuts a highlight.js HTML string into one balanced HTML string per line.
 *
 * This exists so a *streaming* code block can be drawn as a list of memoized
 * rows: a finished line's HTML is then a stable string, so React leaves its
 * DOM completely alone and each commit touches only the line still being
 * typed. Rebuilding the whole block instead is what a single
 * `dangerouslySetInnerHTML` (or a remark re-parse) does, and on a 400-line
 * block that is thousands of token spans thrown away and recreated ~8 times a
 * second.
 *
 * **The whole body is highlighted first, and only then cut.** Highlighting
 * line by line is the obvious cheaper route and is wrong: highlight.js carries
 * state across lines, so a block comment, a template literal or an unterminated
 * string colors every line below it, and lines highlighted in isolation
 * disagree with the finished block. (highlight.js dropped the `continuation`
 * parameter that used to expose that state in v11, so there is no incremental
 * API to use instead — but a full re-highlight measures ~3 ms at 400 lines,
 * where the DOM rebuild it replaces measures tens of ms.) It also means a
 * quote opened high in the file correctly *re*-colors the lines above the
 * cursor as it streams: those rows' strings change, so exactly those rows
 * re-render.
 *
 * A span left open at a line's end is closed at the break and reopened on the
 * next line, so every line stands alone as parseable HTML — the same trick a
 * terminal renderer uses for wrapped ANSI runs. highlight.js emits nothing but
 * `<span class=…>`, `</span>` and escaped text, and its escaping covers `<`,
 * `>` and `&`, so the scanner only has to balance that one tag and no attribute
 * value can fool the search for the closing `>`.
 *
 * **Scanning the HTML is the level to work at, not a shortcut.** hljs does
 * build a token tree, but `result._emitter` is marked private and its `walk`
 * and `rootNode` are absent from the exported `Emitter` type, and the only
 * public route to a custom emitter — `hljs.configure({ __emitter })` — is
 * global, so it would change what the diff view renders too. Reaching for
 * either would also give this module a dependency, and dependency-free is what
 * lets `node --test` run the `.ts` directly.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  // The open `<span …>` tags, in order, so a line break can close them all and
  // the next line can reopen them verbatim.
  const open: string[] = []
  let cur = ''
  let i = 0
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      const end = html.indexOf('>', i)
      // A truncated final tag can only come from malformed input; keep it as
      // text rather than dropping characters the caller handed us.
      if (end === -1) {
        cur += html.slice(i)
        break
      }
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('</')) open.pop()
      else if (!tag.endsWith('/>')) open.push(tag)
      cur += tag
      i = end + 1
      continue
    }
    if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      i++
      continue
    }
    // Copy the whole run of plain text at once — per-character concatenation of
    // a 20 KB body is the one thing in here that would actually cost something.
    let j = i + 1
    while (j < html.length && html[j] !== '<' && html[j] !== '\n') j++
    cur += html.slice(i, j)
    i = j
  }
  lines.push(cur + '</span>'.repeat(open.length))
  return lines
}

/**
 * YAML frontmatter, split off a Markdown file before it is parsed as Markdown.
 *
 * A leading `---` is a thematic break to CommonMark, the key/value lines that
 * follow are a paragraph, and the closing `---` turns that paragraph into a
 * **setext H2** — so an unhandled frontmatter block renders as one giant bold
 * heading, which is exactly what the preview used to show. Every Markdown
 * viewer worth the name (Zed, GitHub, Obsidian) parses it out instead; here it
 * becomes a small key/value table above the document.
 *
 * This is a *display* split, not a YAML parser: values are kept as written
 * (quotes and all), because guessing at a scalar's real value would be a
 * quieter kind of lie than showing the source line.
 *
 * Dependency-free on purpose — `test/frontmatter.test.ts` runs it under
 * `node --test` with no bundler.
 */

export type FrontmatterPair = { key: string; value: string }

export type Frontmatter = {
  pairs: FrontmatterPair[]
  /** The document with the frontmatter block removed. */
  body: string
}

const FENCE = /^---[ \t]*$/
// `description: Use when the user asks "explain", …` — the value owns every
// colon after the first, so the split is on the first one only.
const PAIR = /^([^\s:][^:]*):[ \t]*(.*)$/

/** Removes the smallest indent shared by every line, so nesting reads as nesting. */
function dedent(lines: string[]): string {
  let min = Infinity
  for (const line of lines) {
    if (!line.trim()) continue
    min = Math.min(min, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(min) || min === 0) return lines.join('\n')
  return lines.map((l) => l.slice(min)).join('\n')
}

/**
 * Returns the parsed frontmatter and the remaining document, or `null` when the
 * text does not open with a complete, non-empty frontmatter block — in which
 * case the leading `---` really is a thematic break and normal Markdown
 * rendering is the correct answer.
 */
export function splitFrontmatter(text: string): Frontmatter | null {
  // Cheap first look, so a file with no frontmatter is never split into lines —
  // this runs on every preview, and a preview can be megabytes.
  if (!/^﻿?---[ \t]*\r?(\n|$)/.test(text)) return null
  const lines = text.replace(/^﻿/, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1)
  }
  if (!FENCE.test(lines[0] ?? '')) return null

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      close = i
      break
    }
  }
  // No closing fence: this is an hr followed by prose, not frontmatter.
  if (close === -1) return null

  const pairs: FrontmatterPair[] = []
  // Continuation lines of the pair being built, kept raw so `dedent` can see
  // their relative indentation.
  let cont: string[] = []

  const flush = (): void => {
    if (!pairs.length) return
    if (!cont.length) return
    const last = pairs[pairs.length - 1]
    const extra = dedent(cont)
    last.value = last.value ? `${last.value}\n${extra}` : extra
    cont = []
  }

  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    // Indented — or anything that isn't `key: value` — belongs to the key above
    // it (`metadata:` / `  type: user`, block scalars, list items).
    const isContinuation = /^[ \t]/.test(line) || !PAIR.test(line)
    if (isContinuation) {
      // A stray line before any key at all means this block isn't a mapping.
      if (!pairs.length) return null
      cont.push(line)
      continue
    }
    flush()
    const m = PAIR.exec(line)!
    pairs.push({ key: m[1].trim(), value: m[2].trimEnd() })
  }
  flush()

  if (!pairs.length) return null

  // Drop the blank line(s) that conventionally follow the closing fence, so the
  // body starts at its first real block.
  let start = close + 1
  while (start < lines.length && !lines[start].trim()) start++
  return { pairs, body: lines.slice(start).join('\n') }
}

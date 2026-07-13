import * as React from 'react'
import { highlightLine } from '@/lib/highlight'

const MAX_ROWS = 5000

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  old: number | null
  new: number | null
  text: string
  /** For hunk rows: how many unchanged lines git elided before this hunk. */
  hidden?: number
}

function parseDiff(diff: string): Row[] {
  const rows: Row[] = []
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
    if (rows.length >= MAX_ROWS) {
      rows.push({ kind: 'note', old: null, new: null, text: '… diff truncated' })
      break
    }
    if (line.startsWith('diff --git')) {
      // Start of a(nother) file: back into preamble.
      inHunk = false
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      let hidden = 0
      if (m) {
        oldN = Number(m[1])
        newN = Number(m[2])
        // Unchanged lines git elided between the last shown line and this hunk.
        hidden = Math.max(0, newN - 1 - lastNew)
      }
      inHunk = true
      rows.push({ kind: 'hunk', old: null, new: null, text: line, hidden })
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
  return rows
}

/** The bare diff table (no scroll wrapper) — used standalone and stacked in the
 *  multi-file changes view. */
export const DiffTable = React.memo(function DiffTable({
  text,
  language
}: {
  text: string
  /** highlight.js language id; when set, code lines are syntax-highlighted. */
  language?: string
}): React.JSX.Element {
  const rows = React.useMemo(() => parseDiff(text), [text])
  // Per-line hljs HTML for code rows (null when no language is known).
  const html = React.useMemo(
    () =>
      language
        ? rows.map((r) =>
            r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx'
              ? highlightLine(r.text, language)
              : ''
          )
        : null,
    [rows, language]
  )

  if (rows.length === 0) {
    return <div className="px-3 py-2.5 text-xs text-muted-foreground/70">No textual changes.</div>
  }

  return (
    <table className="w-full border-collapse font-mono text-[length:var(--code-font-size)] leading-relaxed">
      <tbody>
        {rows.map((row, i) => {
          // Hunk boundaries: a full-width fold bar standing in for the unchanged
          // lines git elided, Cursor-style — never git's raw "@@ … @@" heading.
          if (row.kind === 'hunk') {
            return (
              <tr key={i}>
                <td
                  colSpan={2}
                  className="border-y border-border/30 bg-muted/20 px-3 py-[3px] text-[10.5px] text-muted-foreground/55 select-none"
                >
                  {row.hidden
                    ? `⋯  ${row.hidden} unmodified line${row.hidden === 1 ? '' : 's'}`
                    : '⋯'}
                </td>
              </tr>
            )
          }
          return (
            <tr
              key={i}
              className={
                row.kind === 'add'
                  ? 'bg-emerald-500/10'
                  : row.kind === 'del'
                    ? 'bg-red-500/10'
                    : undefined
              }
            >
              {/* A single line-number gutter that doubles as the change indicator:
                  a colored left bar + tinted number (new line for adds/context, old
                  line for deletions), so no second column or +/− glyph is needed. */}
              <td
                className={
                  'w-11 min-w-11 border-r border-l-2 border-border/40 pr-2 text-right align-top text-[10px] select-none ' +
                  (row.kind === 'del'
                    ? 'border-l-red-500/70 text-red-500/80'
                    : row.kind === 'add'
                      ? 'border-l-emerald-500/70 text-emerald-600/90 dark:text-emerald-400/90'
                      : 'border-l-transparent text-muted-foreground/50')
                }
              >
                {row.new ?? row.old ?? ''}
              </td>
              <td className="pr-1.5 pl-2.5 align-top break-all whitespace-pre-wrap">
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
  language
}: {
  text: string | undefined
  language?: string
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
      <DiffTable text={text} language={language} />
    </div>
  )
})

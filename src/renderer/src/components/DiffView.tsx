import * as React from 'react'
import { highlightLine } from '@/lib/highlight'

const MAX_ROWS = 5000

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  old: number | null
  new: number | null
  text: string
}

const SKIP_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to'
]

function parseDiff(diff: string): Row[] {
  const rows: Row[] = []
  let oldN = 0
  let newN = 0
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '' && i === lines.length - 1) break
    if (rows.length >= MAX_ROWS) {
      rows.push({ kind: 'note', old: null, new: null, text: '… diff truncated' })
      break
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldN = Number(m[1])
        newN = Number(m[2])
      }
      rows.push({ kind: 'hunk', old: null, new: null, text: line })
    } else if (SKIP_PREFIXES.some((p) => line.startsWith(p))) {
      // file-level headers add noise for a single-file diff
    } else if (line.startsWith('Binary files')) {
      rows.push({ kind: 'note', old: null, new: null, text: line })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', old: null, new: newN++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', old: oldN++, new: null, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', old: null, new: null, text: line })
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'ctx', old: oldN++, new: newN++, text: line.slice(1) })
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
        {rows.map((row, i) => (
          <tr
            key={i}
            className={
              row.kind === 'add'
                ? 'bg-emerald-500/10'
                : row.kind === 'del'
                  ? 'bg-red-500/10'
                  : row.kind === 'hunk'
                    ? 'bg-accent/40'
                    : undefined
            }
          >
            <td className="w-10 min-w-10 border-r border-border/40 pr-2 text-right align-top text-[10px] text-muted-foreground/50 select-none">
              {row.old ?? ''}
            </td>
            <td className="w-10 min-w-10 border-r border-border/40 pr-2 text-right align-top text-[10px] text-muted-foreground/50 select-none">
              {row.new ?? ''}
            </td>
            <td
              className={
                'w-4 min-w-4 text-center align-top select-none ' +
                (row.kind === 'add'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : row.kind === 'del'
                    ? 'text-red-500'
                    : 'text-transparent')
              }
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </td>
            <td className="px-1.5 align-top break-all whitespace-pre-wrap">
              {row.kind === 'hunk' ? (
                // Drop the raw "@@ -a,b +c,d @@" markers; keep the context that
                // follows (the enclosing function/line), Cursor-style.
                <span className="text-muted-foreground/60">
                  {(() => {
                    const ctx = row.text.replace(/^@@[^@]*@@\s?/, '').trim()
                    return ctx ? `⋯  ${ctx}` : '⋯'
                  })()}
                </span>
              ) : row.kind === 'note' ? (
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
        ))}
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

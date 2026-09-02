/**
 * A line diff of two strings, for the Edit card.
 *
 * `old_string` and `new_string` used to be drawn as two blocks — everything
 * removed in red, everything added in green — which for a one-line change
 * inside a twenty-line anchor meant reading forty lines to find the one that
 * moved. A diff shows the change and only the change, and it also renders
 * *progressively*: `new_string` streams into the card as the model types it
 * (`ToolPart.partial`), and each prefix diffs against the full `old_string` on
 * its own.
 *
 * LCS over lines with the common prefix and suffix trimmed first — an edit's
 * two strings share almost all of their lines by construction, so the DP runs
 * over the few that differ. Past `MAX_CELLS` the quadratic table is not worth
 * building for a display, and the whole thing degrades to the two-block answer
 * it replaces. Dependency-free, so `node --test` runs `test/lineDiff.test.ts`
 * against the `.ts` directly.
 */

export type DiffLineKind = 'ctx' | 'del' | 'add'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Above this many DP cells the diff falls back to remove-all/add-all. */
const MAX_CELLS = 250_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // A trailing newline is a terminator, not an empty last line: `"a\n"` is one
  // line, and drawing a blank row for it makes every block one line too tall.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const out: DiffLine[] = []

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  for (let i = 0; i < start; i++) out.push({ kind: 'ctx', text: a[i] })

  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) out.push({ kind: 'del', text: a[i] })
    for (let j = start; j < endB; j++) out.push({ kind: 'add', text: b[j] })
  } else {
    // lcs[i][j] = length of the LCS of a[start+i..endA) and b[start+j..endB).
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ kind: 'ctx', text: a[start + i] })
        i++
        j++
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        // Deletions before additions at a divergence, so a replaced line reads
        // as "was this, is now this" rather than the other way round.
        out.push({ kind: 'del', text: a[start + i] })
        i++
      } else {
        out.push({ kind: 'add', text: b[start + j] })
        j++
      }
    }
    for (; i < n; i++) out.push({ kind: 'del', text: a[start + i] })
    for (; j < m; j++) out.push({ kind: 'add', text: b[start + j] })
  }

  for (let i = endA; i < a.length; i++) out.push({ kind: 'ctx', text: a[i] })
  return out
}

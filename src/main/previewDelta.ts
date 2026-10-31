/**
 * What an action changed on the page, as the few snapshot lines that moved.
 *
 * Without it an action reported only navigation, console errors and failed
 * requests, so the agent looked again after nearly every click: a screenshot,
 * a snapshot, or a hand-written `preview_evaluate` reading a toast or a
 * dialog after a `setTimeout`. Of 813 recorded clicks, 51% were followed
 * directly by one of those three.
 *
 * The diff is over the snapshot's own lines, ordered, so a repeated row and
 * the position of a change survive (a set difference loses both). Lines are
 * compared without their indentation, the `(offscreen)` marker and the
 * `focused` state: a click scrolls its target into view and moves focus,
 * which would otherwise mark half the page changed. Focus is reported once,
 * on its own line. A removal and an addition of the same ref are one change
 * (`~`), since refs are element identity (`previewPage.ts`).
 *
 * Bounded on both sides: the middle left after trimming the common prefix and
 * suffix is diffed only when it is small enough for a plain LCS, and the
 * output is capped in lines and characters. Past either bound the answer is
 * "changed substantially", never a partial list that would read as complete.
 *
 * Dependency-free so `node --test` runs it directly.
 */

export interface Observation {
  /** Normalized lines, in page order. */
  lines: string[]
  /** What holds focus, as the snapshot describes it. */
  focused: string | null
  /** The capture stopped at its budget, so changes further down are unseen. */
  truncated: boolean
}

export type Delta =
  | { kind: 'none'; focus?: string; partial?: boolean }
  | { kind: 'lines'; lines: string[]; focus?: string; partial?: boolean; crossed?: boolean }
  | { kind: 'large'; count: number }

/** The middle of a diff is LCS'd only up to this many cells (500 × 500). */
const LCS_CELLS = 250_000
const MAX_LINES = 40
const MAX_CHARS = 2048

const REF = /\[ref=([^\]]+)\]/
/**
 * The state list that ends an element's line (`[checked, focused]`): after a
 * space, never the ref, and with no quote in it, so a bracket inside quoted
 * page text (`text: "Status [focused]"`) is never mistaken for one.
 */
const STATE = / \[(?!ref=)([^\]"]+)\]$/
/** A quoted `value="…"` attribute, as `JSON.stringify` writes it. */
const VALUE = / value="(?:[^"\\]|\\.)*"/

/** One snapshot line as compared: no indentation, list marker, `(offscreen)` or `focused`. */
export function normalizeLine(line: string): string {
  return line
    .replace(/^\s*- /, '')
    .replace(/ \(offscreen\)$/, '')
    .replace(STATE, (_m, st: string) => {
      const kept = st.split(', ').filter((x) => x !== 'focused')
      return kept.length ? ` [${kept.join(', ')}]` : ''
    })
    .trimEnd()
}

export function observe(tree: string, focused: string | null, truncated: boolean): Observation {
  return { lines: tree ? tree.split('\n').map(normalizeLine) : [], focused, truncated }
}

const refOf = (line: string): string | undefined => REF.exec(line)?.[1]

const stateOf = (line: string): string => STATE.exec(line)?.[1] ?? ''

/**
 * The changes from `before` to `after`. `skipRef` names the field
 * `preview_type` already reports the new value of: a change to that value
 * alone is dropped, while one to its state (`[invalid]`), its name or its
 * presence is kept.
 *
 * A truncated capture is the top of the page, so its last lines are where
 * the capture stopped, not where the page ends: a toast inserted above
 * pushes a row past the limit, and a reorder can carry one there, and either
 * would read as removed. No alignment of the two captures can tell that
 * apart from a real removal, so the page is asked instead: `present` names
 * the refs of removed lines whose element is still on the page and visible,
 * and those lines are dropped. Without an answer (`present` undefined) a
 * removal is unproven and worded as `crossed`, not reported as certain. A text line gone from a truncated capture, or
 * any line new to one taken after a truncated one, may still have only
 * crossed the limit; those are kept and the result says `crossed`, for the
 * caller to word as such. A ref changed in place (`~`) is exact either way.
 */
export function pageDelta(
  before: Observation,
  after: Observation,
  opts: { skipRef?: string; target?: string; present?: ReadonlySet<string>; maxLines?: number; maxChars?: number } = {}
): Delta {
  const a = before.lines
  const b = after.lines
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const m = endA - start
  const n = endB - start
  if (m * n > LCS_CELLS) return { kind: 'large', count: m + n }

  // Plain LCS over the middle, then walked forwards into ordered ops.
  const ops: { op: '+' | '-'; line: string }[] = []
  const w = n + 1
  const len = new Uint16Array((m + 1) * w)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      len[i * w + j] = a[start + i] === b[start + j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[start + i] === b[start + j]) {
      i++
      j++
    } else if (j < n && (i === m || len[i * w + j + 1] >= len[(i + 1) * w + j])) {
      ops.push({ op: '+', line: b[start + j++] })
    } else {
      ops.push({ op: '-', line: a[start + i++] })
    }
  }

  // A ref both removed and added is one element whose line changed.
  const added = new Set<string>()
  const removed = new Map<string, string>()
  for (const o of ops) {
    const r = refOf(o.line)
    if (r) o.op === '+' ? added.add(r) : removed.set(r, o.line)
  }
  const partial = before.truncated || after.truncated
  let crossed = false
  const out: string[] = []
  for (const o of ops) {
    const r = refOf(o.line)
    if (o.op === '-' && r && added.has(r)) continue
    const was = o.op === '+' && r ? removed.get(r) : undefined
    if (was === undefined) {
      if (o.op === '-' && r && after.truncated) {
        // Still on the page, only past where the capture stopped.
        if (opts.present?.has(r)) continue
        // The page could not be asked: the removal is not proven either.
        if (!opts.present) crossed = true
      }
      if (o.op === '-' ? after.truncated && !r : before.truncated) crossed = true
      out.push(`${o.op} ${o.line}`)
      continue
    }
    if (r === opts.skipRef && was.replace(VALUE, '') === o.line.replace(VALUE, '')) continue
    // A state that went away leaves nothing on the new line to show it.
    const wasState = stateOf(was)
    out.push(`~ ${o.line}${wasState && wasState !== stateOf(o.line) ? ` (was [${wasState}])` : ''}`)
  }

  // Focus landing on what was just clicked or typed into says nothing new.
  const moved = before.focused !== after.focused && !(after.focused && after.focused === opts.target)
  const focus = moved ? (after.focused ? `Focus is now on ${after.focused}.` : 'Nothing is focused now.') : undefined
  const extra = { ...(focus ? { focus } : {}), ...(partial ? { partial } : {}) }
  if (!out.length) return { kind: 'none', ...extra }
  const maxLines = opts.maxLines ?? MAX_LINES
  const maxChars = opts.maxChars ?? MAX_CHARS
  let chars = 0
  for (const l of out) chars += l.length + 1
  if (out.length > maxLines || chars > maxChars) return { kind: 'large', count: out.length }
  return { kind: 'lines', lines: out, ...extra, ...(crossed ? { crossed } : {}) }
}

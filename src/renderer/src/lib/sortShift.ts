/**
 * The sliding gap a sidebar drag opens, on both the desktop and the phone.
 *
 * A drag is modelled as the row leaving its slot and being inserted at
 * another: rows below the slot it left move up one step, rows at or after the
 * slot it is entering move down one, and the empty space lands exactly where
 * the drop will put it. The row's own slot stays in the layout (it is drawn
 * empty), so nothing re-lays out mid-drag — every move is a transform, which
 * is what lets the rows slide instead of jumping.
 *
 * Positions are read once, when the drag starts, and never from the moving
 * rows: hit-testing a row that is sliding under the cursor flips the answer
 * back and forth. Dependency-free so `node --test` runs it directly.
 */

/**
 * Where among the *other* rows the dragged one would go: the count of their
 * midpoints above `y`. `mids` are those rows' midpoints, top to bottom, in the
 * same coordinates as `y`, taken before anything moved.
 */
export function insertionIndex(mids: number[], y: number): number {
  let n = 0
  for (const m of mids) if (m < y) n++
  return n
}

/**
 * How far one row moves, in px.
 *
 * `index` is its position in its own list as drawn, the dragged row included.
 * `origin` is the dragged row's position when this list is the one it left,
 * else null; `insertAt` is the gap's position among the other rows when this
 * list is the one it is entering, else null. A drag within one list sets both.
 */
export function rowShift(index: number, origin: number | null, insertAt: number | null, step: number): number {
  if (origin === index) return 0
  const below = origin !== null && index > origin
  const k = below ? index - 1 : index
  return (below ? -step : 0) + (insertAt !== null && k >= insertAt ? step : 0)
}

/**
 * The dragged row's own offset when it lands in the gap, for the settle
 * animation: rows in one list share a height, so the gap is whole steps away.
 */
export function landingOffset(origin: number, insertAt: number, step: number): number {
  return (insertAt - origin) * step
}

/**
 * The drop as the sidebar's move functions take it — beside which of the other
 * rows, above or below — or null when the row would land where it already is.
 */
export function dropTarget(
  others: string[],
  insertAt: number,
  origin: number | null
): { id: string; after: boolean } | null {
  if (origin !== null && insertAt === origin) return null
  if (!others.length) return null
  return insertAt >= others.length
    ? { id: others[others.length - 1], after: true }
    : { id: others[insertAt], after: false }
}

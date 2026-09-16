/**
 * Where a dragged tab lands. Pure and dependency-free so `node --test` pins it:
 * the before/after arithmetic is exactly the kind that reads right and is off
 * by one — removing the dragged item first shifts every index past it.
 *
 * Returns the *same* array when nothing would move, so a store that assigns
 * the result does not mint a fresh reference for subscribers to re-render on.
 */
export function moveItem<T>(
  list: readonly T[],
  from: number,
  target: number,
  side: 'before' | 'after'
): readonly T[] {
  if (from < 0 || from >= list.length || target < 0 || target >= list.length) return list
  let to = side === 'before' ? target : target + 1
  if (from < to) to -= 1
  if (to === from) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * `ids` in the order `hint` remembers, with anything the hint does not know
 * appended in its given order.
 *
 * A thread's column order is stored as a hint rather than as the columns
 * themselves: columns come and go (added, closed, reopened, restored at
 * launch) through paths that know nothing about ordering, and each of them
 * would otherwise have to keep a second list in step. Read through this, a new
 * column lands at the end, a closed one simply drops out, and a reopened one
 * returns to where it was. Returns `ids` itself when the order is unchanged.
 */
export function orderByHint<T extends string>(
  hint: readonly string[] | undefined,
  ids: readonly T[]
): readonly T[] {
  if (!hint || hint.length === 0) return ids
  const rank = (id: T, i: number): number => {
    const at = hint.indexOf(id)
    return at === -1 ? hint.length + i : at
  }
  const sorted = ids
    .map((id, i) => ({ id, r: rank(id, i) }))
    .sort((a, b) => a.r - b.r)
    .map((e) => e.id)
  return sorted.every((id, i) => id === ids[i]) ? ids : sorted
}

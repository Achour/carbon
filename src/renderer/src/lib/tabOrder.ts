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

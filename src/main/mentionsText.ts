/**
 * Whether any string anywhere inside `value` contains one of `needles`.
 *
 * The phone's image route asks this of a chat's loaded messages to check that
 * the transcript really names the path it is asked to serve. It used to
 * `JSON.stringify` the whole window and search the result: on a 36 MB loaded
 * history that was ~15 ms of main thread and a 36 MB string per image. Walking
 * the values allocates nothing and stops at the first hit.
 */
export function mentionsText(value: unknown, needles: readonly string[]): boolean {
  if (needles.length === 0) return false
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const next = stack.pop()
    if (typeof next === 'string') {
      for (const needle of needles) if (next.includes(needle)) return true
    } else if (next && typeof next === 'object') {
      if (Array.isArray(next)) {
        for (let i = next.length - 1; i >= 0; i--) stack.push(next[i])
      } else {
        for (const key in next) stack.push((next as Record<string, unknown>)[key])
      }
    }
  }
  return false
}

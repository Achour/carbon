/**
 * How a delegate is named by the model, read the same way by main (which acts
 * on it, `resolveDelegate`) and the renderer (which reads a turn's delegate
 * calls back out of the transcript, `useDelegates`). Two readers of one
 * reference that disagree put a follow-up's liveness on the wrong turn.
 *
 * Dependency-free so `node --test` runs it straight off the `.ts`.
 */

/** A delegate name as the model may write it, normalized: `Math Reviewer_2!` → `math-reviewer-2`. */
export function slugName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
}

/**
 * The delegate a reference names: its id, its name in any reasonable spelling,
 * or a provider alone when exactly one delegate is on it — two would make it a
 * guess.
 */
export function findDelegate<T extends { id: string; name: string; provider: string }>(
  views: readonly T[],
  ref: string
): T | undefined {
  const raw = ref.trim()
  if (!raw) return undefined
  const byId = views.find((v) => v.id === raw)
  if (byId) return byId
  const slug = slugName(raw)
  const byName = views.find((v) => v.name === slug)
  if (byName) return byName
  const on = views.filter((v) => v.provider === slug)
  return on.length === 1 ? on[0] : undefined
}

/** The delegate id a call's result names — "… (id <uuid>)". */
export function namedDelegateId(output: string | undefined): string | null {
  return /\(id ([0-9a-f-]{36})\)/i.exec(output ?? '')?.[1] ?? null
}

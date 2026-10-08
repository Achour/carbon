/**
 * Which preview pane an agent's command lands on. Dependency-free so
 * `node --test` can pin it (`test/previewPane.test.ts`).
 *
 * Each chat drives its own pane: several agents on one project — a parent and
 * its delegates, or two threads — used to share one page, so one navigated
 * away from the route another was testing, and a ref read by one was a stale
 * ref for the next. A pane is *owned* by the chat that first used it; the
 * user's own preview starts unowned and is claimed by the first chat to act
 * on it, which keeps the one-chat case exactly as it was.
 */

/**
 * Canonicalize a project path for matching. The agent's folder (`chat.cwd`) and
 * a pane's `cwd` originate from the same value, but a stray trailing slash or
 * duplicate separator would make an exact `===` miss and the command silently
 * no-op ("No preview open"). Strip both so matching is robust.
 */
export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

export interface PaneCandidate {
  id: string
  cwd: string
  /** The chat that drives it; absent until one acts on it. */
  owner?: string
  /** On screen right now. */
  visible?: boolean
  /** When the user last had it selected. */
  lastActive?: number
}

/**
 * The pane `owner` should act on in `cwd`: its own, then an unowned one (or
 * one whose owner chat is gone), which it then claims. Null means it needs a
 * new pane of its own — never another live chat's. Among equals, the one on
 * screen, then the one most recently selected. No `owner` (a caller with no
 * chat) takes any pane of the project, as before ownership existed.
 */
export function pickPreviewPane(
  panes: readonly PaneCandidate[],
  cwd: string,
  owner: string | undefined,
  isLive: (chatId: string) => boolean
): { id: string; claim: boolean } | null {
  const target = normalizeCwd(cwd)
  const best = (list: PaneCandidate[]): PaneCandidate | undefined =>
    list.find((p) => p.visible) ??
    list.reduce<PaneCandidate | undefined>((a, p) => (!a || (p.lastActive ?? 0) > (a.lastActive ?? 0) ? p : a), undefined)
  const mine = panes.filter((p) => normalizeCwd(p.cwd) === target)
  if (!owner) {
    const any = best(mine)
    return any ? { id: any.id, claim: false } : null
  }
  const own = best(mine.filter((p) => p.owner === owner))
  if (own) return { id: own.id, claim: false }
  const free = best(mine.filter((p) => !p.owner || !isLive(p.owner)))
  return free ? { id: free.id, claim: true } : null
}

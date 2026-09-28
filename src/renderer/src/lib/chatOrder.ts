import type { ChatMeta } from '@shared/types'

/**
 * The sidebar's hand-made order (`ChatMeta.sortKey`, higher first).
 *
 * A drop moves one chat and writes one key: the midpoint of the two rows it
 * landed between. Renumbering the list instead would be a meta write per chat —
 * each one a hydrate in main — for a gesture that moved a single row.
 *
 * The limit is precision: keys are ~1.7e12, so a 1 ms gap survives about a
 * dozen halvings (a 1 s gap about twenty) — a dozen chats dropped one after
 * another into the same slot. Past that the tie branch below lands the chat
 * beside its target rather than exactly between the two.
 */

export function sortKeyOf(chat: Pick<ChatMeta, 'sortKey' | 'updatedAt'>): number {
  return chat.sortKey ?? chat.updatedAt
}

/** `chats` in sidebar order. Stable, so equal keys keep the order they came in. */
export function sortChats<T extends Pick<ChatMeta, 'sortKey' | 'updatedAt'>>(chats: T[]): T[] {
  return chats.slice().sort((a, b) => sortKeyOf(b) - sortKeyOf(a))
}

/**
 * The key that puts `from` directly above (or below) `target`.
 *
 * `list` is the *whole* ordered list the target sits in, not the rows on
 * screen: under a project filter the neighbour is often a chat from another
 * project, and landing between the target and its visible neighbour instead
 * would jump the dragged chat past every hidden one in between. Pinned and side
 * chats are left out by the caller — they are not in this list.
 *
 * Null when the drop would change nothing, or when the target is gone.
 */
export function keyForDrop(
  list: Pick<ChatMeta, 'id' | 'sortKey' | 'updatedAt'>[],
  from: string,
  target: string,
  after: boolean
): number | null {
  if (from === target) return null
  const rest = list.filter((c) => c.id !== from)
  const i = rest.findIndex((c) => c.id === target)
  if (i === -1) return null
  const above = after ? rest[i] : rest[i - 1]
  const below = after ? rest[i + 1] : rest[i]
  // Already there: the rows either side of the gap are the ones it sits between.
  const at = list.findIndex((c) => c.id === from)
  if (at !== -1 && list[at - 1]?.id === above?.id && list[at + 1]?.id === below?.id) return null
  if (!above) return sortKeyOf(below) + 1
  if (!below) return sortKeyOf(above) - 1
  const hi = sortKeyOf(above)
  const lo = sortKeyOf(below)
  // Two rows sharing a key have no gap between them; nudging off the lower one
  // still lands the chat below `above`, which ties sort in list order.
  return hi > lo ? lo + (hi - lo) / 2 : lo
}

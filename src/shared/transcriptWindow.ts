import type { ChatMessage } from './types'

/**
 * Applying live events to a transcript that holds one window of its chat.
 *
 * The renderer (and the phone) hold the last window of a chat, not all of it
 * (`Store.viewChat`), with `hiddenBefore` counting what sits above. Main's live
 * copy holds more than that window, so it can address a message the window
 * does not have. Two events can:
 *
 * - a `message` re-stating one that has scrolled above the window — a side
 *   question answered late, a turn's file summary landing after the next turn
 *   began. Appended, it would sit at the foot of the transcript as if it had
 *   just been said. Main stamps each message event with its index in the chat
 *   (`emit`), and one above `hiddenBefore` is left to the window that holds
 *   it, which `loadOlder` serves from main's live copy. Not a timestamp test:
 *   two messages can share a millisecond.
 * - a `truncate` to a point above the window, which empties it and moves
 *   `hiddenBefore` down to where the chat now ends.
 *
 * Dependency-free so both reducers, and `node --test`, can import it.
 */
export function placeMessage(
  messages: ChatMessage[],
  message: ChatMessage,
  hiddenBefore: number,
  index?: number
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx === -1) {
    if (index !== undefined && index < hiddenBefore) return messages
    return [...messages, message]
  }
  const next = messages.slice()
  next[idx] = message
  return next
}

/** The window after main kept the chat's first `keep` messages. */
export function truncateWindow(
  messages: ChatMessage[],
  hiddenBefore: number,
  keep: number
): { messages: ChatMessage[]; hiddenBefore: number } {
  if (keep < hiddenBefore) return { messages: [], hiddenBefore: Math.max(0, keep) }
  const local = keep - hiddenBefore
  if (local >= messages.length) return { messages, hiddenBefore }
  return { messages: messages.slice(0, local), hiddenBefore }
}

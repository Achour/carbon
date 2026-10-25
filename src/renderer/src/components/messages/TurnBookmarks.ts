import * as React from 'react'

/**
 * The chat's marked turns, for the prompt bubble's own bookmark button.
 *
 * A context rather than a store selector per bubble: the store changes on
 * every streamed delta, and sixty bubbles each searching `chats` for theirs
 * would pay for that on every one. `ChatView` provides it, keyed on the list
 * itself, so a bubble re-renders only when a mark changes. Absent — the phone
 * draws the same bubbles — the button is simply not offered.
 */
export interface TurnBookmarksValue {
  marked: ReadonlySet<string>
  toggle(messageId: string, prompt: string): void
}

export const TurnBookmarks = React.createContext<TurnBookmarksValue | null>(null)

/**
 * Put the caret in a chat's composer, waiting for its column to mount.
 *
 * Adding a chat, jumping to one with ⌘1–⌘4 or expanding one are all statements
 * that you are about to type into it, and a column whose composer does not take
 * the caret makes the next keystroke land in whichever box had it. The column
 * may not be in the DOM yet — a chat added a frame ago, a thread still
 * hydrating — so this retries briefly rather than trying once.
 */
export function focusComposer(chatId: string): void {
  const tryFocus = (left: number): void => {
    const el = document.querySelector<HTMLTextAreaElement>(
      `[data-chat-surface="${CSS.escape(chatId)}"] [data-composer-input]`
    )
    if (el) el.focus()
    else if (left > 0) window.setTimeout(() => tryFocus(left - 1), 40)
  }
  requestAnimationFrame(() => tryFocus(10))
}

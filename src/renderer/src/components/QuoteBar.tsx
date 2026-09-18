import * as React from 'react'
import { MessageSquareQuote, PanelRight } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { QUOTE_MAX_CHARS } from '@shared/types'
import { quoteLabel, quoteText } from '@/lib/quoteSelection'
import { cn } from '@/lib/utils'
import { threadFull, useApp } from '@/store'

/**
 * Select a passage in a reply and ask about *that* — the transcript's half of
 * the editor's "Add to chat" pill.
 *
 * The passage is already in the model's history, so what this adds is not the
 * text but the **pointing**: the reader's "this part, of everything you just
 * said" has no other spelling. Retyping it is the thing people actually do
 * instead, and a retyped quote is a paraphrase — the model then answers about a
 * sentence nobody wrote.
 *
 * It rides the same `attachmentInbox` seam as the editor's pill, the canvas
 * list and the browser's element picker, so nothing new crosses IPC and the
 * chip, the draft and the three providers' prompt text all already work.
 */

/** The bar's gap from the line it points at, in px. */
const GAP = 6
/** Distance from the container's edges the bar is kept inside. */
const EDGE = 8

interface Picked {
  text: string
  truncated: boolean
  /** Unset when the drag crossed a message boundary — see `QuoteRef.role`. */
  role?: 'assistant' | 'user'
  /** The container's own coordinates. `below` flips the anchor under the text. */
  left: number
  top: number
  below: boolean
}

function roleAt(node: Node | null): string | undefined {
  const el = node instanceof Element ? node : node?.parentElement
  return el?.closest('[data-message-role]')?.getAttribute('data-message-role') ?? undefined
}

/**
 * The live selection, if it is one this transcript can quote.
 *
 * Containment is checked on the range's **common ancestor**, which settles both
 * ends in one question: `.markdown` is `user-select: text` in the right panel's
 * preview and in a canvas too, and a drag that began in the transcript and
 * ended in another column is not a quote from either.
 *
 * A selection scrolled out of the scroller returns null rather than a bar
 * pinned to an edge. The bar names a passage by sitting next to it; with the
 * passage off screen it names nothing, and the reader has no way to tell which
 * of the two columns' selections it belongs to.
 */
function pick(scroller: HTMLElement, container: HTMLElement): Picked | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!scroller.contains(range.commonAncestorContainer)) return null
  const quote = quoteText(sel.toString(), QUOTE_MAX_CHARS)
  if (!quote) return null

  const rects = range.getClientRects()
  const first = rects[0]
  const last = rects[rects.length - 1]
  if (!first || !last) return null
  const view = scroller.getBoundingClientRect()
  if (last.bottom <= view.top || first.top >= view.bottom) return null

  const base = container.getBoundingClientRect()
  // Above the first line by default — that is where the passage begins, and it
  // is the edge the pointer is furthest from after a downward drag. With the
  // first line at the top of the scroller there is no room above it, so the bar
  // goes under the last line instead.
  const room = first.top - view.top > 40
  const anchor = room ? first : last
  const start = roleAt(range.startContainer)
  const end = roleAt(range.endContainer)
  const role = start === end && (start === 'assistant' || start === 'user') ? start : undefined
  return {
    text: quote.text,
    truncated: quote.truncated,
    ...(role ? { role } : {}),
    left: first.left - base.left,
    top: (room ? anchor.top - GAP : anchor.bottom + GAP) - base.top,
    below: !room
  }
}

function attachmentFor(p: Picked): Attachment {
  return {
    id: crypto.randomUUID(),
    kind: 'quote',
    name: quoteLabel(p.text),
    quote: {
      text: p.text,
      ...(p.role ? { role: p.role } : {}),
      ...(p.truncated ? { truncated: true } : {})
    }
  }
}

/**
 * Leaving the passage highlighted under a bar that has done its job reads as
 * though the click did nothing — the editor's pill collapses its selection at
 * the same moment and for the same reason. It is also what dismisses the bar:
 * clearing the range fires `selectionchange`, which re-evaluates to null.
 */
function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

function addToChat(chatId: string, p: Picked): void {
  const app = useApp.getState()
  // The inbox goes to the *focused* column's composer, and a keyboard selection
  // never claimed focus for this one (`claimFocus` is on pointer down). Say so
  // explicitly rather than letting the quote land in whichever column was last
  // clicked. No caret: the composer's own inbox effect focuses the box.
  app.focusChat(chatId)
  app.addAttachment(attachmentFor(p))
  clearSelection()
}

async function askInSideChat(p: Picked): Promise<void> {
  // Built before the column, because the selection does not survive the round
  // trip through `chats:create`: the new column takes the caret, and focusing a
  // text field collapses what was highlighted behind it.
  const att = attachmentFor(p)
  clearSelection()
  const id = await useApp.getState().addThreadChat()
  // Null means there was no thread to add to, or no room left in it — and the
  // button is not drawn in either case.
  if (!id) return
  // Addressed to the new chat rather than left to focus. `addThreadChat` names
  // it as focused at once, but the old column's `claimFocus` fires again as
  // React re-parents it and holds focus for the ~24ms this round trip lands in
  // — long enough for an unaddressed quote to reach the column being left.
  useApp.getState().addAttachment(att, id)
}

export function QuoteBar({
  chatId,
  scrollRef,
  containerRef
}: {
  chatId: string
  /** The transcript's scroller — what a selection has to be inside. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** The positioned ancestor the bar's coordinates are measured against. */
  containerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [picked, setPicked] = React.useState<Picked | null>(null)
  const barRef = React.useRef<HTMLDivElement>(null)
  const canSplit = useApp((s) => !threadFull(s))

  React.useEffect(() => {
    const scroller = scrollRef.current
    const container = containerRef.current
    if (!scroller || !container) return undefined

    let frame = 0
    let pressed = false
    const evaluate = (): void => {
      frame = 0
      setPicked(pick(scroller, container))
    }
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(evaluate)
    }

    // `selectionchange` fires on every mousemove of a drag, so a bar shown from
    // it appears *under the cursor* halfway through the gesture and eats the
    // rest of it. The pointer being down is the whole test: while it is, the
    // selection is still being made.
    const onDown = (e: PointerEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return
      pressed = true
      setPicked(null)
    }
    const onUp = (): void => {
      pressed = false
      schedule()
    }
    const onSelect = (): void => {
      if (!pressed) schedule()
    }
    // A scroll moves the passage and fires no `selectionchange`; a bar left
    // where it was is pointing at whatever scrolled under it. The listener is
    // this component's own rather than the view's `onScroll`, which is the
    // follow logic (`docs/performance.md`) and has nothing to do with this.
    const onScroll = (): void => {
      if (barRef.current) schedule()
    }
    // ⌘L is the editor's "Add to chat", and it means the same thing here. It
    // is skipped while a text field has focus — the editor's own binding is a
    // CodeMirror keymap on a contenteditable, and it would otherwise fire
    // twice, adding lines *and* a stale transcript quote.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'l' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const found = pick(scroller, container)
      if (!found) return
      e.preventDefault()
      addToChat(chatId, found)
    }

    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
    document.addEventListener('selectionchange', onSelect)
    document.addEventListener('keydown', onKey)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onUp, true)
      document.removeEventListener('selectionchange', onSelect)
      document.removeEventListener('keydown', onKey)
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [chatId, scrollRef, containerRef])

  // The bar's width depends on its labels and on whether the second button is
  // there, so the clamp is applied after it has one — as a style write rather
  // than as state, since it resolves a layout question the render cannot.
  React.useLayoutEffect(() => {
    const el = barRef.current
    const container = containerRef.current
    if (!el || !container || !picked) return
    const max = container.clientWidth - el.offsetWidth - EDGE
    el.style.left = `${Math.max(EDGE, Math.min(picked.left, max))}px`
  }, [picked, containerRef])

  if (!picked) return null
  const button =
    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-accent'
  return (
    <div
      ref={barRef}
      data-quote-bar={chatId}
      style={{ left: picked.left, top: picked.top }}
      // The flip is on the wrapper because `animate-enter` is itself a
      // transform: a `-translate-y-full` on the animated element is overwritten
      // by the keyframe for the length of the animation, which drops the bar
      // onto the text it is pointing at and then snaps it up.
      className={cn('absolute z-20', !picked.below && '-translate-y-full')}
    >
      <div
        // Preventing the default on mousedown is what keeps the selection alive
        // long enough for the click to resolve — the browser collapses it on a
        // mousedown outside the range otherwise, and the quote is gone before
        // the handler runs.
        onMouseDown={(e) => e.preventDefault()}
        className="flex animate-enter items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 text-popover-foreground shadow-lg"
      >
        <button type="button" onClick={() => addToChat(chatId, picked)} className={button}>
          <MessageSquareQuote className="size-3.5 text-muted-foreground" />
          Add to chat
          <span className="ml-0.5 text-[10px] text-muted-foreground/70">
            {window.api.platform === 'darwin' ? '⌘L' : 'Ctrl L'}
          </span>
        </button>
        {canSplit && (
          <>
            <div className="h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => void askInSideChat(picked)}
              className={button}
              title="Open a new chat beside this one and ask there"
            >
              <PanelRight className="size-3.5 text-muted-foreground" />
              Ask in side chat
            </button>
          </>
        )}
      </div>
    </div>
  )
}

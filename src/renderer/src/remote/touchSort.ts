import * as React from 'react'
import { dropTarget, insertionIndex, landingOffset, rowShift } from '@/lib/sortShift'

/** How long a finger rests on a row before it lifts. Long enough not to fire on a tap. */
const HOLD_MS = 350
/** A finger that moves this far before then is scrolling, not holding. */
const SLOP = 8
/** The band at the scroller's top and bottom edges that scrolls it while dragging. */
const EDGE = 64
const MAX_SPEED = 14
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const SLIDE_MS = 200

export type SortDrop = (zone: string, from: string, target: { id: string; after: boolean } | null) => void

interface Active {
  id: string
  zone: string
  el: HTMLElement
  origin: number
  others: string[]
  /** The other rows' midpoints, in the scroller's content coordinates. */
  mids: number[]
  originMid: number
  step: number
  startY: number
  startScroll: number
  y: number
  insertAt: number
}

/**
 * Hold a sidebar row and drag it: the phone's half of the sidebar's sliding
 * gap (`lib/sortShift.ts` is shared with the desktop). The row lifts and follows
 * the finger, the others slide apart to open a space where it will land, the
 * list scrolls when the finger nears an edge, and on release the row glides
 * into the gap before the order is committed.
 *
 * The dragged row is moved by writing its transform straight to the element:
 * a React render per touch-move would re-render the sidebar sixty times a
 * second. React renders only when the gap moves to another slot.
 *
 * The scroller's touch listeners are native, not React's, because React's are
 * passive: only a non-passive `touchmove` can stop the list scrolling under a
 * row being dragged. A hold that turns into a drag also swallows the click
 * the release would send, or every drag would open the chat it moved.
 */
export function useTouchSort(onDrop: SortDrop): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  row: (zone: string, id: string, index: number) => React.HTMLAttributes<HTMLDivElement> & { 'data-sort-row': string }
} {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [gap, setGap] = React.useState<{ zone: string; id: string; origin: number; insertAt: number; step: number } | null>(null)
  const [settling, setSettling] = React.useState(false)
  const pending = React.useRef<{ id: string; zone: string; el: HTMLElement; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const active = React.useRef<Active | null>(null)
  const landing = React.useRef(false)
  const swallowClick = React.useRef(false)
  const startHold = React.useRef<(zone: string, id: string, el: HTMLElement, x: number, y: number) => void>(() => {})
  const onDropRef = React.useRef(onDrop)
  onDropRef.current = onDrop

  React.useEffect(() => {
    if (!settling) return
    let b = 0
    const a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setSettling(false))))
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [settling])

  React.useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let frame = 0

    const place = (): void => {
      const a = active.current
      if (!a) return
      const dy = a.y - a.startY + (scroller.scrollTop - a.startScroll)
      a.el.style.transform = `translateY(${dy}px) scale(1.03)`
      const insertAt = insertionIndex(a.mids, a.originMid + dy)
      if (insertAt !== a.insertAt) {
        a.insertAt = insertAt
        setGap((g) => (g ? { ...g, insertAt } : g))
      }
    }

    // Near an edge the list scrolls, faster the closer the finger; the row
    // keeps its place under the finger because `place` adds the scroll.
    const autoscroll = (): void => {
      frame = 0
      const a = active.current
      if (!a) return
      const r = scroller.getBoundingClientRect()
      const into = a.y < r.top + EDGE ? -(r.top + EDGE - a.y) : a.y > r.bottom - EDGE ? a.y - (r.bottom - EDGE) : 0
      if (!into) return
      const before = scroller.scrollTop
      scroller.scrollTop += Math.max(-MAX_SPEED, Math.min(MAX_SPEED, into / 3))
      if (scroller.scrollTop !== before) place()
      frame = requestAnimationFrame(autoscroll)
    }

    const lift = (): void => {
      const p = pending.current
      pending.current = null
      if (!p) return
      const rows = [...scroller.querySelectorAll<HTMLElement>(`[data-sort-zone="${CSS.escape(p.zone)}"]`)]
      const origin = rows.findIndex((r) => r.dataset.sortRow === p.id)
      if (origin === -1) return
      const top = scroller.getBoundingClientRect().top - scroller.scrollTop
      const rects = rows.map((r) => r.getBoundingClientRect())
      const mids = rects.map((r) => r.top - top + r.height / 2)
      const next = rects[origin + 1]
      const step = next ? next.top - rects[origin].top : rects[origin].height
      active.current = {
        id: p.id,
        zone: p.zone,
        el: p.el,
        origin,
        others: rows.filter((_, i) => i !== origin).map((r) => r.dataset.sortRow!),
        mids: mids.filter((_, i) => i !== origin),
        originMid: mids[origin],
        step,
        startY: p.y,
        startScroll: scroller.scrollTop,
        y: p.y,
        insertAt: origin
      }
      swallowClick.current = true
      p.el.style.zIndex = '20'
      ;(navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(8)
      setGap({ zone: p.zone, id: p.id, origin, insertAt: origin, step })
      // After React's render, which drops the row's managed style: the lift
      // animates, and following the finger after it must not.
      requestAnimationFrame(() => {
        if (active.current?.el !== p.el) return
        p.el.style.transition = `transform 160ms ${EASE}`
        place()
        setTimeout(() => {
          if (active.current?.el === p.el) p.el.style.transition = 'none'
        }, 160)
      })
    }

    const release = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      const a = active.current
      active.current = null
      if (!a) return
      landing.current = true
      a.el.style.transition = `transform ${SLIDE_MS}ms ${EASE}`
      a.el.style.transform = `translateY(${landingOffset(a.origin, a.insertAt, a.step)}px)`
      setTimeout(() => {
        // The row sits in the gap; the new order puts it there, so the commit,
        // with transitions off for a frame, moves nothing on screen.
        landing.current = false
        a.el.style.transition = 'none'
        a.el.style.transform = ''
        a.el.style.zIndex = ''
        setSettling(true)
        setGap(null)
        onDropRef.current(a.zone, a.id, dropTarget(a.others, a.insertAt, a.origin))
      }, SLIDE_MS)
    }

    const onMove = (e: TouchEvent): void => {
      const t = e.touches[0]
      const p = pending.current
      if (p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > SLOP) {
        clearTimeout(p.timer)
        pending.current = null
      }
      const a = active.current
      if (!a) return
      // Ours now: neither the list's scroll nor the drawer's swipe gets it.
      e.preventDefault()
      e.stopPropagation()
      a.y = t.clientY
      place()
      if (!frame) frame = requestAnimationFrame(autoscroll)
    }
    const onEnd = (): void => {
      const p = pending.current
      if (p) {
        clearTimeout(p.timer)
        pending.current = null
      }
      release()
    }
    const onClick = (e: MouseEvent): void => {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.preventDefault()
      e.stopPropagation()
    }

    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd)
    scroller.addEventListener('touchcancel', onEnd)
    scroller.addEventListener('click', onClick, true)
    startHold.current = (zone, id, el, x, y) => {
      if (active.current || landing.current) return
      if (pending.current) clearTimeout(pending.current.timer)
      swallowClick.current = false
      pending.current = { id, zone, el, x, y, timer: setTimeout(lift, HOLD_MS) }
    }
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
      scroller.removeEventListener('click', onClick, true)
    }
  }, [])


  const row = (zone: string, id: string, index: number): React.HTMLAttributes<HTMLDivElement> & { 'data-sort-row': string } => {
    const transition = settling ? 'none' : `transform ${SLIDE_MS}ms ${EASE}`
    const lifted = gap?.id === id
    const y = gap && gap.zone === zone && !lifted ? rowShift(index, gap.origin, gap.insertAt, gap.step) : 0
    return {
      'data-sort-row': id,
      ...({ 'data-sort-zone': zone } as React.HTMLAttributes<HTMLDivElement>),
      onTouchStart: (e) => {
        const t = e.touches[0]
        if (t) startHold.current(zone, id, e.currentTarget, t.clientX, t.clientY)
      },
      // iOS's own long-press (the link preview, text selection) would fight the hold.
      className: lifted
        ? 'relative select-none rounded-lg bg-sidebar-accent shadow-[0_8px_28px_rgb(0_0_0/0.28)] [-webkit-touch-callout:none]'
        : 'relative select-none [-webkit-touch-callout:none]',
      style: lifted ? undefined : { transform: y ? `translateY(${y}px)` : undefined, transition }
    }
  }

  return { scrollRef, row }
}

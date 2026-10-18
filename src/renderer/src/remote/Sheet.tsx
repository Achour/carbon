import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Past this far down, or this fast (px/ms), a released drag dismisses the sheet. */
const DISMISS_DISTANCE = 110
const DISMISS_VELOCITY = 0.5
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * A bottom sheet: the phone's popover. Every picker the desktop draws as a
 * menu under a chip opens one of these instead — a thumb-reachable list with
 * room for each row's description, which a menu on a 390px screen has not.
 *
 * It follows the finger the way an iOS sheet does: dragged down by its handle
 * or title, or by its body once that is scrolled to the top, with the scrim
 * fading as it goes; released, it settles shut or open by distance and speed.
 * The transforms are written straight to the elements during the drag, as the
 * drawer's are (`App.tsx`), so a touch-move never renders React.
 *
 * It leaves the way it came: `open` going false plays the exit before the
 * sheet unmounts. A flung sheet continues from where the finger let go
 * instead — the class-based exit would restart it from the bottom edge,
 * because keyframes outrank the inline transform the drag left behind.
 */
export function Sheet({
  open,
  onClose,
  title,
  children
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(open)
  const [leaving, setLeaving] = React.useState(false)
  const flung = React.useRef(false)
  const panel = React.useRef<HTMLDivElement>(null)
  const scrim = React.useRef<HTMLButtonElement>(null)
  const body = React.useRef<HTMLDivElement>(null)
  const close = React.useRef(onClose)
  close.current = onClose

  React.useEffect(() => {
    if (open) {
      setMounted(true)
      setLeaving(false)
      flung.current = false
      return
    }
    if (!mounted) return
    setLeaving(true)
    const t = setTimeout(() => {
      setMounted(false)
      setLeaving(false)
      flung.current = false
    }, 240)
    return () => clearTimeout(t)
  }, [open, mounted])

  // A long list opens on the row already picked, as a native picker does,
  // rather than leaving it below the fold.
  React.useLayoutEffect(() => {
    const el = body.current
    if (!open || !el) return
    const row = el.querySelector<HTMLElement>('[data-selected]')
    if (row && row.offsetTop + row.offsetHeight > el.clientHeight) {
      // Centred in what a pinned header (the model sheet's) leaves visible.
      const pinned = el.querySelector<HTMLElement>(':scope > .sticky')?.offsetHeight ?? 0
      el.scrollTop = row.offsetTop - pinned - (el.clientHeight - pinned - row.offsetHeight) / 2
    }
  }, [open, mounted])

  // Native listeners, because React registers `touchmove` passively and a
  // drag has to stop the body from scrolling underneath it.
  React.useEffect(() => {
    const el = panel.current
    if (!mounted || leaving || !el) return
    let start: { y: number; t: number; fromBody: boolean } | null = null
    let dragging = false
    let offset = 0
    let velocity = 0
    let last = { y: 0, t: 0 }

    const paint = (y: number, animate: boolean): void => {
      const transition = animate ? `transform 320ms ${EASE}` : 'none'
      el.style.transition = transition
      el.style.transform = y ? `translateY(${y}px)` : ''
      if (scrim.current) {
        scrim.current.style.transition = animate ? `opacity 320ms ${EASE}` : 'none'
        scrim.current.style.opacity = String(Math.max(0, 1 - y / Math.max(1, el.offsetHeight)))
      }
    }

    const onStart = (e: TouchEvent): void => {
      const touch = e.touches[0]
      const target = e.target as Node
      const inBody = !!body.current?.contains(target)
      start = { y: touch.clientY, t: e.timeStamp, fromBody: inBody }
      last = { y: touch.clientY, t: e.timeStamp }
      dragging = false
      offset = 0
      velocity = 0
    }
    const onMove = (e: TouchEvent): void => {
      if (!start) return
      const touch = e.touches[0]
      const dy = touch.clientY - start.y
      if (!dragging) {
        // The body scrolls first: only a pull down from its very top drags.
        const atTop = !start.fromBody || (body.current?.scrollTop ?? 0) <= 0
        if (dy > 6 && atTop) dragging = true
        else if (Math.abs(dy) > 6) {
          start = null
          return
        } else return
      }
      e.preventDefault()
      // Down follows the finger; up stretches a little and stops, as iOS does.
      offset = dy > 0 ? dy : -Math.sqrt(-dy) * 2
      const dt = Math.max(1, e.timeStamp - last.t)
      velocity = (touch.clientY - last.y) / dt
      last = { y: touch.clientY, t: e.timeStamp }
      paint(offset, false)
    }
    const onEnd = (): void => {
      const wasDragging = dragging
      start = null
      dragging = false
      if (!wasDragging) return
      if (offset > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) {
        flung.current = true
        el.style.transition = `transform 240ms ${EASE}`
        el.style.transform = 'translateY(100%)'
        if (scrim.current) {
          scrim.current.style.transition = `opacity 240ms ${EASE}`
          scrim.current.style.opacity = '0'
        }
        close.current()
      } else paint(0, true)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [mounted, leaving])

  if (!mounted) return null
  const exit = leaving && !flung.current
  return createPortal(
    // A portal still bubbles through the React tree, and the drawer listens
    // for edge swipes on the shell around every screen: a touch in here is
    // the sheet's alone.
    // As tall as what shows: with the keyboard up (`--kb-height`), a sheet
    // anchored to the screen's bottom would sit behind the keys, field and all.
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--kb-height,100%)] flex-col justify-end"
      onTouchStart={(e) => e.stopPropagation()}
    >
      <button
        ref={scrim}
        type="button"
        aria-label="Close"
        className={cn(
          'absolute inset-0 bg-black/45 backdrop-blur-[2px]',
          exit ? 'opacity-0 transition-opacity duration-200' : !leaving && 'animate-in fade-in duration-200'
        )}
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        className={cn(
          'relative flex max-h-[82dvh] flex-col rounded-t-[22px] border-t border-border bg-popover text-popover-foreground shadow-2xl will-change-transform',
          'pb-[max(env(safe-area-inset-bottom),12px)] [.kb-open_&]:pb-3',
          exit
            ? 'animate-out slide-out-to-bottom fill-mode-forwards duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
            : !leaving && 'animate-in slide-in-from-bottom duration-[380ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
        )}
      >
        <div className="flex shrink-0 justify-center pt-2 pb-1">
          <div className="h-[5px] w-9 rounded-full bg-muted-foreground/30" />
        </div>
        {title && <div className="shrink-0 px-5 pt-2 pb-1 text-[13px] font-medium text-muted-foreground">{title}</div>}
        <div ref={body} className="relative min-h-0 overflow-y-auto overscroll-contain px-2 pb-1">
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}

export function SheetSection({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pt-2">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}

export function SheetRow({
  selected,
  icon,
  label,
  description,
  trailing,
  onClick
}: {
  selected?: boolean
  icon?: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={selected || undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors active:bg-accent',
        selected && 'bg-accent/70'
      )}
    >
      {icon && <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight">{label}</span>
        {description && (
          <span className="mt-0.5 block truncate text-[13px] leading-tight text-muted-foreground">{description}</span>
        )}
      </span>
      {trailing}
      <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </button>
  )
}

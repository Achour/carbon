import * as React from 'react'
import type { PreviewBox, PreviewMark } from '@shared/types'

/**
 * What the agent is doing in a preview, drawn over the page: a cursor that
 * glides to each click and ripples, an outline on the field it types into, the
 * key it presses, the way it scrolls. Drawn here, in the app, rather than in the
 * page — the page's DOM, and so the agent's own snapshot of it, stays exactly
 * what the app under test rendered — and fed by main a beat *before* each input
 * goes out (`PreviewDriver.onMark`), so the mark never trails the change.
 *
 * Positions arrive in the page's CSS px for a `vw`×`vh` viewport. This layer
 * covers the guest exactly as drawn, so one ratio per axis maps them whatever
 * size the pane draws the page at: filled, a device preset scaled to fit, or
 * the pop-up over a closed panel.
 */
export interface PreviewMarksHandle {
  show(m: PreviewMark): void
}

/** How long the cursor stays after the agent's last mark. */
const CURSOR_LINGER_MS = 2600

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function PreviewMarks({
  ref,
  driver
}: {
  ref: React.Ref<PreviewMarksHandle>
  /** The chat driving this pane this turn, for the chip; absent when none is. */
  driver?: string
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const cursorRef = React.useRef<HTMLDivElement>(null)
  const lingerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => () => clearTimeout(lingerRef.current), [])

  React.useImperativeHandle(ref, () => {
    const scale = (vw: number, vh: number): { sx: number; sy: number } | null => {
      const root = rootRef.current
      if (!root || vw <= 0 || vh <= 0) return null
      return { sx: root.clientWidth / vw, sy: root.clientHeight / vh }
    }
    const moveCursor = (x: number, y: number): void => {
      const c = cursorRef.current
      if (!c) return
      // The first appearance jumps; after that it glides from where it was.
      const shown = c.style.opacity === '1'
      c.style.transitionDuration = shown && !reducedMotion() ? '' : '0s'
      c.style.translate = `${x}px ${y}px`
      c.style.opacity = '1'
      clearTimeout(lingerRef.current)
      lingerRef.current = setTimeout(() => {
        if (cursorRef.current) cursorRef.current.style.opacity = '0'
      }, CURSOR_LINGER_MS)
    }
    /** A transient element, animated in place and removed when done. */
    const flash = (
      el: HTMLElement,
      frames: Keyframe[],
      ms: number
    ): void => {
      const root = rootRef.current
      if (!root) return
      root.appendChild(el)
      const still = reducedMotion()
      const anim = el.animate(still ? [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }] : frames, {
        duration: ms,
        easing: 'ease-out',
        fill: 'forwards'
      })
      anim.onfinish = () => el.remove()
      anim.oncancel = () => el.remove()
    }
    const ripple = (x: number, y: number, delay = 0): void => {
      const el = document.createElement('div')
      el.className = 'absolute rounded-full border-2 border-(--agent-mark) bg-(--agent-mark)/20'
      Object.assign(el.style, { left: `${x - 14}px`, top: `${y - 14}px`, width: '28px', height: '28px' })
      el.style.opacity = '0'
      setTimeout(
        () =>
          flash(
            el,
            [
              { transform: 'scale(0.4)', opacity: 0.95 },
              { transform: 'scale(1.6)', opacity: 0 }
            ],
            520
          ),
        delay
      )
    }
    const outline = (b: PreviewBox, s: { sx: number; sy: number }, label?: string): void => {
      const el = document.createElement('div')
      el.className = 'absolute rounded-md ring-2 ring-(--agent-mark) bg-(--agent-mark)/10'
      Object.assign(el.style, {
        left: `${b.x * s.sx - 3}px`,
        top: `${b.y * s.sy - 3}px`,
        width: `${b.w * s.sx + 6}px`,
        height: `${b.h * s.sy + 6}px`
      })
      if (label) {
        const tag = document.createElement('span')
        tag.className =
          'absolute -top-5 left-0 rounded bg-(--agent-mark) px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap text-white shadow'
        tag.textContent = label
        el.appendChild(tag)
      }
      flash(
        el,
        [
          { opacity: 0, transform: 'scale(1.03)' },
          { opacity: 1, transform: 'scale(1)', offset: 0.12 },
          { opacity: 1, offset: 0.75 },
          { opacity: 0 }
        ],
        1600
      )
    }
    const pill = (text: string, place: (el: HTMLElement) => void): void => {
      const el = document.createElement('div')
      el.className =
        'absolute rounded-md bg-popover/95 px-2 py-0.5 font-mono text-[11px] text-popover-foreground shadow-lg ring-1 ring-border'
      el.textContent = text
      place(el)
      flash(
        el,
        [
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'none', offset: 0.15 },
          { opacity: 1, offset: 0.7 },
          { opacity: 0 }
        ],
        1300
      )
    }
    return {
      show(m) {
        if (m.kind === 'click') {
          const s = scale(m.vw, m.vh)
          if (!s) return
          const x = m.x * s.sx
          const y = m.y * s.sy
          moveCursor(x, y)
          // Lands as the cursor arrives, not before it.
          const at = reducedMotion() ? 0 : 260
          ripple(x, y, at)
          if (m.double) ripple(x, y, at + 140)
          return
        }
        if (m.kind === 'type') {
          const s = scale(m.vw, m.vh)
          if (!s) return
          moveCursor(m.box.x * s.sx + Math.min(18, (m.box.w * s.sx) / 2), (m.box.y + m.box.h / 2) * s.sy)
          outline(m.box, s, 'Typing')
          return
        }
        if (m.kind === 'press') {
          const label = keyLabel(m.key)
          const s = m.box && m.vw && m.vh ? scale(m.vw, m.vh) : null
          if (m.box && s) {
            const b = m.box
            outline(b, s)
            pill(label, (el) => {
              el.style.left = `${b.x * s.sx}px`
              el.style.top = `${(b.y + b.h) * s.sy + 6}px`
            })
          } else {
            pill(label, (el) => {
              // Centred without a transform, which the animation owns.
              Object.assign(el.style, { left: '0', right: '0', bottom: '16px', margin: '0 auto', width: 'fit-content' })
            })
          }
          return
        }
        pill(m.up ? '↑ Scroll' : '↓ Scroll', (el) => {
          el.style.right = '12px'
          el.style.top = '50%'
        })
      }
    }
  }, [])

  return (
    <div ref={rootRef} aria-hidden className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div
        ref={cursorRef}
        className="absolute top-0 left-0 opacity-0 transition-[translate,opacity] duration-300 ease-out"
        style={{ translate: '0px 0px' }}
      >
        {/* The arrow's tip is the click point. */}
        <svg width="18" height="22" viewBox="0 0 18 22" className="drop-shadow-[0_1px_2px_rgb(0_0_0/0.45)]">
          <path
            d="M1.5 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5h6z"
            className="fill-(--agent-mark) stroke-white"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {driver && (
        <div className="absolute top-2 left-2 flex max-w-[60%] items-center gap-1.5 rounded-full bg-popover/95 py-0.5 pr-2.5 pl-2 text-[11px] text-popover-foreground shadow-md ring-1 ring-border">
          <span className="relative flex size-1.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-(--agent-mark) opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-1.5 rounded-full bg-(--agent-mark)" />
          </span>
          <span className="truncate">{driver}</span>
        </div>
      )}
    </div>
  )
}

/** A key combo as a person would read it: `Meta+A` → `⌘A`, `Enter` → `⏎ Enter`. */
function keyLabel(combo: string): string {
  const mods: Record<string, string> = { meta: '⌘', cmd: '⌘', command: '⌘', control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧' }
  const named: Record<string, string> = {
    enter: '⏎ Enter',
    return: '⏎ Enter',
    tab: '⇥ Tab',
    escape: 'Esc',
    esc: 'Esc',
    backspace: '⌫',
    delete: '⌦',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    space: 'Space',
    ' ': 'Space'
  }
  const parts = combo.split('+').filter(Boolean)
  const key = parts.pop() ?? combo
  const prefix = parts.map((p) => mods[p.toLowerCase()] ?? `${p}+`).join('')
  const k = named[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return prefix + k
}

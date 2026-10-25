import * as React from 'react'
import { Bookmark } from 'lucide-react'
import type { TurnBookmark } from '@shared/types'
import { formatAgentDuration } from '@shared/agentRuns'
import { cn } from '@/lib/utils'
import type { RailTurn } from '@/lib/turnRail'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * The conversation's outline, down the transcript's left edge: one tick per
 * turn, the one being read drawn longer and brighter, a marked one in the
 * bookmark colour. Hovering a tick shows what was asked and how it ended;
 * clicking it goes there.
 *
 * **Evenly spaced, not placed by height.** A minimap places marks where their
 * content sits, which here would bunch every short exchange into a smudge
 * beside one long turn — and the heights are not even knowable, since settled
 * turns fold and older history is not loaded. The rail is an index of turns,
 * so every turn gets the same room, and what a turn *did* is the tick's length
 * (`RailTurn.weight`).
 *
 * It reaches as far as the loaded window. Above it, an "earlier" mark loads the
 * next window, and a bookmark further back still gets its tick — it carries its
 * own words (`TurnBookmark`) — and loads windows until its turn arrives.
 */

/** Ticks closer than this are no longer separate marks, so the rail windows. */
const MIN_PITCH = 5
const MAX_PITCH = 9
/** How much of the view's height the rail may take. */
const RAIL_SHARE = 0.7
/** Grace for the pointer to cross from a tick to its card. */
const CLOSE_MS = 160

/**
 * Two sizes, chosen by the gutter beside the reading column. A prompt box hangs
 * 14px into that gutter (`CHAT_BLEED`), so in a narrow thread column the full
 * rail would sit on its border; there it shrinks to the strip the box leaves.
 */
const WIDE = { left: 8, widths: [6, 9, 12, 15], active: 20, card: 34 }
const NARROW = { left: 2, widths: [3, 4, 5, 6], active: 7, card: 16 }
/** `max-w-3xl` — the reading column, padding included. */
const COLUMN = 768

type Entry =
  | { kind: 'turn'; key: string; turn: RailTurn; index: number }
  | { kind: 'earlier-mark'; key: string; mark: TurnBookmark }
  | { kind: 'earlier'; key: string }

export function TurnRail({
  turns,
  marked,
  earlier,
  hiddenBefore,
  scrollRef,
  onNavigate,
  onRevealEarlier,
  onToggleBookmark
}: {
  turns: RailTurn[]
  marked: ReadonlySet<string>
  /** Bookmarks behind the loaded window (`earlierBookmarks`). */
  earlier: TurnBookmark[]
  hiddenBefore: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  onNavigate(id: string): void
  /** Load history: one window, or until the given turn is on the page. */
  onRevealEarlier(id: string | null): void
  onToggleBookmark(id: string, prompt: string | null): void
}): React.JSX.Element {
  const railRef = React.useRef<HTMLDivElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const [view, setView] = React.useState({ h: 0, w: 0 })
  const [active, setActive] = React.useState<string | null>(null)
  const [hover, setHover] = React.useState<{ key: string; y: number } | null>(null)
  const closeTimer = React.useRef<number | undefined>(undefined)
  /**
   * The turn a click went to, held as the one being read until the reader
   * moves the transcript themselves. Without it a click on one of the last
   * turns — which cannot scroll to the top, so the jump ends at the bottom —
   * lit the final turn instead of the one clicked. The scroll the jump makes
   * cannot clear it (it is that scroll), so only the reader's own input does.
   */
  const target = React.useRef<string | null>(null)

  // The view this rail is drawn over — its height bounds the rail, its width
  // decides how much gutter there is to draw in.
  React.useLayoutEffect(() => {
    const el = railRef.current?.parentElement
    if (!el) return
    const read = (): void => setView({ h: el.clientHeight, w: el.clientWidth })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The turn being read: the last prompt above the top third of the scroller,
  // or the last turn once the reader is at the bottom. Measured at most once a
  // frame, and the prompts are collected when the turns change rather than per
  // scroll — the bubbles keep their elements across a fold.
  const idsKey = turns.map((t) => t.id).join('\n')
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    let nodes: HTMLElement[] = []
    const collect = (): void => {
      nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-turn-id]'))
    }
    const measure = (): void => {
      frame = 0
      if (target.current) {
        setActive(target.current)
        return
      }
      if (!nodes.length || !nodes[0].isConnected || !nodes[nodes.length - 1].isConnected) collect()
      if (!nodes.length) return
      let id = nodes[0].dataset.turnId ?? null
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) {
        id = nodes[nodes.length - 1].dataset.turnId ?? id
      } else {
        const box = el.getBoundingClientRect()
        const line = box.top + box.height / 3
        for (const n of nodes) {
          if (n.getBoundingClientRect().top > line) break
          id = n.dataset.turnId ?? id
        }
      }
      setActive(id)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const release = (): void => {
      if (!target.current) return
      target.current = null
      schedule()
    }
    collect()
    schedule()
    el.addEventListener('scroll', schedule, { passive: true })
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
      el.addEventListener(type, release, { passive: true })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
        el.removeEventListener(type, release)
      }
      ro.disconnect()
    }
  }, [scrollRef, idsKey])

  React.useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const entries = React.useMemo<Entry[]>(() => {
    const out: Entry[] = earlier.map((mark) => ({ kind: 'earlier-mark', key: `mark:${mark.id}`, mark }))
    if (hiddenBefore > 0) out.push({ kind: 'earlier', key: 'earlier' })
    turns.forEach((turn, index) => out.push({ kind: 'turn', key: turn.id, turn, index }))
    return out
  }, [earlier, hiddenBefore, turns])

  const geo = (view.w - Math.min(view.w, COLUMN)) / 2 >= 20 ? WIDE : NARROW
  const avail = Math.max(0, view.h * RAIL_SHARE)
  // Too many to space out: a window of the turns around the one being read,
  // faded at whichever end is cut.
  const fit = Math.max(1, Math.floor(avail / MIN_PITCH))
  let start = 0
  let end = entries.length
  if (entries.length > fit) {
    const at = Math.max(0, entries.findIndex((e) => e.key === active))
    start = Math.min(Math.max(0, at - Math.floor(fit / 2)), entries.length - fit)
    end = start + fit
  }
  const shown = entries.slice(start, end)
  const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, avail / Math.max(1, shown.length)))

  const hovered = hover ? entries.find((e) => e.key === hover.key) : undefined

  // Place the card against its tick, kept inside the view. Measured before
  // paint, so it never shows at a position it is about to leave.
  React.useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !hover) return
    const h = card.offsetHeight
    const top = Math.min(Math.max(8, hover.y - h / 2), Math.max(8, view.h - h - 8))
    card.style.top = `${top}px`
  }, [hover, hovered, view.h])

  // The container stays mounted while there is nothing to draw: it is what the
  // view's size is measured through, and a rail that mounted empty — a chat
  // still loading — would otherwise never learn how tall it is.
  const empty =
    (turns.length < 2 && hiddenBefore <= 0 && earlier.length === 0) ||
    view.h === 0 ||
    avail < MIN_PITCH * 2

  const keep = (): void => window.clearTimeout(closeTimer.current)
  const leave = (): void => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHover(null), CLOSE_MS)
  }
  const show = (key: string, target: HTMLElement): void => {
    keep()
    const base = railRef.current?.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    setHover({ key, y: r.top + r.height / 2 - (base?.top ?? 0) })
  }
  const go = (entry: Entry): void => {
    if (entry.kind === 'turn') {
      target.current = entry.turn.id
      setActive(entry.turn.id)
      onNavigate(entry.turn.id)
    } else onRevealEarlier(entry.kind === 'earlier-mark' ? entry.mark.id : null)
  }
  const goByKey = (key: string): void => {
    const entry = entries.find((e) => e.key === key)
    if (entry) go(entry)
  }

  const fade =
    start > 0 && end < entries.length
      ? 'linear-gradient(transparent, black 18%, black 82%, transparent)'
      : start > 0
        ? 'linear-gradient(transparent, black 18%)'
        : end < entries.length
          ? 'linear-gradient(black 82%, transparent)'
          : undefined

  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center"
      style={{ width: geo.card - 4 }}
    >
      {!empty && (
      <nav
        aria-label="Turns"
        className="pointer-events-auto flex w-full flex-col"
        style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
        onPointerLeave={leave}
      >
        {shown.map((entry) => {
          const isHover = hover?.key === entry.key
          if (entry.kind === 'earlier') {
            return (
              <button
                key={entry.key}
                type="button"
                aria-label="Load earlier messages"
                onPointerEnter={(e) => show(entry.key, e.currentTarget)}
                onFocus={(e) => show(entry.key, e.currentTarget)}
                onBlur={leave}
                onClick={() => go(entry)}
                className="flex w-full items-center outline-none"
                style={{ height: Math.max(pitch, 10) }}
              >
                <span className="flex flex-col gap-[2px]" style={{ marginLeft: geo.left }}>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        'block size-[2px] rounded-full transition-colors',
                        isHover ? 'bg-foreground/80' : 'bg-muted-foreground/45'
                      )}
                    />
                  ))}
                </span>
              </button>
            )
          }
          const id = entry.kind === 'turn' ? entry.turn.id : entry.mark.id
          const isActive = entry.kind === 'turn' && entry.turn.id === active
          const weight = entry.kind === 'turn' ? entry.turn.weight : 1
          return (
            <Tick
              key={entry.key}
              entryKey={entry.key}
              label={
                entry.kind === 'turn'
                  ? `Turn ${entry.index + 1}: ${entry.turn.prompt}`
                  : `Bookmark, earlier: ${entry.mark.text}`
              }
              active={isActive}
              marked={entry.kind === 'earlier-mark' || marked.has(id)}
              hover={isHover}
              live={entry.kind === 'turn' && entry.turn.live}
              width={isActive ? geo.active : geo.widths[weight] + (isHover ? 3 : 0)}
              left={geo.left}
              pitch={pitch}
              onShow={show}
              onLeave={leave}
              onGo={goByKey}
            />
          )
        })}
      </nav>
      )}

      {!empty && hover && hovered && (
        <div
          ref={cardRef}
          role="tooltip"
          onPointerEnter={keep}
          onPointerLeave={leave}
          className="pointer-events-auto absolute animate-in rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg transition-[top] duration-150 ease-out fade-in-0"
          style={{ left: geo.card, width: Math.max(200, Math.min(320, view.w - geo.card - 16)) }}
        >
          <RailCard
            entry={hovered}
            count={hiddenBefore > 0 ? null : turns.length}
            marked={hovered.kind === 'earlier-mark' || (hovered.kind === 'turn' && marked.has(hovered.turn.id))}
            onToggleBookmark={onToggleBookmark}
            onGo={() => go(hovered)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * One tick. Memoized on what it draws, all primitives, so that while a turn
 * streams only the live turn's tick (and the active one, when it moves) does
 * any work; the handlers it takes are read for their latest version through a
 * ref, so their identity changing every render does not defeat the memo.
 */
const Tick = React.memo(
  function Tick(props: {
    entryKey: string
    label: string
    active: boolean
    marked: boolean
    hover: boolean
    live: boolean
    width: number
    left: number
    pitch: number
    onShow(key: string, target: HTMLElement): void
    onLeave(): void
    onGo(key: string): void
  }): React.JSX.Element {
    const { entryKey, label, active, marked, hover, live, width, left, pitch } = props
    const latest = React.useRef(props)
    latest.current = props
    return (
      <button
        type="button"
        aria-label={label}
        aria-current={active ? 'location' : undefined}
        onPointerEnter={(e) => latest.current.onShow(entryKey, e.currentTarget)}
        onFocus={(e) => latest.current.onShow(entryKey, e.currentTarget)}
        onBlur={() => latest.current.onLeave()}
        onClick={() => latest.current.onGo(entryKey)}
        className="group/tick flex w-full items-center outline-none"
        style={{ height: pitch }}
      >
        <span
          className={cn(
            'block h-[2px] rounded-full transition-[width,background-color] duration-150 group-focus-visible/tick:outline group-focus-visible/tick:outline-2 group-focus-visible/tick:outline-offset-2 group-focus-visible/tick:outline-ring',
            marked
              ? 'bg-warning'
              : active
                ? 'bg-foreground'
                : hover
                  ? 'bg-foreground/75'
                  : 'bg-muted-foreground/45',
            live && 'animate-pulse-soft'
          )}
          style={{ width, marginLeft: left }}
        />
      </button>
    )
  },
  (a, b) =>
    a.entryKey === b.entryKey &&
    a.label === b.label &&
    a.active === b.active &&
    a.marked === b.marked &&
    a.hover === b.hover &&
    a.live === b.live &&
    a.width === b.width &&
    a.left === b.left &&
    a.pitch === b.pitch
)

/**
 * What a tick stands for. The facts line is the turn header's own reading —
 * the same clock and words — so the card and the transcript never disagree
 * about a turn; the prompt sits in a box like the one it was sent in.
 */
function RailCard({
  entry,
  count,
  marked,
  onToggleBookmark,
  onGo
}: {
  entry: Entry
  /** Turns in the chat, when all of them are loaded and the number is true. */
  count: number | null
  marked: boolean
  onToggleBookmark(id: string, prompt: string | null): void
  /** The card's body is the tick's own action, at a size a pointer can hit. */
  onGo(): void
}): React.JSX.Element {
  if (entry.kind === 'earlier') {
    return (
      <div className="text-xs leading-relaxed text-muted-foreground">
        <div className="text-[13px] text-foreground">Earlier messages</div>
        Not loaded yet. Click to load the next part of the conversation.
      </div>
    )
  }
  const id = entry.kind === 'turn' ? entry.turn.id : entry.mark.id
  const prompt = entry.kind === 'turn' ? entry.turn.prompt : entry.mark.text
  const facts: string[] = []
  if (entry.kind === 'turn') {
    const { turn } = entry
    facts.push(count ? `Turn ${entry.index + 1} of ${count}` : `Turn ${entry.index + 1}`)
    if (turn.live) facts.push('Working…')
    else if (turn.ms > 0) facts.push(`Worked for ${formatAgentDuration(turn.ms)}`)
    if (turn.steps > 0) facts.push(`${turn.steps} step${turn.steps === 1 ? '' : 's'}`)
  } else facts.push('Earlier in this chat')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{facts.join(' · ')}</span>
        <WithTooltip label={marked ? 'Remove bookmark' : 'Bookmark this turn'}>
          <button
            type="button"
            aria-label={marked ? 'Remove bookmark' : 'Bookmark this turn'}
            aria-pressed={marked}
            onClick={() => onToggleBookmark(id, marked ? null : prompt)}
            className={cn(
              '-my-1 -mr-1 ml-auto shrink-0 rounded-md p-1 transition-colors hover:bg-accent',
              marked ? 'text-warning' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Bookmark className={cn('size-3.5', marked && 'fill-current')} />
          </button>
        </WithTooltip>
      </div>
      <button
        type="button"
        onClick={onGo}
        className="line-clamp-3 rounded-lg bg-secondary/70 px-2.5 py-1.5 text-left text-[13px] leading-snug break-words text-foreground transition-colors hover:bg-secondary"
      >
        {prompt}
      </button>
      {entry.kind === 'turn' && entry.turn.answer ? (
        <p className="line-clamp-4 text-xs leading-relaxed break-words text-muted-foreground">
          {entry.turn.answer}
        </p>
      ) : entry.kind === 'earlier-mark' ? (
        <p className="text-xs text-muted-foreground">Click to load it and go there.</p>
      ) : null}
    </div>
  )
}

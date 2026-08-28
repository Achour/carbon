import * as React from 'react'
import { ExternalLink, Minus, Plus, Scan, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { WithTooltip } from '@/components/ui/tooltip'

const MIN_SCALE = 0.05
const MAX_SCALE = 16
const clamp = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n))

/**
 * An image you can actually read.
 *
 * "Fit to the pane" is the right *default* and a useless *only* option: the
 * images that land here are screenshots and diagrams — a 2560px-wide capture
 * scaled into a side panel is a picture of unreadable text. So the image is
 * sized in real pixels (`width = natural × scale`) inside a scroller, which
 * makes panning the browser's own job and keeps the zoom honest: 100% means
 * 100%.
 *
 * Scale is `null` until the user touches it, meaning "fit" — held as absence
 * rather than as a computed number so a resize (dragging the panel wider,
 * maximizing it) re-fits instead of freezing the ratio that fit the old width.
 */
export function ImageView({
  src,
  alt,
  className,
  autoFocus = false
}: {
  src: string
  alt?: string
  className?: string
  /** Take focus on mount, so +/-/0/1 work without a click first (the lightbox). */
  autoFocus?: boolean
}): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  const [box, setBox] = React.useState<{ w: number; h: number } | null>(null)
  const [scale, setScale] = React.useState<number | null>(null)

  // A new image is a new fit.
  React.useEffect(() => {
    setScale(null)
    setNatural(null)
  }, [src])

  React.useEffect(() => {
    if (autoFocus) scrollRef.current?.focus()
  }, [autoFocus])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit never *enlarges*: a 200px icon blown up to fill a panel is a blurry lie
  // about what the file contains. Zooming in is then an explicit act.
  const fit = React.useMemo(() => {
    if (!natural || !box || !natural.w || !natural.h || !box.w || !box.h) return 1
    return Math.min(box.w / natural.w, box.h / natural.h, 1)
  }, [natural, box])
  const effective = scale ?? fit

  /**
   * Zoom, keeping whatever is under the pointer under the pointer.
   *
   * The scroll position has to move with the scale or zooming walks the image
   * away from the thing you were looking at — the one behaviour that makes a
   * zoom control feel broken. `anchor` is in container coordinates; the default
   * is the middle, which is what the buttons and the keyboard want.
   */
  const zoomTo = React.useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const el = scrollRef.current
      const from = effective
      const to = clamp(next)
      if (!el || to === from) {
        setScale(to)
        return
      }
      const ax = anchor?.x ?? el.clientWidth / 2
      const ay = anchor?.y ?? el.clientHeight / 2
      const cx = (el.scrollLeft + ax) / from
      const cy = (el.scrollTop + ay) / from
      setScale(to)
      requestAnimationFrame(() => {
        el.scrollLeft = cx * to - ax
        el.scrollTop = cy * to - ay
      })
    },
    [effective]
  )

  // Wheel and pinch both arrive here — a trackpad pinch is a wheel event with
  // ctrlKey set. Registered by hand because it must not be passive: there is
  // nothing else to scroll at fit, so the page-level scroll has to be stopped.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey && e.deltaY === 0) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomTo(effective * Math.exp(-e.deltaY / 300), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, effective])

  // Drag to pan. `moved` is what keeps a pan from also counting as the click
  // that toggles zoom.
  const drag = React.useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    const el = scrollRef.current
    if (!d || !el) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    el.scrollLeft -= dx
    el.scrollTop -= dy
    d.x = e.clientX
    d.y = e.clientY
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    // A plain click toggles between fit and actual size, anchored where you
    // clicked — the gesture every image viewer has.
    const el = scrollRef.current
    const rect = el?.getBoundingClientRect()
    const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined
    if (effective < 1) zoomTo(1, anchor)
    else setScale(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomTo(effective * 1.25)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomTo(effective / 1.25)
    } else if (e.key === '0') {
      e.preventDefault()
      setScale(null)
    } else if (e.key === '1') {
      e.preventDefault()
      zoomTo(1)
    }
  }

  const atFit = scale === null
  const percent = Math.round(effective * 100)

  return (
    <div className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          'min-h-0 flex-1 overflow-auto outline-none active:cursor-grabbing',
          effective < 1 ? 'cursor-zoom-in' : 'cursor-grab'
        )}
      >
        {/* Centers the image while it is smaller than the pane, and stops
            collapsing the moment it is larger — `min-w/h-full` plus `w-fit`
            keeps the scroller's content box exactly the image's size. */}
        <div className="flex min-h-full min-w-full items-center justify-center p-4">
          <img
            src={src}
            alt={alt ?? ''}
            draggable={false}
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight
              })
            }
            style={
              natural
                ? {
                    width: Math.max(1, Math.round(natural.w * effective)),
                    height: Math.max(1, Math.round(natural.h * effective)),
                    // Above ~1:1 the browser's smoothing turns a screenshot into
                    // mush; nearest-neighbour keeps the pixels readable.
                    imageRendering: effective > 1.5 ? 'pixelated' : 'auto'
                  }
                : undefined
            }
            className="max-w-none rounded-md border border-border select-none"
          />
        </div>
      </div>
      <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-px rounded-lg border border-border bg-popover/90 p-0.5 shadow-lg backdrop-blur">
        <Button
          size="icon-sm"
          variant="ghost"
          className="pointer-events-auto size-6"
          aria-label="Zoom out"
          onClick={() => zoomTo(effective / 1.25)}
        >
          <Minus className="size-3" />
        </Button>
        <button
          type="button"
          onClick={() => setScale(atFit ? 1 : null)}
          className="pointer-events-auto min-w-12 rounded px-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={atFit ? 'Actual size (1)' : 'Fit (0)'}
        >
          {percent}%
        </button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="pointer-events-auto size-6"
          aria-label="Zoom in"
          onClick={() => zoomTo(effective * 1.25)}
        >
          <Plus className="size-3" />
        </Button>
        {!atFit && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="pointer-events-auto size-6"
            aria-label="Fit to pane"
            onClick={() => setScale(null)}
          >
            <Scan className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The full-window view, opened by clicking an image in the transcript.
 *
 * Clicking an image in a message used to open it as a file tab, which put a
 * screenshot in the *narrowest* column on screen — a side panel with the file
 * tree docked beside it — and offered no zoom, so the answer to "let me see
 * that" was a smaller picture than the one already in the message. The window
 * is the only surface big enough to be worth the click; the tab is still one
 * button away, for when it should stay open beside the conversation.
 */
export function ImageLightbox(): React.JSX.Element | null {
  const path = useApp((s) => s.lightbox)
  const closeLightbox = useApp((s) => s.closeLightbox)
  const openFile = useApp((s) => s.openFile)
  const [uri, setUri] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!path) return undefined
    let alive = true
    setUri(null)
    setFailed(false)
    // Read directly rather than through `imageCache`: this is one image the user
    // asked for by name, and the cache exists to keep a transcript full of them
    // from re-reading on every turn.
    void window.api
      .readFile(path)
      .then((c) => {
        if (!alive) return
        if (c.kind === 'image') setUri(c.dataUri)
        else setFailed(true)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [path])

  if (!path) return null
  const name = path.split('/').pop() ?? path

  return (
    <Dialog open onOpenChange={(open) => !open && closeLightbox()}>
      <DialogContent
        aria-label={name}
        className="flex h-[90vh] w-[92vw] max-w-none flex-col overflow-hidden p-0"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
          <WithTooltip label="Open as a tab">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open as a tab"
              onClick={() => {
                void openFile(path, { preview: true })
                closeLightbox()
              }}
            >
              <ExternalLink />
            </Button>
          </WithTooltip>
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={closeLightbox}>
            <X />
          </Button>
        </header>
        <div className="min-h-0 flex-1">
          {uri ? (
            <ImageView src={uri} alt={name} autoFocus />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {failed ? 'That file is not a readable image.' : 'Loading…'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

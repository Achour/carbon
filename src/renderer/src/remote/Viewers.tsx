import * as React from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Loader2 } from 'lucide-react'
import type { Canvas } from '@shared/types'
import { agentRunOf } from '@shared/agentRuns'
import { useAgentPart } from '@/components/messages/AgentRows'
import { SubAgentStream } from '@/components/messages/ToolCard'
import { invoke } from './api'

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** Where a back swipe has to start: the screen's left edge, as on iOS. */
const EDGE = 24

/**
 * What the desktop opens in its right panel or a thread column, opened over
 * the phone's chat instead: a full-screen layer with its own title and a way
 * back. Kept separate from `Sheet` because these are documents to read at
 * length, and a sheet's 82% height and drag-to-dismiss posture are a picker's.
 *
 * It behaves as a pushed screen does on iOS: it slides in from the right over
 * the chat, which dims, and a swipe from the left edge
 * follows the finger back. Leaving (the back button or a swipe) slides it out
 * before `onClose` unmounts it. The edge strip sits above the content, because
 * a canvas is an iframe and an iframe keeps every touch that lands on it.
 */
function FullView({
  title,
  onClose,
  children
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const layer = React.useRef<HTMLDivElement>(null)
  const shade = React.useRef<HTMLDivElement>(null)
  const closing = React.useRef(false)
  const done = React.useRef(onClose)
  done.current = onClose

  const paint = React.useCallback((x: number, ms: number): void => {
    const el = layer.current
    if (!el) return
    const w = el.offsetWidth || window.innerWidth
    el.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none'
    el.style.transform = `translateX(${x}px)`
    if (shade.current) {
      shade.current.style.transition = ms ? `opacity ${ms}ms ${EASE}` : 'none'
      shade.current.style.opacity = String(Math.max(0, 1 - x / w))
    }
  }, [])

  const leave = React.useCallback((): void => {
    if (closing.current) return
    closing.current = true
    paint(layer.current?.offsetWidth ?? window.innerWidth, 300)
    setTimeout(() => done.current(), 300)
  }, [paint])

  // In from the right, on the next frame so the start position paints first.
  React.useLayoutEffect(() => {
    paint(window.innerWidth, 0)
    const raf = requestAnimationFrame(() => paint(0, 420))
    return () => cancelAnimationFrame(raf)
  }, [paint])

  const swipe = React.useRef<{ x: number; y: number; t: number; v: number; dx: number; axis: 'x' | 'y' | null } | null>(null)
  const onTouchStart = (e: React.TouchEvent): void => {
    const t = e.touches[0]
    swipe.current = { x: t.clientX, y: t.clientY, t: e.timeStamp, v: 0, dx: 0, axis: null }
  }
  const onTouchMove = (e: React.TouchEvent): void => {
    const g = swipe.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (!g.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (g.axis !== 'x') return
    const x = Math.max(0, dx)
    g.v = (x - g.dx) / Math.max(1, e.timeStamp - g.t)
    g.dx = x
    g.t = e.timeStamp
    paint(x, 0)
  }
  const onTouchEnd = (): void => {
    const g = swipe.current
    swipe.current = null
    if (!g || g.axis !== 'x') return
    const w = layer.current?.offsetWidth ?? window.innerWidth
    if (g.v > 0.35 || g.dx > w / 3) leave()
    else paint(0, 300)
  }

  return createPortal(
    // A portal bubbles through the React tree, into the shell's drawer gesture.
    <div className="fixed inset-0 z-50" onTouchStart={(e) => e.stopPropagation()}>
      <div ref={shade} aria-hidden className="absolute inset-0 bg-black/30 opacity-0" />
      <div
        ref={layer}
        role="dialog"
        className="absolute inset-0 flex flex-col bg-background pt-[env(safe-area-inset-top)] shadow-[-8px_0_32px_rgb(0_0_0/0.18)] will-change-transform"
        style={{ transform: 'translateX(100%)' }}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border/70 px-1.5">
          <button
            type="button"
            aria-label="Back"
            onClick={leave}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
          >
            <ChevronLeft className="size-6" />
          </button>
          <span className="min-w-0 flex-1 truncate pr-12 text-center text-[16px] font-semibold">{title}</span>
        </div>
        <div className="relative min-h-0 flex-1">
          {children}
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 z-10"
            style={{ width: EDGE }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * A canvas, framed exactly as `CanvasDoc` frames it on the desktop:
 * `allow-scripts` without `allow-same-origin`, so the document runs in an
 * opaque origin and can reach nothing of this page — not its cookie, which is
 * the phone's pairing.
 */
export function CanvasView({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const [canvas, setCanvas] = React.useState<Canvas | null | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    invoke<Canvas | null>('canvas:get', id)
      .then((c) => alive && setCanvas(c))
      .catch(() => alive && setCanvas(null))
    return () => {
      alive = false
    }
  }, [id])
  const dark = document.documentElement.classList.contains('dark')
  return (
    <FullView title={canvas?.title ?? 'Canvas'} onClose={onClose}>
      {canvas === undefined ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : canvas === null ? (
        <div className="flex h-full items-center justify-center px-8 text-center text-[15px] text-muted-foreground">
          This canvas no longer exists.
        </div>
      ) : (
        <iframe
          title={canvas.title}
          srcDoc={canvas.html}
          sandbox="allow-scripts"
          style={{ colorScheme: dark ? 'dark' : 'light' }}
          className="h-full w-full border-0 bg-background"
        />
      )}
    </FullView>
  )
}

/**
 * A sub-agent's own transcript — the desktop's agent column, as a layer. Read
 * live out of the parent's transcript, so it keeps streaming while open.
 */
export function AgentView({
  parentId,
  toolUseId,
  cwd,
  onClose
}: {
  parentId: string
  toolUseId: string
  cwd: string
  onClose: () => void
}): React.JSX.Element {
  const part = useAgentPart(parentId, toolUseId)
  const run = React.useMemo(() => (part ? agentRunOf(part) : null), [part])
  const children = part?.children ?? []
  return (
    <FullView title={run ? run.description || run.type || 'Agent' : 'Agent'} onClose={onClose}>
      <div className="h-full overflow-y-auto overscroll-contain px-4 py-4">
        {children.length === 0 ? (
          <div className="py-16 text-center text-[15px] text-muted-foreground">
            {part?.status === 'running' ? 'Starting…' : 'Nothing to show yet.'}
          </div>
        ) : (
          <div className="reading-zoom">
            <SubAgentStream parts={children} cwd={cwd} live={part?.status === 'running'} />
          </div>
        )}
      </div>
    </FullView>
  )
}

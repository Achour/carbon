import * as React from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { LineDeltas } from '@/components/GitPanel'
import { FileIcon } from '@/lib/fileIcon'
import { cn } from '@/lib/utils'
import type { Canvas } from '@shared/types'
import { agentRunOf } from '@shared/agentRuns'
import { useAgentPart } from '@/components/messages/AgentRows'
import { SubAgentStream } from '@/components/messages/ToolCard'
import { DiffView } from '@/components/DiffView'
import { languageForPath } from '@/lib/highlight'
import { changes as fetchChanges, diff as fetchDiff, invoke, type ChangedFile } from './api'

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
/**
 * One changed file's diff, opened from a turn's changed-files row: what the
 * desktop shows in its diff panel, wrapped to the phone's width. It is the
 * file's uncommitted change now, not as of that turn, so a file committed
 * since has nothing left to show, and says so.
 */
export function DiffScreen({
  chatId,
  path,
  scope,
  onClose
}: {
  chatId: string
  path: string
  /** `repo`: `path` is relative to the repository's root, not the chat's folder. */
  scope?: 'repo'
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = React.useState<string | undefined>(undefined)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    fetchDiff(chatId, path, scope)
      .then((d) => alive && setText(d))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [chatId, path, scope])
  const name = path.split('/').pop() ?? path
  return (
    <FullView title={name} onClose={onClose}>
      {error ? (
        <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">{error}</div>
      ) : text === '' ? (
        <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">
          No uncommitted changes to {name} — they have been committed or undone since.
        </div>
      ) : text && !text.includes('@@') && /^Binary files /m.test(text) ? (
        <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">
          {name} is a binary file, so there are no lines to compare.
        </div>
      ) : (
        <div className="h-full text-[12px]">
          <DiffView text={text} language={languageForPath(path)} wrap />
        </div>
      )}
    </FullView>
  )
}

const STATUS_WORD: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'New'
}

/**
 * Everything uncommitted in the chat's repository, from the chat menu's "View
 * changes": the list a turn's changed-files card cannot stand in for, since
 * that card appears only when the turn's own edits were tracked. A row opens
 * its diff on top, and back returns to the list.
 */
export function ChangesScreen({ chatId, onClose }: { chatId: string; onClose: () => void }): React.JSX.Element {
  const [state, setState] = React.useState<{ branch: string; files: ChangedFile[]; isRepo: boolean } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    fetchChanges(chatId)
      .then((r) => alive && setState(r))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [chatId])
  const additions = state?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const deletions = state?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0
  return (
    <>
      <FullView title="Changes" onClose={onClose}>
        <div className="h-full overflow-y-auto overscroll-contain">
          {error ? (
            <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">{error}</div>
          ) : !state ? (
            <div className="flex justify-center py-16 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : !state.isRepo ? (
            <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">This chat’s folder isn’t a git repository.</div>
          ) : state.files.length === 0 ? (
            <div className="px-6 py-16 text-center text-[14px] text-muted-foreground">
              No uncommitted changes{state.branch ? ` on ${state.branch}` : ''}.
            </div>
          ) : (
            <div className="px-3 py-3">
              <div className="flex items-center justify-between px-2 pb-2 text-[13px] text-muted-foreground">
                <span>
                  {state.files.length} file{state.files.length === 1 ? '' : 's'}
                  {state.branch ? ` on ${state.branch}` : ''}
                </span>
                <LineDeltas additions={additions} deletions={deletions} className="text-[13px]" />
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {state.files.map((f) => {
                  const name = f.path.split('/').pop() ?? f.path
                  const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '')
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setOpen(f.path)}
                      className="flex w-full items-center gap-3 px-3.5 py-3 text-left active:bg-accent"
                    >
                      <FileIcon path={name} className="size-[18px] shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-[15px]', f.status === 'D' && 'line-through opacity-70')}>{name}</span>
                        <span className="block truncate text-[12.5px] text-muted-foreground">
                          {STATUS_WORD[f.status] ?? f.status}
                          {dir ? ` · ${dir}` : ''}
                        </span>
                      </span>
                      <LineDeltas additions={f.additions ?? 0} deletions={f.deletions ?? 0} className="shrink-0 text-[12.5px]" />
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </FullView>
      {open && <DiffScreen chatId={chatId} path={open} scope="repo" onClose={() => setOpen(null)} />}
    </>
  )
}

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

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import type { Canvas } from '@shared/types'
import { agentRunOf } from '@shared/agentRuns'
import { useAgentPart } from '@/components/messages/AgentRows'
import { SubAgentStream } from '@/components/messages/ToolCard'
import { invoke } from './api'

/**
 * What the desktop opens in its right panel or a thread column, opened over
 * the phone's chat instead: a full-screen layer with its own title and a way
 * back. Kept separate from `Sheet` because these are documents to read at
 * length, and a sheet's 82% height and drag-to-dismiss posture are a picker's.
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
  return createPortal(
    <div
      role="dialog"
      className="fixed inset-0 z-50 flex animate-in flex-col bg-background pt-[env(safe-area-inset-top)] duration-200 fade-in slide-in-from-bottom-6"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate pl-2 text-[15px] font-medium">{title}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
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
          <SubAgentStream parts={children} cwd={cwd} live={part?.status === 'running'} />
        )}
      </div>
    </FullView>
  )
}

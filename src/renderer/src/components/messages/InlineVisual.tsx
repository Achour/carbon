import * as React from 'react'
import type { ToolPart } from '@shared/types'
import { chartCall } from '@shared/chartSpec'
import { diagramCall } from '@shared/diagramSpec'

/**
 * Recharts and dagre are large dependencies most chats never draw, so each
 * visual is a lazy chunk — off the path to first paint, and warmed on idle by
 * `preloadHeavyChunks` so the first one does not wait on a fetch either.
 */
const ChartCard = React.lazy(() => import('./ChartCard'))
const DiagramCard = React.lazy(() => import('./DiagramCard'))

/** Warm the chunks off the critical path — see `lib/preloadHeavy.ts`. */
export function preloadVisuals(): Promise<unknown> {
  return Promise.all([import('./ChartCard'), import('./DiagramCard')])
}

/**
 * Whether a call drew something inline — a chart or a diagram — in any
 * provider's spelling. The one question every transcript path asks, so a third
 * kind of visual is added here and nowhere else.
 */
export function isInlineVisual(part: ToolPart): boolean {
  return chartCall(part) !== null || diagramCall(part) !== null
}

/**
 * A visual that throws costs its own card, never the chat around it.
 *
 * Rendering happens in the transcript, under the content pane's boundary — so
 * before this, one graph dagre could not lay out replaced the chat *and* the
 * right panel with a crash screen, and did again every time the chat was
 * reopened, since the call that caused it is saved with the chat. The layout
 * now survives every input known to break it (`lib/diagramLayout.ts`); this is
 * for the one nobody has found yet.
 */
class VisualBoundary extends React.Component<
  React.PropsWithChildren<{ title: string }>,
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    console.error('[inline visual]', this.props.title, error.message)
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        Couldn't draw “{this.props.title}”.
      </div>
    )
  }
}

/**
 * What a `chart_render` or `diagram_render` call drew, **in the transcript,
 * under the call** — read straight off the call's own input, which is the only
 * place it lives. Nothing is fetched and nothing is versioned: a later visual is
 * a new call, and this one stays what it was, the way a reply keeps the
 * screenshot it took.
 *
 * It is a result in the sense `ToolOutputImages` is, so it is drawn on every
 * path a screenshot is and survives the turn folding (`AssistantBlock`,
 * `renderMessages`). Drawn once the call has succeeded: before that the input
 * is still streaming, and a refused spec was answered to the model, not drawn.
 */
export function InlineVisual({ part }: { part: ToolPart }): React.JSX.Element | null {
  const chart = React.useMemo(() => chartCall(part), [part])
  const diagram = React.useMemo(() => (chart ? null : diagramCall(part)), [part, chart])
  if ((!chart && !diagram) || part.status !== 'success') return null
  return (
    <VisualBoundary title={(chart ?? diagram)!.title}>
      <React.Suspense
        // The card's own frame at roughly its height, so the transcript does
        // not jump when the chunk lands.
        fallback={<div className="h-[300px] rounded-lg border border-border bg-card" />}
      >
        {chart ? <ChartCard spec={chart} /> : <DiagramCard spec={diagram!} />}
      </React.Suspense>
    </VisualBoundary>
  )
}

import * as React from 'react'
import type { ToolPart } from '@shared/types'
import { chartCall } from '@shared/chartSpec'

/**
 * Recharts is a large dependency most chats never draw, so the chart itself is
 * a lazy chunk — off the path to first paint, and warmed on idle by
 * `preloadHeavyChunks` so the first chart does not wait on a fetch either.
 */
const ChartCard = React.lazy(() => import('./ChartCard'))

/** Warm the chunk off the critical path — see `lib/preloadHeavy.ts`. */
export function preloadChart(): Promise<unknown> {
  return import('./ChartCard')
}

/**
 * The chart a `chart_render` call drew, **in the transcript, under the call**
 * — read straight off the call's own input (`chartCall`), which is the only
 * place it lives. Nothing is fetched and nothing is versioned: a later chart is
 * a new call with its own data, and this one stays what it was, the way a
 * reply keeps the screenshot it took.
 *
 * It is a result in the sense `ToolOutputImages` is, so it is drawn on every
 * path a screenshot is and survives the turn folding (`AssistantBlock`,
 * `renderMessages`). Drawn once the call has succeeded: before that the input
 * is still streaming, and a refused spec was answered to the model, not drawn.
 */
export function ChartEmbed({ part }: { part: ToolPart }): React.JSX.Element | null {
  const spec = React.useMemo(() => chartCall(part), [part])
  if (!spec || part.status !== 'success') return null
  return (
    <React.Suspense
      // The card's own frame at roughly its height, so the transcript does not
      // jump when the chunk lands.
      fallback={<div className="h-[300px] rounded-lg border border-border bg-card" />}
    >
      <ChartCard spec={spec} />
    </React.Suspense>
  )
}

import * as React from 'react'
import { Check, TriangleAlert, X } from 'lucide-react'
import type { DiagramSpec, DiagramTone } from '@shared/diagramSpec'
import {
  DETAIL_LINE,
  DETAIL_PX,
  DiagramLayouts,
  LABEL_LINE,
  LABEL_PX,
  LABEL_WEIGHT,
  MIN_SCALE,
  PAD_X,
  PAD_Y,
  TAG_LINE,
  TAG_PX,
  type Measure
} from '@/lib/diagramLayout'
import { cn } from '@/lib/utils'

/**
 * A flow diagram an agent drew with `diagram_render`, laid out by
 * `lib/diagramLayout.ts` and drawn with the app's own surfaces — the heavy half
 * of `InlineVisual`, a lazy chunk like the chart (see `lib/preloadHeavy.ts`).
 *
 * Nodes are HTML, edges are SVG, in one box. HTML rather than SVG text because
 * the boxes then wear the app's type, wrapping and theme tokens directly, and
 * stay crisp when the box is scaled; the layout is computed from text measured
 * in the same font, so what dagre sized is what the browser draws.
 */

/**
 * State tones carry an icon as well as a colour — a state never rides on hue
 * alone. `accent` and `muted` are emphasis, not state, so they have none.
 */
const TONE: Record<DiagramTone, { box: string; icon?: React.ElementType; iconClass?: string }> = {
  default: { box: 'border-border bg-card' },
  accent: { box: 'border-primary/60 bg-primary/10' },
  muted: { box: 'border-border/70 bg-muted/40 text-muted-foreground' },
  success: { box: 'border-success/50 bg-success/10', icon: Check, iconClass: 'text-success' },
  warning: { box: 'border-warning/50 bg-warning/10', icon: TriangleAlert, iconClass: 'text-warning' },
  danger: { box: 'border-destructive/50 bg-destructive/10', icon: X, iconClass: 'text-destructive' }
}

/** What a state tone says in words, for the text description. */
const TONE_WORD: Partial<Record<DiagramTone, string>> = {
  success: 'success',
  warning: 'warning',
  danger: 'failure'
}

/** A smooth path through dagre's points: straight runs, rounded at each bend. */
function edgePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return ''
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  let d = `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) return `${d} L ${points[1].x} ${points[1].y}`
  const first = mid(points[0], points[1])
  d += ` L ${first.x} ${first.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const m = mid(points[i], points[i + 1])
    d += ` Q ${points[i].x} ${points[i].y} ${m.x} ${m.y}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

/** Canvas `measureText` in the body's own font — the font the boxes are drawn in. */
function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!
  const font = getComputedStyle(document.body).fontFamily || 'system-ui'
  return (text, px, weight) => {
    ctx.font = `${weight} ${px}px ${font}`
    return ctx.measureText(text).width
  }
}

export default function DiagramCard({ spec }: { spec: DiagramSpec }): React.JSX.Element {
  const marker = React.useId().replace(/:/g, '')
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const [avail, setAvail] = React.useState<number | null>(null)

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // The content box, not `clientWidth`, which counts the padding — read
    // that way, every fit test was 32px generous and a diagram that "fit"
    // scrolled.
    const measure = (): void => {
      const cs = getComputedStyle(el)
      setAvail(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // One set of candidate layouts per spec, built lazily and kept: a resize
  // chooses among them rather than laying the graph out again.
  const layouts = React.useMemo(() => new DiagramLayouts(spec, canvasMeasure()), [spec])
  const layout = React.useMemo(() => layouts.pick(avail), [layouts, avail])

  // Never enlarged; shrunk to fit the column down to MIN_SCALE, then scrolled.
  const scale = avail ? Math.max(MIN_SCALE, Math.min(1, avail / layout.width)) : 1
  const nameOf = (id: string): string => spec.nodes.find((n) => n.id === id)?.label ?? id
  const descId = `${marker}-desc`

  return (
    <figure
      data-diagram-render
      aria-label={spec.title}
      aria-describedby={descId}
      className="m-0 rounded-lg border border-border bg-card text-card-foreground"
    >
      <figcaption className="px-4 pt-3.5">
        <div className="text-[13px] leading-snug font-medium">{spec.title}</div>
        {spec.description && <div className="text-xs text-muted-foreground">{spec.description}</div>}
      </figcaption>
      {/* The drawing is for the eye; this is the same graph in words — every
          step, its detail and state, its group, and where each arrow goes and
          on what condition. A `role="img"` named only by the title made the
          whole graph presentational to a screen reader. */}
      <div id={descId} className="sr-only">
        <p>{layout.direction === 'right' ? 'Flow from left to right.' : 'Flow from top to bottom.'}</p>
        <ul>
          {spec.nodes.map((node) => (
            <li key={node.id}>
              {node.label}
              {node.detail ? `: ${node.detail}` : ''}
              {TONE_WORD[node.tone] ? ` (${TONE_WORD[node.tone]})` : ''}
              {node.group ? `, in ${spec.groups.find((g) => g.id === node.group)?.label ?? node.group}` : ''}
            </li>
          ))}
        </ul>
        {spec.edges.length > 0 && (
          <ul>
            {spec.edges.map((edge, i) => (
              <li key={i}>
                {nameOf(edge.from)} to {nameOf(edge.to)}
                {edge.label ? `, ${edge.label}` : ''}
                {/* Neutral on purpose: a dashed edge may be optional, async or
                    a fallback, and the text must not pick one for it. */}
                {edge.dashed ? ' (dashed)' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={wrapRef} aria-hidden className="overflow-x-auto px-4 pt-3 pb-3.5">
        <div className="relative mx-auto" style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
            {layout.groups.map((group, i) => (
              <div
                key={i}
                className="absolute rounded-xl border border-border/70 bg-muted/30"
                style={{ left: group.x, top: group.y, width: group.w, height: group.h }}
              />
            ))}
            <svg
              className="absolute top-0 left-0 overflow-visible text-muted-foreground/70"
              width={layout.width}
              height={layout.height}
            >
              <defs>
                <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {layout.edges.map((edge, i) => (
                <path
                  key={i}
                  d={edgePath(edge.points)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeDasharray={edge.dashed ? '5 4' : undefined}
                  strokeLinecap="round"
                  markerEnd={`url(#${marker})`}
                />
              ))}
            </svg>
            {/* Group captions sit *above* the edges, on the card's colour: an
                edge entering a group at its top centre otherwise ran straight
                through a caption long enough to reach the middle. */}
            {layout.groups.map((group, i) => (
              <div
                key={i}
                className="absolute truncate rounded-sm bg-card px-1 text-[11px] leading-4 text-muted-foreground"
                style={{ left: group.x + 8, top: group.y + 4, maxWidth: group.w - 16 }}
              >
                {group.label}
              </div>
            ))}
            {layout.edges.map((edge, i) =>
              edge.label && edge.lx != null && edge.ly != null && edge.lw != null && edge.lh != null ? (
                <div
                  key={i}
                  className="absolute flex items-center justify-center rounded-md border border-border bg-card text-[11px] whitespace-nowrap text-muted-foreground"
                  // The size dagre reserved for the label — the same one the
                  // bounds were trimmed to.
                  style={{ left: edge.lx - edge.lw / 2, top: edge.ly - edge.lh / 2, width: edge.lw, height: edge.lh }}
                >
                  {edge.label}
                </div>
              ) : null
            )}
            {layout.nodes.map(({ node, x, y, w, h, tag }) => {
              const tone = TONE[node.tone]
              const Icon = tone.icon
              return (
                <div
                  key={node.id}
                  className={cn('absolute rounded-lg border shadow-xs', tone.box)}
                  style={{ left: x, top: y, width: w, height: h, padding: `${PAD_Y}px ${PAD_X}px` }}
                >
                  {tag && (
                    <div
                      className="truncate text-center text-muted-foreground"
                      style={{ fontSize: TAG_PX, lineHeight: `${TAG_LINE}px` }}
                    >
                      {tag}
                    </div>
                  )}
                  <div
                    className="flex items-start justify-center gap-1 text-center"
                    style={{ fontSize: LABEL_PX, lineHeight: `${LABEL_LINE}px`, fontWeight: LABEL_WEIGHT }}
                  >
                    {Icon && <Icon className={cn('mt-[3px] size-3.5 shrink-0', tone.iconClass)} />}
                    <span>{node.label}</span>
                  </div>
                  {node.detail && (
                    <div className="text-center text-muted-foreground" style={{ fontSize: DETAIL_PX, lineHeight: `${DETAIL_LINE}px` }}>
                      {node.detail}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {spec.footer && <div className="px-4 pb-3.5 text-xs text-muted-foreground">{spec.footer}</div>}
    </figure>
  )
}

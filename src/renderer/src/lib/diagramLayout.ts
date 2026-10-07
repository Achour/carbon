import dagre from '@dagrejs/dagre'
import type { DiagramDirection, DiagramNode, DiagramSpec, DiagramTone } from '@shared/diagramSpec'

/**
 * Laying out a `diagram_render` graph — dagre, fed sizes measured in the font
 * the boxes are drawn in, and hardened against what a model can send.
 *
 * Out of `DiagramCard` so `node --test` reaches it (`test/diagramLayout.test.ts`):
 * every way this has failed was an input the validator accepted and the layout
 * could not survive, and none of them is visible to a typecheck. It imports
 * only dagre and a type, and takes text measurement as a function, so the test
 * passes a stub where the card passes canvas `measureText`.
 */

/** Text width in px for a string at a size and weight. */
export type Measure = (text: string, px: number, weight: number) => number

export const LABEL_WEIGHT = 500
export const LABEL_PX = 13
export const DETAIL_PX = 12
export const EDGE_PX = 11
export const LABEL_LINE = 18
export const DETAIL_LINE = 16
export const PAD_X = 12
export const PAD_Y = 9
/** The status icon and its gap, which a state tone puts before its label. */
export const ICON = 18
/** Room a group's caption takes above its first row. */
export const GROUP_LABEL = 22
/** A group caption inside a box, when the layout cannot draw groups as boxes. */
export const TAG_PX = 11
export const TAG_LINE = 15
/**
 * How wide a box's text may run before it wraps: wide enough for a short
 * phrase, and a narrower step for a column that cannot hold the first.
 */
export const TEXT_WIDTHS = [196, 136] as const
/** Below this a diagram scrolls sideways instead of shrinking further. */
export const MIN_SCALE = 0.8
/** Breathing room around the drawing, for arrowheads and the boxes' shadow. */
const PAD = 4

/** States carry an icon as well as a colour, so their label is wider. */
export function toneHasIcon(tone: DiagramTone): boolean {
  return tone === 'success' || tone === 'warning' || tone === 'danger'
}

/** Greedy word wrap against a measured width. */
export function wrap(text: string, max: number, width: (s: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && width(next) > max) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export interface Placed {
  node: DiagramNode
  x: number
  y: number
  w: number
  h: number
  /**
   * The group's name, drawn as a caption inside the box — set only when the
   * layout could not draw groups as boxes (`layoutFlat`).
   */
  tag?: string
}

export interface PlacedEdge {
  points: { x: number; y: number }[]
  dashed: boolean
  label?: string
  /** The label's centre and its measured size — the same size dagre reserved. */
  lx?: number
  ly?: number
  lw?: number
  lh?: number
}

export interface Layout {
  width: number
  height: number
  direction: DiagramDirection
  nodes: Placed[]
  edges: PlacedEdge[]
  groups: { label: string; x: number; y: number; w: number; h: number }[]
}

/**
 * One layout of the graph.
 *
 * **Every id dagre sees is generated, never the model's.** graphlib keeps its
 * nodes in plain objects keyed by id, so model ids reached object internals:
 * `constructor` and `toString` crashed the layout, a node named `__proto__`
 * with an outgoing edge wrote enumerable keys onto the renderer's own
 * `Object.prototype`, and a node named `group:g` collided with the container
 * this file used to derive for group `g`. Nodes are `n<i>` and groups `c<i>`
 * here, and the model's ids stay what they are — application data.
 *
 * **A compound layout that dagre cannot finish falls back to a flat one** —
 * whether it throws ("Not possible to find intersection inside of the
 * rectangle") or quietly returns `NaN` positions (`finite`). The flat layout
 * draws the same nodes and edges, and each group's box is taken from its
 * members carry their group as a caption, not a box (see `place`).
 */
export function layoutDiagram(
  spec: DiagramSpec,
  measure: Measure,
  direction: DiagramDirection = spec.direction,
  maxText: number = TEXT_WIDTHS[0]
): Layout {
  if (spec.groups.length > 0) {
    try {
      return finite(place(spec, measure, direction, maxText, true))
    } catch {
      // Fall through to the flat layout below.
    }
  }
  return finite(place(spec, measure, direction, maxText, false))
}

/**
 * The flat layout, groups as captions inside their members' boxes — what a
 * grouped graph falls back to. Exported for the test, which cannot rely on finding an
 * input dagre's compound pass fails on: those are the inputs that get fixed.
 */
export function layoutFlat(
  spec: DiagramSpec,
  measure: Measure,
  direction: DiagramDirection = spec.direction,
  maxText: number = TEXT_WIDTHS[0]
): Layout {
  return finite(place(spec, measure, direction, maxText, false))
}

/**
 * **A layout with a non-finite coordinate is a failure, not a drawing.**
 * dagre's compound pass does not always throw when it cannot place a graph: a
 * dense one with every node in a group came back with `NaN` for every
 * position, which renders as nothing at all with no error anywhere. Checked
 * here, it falls back like a throw does.
 */
function finite(layout: Layout): Layout {
  const ok = (v: number | undefined): boolean => v === undefined || Number.isFinite(v)
  const bad =
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.nodes.some((n) => !ok(n.x) || !ok(n.y)) ||
    layout.groups.some((c) => !ok(c.x) || !ok(c.y) || !ok(c.w) || !ok(c.h)) ||
    layout.edges.some((e) => !ok(e.lx) || !ok(e.ly) || e.points.some((p) => !ok(p.x) || !ok(p.y)))
  if (bad) throw new Error('diagram layout produced non-finite coordinates')
  return layout
}

function place(
  spec: DiagramSpec,
  measure: Measure,
  direction: DiagramDirection,
  maxText: number,
  compound: boolean
): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound })
  g.setGraph({
    rankdir: direction === 'right' ? 'LR' : 'TB',
    nodesep: direction === 'right' ? 24 : 32,
    ranksep: spec.groups.length ? 56 : 44,
    edgesep: 14,
    marginx: 0,
    marginy: 0
  })
  g.setDefaultEdgeLabel(() => ({}))

  const nodeKey = new Map(spec.nodes.map((n, i) => [n.id, `n${i}`]))
  const groupKey = new Map(spec.groups.map((c, i) => [c.id, `c${i}`]))
  const groupLabel = new Map(spec.groups.map((c) => [c.id, c.label]))
  const sizes: { w: number; h: number }[] = []
  spec.nodes.forEach((node, i) => {
    const icon = toneHasIcon(node.tone) ? ICON : 0
    const tag = !compound && node.group ? groupLabel.get(node.group) : undefined
    const label = wrap(node.label, maxText - icon, (s) => measure(s, LABEL_PX, LABEL_WEIGHT))
    const detail = node.detail ? wrap(node.detail, maxText, (s) => measure(s, DETAIL_PX, 400)) : []
    const textW = Math.max(
      ...label.map((l) => measure(l, LABEL_PX, LABEL_WEIGHT) + icon),
      ...detail.map((l) => measure(l, DETAIL_PX, 400)),
      tag ? Math.min(maxText, measure(tag, TAG_PX, 400)) : 0,
      24
    )
    const size = {
      w: Math.ceil(textW) + PAD_X * 2 + 2,
      h: label.length * LABEL_LINE + detail.length * DETAIL_LINE + (tag ? TAG_LINE : 0) + PAD_Y * 2 + 2
    }
    sizes.push(size)
    g.setNode(`n${i}`, { width: size.w, height: size.h })
  })
  if (compound) {
    for (const key of groupKey.values()) g.setNode(key, {})
    spec.nodes.forEach((node, i) => {
      if (node.group) g.setParent(`n${i}`, groupKey.get(node.group)!)
    })
  }
  const labelSize = spec.edges.map((edge) =>
    edge.label ? { w: Math.ceil(measure(edge.label, EDGE_PX, 400)) + 14, h: 20 } : null
  )
  spec.edges.forEach((edge, i) => {
    const size = labelSize[i]
    g.setEdge(
      { v: nodeKey.get(edge.from)!, w: nodeKey.get(edge.to)!, name: `e${i}` },
      size ? { width: size.w, height: size.h, labelpos: 'c' } : {}
    )
  })

  dagre.layout(g)

  const nodes = spec.nodes.map((node, i) => {
    const placed = g.node(`n${i}`)
    const { w, h } = sizes[i]
    const tag = !compound && node.group ? groupLabel.get(node.group) : undefined
    return { node, x: placed.x - w / 2, y: placed.y - h / 2, w, h, ...(tag ? { tag } : {}) }
  })
  const edges: PlacedEdge[] = spec.edges.map((edge, i) => {
    const e = g.edge({ v: nodeKey.get(edge.from)!, w: nodeKey.get(edge.to)!, name: `e${i}` }) as {
      points: { x: number; y: number }[]
      x?: number
      y?: number
    }
    const size = labelSize[i]
    return {
      points: e.points,
      dashed: edge.dashed,
      ...(edge.label && size ? { label: edge.label, lx: e.x, ly: e.y, lw: size.w, lh: size.h } : {})
    }
  })
  // Without a compound pass there are no group boxes at all — each member
  // carries its group as a caption instead (`Placed.tag`). Boxes drawn round
  // the members of a flat layout were the first fallback, and they lied: a
  // flat layout places nodes with no regard for groups, so one group's box
  // swept in other groups' nodes and the boxes overlapped one another — the
  // architectural boundary the diagram existed to show, drawn wrong.
  const groups = compound
    ? spec.groups.map((group) => {
        const c = g.node(groupKey.get(group.id)!)
        // Grown upward by the caption: dagre sizes a cluster to its members
        // and leaves the caption no room of its own.
        return {
          label: group.label,
          x: c.x - c.width / 2,
          y: c.y - c.height / 2 - GROUP_LABEL,
          w: c.width,
          h: c.height + GROUP_LABEL
        }
      })
    : []
  return trim({ width: 0, height: 0, direction, nodes, edges, groups })
}

/**
 * **The bounds are measured off what was placed, not read off dagre.** Its
 * graph size carries margins and cluster slack, which showed as a band of
 * empty card under a grouped flow. Edge labels count at their *measured* size —
 * a fixed allowance under-measured a 40-character label by more than half and
 * let it hang past the left edge of a drawing that "fit".
 */
function trim(layout: Layout): Layout {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const take = (x: number, y: number, w = 0, h = 0): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  for (const n of layout.nodes) take(n.x, n.y, n.w, n.h)
  for (const c of layout.groups) take(c.x, c.y, c.w, c.h)
  for (const e of layout.edges) {
    for (const p of e.points) take(p.x, p.y)
    if (e.lx != null && e.ly != null && e.lw != null && e.lh != null) {
      take(e.lx - e.lw / 2, e.ly - e.lh / 2, e.lw, e.lh)
    }
  }
  const dx = PAD - minX
  const dy = PAD - minY
  return {
    ...layout,
    width: Math.ceil(maxX - minX + PAD * 2),
    height: Math.ceil(maxY - minY + PAD * 2),
    nodes: layout.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
    edges: layout.edges.map((e) => ({
      ...e,
      points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      ...(e.lx != null && e.ly != null ? { lx: e.lx + dx, ly: e.ly + dy } : {})
    })),
    groups: layout.groups.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
  }
}

/**
 * The layouts a card may choose between, built **lazily and once**.
 *
 * The first one that fits the column wins, in this order: what was asked; the
 * same with box text wrapped narrower; and, for a left-to-right flow, the same
 * turned downward — the column's length is free and its width is not, and
 * `right` was asked because the flow is shallow, not because it must be read
 * sideways. Only if none fits is the narrowest scaled (down to `MIN_SCALE`)
 * and then scrolled.
 *
 * A layout of the largest accepted graph costs tens of milliseconds, so a
 * resize — the panel divider dragged, the window sized — must *choose among*
 * layouts, never compute them again. One `DiagramLayouts` lives per spec and
 * font; `pick` builds a candidate only the first time it is tried.
 */
export class DiagramLayouts {
  private readonly built = new Map<string, Layout>()
  // Plain fields rather than constructor parameter properties: `node --test`
  // strips types and does not transform, and those are syntax, not types.
  private readonly spec: DiagramSpec
  private readonly measure: Measure

  constructor(spec: DiagramSpec, measure: Measure) {
    this.spec = spec
    this.measure = measure
  }

  private get(direction: DiagramDirection, maxText: number): Layout {
    const key = `${direction}:${maxText}`
    let layout = this.built.get(key)
    if (!layout) {
      layout = layoutDiagram(this.spec, this.measure, direction, maxText)
      this.built.set(key, layout)
    }
    return layout
  }

  /** The layout to draw in a column `avail` px wide (null: not measured yet). */
  pick(avail: number | null): Layout {
    const directions: DiagramDirection[] =
      this.spec.direction === 'right' ? ['right', 'down'] : ['down']
    const tried: Layout[] = []
    for (const direction of directions) {
      for (const maxText of TEXT_WIDTHS) {
        const layout = this.get(direction, maxText)
        if (avail == null || layout.width <= avail) return layout
        tried.push(layout)
      }
    }
    const scalable = tried.find((t) => t.width * MIN_SCALE <= avail!)
    return scalable ?? tried.reduce((a, b) => (b.width < a.width ? b : a))
  }

  /** How many layouts have actually been computed — for the test. */
  get computed(): number {
    return this.built.size
  }
}

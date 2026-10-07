/**
 * A flow diagram the agent draws **in the conversation** — `diagram_render`.
 *
 * The chart tool's sibling, for the visual a coding chat needs most and a chart
 * cannot be: *how something works*. A request path, a pipeline, what calls
 * what, which branch a value takes. The agent sends the graph — nodes, the
 * edges between them, optional groups — and Carbon lays it out and draws it
 * with the app's own surfaces and type, so it reads like the rest of the app
 * rather than like whoever described it.
 *
 * Shipping charts alone left this out, and the model said so in the first chat
 * that needed it: "chart_render only draws numeric charts, so it can't show a
 * flow" — and fell back to a Mermaid block. Mermaid still renders, and still
 * serves plan documents, but in a reply it is the generic look this replaces.
 *
 * Shared by main (validation, with refusals the model can act on) and the
 * renderer (drawing), the way `chartSpec.ts` is. Dependency-free so
 * `node --test` runs it directly. Nothing is stored: the spec is the call's own
 * input, saved with the chat like every other call.
 */

export const DIAGRAM_DIRECTIONS = ['down', 'right'] as const
export type DiagramDirection = (typeof DIAGRAM_DIRECTIONS)[number]

/**
 * What a node *is*, not a colour: `accent` marks the node the explanation is
 * about; the three states mark outcomes. State is reserved — never a way to
 * tell two ordinary steps apart.
 */
export const DIAGRAM_TONES = ['default', 'accent', 'muted', 'success', 'warning', 'danger'] as const
export type DiagramTone = (typeof DIAGRAM_TONES)[number]

export const DIAGRAM_MAX_NODES = 40
export const DIAGRAM_MAX_EDGES = 80
export const DIAGRAM_MAX_GROUPS = 8
const MAX_LABEL = 80
const MAX_DETAIL = 160
const MAX_EDGE_LABEL = 40

export interface DiagramNode {
  id: string
  label: string
  detail?: string
  tone: DiagramTone
  group?: string
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string
  dashed: boolean
}

export interface DiagramGroup {
  id: string
  label: string
}

export interface DiagramSpec {
  title: string
  description?: string
  direction: DiagramDirection
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  groups: DiagramGroup[]
  footer?: string
}

/**
 * The input as JSON Schema, declared once: the HTTP providers read it as-is
 * and Claude's in-process server derives zod from it property by property —
 * the arrangement `CHART_INPUT_SCHEMA` explains. No type arrays anywhere:
 * Gemini-style function schemas (Antigravity) refuse them.
 */
export const DIAGRAM_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What the diagram shows, in a few words.' },
    description: { type: 'string', description: 'Optional one-line subtitle.' },
    direction: {
      type: 'string',
      enum: [...DIAGRAM_DIRECTIONS],
      description:
        'Which way the flow runs: down (default — steps, pipelines, decision trees) or right (wide, shallow flows such as a request crossing services).'
    },
    nodes: {
      type: 'array',
      description: `The boxes (1 to ${DIAGRAM_MAX_NODES}). Keep labels short — a few words; put the specifics in detail.`,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique id that edges refer to.' },
          label: { type: 'string', description: `The step or component, a few words (at most ${MAX_LABEL} characters).` },
          detail: {
            type: 'string',
            description: `Optional second line: a file, a function, a condition (at most ${MAX_DETAIL} characters).`
          },
          tone: {
            type: 'string',
            enum: [...DIAGRAM_TONES],
            description:
              'default for ordinary steps. accent for the one node the explanation centres on. muted for context outside the system. success / warning / danger only for outcomes (saved, retried, failed).'
          },
          group: { type: 'string', description: 'Optional id of the group this node sits in.' }
        },
        required: ['id', 'label']
      }
    },
    edges: {
      type: 'array',
      description: `Arrows between nodes (at most ${DIAGRAM_MAX_EDGES}).`,
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source node id.' },
          to: { type: 'string', description: 'Target node id.' },
          label: {
            type: 'string',
            description: 'Optional short label: the condition or what travels along it ("on 401", "JSON").'
          },
          dashed: {
            type: 'boolean',
            description: 'Dashed for an optional, async or fallback path.'
          }
        },
        required: ['from', 'to']
      }
    },
    groups: {
      type: 'array',
      description: `Optional boxes around related nodes — a process, a service, a layer (at most ${DIAGRAM_MAX_GROUPS}).`,
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label']
      }
    },
    footer: { type: 'string', description: 'Optional one-line takeaway under the diagram.' }
  },
  required: ['title', 'nodes']
} as const

function str(v: unknown, max?: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().replace(/\s+/g, ' ')
  if (!s) return undefined
  return max && s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * The input, checked and normalized — or the reason it cannot be drawn,
 * worded for the model to fix in one go.
 */
export function normalizeDiagram(raw: unknown): { spec: DiagramSpec } | { error: string } {
  const input = record(raw)
  const title = str(input.title, 120)
  if (!title) return { error: 'title is required.' }

  const groups: DiagramGroup[] = []
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) return { error: 'groups must be an array of {id, label}.' }
    for (const g of input.groups) {
      const id = str(record(g).id)
      const label = str(record(g).label, MAX_LABEL)
      if (!id || !label) return { error: 'each group needs an id and a label.' }
      if (groups.some((x) => x.id === id)) return { error: `group id "${id}" is used twice.` }
      groups.push({ id, label })
    }
    if (groups.length > DIAGRAM_MAX_GROUPS) {
      return { error: `${groups.length} groups; at most ${DIAGRAM_MAX_GROUPS}.` }
    }
  }

  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    return { error: 'nodes must be a non-empty array of {id, label}.' }
  }
  if (input.nodes.length > DIAGRAM_MAX_NODES) {
    return {
      error: `${input.nodes.length} nodes; at most ${DIAGRAM_MAX_NODES}. Collapse detail into fewer steps, or split into two diagrams.`
    }
  }
  const nodes: DiagramNode[] = []
  for (const n of input.nodes) {
    const node = record(n)
    const id = str(node.id)
    const label = str(node.label, MAX_LABEL)
    if (!id || !label) return { error: 'each node needs an id and a label.' }
    if (nodes.some((x) => x.id === id)) return { error: `node id "${id}" is used twice.` }
    const group = str(node.group)
    if (group && !groups.some((g) => g.id === group)) {
      return { error: `node "${id}" names group "${group}", which is not in groups.` }
    }
    const tone = DIAGRAM_TONES.find((t) => t === node.tone) ?? 'default'
    const detail = str(node.detail, MAX_DETAIL)
    nodes.push({ id, label, tone, ...(detail ? { detail } : {}), ...(group ? { group } : {}) })
  }

  const edges: DiagramEdge[] = []
  if (input.edges !== undefined) {
    if (!Array.isArray(input.edges)) return { error: 'edges must be an array of {from, to}.' }
    if (input.edges.length > DIAGRAM_MAX_EDGES) {
      return { error: `${input.edges.length} edges; at most ${DIAGRAM_MAX_EDGES}.` }
    }
    for (const e of input.edges) {
      const edge = record(e)
      const from = str(edge.from)
      const to = str(edge.to)
      if (!from || !to) return { error: 'each edge needs from and to.' }
      for (const end of [from, to]) {
        if (!nodes.some((n) => n.id === end)) return { error: `edge ${from} → ${to} names "${end}", which is not a node id.` }
      }
      const label = str(edge.label, MAX_EDGE_LABEL)
      // **Parallel edges: an exact repeat is dropped, a different one is
      // refused.** Two arrows from one node to the same node draw on top of
      // each other, and dagre's routing throws on them ("Not possible to find
      // intersection inside of the rectangle") once a graph is dense. Joining
      // them was the first answer, and it lost meaning: two conditions that
      // each fit the label limit were cut to one, and a dashed and a solid
      // path became one or the other. So a repeat that says the same thing is
      // dropped, and one that says something different is sent back with how
      // to express it.
      const twin = edges.find((x) => x.from === from && x.to === to)
      if (twin) {
        if ((twin.label ?? '') === (label ?? '') && twin.dashed === (edge.dashed === true)) continue
        return {
          error: `${from} → ${to} appears more than once with different labels or styles. Give it one edge whose label covers both (e.g. "ok or retry"), or route one path through its own node.`
        }
      }
      edges.push({ from, to, dashed: edge.dashed === true, ...(label ? { label } : {}) })
    }
  }

  return {
    spec: {
      title,
      ...(str(input.description, 160) ? { description: str(input.description, 160) } : {}),
      direction: DIAGRAM_DIRECTIONS.find((d) => d === input.direction) ?? 'down',
      nodes,
      edges,
      // A group nothing sits in would draw an empty box.
      groups: groups.filter((g) => nodes.some((n) => n.group === g.id)),
      ...(str(input.footer, 200) ? { footer: str(input.footer, 200) } : {})
    }
  }
}

/**
 * The spec a transcript call carries, in any provider's spelling — or null.
 * Grok's arrives wrapped in its own `use_tool`, as `chartCall` explains.
 */
export function diagramCall(part: { name: string; input?: unknown }): DiagramSpec | null {
  const input = record(part.input)
  let args: unknown
  if (part.name === 'mcp__carbon__diagram_render') args = input
  else if (
    part.name === 'use_tool' &&
    /(?:^|_|\/)diagram_render$/.test(String(input.tool_name ?? '').trim())
  ) {
    args = input.tool_input
  } else return null
  const result = normalizeDiagram(args)
  return 'spec' in result ? result.spec : null
}

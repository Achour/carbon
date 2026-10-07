import { DIAGRAM_INPUT_SCHEMA, normalizeDiagram } from '../shared/diagramSpec.ts'

/**
 * `diagram_render` — a flow diagram drawn **in the conversation**, under the
 * call. The agent sends the graph and Carbon lays it out and draws it
 * (`shared/diagramSpec.ts` is the spec and its reasoning). Like `chart_render`
 * it stores nothing and needs no host; the only work here is refusing a graph
 * that cannot be drawn, with the reason.
 *
 * Dependency-free (`node:*` and `shared/` only) so `node --test` runs it.
 */

export const DIAGRAM_TOOL_NAMES = ['render'] as const

export type DiagramToolName = (typeof DIAGRAM_TOOL_NAMES)[number]

export const DIAGRAM_TOOL_INFO: Record<
  DiagramToolName,
  { description: string; readOnly: boolean; inputSchema: typeof DIAGRAM_INPUT_SCHEMA }
> = {
  render: {
    description:
      "Draw a flow diagram directly in the conversation, under this call, in the app's own style: boxes and arrows laid out automatically. Use it to show how something works — a request path, a pipeline, what calls what, which branch a value takes, how components fit together. Send the graph, not markup: nodes (id, short label, optional detail line, optional tone and group), edges (from, to, optional label, dashed for optional or async paths) and optional groups. Keep explaining in prose around it. Nothing is saved and there is no id: to change a diagram, call this again; the earlier one stays in the history as it was.",
    // Draws a picture and changes nothing, so plan mode allows it and the
    // permission gate never asks.
    readOnly: true,
    inputSchema: DIAGRAM_INPUT_SCHEMA
  }
}

export type DiagramToolResult = { kind: 'text'; text: string; isError?: boolean }

export function runDiagramTool(name: DiagramToolName, input: unknown): DiagramToolResult {
  switch (name) {
    case 'render': {
      const result = normalizeDiagram(input)
      if ('error' in result) {
        return { kind: 'text', text: `Failed to draw the diagram: ${result.error}`, isError: true }
      }
      return {
        kind: 'text',
        text: `Drew "${result.spec.title}" in the conversation. The user can see it now — do not redraw it as Mermaid or ASCII; walk through what it shows.`
      }
    }
  }
}

import { CHART_INPUT_SCHEMA, normalizeChart } from '../shared/chartSpec.ts'

/**
 * `chart_render` — a chart drawn **in the conversation**, under the call.
 *
 * The agent sends data and Carbon draws it with the app's own chart
 * components (`shared/chartSpec.ts` is the spec and its reasoning). The tool
 * stores nothing and needs no host: the spec is the call's own input, which is
 * what the transcript draws from, so the only work here is refusing a spec
 * that cannot be drawn — with the reason, so the model can fix it in one go.
 *
 * Dependency-free (`node:*` and `shared/` only) so `node --test` runs it.
 */

export const CHART_TOOL_NAMES = ['render'] as const

export type ChartToolName = (typeof CHART_TOOL_NAMES)[number]

export const CHART_TOOL_INFO: Record<
  ChartToolName,
  { description: string; readOnly: boolean; inputSchema: typeof CHART_INPUT_SCHEMA }
> = {
  render: {
    description:
      "Draw a chart directly in the conversation, under this call, in the app's own chart style. Send the data, not markup: a form (bar, line, area, pie), the rows, the column holding each row's category, and the numeric columns to plot. Optional headline stats above it and a one-line takeaway below. Use it when the answer is a comparison, a trend or a breakdown of numbers you gathered — and keep explaining in prose around it. Nothing is saved and there is no id: to change a chart, call this again with the new data; the earlier chart stays in the history as it was.",
    // Draws a picture and changes nothing, so plan mode allows it and the
    // permission gate never asks.
    readOnly: true,
    inputSchema: CHART_INPUT_SCHEMA
  }
}

export type ChartToolResult = { kind: 'text'; text: string; isError?: boolean }

export function runChartTool(name: ChartToolName, input: unknown): ChartToolResult {
  switch (name) {
    case 'render': {
      const result = normalizeChart(input)
      if ('error' in result) {
        return { kind: 'text', text: `Failed to draw the chart: ${result.error}`, isError: true }
      }
      return {
        kind: 'text',
        text: `Drew "${result.spec.title}" in the conversation. The user can see it now — do not repeat the numbers as a table; say what the chart shows.`
      }
    }
  }
}

/**
 * What every session appends so the model knows the tool exists and how it
 * differs from a canvas. Delivered beside `CANVAS_SESSION_RULES`, at each
 * provider's own cadence (see "the one option that changes on neither axis"
 * in CLAUDE.md).
 */
export const CHART_SESSION_RULES =
  "The `carbon` MCP server can also draw a CHART or a DIAGRAM inline in the conversation: `chart_render` takes data — kind (bar, line, area, pie), title, the rows, the x column and the series columns, plus optional headline stats — and the app draws it in its own style under the call. Reach for it whenever an answer compares amounts, shows a trend or breaks a whole into parts, instead of a markdown table of numbers; keep the explanation in prose around it. Do not write chart HTML yourself. For how something WORKS — a flow, a pipeline, what calls what, which branch a value takes — use `diagram_render` instead: nodes, edges and optional groups, laid out and drawn by the app; prefer it to a Mermaid block in a reply. Neither is stored or has an id: to change one, draw it again. A canvas is different — a document kept beside the chat that the user reads at length and you revise with `canvas_edit`."

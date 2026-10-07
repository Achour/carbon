/**
 * A chart the agent draws **in the conversation** — `chart_render`.
 *
 * The agent sends *data*, never markup: a form, the rows, which column is the
 * axis and which are the series. Carbon draws it natively with the app's own
 * chart components (shadcn's, on Recharts), in the app's theme and palette. A
 * page of agent-written HTML was the first version, and every chart looked
 * like whoever wrote it; this way every chart in every chat looks like Carbon.
 *
 * The spec lives here, in `shared/`, because both sides read it: main
 * validates a call and answers the model with what to fix, and the renderer
 * draws from the same normalization — so a chart the tool accepted is a chart
 * the transcript can draw. Dependency-free so `node --test` runs it directly.
 *
 * Nothing is stored. The spec is the call's own input, saved with the chat like
 * every other tool call; a later "make it monthly" is a new call in a new turn,
 * and the earlier chart stays as it was, the way a reply keeps its screenshot.
 */

export const CHART_KINDS = ['bar', 'line', 'area', 'pie'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

/** One categorical slot per series, in fixed order — never cycled, never generated. */
export const CHART_MAX_SERIES = 8
/** A pie past this many slices folds the rest into "Other" — hue cannot carry more. */
export const CHART_MAX_SLICES = 8
export const CHART_MAX_ROWS = 500
export const CHART_MAX_STATS = 4

export interface ChartSeries {
  key: string
  label: string
}

export interface ChartStat {
  label: string
  value: string
}

/** A chart the renderer can draw: validated, coerced, and bounded. */
export interface ChartSpec {
  kind: ChartKind
  title: string
  description?: string
  /** The column holding each row's category — the x axis, or a pie's slice name. */
  x: string
  data: Record<string, string | number>[]
  series: ChartSeries[]
  stacked: boolean
  horizontal: boolean
  stats: ChartStat[]
  footer?: string
}

/**
 * The tool's input, as JSON Schema — declared **once**. Codex, Grok and
 * Antigravity read it off the wire as-is; Claude's in-process server derives
 * its zod from it property by property (`z.fromJSONSchema`), so the two
 * spellings cannot drift the way hand-copied ones did before `CANVAS_TOOL_INFO`
 * existed.
 */
export const CHART_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [...CHART_KINDS],
      description:
        'The form. bar: compare amounts across categories. line: change over time. area: change over time where the total matters (use stacked). pie: parts of one whole, at most a handful of slices.'
    },
    title: { type: 'string', description: 'What the chart shows, in a few words.' },
    description: {
      type: 'string',
      description: 'Optional one-line subtitle: the period, the unit, the source.'
    },
    x: {
      type: 'string',
      description:
        'The column in each row that holds its category or x value (e.g. "month", "file"). For pie, the column naming each slice.'
    },
    data: {
      type: 'array',
      description: `The rows, in display order (at most ${CHART_MAX_ROWS}). Each row is an object with the x column and one numeric column per series, e.g. {"month":"Jan","desktop":186,"mobile":80}.`,
      // A bare object, deliberately: a `string | number` union on the cells
      // is a type array, which Gemini-style function schemas (Antigravity)
      // refuse — and `normalizeChart` coerces every cell anyway.
      items: { type: 'object' }
    },
    series: {
      type: 'array',
      description: `The numeric columns to plot, in order (1 to ${CHART_MAX_SERIES}; exactly 1 for pie). Colours are assigned by position from the app's palette.`,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The column name in each row.' },
          label: { type: 'string', description: 'How the legend and tooltip name it.' }
        },
        required: ['key']
      }
    },
    stacked: {
      type: 'boolean',
      description: 'bar/area only: stack the series instead of drawing them side by side.'
    },
    horizontal: {
      type: 'boolean',
      description: 'bar only: horizontal bars — better for long category names.'
    },
    stats: {
      type: 'array',
      description: `Optional headline numbers drawn above the chart (at most ${CHART_MAX_STATS}).`,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string', description: 'Already formatted, e.g. "85.0k" or "18%".' }
        },
        required: ['label', 'value']
      }
    },
    footer: { type: 'string', description: 'Optional one-line takeaway under the chart.' }
  },
  required: ['kind', 'title', 'x', 'data', 'series']
} as const

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** A cell as a number, when it is one — models send `"186"` often enough. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * The input, checked and coerced into something drawable — or the reason it
 * is not, worded for the model to act on, the way `canvas_edit` words its
 * refusals.
 */
export function normalizeChart(raw: unknown): { spec: ChartSpec } | { error: string } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = CHART_KINDS.find((k) => k === input.kind)
  if (!kind) return { error: `kind must be one of ${CHART_KINDS.join(', ')}.` }
  const title = str(input.title)
  if (!title) return { error: 'title is required.' }
  const x = str(input.x)
  if (!x) return { error: 'x is required: the column in each row that holds its category.' }

  if (!Array.isArray(input.data) || input.data.length === 0) {
    return { error: 'data must be a non-empty array of row objects.' }
  }
  if (input.data.length > CHART_MAX_ROWS) {
    return { error: `data has ${input.data.length} rows; at most ${CHART_MAX_ROWS}. Aggregate first.` }
  }
  const rows = input.data.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)
  )
  if (rows.length !== input.data.length) return { error: 'every entry in data must be an object.' }
  if (!rows.some((r) => r[x] !== undefined && r[x] !== null)) {
    return { error: `no row has the x column "${x}".` }
  }

  if (!Array.isArray(input.series) || input.series.length === 0) {
    return { error: 'series must list at least one numeric column, e.g. [{"key":"visits"}].' }
  }
  const series: ChartSeries[] = []
  for (const s of input.series) {
    const entry = (s && typeof s === 'object' ? s : { key: s }) as Record<string, unknown>
    const key = str(entry.key)
    if (!key) return { error: 'each series needs a key naming a column in the rows.' }
    if (key === x) return { error: `series "${key}" is the x column; plot a numeric column instead.` }
    if (!rows.some((r) => num(r[key]) !== undefined)) {
      return { error: `series "${key}" has no numeric values in the rows.` }
    }
    if (!series.some((existing) => existing.key === key)) {
      series.push({ key, label: str(entry.label) ?? key })
    }
  }
  if (series.length > CHART_MAX_SERIES) {
    return {
      error: `${series.length} series; at most ${CHART_MAX_SERIES}. Fold the smallest into an "Other" column, or split into two charts.`
    }
  }
  if (kind === 'pie' && series.length !== 1) {
    return { error: 'a pie takes exactly one series: the value of each slice.' }
  }

  let data = rows.map((r) => {
    const row: Record<string, string | number> = { [x]: String(r[x] ?? '') }
    for (const s of series) row[s.key] = num(r[s.key]) ?? 0
    return row
  })
  // Hue carries a pie's identity, and there are only so many hues — the rest
  // fold into one slice rather than repeating a colour.
  if (kind === 'pie' && data.length > CHART_MAX_SLICES) {
    const key = series[0].key
    const kept = data.slice(0, CHART_MAX_SLICES - 1)
    const rest = data.slice(CHART_MAX_SLICES - 1).reduce((sum, r) => sum + Number(r[key]), 0)
    data = [...kept, { [x]: 'Other', [key]: rest }]
  }

  const stats: ChartStat[] = []
  if (Array.isArray(input.stats)) {
    for (const s of input.stats.slice(0, CHART_MAX_STATS)) {
      const entry = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
      const label = str(entry.label)
      const value =
        typeof entry.value === 'number' ? String(entry.value) : str(entry.value)
      if (label && value) stats.push({ label, value })
    }
  }

  return {
    spec: {
      kind,
      title,
      ...(str(input.description) ? { description: str(input.description) } : {}),
      x,
      data,
      series,
      stacked: (kind === 'bar' || kind === 'area') && input.stacked === true && series.length > 1,
      horizontal: kind === 'bar' && input.horizontal === true,
      stats,
      ...(str(input.footer) ? { footer: str(input.footer) } : {})
    }
  }
}

/**
 * The spec a transcript call carries, in any provider's spelling — or null
 * when the call is not a chart.
 *
 * Claude, Codex and Antigravity call `mcp__carbon__chart_render`. **Grok defers
 * MCP tools behind its own `use_tool`**, so its call arrives named `use_tool`
 * with the real name (`carbon__chart_render`) and the arguments in its input.
 */
export function chartCall(part: { name: string; input?: unknown }): ChartSpec | null {
  const input = (part.input && typeof part.input === 'object' ? part.input : {}) as Record<
    string,
    unknown
  >
  let args: unknown
  if (part.name === 'mcp__carbon__chart_render') args = input
  else if (
    part.name === 'use_tool' &&
    /(?:^|_|\/)chart_render$/.test(String(input.tool_name ?? '').trim())
  ) {
    args = input.tool_input
  } else return null
  const result = normalizeChart(args)
  return 'spec' in result ? result.spec : null
}

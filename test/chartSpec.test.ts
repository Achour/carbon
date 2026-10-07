import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CHART_MAX_SERIES, CHART_MAX_SLICES, chartCall, normalizeChart } from '../src/shared/chartSpec.ts'
import { runChartTool } from '../src/main/chartTool.ts'
import {
  carbonToolInput,
  carbonToolList,
  isCarbonSideEffect,
  parseCarbonTool,
  runCarbonTool
} from '../src/main/carbonMcp.ts'

const BAR = {
  kind: 'bar',
  title: 'Edits per file',
  x: 'file',
  data: [
    { file: 'store.ts', edits: 45, tests: '12' },
    { file: 'ChatView.tsx', edits: '31', tests: 4 }
  ],
  series: [{ key: 'edits', label: 'Edits' }, { key: 'tests' }]
}

function spec(input: unknown) {
  const out = normalizeChart(input)
  assert.ok('spec' in out, 'error' in out ? out.error : '')
  return out.spec
}
function refused(input: unknown): string {
  const out = normalizeChart(input)
  assert.ok('error' in out, 'expected a refusal')
  return out.error
}

test('a spec is coerced into something drawable', () => {
  const s = spec(BAR)
  // Numeric strings — which models send often enough — become numbers.
  assert.deepEqual(s.data, [
    { file: 'store.ts', edits: 45, tests: 12 },
    { file: 'ChatView.tsx', edits: 31, tests: 4 }
  ])
  // A series with no label is named by its column.
  assert.deepEqual(s.series, [
    { key: 'edits', label: 'Edits' },
    { key: 'tests', label: 'tests' }
  ])
  assert.equal(s.stacked, false)
  assert.equal(s.horizontal, false)
})

test('options apply only to the forms they mean something for', () => {
  assert.equal(spec({ ...BAR, stacked: true, horizontal: true }).stacked, true)
  assert.equal(spec({ ...BAR, horizontal: true }).horizontal, true)
  assert.equal(spec({ ...BAR, kind: 'line', stacked: true, horizontal: true }).stacked, false)
  assert.equal(spec({ ...BAR, kind: 'line', horizontal: true }).horizontal, false)
  // Stacking one series is no stack at all.
  assert.equal(spec({ ...BAR, series: [{ key: 'edits' }], stacked: true }).stacked, false)
})

test('a spec that cannot be drawn is refused with what to fix', () => {
  assert.match(refused({ ...BAR, kind: 'scatter' }), /kind must be one of bar, line, area, pie/)
  assert.match(refused({ ...BAR, x: 'month' }), /no row has the x column "month"/)
  assert.match(refused({ ...BAR, series: [{ key: 'nope' }] }), /series "nope" has no numeric values/)
  assert.match(refused({ ...BAR, series: [{ key: 'file' }] }), /is the x column/)
  assert.match(refused({ ...BAR, data: [] }), /non-empty array/)
  assert.match(refused({ ...BAR, kind: 'pie' }), /exactly one series/)
  // A ninth series is never a generated hue.
  const wide = Object.fromEntries([...Array(9)].map((_, i) => [`s${i}`, i]))
  assert.match(
    refused({ ...BAR, data: [{ file: 'a', ...wide }], series: Object.keys(wide).map((key) => ({ key })) }),
    new RegExp(`at most ${CHART_MAX_SERIES}`)
  )
})

test('a pie past the palette folds its tail into "Other"', () => {
  const data = [...Array(11)].map((_, i) => ({ lang: `L${i}`, n: 1 }))
  const s = spec({ kind: 'pie', title: 'Langs', x: 'lang', data, series: [{ key: 'n' }] })
  assert.equal(s.data.length, CHART_MAX_SLICES)
  assert.deepEqual(s.data.at(-1), { lang: 'Other', n: 11 - (CHART_MAX_SLICES - 1) })
})

test('the transcript finds the spec in every provider spelling', () => {
  assert.equal(chartCall({ name: 'mcp__carbon__chart_render', input: BAR })?.title, 'Edits per file')
  for (const tool_name of ['carbon__chart_render', 'mcp__carbon__chart_render', 'carbon/chart_render']) {
    assert.equal(chartCall({ name: 'use_tool', input: { tool_name, tool_input: BAR } })?.title, 'Edits per file', tool_name)
  }
  assert.equal(chartCall({ name: 'mcp__carbon__canvas_write', input: BAR }), null)
  // A spec the tool refused draws nothing either.
  assert.equal(chartCall({ name: 'mcp__carbon__chart_render', input: { ...BAR, kind: 'nope' } }), null)
})

test('the tool answers the model, and refuses with the reason', () => {
  assert.match(runChartTool('render', BAR).text, /Drew "Edits per file" in the conversation/)
  const bad = runChartTool('render', { ...BAR, x: '' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /^Failed to draw the chart: x is required/)
})

test('it is one carbon tool on every provider, never gated, and keeps its arrays', async () => {
  assert.deepEqual(parseCarbonTool('mcp__carbon__chart_render'), { kind: 'chart', name: 'render' })
  assert.deepEqual(parseCarbonTool('carbon__chart_render'), { kind: 'chart', name: 'render' })
  assert.equal(isCarbonSideEffect('mcp__carbon__chart_render'), false)
  // The wire schema the HTTP providers read is the declared one, arrays and all.
  const wire = carbonToolList().find((t) => t.name === 'chart_render')!
  const props = (wire.inputSchema as { properties: Record<string, { type: string }> }).properties
  assert.equal(props.data.type, 'array')
  assert.equal(props.series.type, 'array')
  // Through the HTTP path's coercion — which keeps only known *string* fields
  // for every other tool — the rows survive, in plan mode, with no hosts.
  const res = await runCarbonTool(
    { preview: {} as never },
    { cwd: '', project: '', plan: () => true },
    'chart_render',
    carbonToolInput(BAR)
  )
  assert.deepEqual(res, { ok: true, kind: 'text', text: runChartTool('render', BAR).text })
})

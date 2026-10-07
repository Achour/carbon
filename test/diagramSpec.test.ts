import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DIAGRAM_MAX_NODES, diagramCall, normalizeDiagram } from '../src/shared/diagramSpec.ts'
import { runDiagramTool } from '../src/main/diagramTool.ts'
import {
  carbonToolInput,
  carbonToolList,
  isCarbonSideEffect,
  parseCarbonTool,
  runCarbonTool
} from '../src/main/carbonMcp.ts'

const FLOW = {
  title: 'Autofill',
  nodes: [
    { id: 'pick', label: 'Seller picks a reference', tone: 'accent' },
    { id: 'fetch', label: 'Fetch watch data', detail: 'watchdata.ts · fetchReference', group: 'server' },
    { id: 'none', label: 'Return null', tone: 'danger' },
    { id: 'map', label: 'Map fields', group: 'server' }
  ],
  edges: [
    { from: 'pick', to: 'fetch' },
    { from: 'fetch', to: 'none', label: 'on 401', dashed: true },
    { from: 'fetch', to: 'map', label: 'data' }
  ],
  groups: [{ id: 'server', label: 'Server' }, { id: 'unused', label: 'Nobody' }]
}

function spec(input: unknown) {
  const out = normalizeDiagram(input)
  assert.ok('spec' in out, 'error' in out ? out.error : '')
  return out.spec
}
function refused(input: unknown): string {
  const out = normalizeDiagram(input)
  assert.ok('error' in out, 'expected a refusal')
  return out.error
}

test('a graph is normalized into something drawable', () => {
  const s = spec(FLOW)
  assert.equal(s.direction, 'down')
  assert.deepEqual(s.nodes.map((n) => n.tone), ['accent', 'default', 'danger', 'default'])
  assert.equal(s.nodes[1].detail, 'watchdata.ts · fetchReference')
  assert.deepEqual(s.edges[1], { from: 'fetch', to: 'none', label: 'on 401', dashed: true })
  // A group no node sits in would draw an empty box.
  assert.deepEqual(s.groups, [{ id: 'server', label: 'Server' }])
  // An unknown tone is an ordinary step, not a refusal.
  assert.equal(spec({ ...FLOW, nodes: [{ id: 'a', label: 'A', tone: 'purple' }], edges: [], groups: [] }).nodes[0].tone, 'default')
  assert.equal(spec({ ...FLOW, direction: 'right' }).direction, 'right')
})

test('a graph that cannot be drawn is refused with what to fix', () => {
  assert.match(refused({ ...FLOW, title: '' }), /title is required/)
  assert.match(refused({ ...FLOW, nodes: [] }), /non-empty array/)
  assert.match(refused({ ...FLOW, nodes: [...FLOW.nodes, { id: 'pick', label: 'Again' }] }), /node id "pick" is used twice/)
  assert.match(refused({ ...FLOW, edges: [{ from: 'pick', to: 'ghost' }] }), /names "ghost", which is not a node id/)
  assert.match(refused({ ...FLOW, nodes: [{ id: 'a', label: 'A', group: 'nope' }] }), /names group "nope"/)
  const many = [...Array(DIAGRAM_MAX_NODES + 1)].map((_, i) => ({ id: `n${i}`, label: `N${i}` }))
  assert.match(refused({ title: 'Big', nodes: many }), new RegExp(`at most ${DIAGRAM_MAX_NODES}`))
})

test('long text is trimmed rather than refused', () => {
  const s = spec({ title: 'T', nodes: [{ id: 'a', label: 'x'.repeat(200), detail: 'y'.repeat(400) }] })
  assert.ok(s.nodes[0].label.length <= 80 && s.nodes[0].label.endsWith('…'))
  assert.ok(s.nodes[0].detail!.length <= 160)
})

test('the transcript finds the graph in every provider spelling', () => {
  assert.equal(diagramCall({ name: 'mcp__carbon__diagram_render', input: FLOW })?.title, 'Autofill')
  for (const tool_name of ['carbon__diagram_render', 'mcp__carbon__diagram_render']) {
    assert.equal(diagramCall({ name: 'use_tool', input: { tool_name, tool_input: FLOW } })?.title, 'Autofill', tool_name)
  }
  assert.equal(diagramCall({ name: 'mcp__carbon__chart_render', input: FLOW }), null)
})

test('it is one carbon tool on every provider, never gated, and keeps its graph', async () => {
  assert.deepEqual(parseCarbonTool('mcp__carbon__diagram_render'), { kind: 'diagram', name: 'render' })
  assert.equal(isCarbonSideEffect('mcp__carbon__diagram_render'), false)
  const wire = carbonToolList().find((t) => t.name === 'diagram_render')!
  const props = (wire.inputSchema as { properties: Record<string, { type: string }> }).properties
  assert.equal(props.nodes.type, 'array')
  // No type arrays anywhere — Gemini-style function schemas refuse them.
  assert.doesNotMatch(JSON.stringify(wire.inputSchema), /"type":\[/)
  const res = await runCarbonTool(
    { preview: {} as never },
    { cwd: '', project: '', plan: () => true },
    'diagram_render',
    carbonToolInput(FLOW)
  )
  assert.deepEqual(res, { ok: true, kind: 'text', text: runDiagramTool('render', FLOW).text })
  assert.equal(runDiagramTool('render', { title: 'x' }).isError, true)
})

test('an exact repeat of an edge is dropped; a different parallel edge is refused', () => {
  const s = spec({
    title: 'P',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [
      { from: 'a', to: 'b', label: 'ok', dashed: true },
      { from: 'a', to: 'b', label: 'ok', dashed: true },
      { from: 'b', to: 'a', label: 'back' }
    ]
  })
  assert.deepEqual(s.edges, [
    { from: 'a', to: 'b', label: 'ok', dashed: true },
    { from: 'b', to: 'a', label: 'back', dashed: false }
  ])
  // Joining these used to cut the second condition off at the label limit.
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  assert.match(
    refused({ title: 'P', nodes, edges: [{ from: 'a', to: 'b', label: 'Authentication successfully completed' }, { from: 'a', to: 'b', label: 'Retry after timeout' }] }),
    /a → b appears more than once/
  )
  // A dashed and a solid path between the same pair say different things too.
  assert.match(refused({ title: 'P', nodes, edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b', dashed: true }] }), /appears more than once/)
})

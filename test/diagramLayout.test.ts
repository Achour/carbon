import { strict as assert } from 'node:assert'
import test from 'node:test'
import { normalizeDiagram, type DiagramSpec } from '../src/shared/diagramSpec.ts'
import { DiagramLayouts, layoutDiagram, layoutFlat, type Layout } from '../src/renderer/src/lib/diagramLayout.ts'

/** A stand-in for canvas `measureText`: proportional to length and size. */
const measure = (text: string, px: number): number => text.length * px * 0.55

function spec(input: unknown): DiagramSpec {
  const out = normalizeDiagram(input)
  assert.ok('spec' in out, 'error' in out ? out.error : '')
  return out.spec
}

function inside(layout: Layout): void {
  for (const n of layout.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= layout.width && n.y + n.h <= layout.height, `node ${n.node.id} inside`)
  }
  for (const e of layout.edges) {
    if (e.lx == null) continue
    assert.ok(e.lx - e.lw! / 2 >= 0 && e.lx + e.lw! / 2 <= layout.width, 'edge label inside horizontally')
    assert.ok(e.ly! - e.lh! / 2 >= 0 && e.ly! + e.lh! / 2 <= layout.height, 'edge label inside vertically')
  }
}

test('model ids never reach graphlib: reserved words lay out, the prototype stays clean', () => {
  const before = Object.keys(Object.prototype).length
  const s = spec({
    title: 'Reserved',
    nodes: ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((id) => ({ id, label: id })),
    edges: [
      { from: '__proto__', to: 'constructor' },
      { from: 'constructor', to: 'toString' },
      { from: 'toString', to: 'hasOwnProperty' }
    ]
  })
  const layout = layoutDiagram(s, measure)
  assert.equal(layout.nodes.length, 4)
  assert.equal(layout.edges.length, 3)
  // A node named `__proto__` used to write enumerable keys onto the
  // renderer's own Object.prototype.
  assert.equal(Object.keys(Object.prototype).length, before)
  inside(layout)
})

test('a node id that looks like a container id does not collide with its group', () => {
  const s = spec({
    title: 'Collide',
    nodes: [{ id: 'group:g', label: 'In g', group: 'g' }, { id: 'c0', label: 'Also', group: 'g' }],
    groups: [{ id: 'g', label: 'G' }]
  })
  const layout = layoutDiagram(s, measure)
  assert.equal(layout.groups.length, 1)
})

test("the reviewer's crossing graph lays out — parallel edges merged, groups intact", () => {
  // Two nodes in two groups, parallel edges and a return edge: dagre threw
  // "Not possible to find intersection inside of the rectangle".
  const s = spec({
    title: 'Crossing',
    nodes: [{ id: 'a', label: 'A', group: 'g1' }, { id: 'b', label: 'B', group: 'g2' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    groups: [{ id: 'g1', label: 'One' }, { id: 'g2', label: 'Two' }]
  })
  for (const direction of ['down', 'right'] as const) {
    const layout = layoutDiagram(s, measure, direction)
    assert.equal(layout.edges.length, 2)
    assert.equal(layout.groups.length, 2)
    inside(layout)
  }
})

test("the flat fallback names each node's group inside its box, and draws no group boxes", () => {
  // Boxes drawn round a flat layout's members swept in other groups' nodes —
  // a wrong boundary is worse than none, so the fallback captions instead.
  const s = spec({
    title: 'Flat',
    nodes: [
      { id: 'a', label: 'A', group: 'g1' },
      { id: 'b', label: 'B', group: 'g1' },
      { id: 'c', label: 'C', group: 'g2' },
      { id: 'd', label: 'D' }
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
    groups: [{ id: 'g1', label: 'One' }, { id: 'g2', label: 'Two' }]
  })
  for (const direction of ['down', 'right'] as const) {
    const layout = layoutFlat(s, measure, direction)
    assert.equal(layout.groups.length, 0)
    const tags = Object.fromEntries(layout.nodes.map((n) => [n.node.id, n.tag]))
    assert.deepEqual(tags, { a: 'One', b: 'One', c: 'Two', d: undefined })
    // The caption takes a line of its own, so a captioned box is taller.
    const a = layout.nodes.find((n) => n.node.id === 'a')!
    const d = layout.nodes.find((n) => n.node.id === 'd')!
    assert.ok(a.h > d.h)
    inside(layout)
  }
  // With a compound pass that succeeds, the same graph draws real boxes.
  const compound = layoutDiagram(s, measure)
  assert.equal(compound.groups.length, 2)
  assert.ok(compound.nodes.every((n) => n.tag === undefined))
})

test('a compound layout that comes back as NaN falls back instead of drawing nothing', () => {
  // Every node grouped, dense edges: dagre's compound pass returned NaN for
  // every position without throwing.
  const s = spec({
    title: 'All grouped',
    nodes: [...Array(40)].map((_, i) => ({ id: `n${i}`, label: `Step ${i}`, group: `g${i % 8}` })),
    edges: [...Array(80)].map((_, i) => ({ from: `n${i % 40}`, to: `n${(i * 7 + 3) % 40}` })),
    groups: [...Array(8)].map((_, i) => ({ id: `g${i}`, label: `G${i}` }))
  })
  const layout = layoutDiagram(s, measure)
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height))
  // It fell back: no boxes, every node captioned with its own group.
  assert.equal(layout.groups.length, 0)
  assert.ok(layout.nodes.every((n) => n.tag === `G${Number(n.node.id.slice(1)) % 8}`))
  inside(layout)
})

test('a long edge label is bounded at its measured size, not a fixed allowance', () => {
  const s = spec({
    title: 'Label',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', label: 'a forty character condition on this edge' }]
  })
  const layout = layoutDiagram(s, measure)
  const edge = layout.edges[0]
  assert.ok(edge.lw! > 120, `measured ${edge.lw}`)
  // The drawing is at least as wide as the label, and the label lies inside it.
  assert.ok(layout.width >= edge.lw!)
  inside(layout)
})

test('cycles, self-loops and the largest accepted graph all lay out inside their bounds', () => {
  const nodes = [...Array(40)].map((_, i) => ({ id: `n${i}`, label: `Step ${i}`, group: `g${i % 8}` }))
  // Every pair occurs twice (i and i + 40); the label follows the pair, so the
  // repeat is exact and dropped rather than refused.
  const edges = [...Array(80)].map((_, i) => {
    const to = (i * 7 + 3) % 40
    return { from: `n${i % 40}`, to: `n${to}`, label: to % 5 ? undefined : `to ${to}` }
  })
  edges.push({ from: 'n0', to: 'n0', label: undefined })
  const s = spec({ title: 'Big', nodes, edges: edges.slice(0, 80), groups: [...Array(8)].map((_, i) => ({ id: `g${i}`, label: `G${i}` })) })
  inside(layoutDiagram(s, measure))
  inside(layoutDiagram(s, measure, 'right', 136))
})

test('a resize chooses among layouts already built, never lays the graph out again', () => {
  const s = spec({
    title: 'Wide',
    direction: 'right',
    nodes: [...Array(6)].map((_, i) => ({ id: `n${i}`, label: `Service number ${i}` })),
    edges: [...Array(5)].map((_, i) => ({ from: `n${i}`, to: `n${i + 1}` }))
  })
  const layouts = new DiagramLayouts(s, measure)
  const wide = layouts.pick(5000)
  assert.equal(wide.direction, 'right')
  assert.equal(layouts.computed, 1)
  // Narrow: falls through to the downward layouts.
  const narrow = layouts.pick(300)
  assert.equal(narrow.direction, 'down')
  const built = layouts.computed
  // A dragged divider: many widths, no new layouts.
  for (let w = 200; w < 3000; w += 37) layouts.pick(w)
  assert.equal(layouts.computed, built)
  assert.ok(built <= 4)
})

test('random dense graphs never throw — the shapes that broke dagre, found by fuzzing', () => {
  // Parallel edges between the same pair broke dagre's routing even with no
  // groups; `normalizeDiagram` drops or refuses them, and this keeps it so.
  let seed = 7
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  for (let t = 0; t < 60; t++) {
    const N = 2 + Math.floor(rnd() * 39)
    const G = Math.floor(rnd() * 9)
    const s = spec({
      title: 'Fuzz',
      groups: [...Array(G)].map((_, i) => ({ id: `g${i}`, label: `Group ${i}` })),
      nodes: [...Array(N)].map((_, i) => ({
        id: `n${i}`,
        label: `Node ${i} ${'x'.repeat(Math.floor(rnd() * 30))}`,
        ...(G && rnd() < 0.6 ? { group: `g${Math.floor(rnd() * G)}` } : {})
      })),
      // One edge per ordered pair: a parallel edge with a different label is
      // refused by the validator now, so the fuzz exercises layout, not that.
      edges: [
        ...new Map(
          [...Array(Math.floor(rnd() * 81))].map(() => {
            const from = `n${Math.floor(rnd() * N)}`
            const to = `n${Math.floor(rnd() * N)}`
            return [`${from}>${to}`, { from, to, ...(rnd() < 0.3 ? { label: `cond ${Math.floor(rnd() * 99)}` } : {}) }]
          })
        ).values()
      ]
    })
    for (const direction of ['down', 'right'] as const) inside(layoutDiagram(s, measure, direction))
  }
})

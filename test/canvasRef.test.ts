import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  canvasIdFromOutput,
  canvasInRun,
  canvasWrite,
  resolveCanvasId
} from '../src/renderer/src/lib/canvasRef.ts'

const ID = '2f714d35-fb38-4d87-b12b-8b837fbd2aaa'
const RESULT = `Saved canvas "Vite vs Webpack" (id: ${ID}). It is now in the Canvas panel.`

test('a direct call carries both its id and its title', () => {
  assert.deepEqual(
    canvasWrite({ name: 'mcp__canvas__write', input: { title: 'Vite vs Webpack' }, output: RESULT }),
    { id: ID, title: 'Vite vs Webpack' }
  )
})

test("Grok's wrapped call is recognized, title and all", () => {
  // Grok defers MCP tools behind `use_tool`: the card is named `use_tool`, the
  // real name and arguments are in the input, and the result text is empty.
  // Matched on `name` alone this drew an unnamed row with no way into the
  // document it had just written.
  assert.deepEqual(
    canvasWrite({
      name: 'use_tool',
      input: {
        variant: 'UseTool',
        tool_name: 'canvas__write',
        tool_input: { title: 'TanStack Start vs Next.js', html: '<p>x</p>' }
      },
      output: ''
    }),
    { id: undefined, title: 'TanStack Start vs Next.js' }
  )
})

test('a wrapped revision keeps the id it was given', () => {
  const written = canvasWrite({
    name: 'use_tool',
    input: { tool_name: 'canvas__write', tool_input: { title: 'T', id: ID } }
  })
  assert.equal(written?.id, ID)
})

test('another wrapped tool is not a canvas write', () => {
  assert.equal(canvasWrite({ name: 'use_tool', input: { tool_name: 'preview__start' } }), null)
  assert.equal(canvasWrite({ name: 'Read', input: { file_path: '/a' } }), null)
  // A write is not inferred from a title alone.
  assert.equal(canvasWrite({ name: 'use_tool', input: { tool_input: { title: 'T' } } }), null)
})

test('the id is scraped, and yields nothing rather than guessing', () => {
  assert.equal(canvasIdFromOutput(RESULT), ID)
  assert.equal(canvasIdFromOutput('Saved canvas "X".'), undefined)
  assert.equal(canvasIdFromOutput(undefined), undefined)
  assert.equal(canvasIdFromOutput('(id: not-a-uuid)'), undefined)
})

test('a run reports its first canvas and ignores everything else', () => {
  const parts = [
    { name: 'ToolSearch', input: { query: 'canvas' } },
    { name: 'mcp__canvas__write', input: { title: 'One' }, output: RESULT },
    { name: 'mcp__canvas__write', input: { title: 'Two' }, output: RESULT }
  ]
  assert.equal(canvasInRun(parts)?.title, 'One')
  assert.equal(canvasInRun([{ name: 'Read', input: {} }]), null)
})

test('an id wins; a title falls back to the project list', () => {
  const list = [
    { id: 'new', title: 'Report' },
    { id: 'old', title: 'Report' }
  ]
  assert.equal(resolveCanvasId({ id: ID, title: 'Report' }, list), ID)
  // Newest-first, so a repeated title resolves to the one just written.
  assert.equal(resolveCanvasId({ title: 'Report' }, list), 'new')
  assert.equal(resolveCanvasId({ title: 'Missing' }, list), undefined)
  assert.equal(resolveCanvasId({}, list), undefined)
})

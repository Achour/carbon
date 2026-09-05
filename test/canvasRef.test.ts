import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  canvasIdFromOutput,
  canvasInRun,
  canvasTitleFromOutput,
  canvasWrite,
  resolveCanvasId,
  resolveCanvasTitle
} from '../src/renderer/src/lib/canvasRef.ts'

const ID = '2f714d35-fb38-4d87-b12b-8b837fbd2aaa'
const RESULT = `Saved canvas "Vite vs Webpack" (id: ${ID}). It is now in the Canvas panel.`
const EDITED = `Updated canvas "Vite vs Webpack" (id: ${ID}). The panel is showing the new version.`

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

test('an edit is a way into the canvas too, and names it from its result', () => {
  // An edit deliberately does not carry the title in its input — that is the
  // whole point of it — so the prose is the only place the row can read one.
  assert.deepEqual(
    canvasWrite({
      name: 'mcp__canvas__edit',
      input: { id: ID, old_string: '<h1>a</h1>', new_string: '<h1>b</h1>' },
      output: EDITED
    }),
    { id: ID, title: 'Vite vs Webpack' }
  )
  // The id is in the input, so the row has somewhere to go before the call
  // returns — which a create can never manage.
  assert.equal(canvasWrite({ name: 'mcp__canvas__edit', input: { id: ID } })?.id, ID)
  // Grok's wrapper, same tool.
  assert.equal(
    canvasWrite({
      name: 'use_tool',
      input: { tool_name: 'canvas__edit', tool_input: { id: ID } }
    })?.id,
    ID
  )
})

test('the title is scraped from either verb, and yields nothing rather than guessing', () => {
  assert.equal(canvasTitleFromOutput(RESULT), 'Vite vs Webpack')
  assert.equal(canvasTitleFromOutput(EDITED), 'Vite vs Webpack')
  assert.equal(canvasTitleFromOutput('Failed to edit canvas: old_string was not found.'), undefined)
  assert.equal(canvasTitleFromOutput(undefined), undefined)
})

test('a canvas named only by id takes its title from the project list', () => {
  // An edit's input carries the id and nothing else, so this is the only way
  // the row can name the document while the call is still running.
  const list = [{ id: ID, title: 'Vite vs Webpack' }]
  assert.equal(resolveCanvasTitle({ id: ID }, list), 'Vite vs Webpack')
  // A title the call already knows wins — it may name a canvas the list has
  // not caught up with.
  assert.equal(resolveCanvasTitle({ id: ID, title: 'Renamed' }, list), 'Renamed')
  assert.equal(resolveCanvasTitle({ id: 'missing' }, list), undefined)
  assert.equal(resolveCanvasTitle({}, list), undefined)
})

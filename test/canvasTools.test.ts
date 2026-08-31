import { strict as assert } from 'node:assert'
import test from 'node:test'
import { runCanvasTool, type CanvasToolHost } from '../src/main/canvasTools.ts'
import { canvasToolList } from '../src/main/previewMcp.ts'

function host(): CanvasToolHost & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>()
  let n = 0
  return {
    rows,
    list: (project) =>
      [...rows.values()]
        .filter((r) => r.project === project)
        .map((r) => ({ ...r, html: undefined }) as never),
    get: (id) => (rows.get(id) as never) ?? null,
    save: (input) => {
      const id = input.id ?? `c${++n}`
      const prev = rows.get(id)
      const row = {
        id,
        project: (prev?.project as string) ?? input.project,
        chatId: input.chatId ?? null,
        title: input.title,
        html: input.html,
        createdAt: (prev?.createdAt as number) ?? 1,
        updatedAt: 2
      }
      rows.set(id, row)
      return { ...row, html: undefined } as never
    }
  }
}

const ctx = { project: '/repo', chatId: 'chat-1' }

test('write returns the id, which is the only handle a revision has', () => {
  const h = host()
  const out = runCanvasTool(h, ctx, 'write', { title: 'Report', html: '<p>hi</p>' })
  assert.match(out.text, /id: c1/)
  // Stated twice on purpose: the model has to see how to revise this canvas
  // rather than write a second one with the same title.
  assert.match(out.text, /call canvas write again with id: c1/)
})

test('a write with an id revises in place instead of adding a row', () => {
  const h = host()
  runCanvasTool(h, ctx, 'write', { title: 'Report', html: '<p>one</p>' })
  runCanvasTool(h, ctx, 'write', { title: 'Report v2', html: '<p>two</p>', id: 'c1' })
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.get('c1')?.title, 'Report v2')
  // The creation date survives a revision — it is the same document.
  assert.equal(h.rows.get('c1')?.createdAt, 1)
})

test('the project comes from the session, never from the model', () => {
  const h = host()
  // An `input.project` is not part of the schema, so even a model that invents
  // one cannot write into another project's list.
  runCanvasTool(h, { project: '/repo', chatId: 'c' }, 'write', {
    title: 'T',
    html: '<p>x</p>',
    ...({ project: '/elsewhere' } as object)
  })
  assert.equal(h.rows.get('c1')?.project, '/repo')
})

test('a write missing either half is refused, not half-saved', () => {
  const h = host()
  assert.match(runCanvasTool(h, ctx, 'write', { title: 'T' }).text, /html is required/)
  assert.match(runCanvasTool(h, ctx, 'write', { html: '<p>x</p>' }).text, /title is required/)
  assert.match(runCanvasTool(h, ctx, 'write', { title: '   ', html: '<p>x</p>' }).text, /title is required/)
  assert.equal(h.rows.size, 0)
})

test('a failing host is reported, not thrown at the session', () => {
  const h = host()
  h.save = () => {
    throw new Error('Canvas is too large (limit 4 MB).')
  }
  assert.match(runCanvasTool(h, ctx, 'write', { title: 'T', html: '<p>x</p>' }).text, /too large/)
})

test('list names the ids, since that is what a revision needs', () => {
  const h = host()
  runCanvasTool(h, ctx, 'write', { title: 'One', html: '<p>1</p>' })
  const out = runCanvasTool(h, ctx, 'list')
  assert.match(out.text, /^c1\tOne\t/m)
})

test('an empty project says so rather than returning a blank result', () => {
  assert.match(runCanvasTool(host(), ctx, 'list').text, /No canvases saved/)
})

test('read returns the document, and says so when the id is gone', () => {
  const h = host()
  runCanvasTool(h, ctx, 'write', { title: 'One', html: '<h1>doc</h1>' })
  assert.equal(runCanvasTool(h, ctx, 'read', { id: 'c1' }).text, '<h1>doc</h1>')
  assert.match(runCanvasTool(h, ctx, 'read', { id: 'nope' }).text, /No canvas with id/)
  assert.match(runCanvasTool(h, ctx, 'read', {}).text, /id is required/)
})

test('the wire schema requires exactly what the tool cannot default', () => {
  const tools = Object.fromEntries(canvasToolList().map((t) => [t.name, t]))
  assert.deepEqual(Object.keys(tools), ['write', 'list', 'read'])
  assert.deepEqual((tools.write.inputSchema as { required: string[] }).required, ['title', 'html'])
  // `id` is optional on write — that is what makes a first write possible.
  assert.ok('id' in (tools.write.inputSchema as { properties: object }).properties)
  assert.deepEqual((tools.read.inputSchema as { required: string[] }).required, ['id'])
  assert.deepEqual((tools.list.inputSchema as { required?: string[] }).required, undefined)
})

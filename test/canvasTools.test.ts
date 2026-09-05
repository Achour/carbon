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
  // rather than write a second one with the same title — and it is pointed at
  // `edit`, since re-sending the whole document is the cost this exists to avoid.
  assert.match(out.text, /call canvas edit with id: c1/)
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
  assert.deepEqual(Object.keys(tools), ['write', 'edit', 'list', 'read'])
  assert.deepEqual((tools.edit.inputSchema as { required: string[] }).required, ['id'])
  // The schema is derived from CANVAS_TOOL_INFO's parameter table, so a boolean
  // stays a boolean across the wire rather than becoming a string on the two
  // providers that read this schema and not Claude's zod one.
  assert.deepEqual(
    (tools.edit.inputSchema as { properties: Record<string, { type: string }> }).properties
      .replace_all.type,
    'boolean'
  )
  assert.deepEqual((tools.write.inputSchema as { required: string[] }).required, ['title', 'html'])
  // `id` is optional on write — that is what makes a first write possible.
  assert.ok('id' in (tools.write.inputSchema as { properties: object }).properties)
  assert.deepEqual((tools.read.inputSchema as { required: string[] }).required, ['id'])
  assert.deepEqual((tools.list.inputSchema as { required?: string[] }).required, undefined)
})

// --- edit -------------------------------------------------------------------
//
// The four outcomes are `Edit`'s, deliberately: a unique hit, no hit, several
// hits, and several hits with `replace_all`. A canvas revision used to cost the
// whole document in output tokens — measured at 281s for a 57-byte change to an
// 80 KB canvas — which is the entire reason this tool exists.

function seeded(html: string): ReturnType<typeof host> {
  const h = host()
  runCanvasTool(h, ctx, 'write', { title: 'Report', html })
  return h
}

test('edit replaces one occurrence and leaves the rest of the document alone', () => {
  const h = seeded('<h1>Old</h1><p>body</p>')
  const out = runCanvasTool(h, ctx, 'edit', {
    id: 'c1',
    old_string: '<h1>Old</h1>',
    new_string: '<h1>New</h1>'
  })
  assert.equal(h.rows.get('c1')?.html, '<h1>New</h1><p>body</p>')
  // The id and the title ride the result: the renderer scrapes both out of this
  // sentence to draw the row and its Open link.
  assert.match(out.text, /Updated canvas "Report" \(id: c1\)/)
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.get('c1')?.createdAt, 1)
})

test('edit refuses when old_string is not in the document', () => {
  const h = seeded('<p>body</p>')
  const out = runCanvasTool(h, ctx, 'edit', { id: 'c1', old_string: 'nope', new_string: 'x' })
  assert.match(out.text, /not found/)
  assert.equal(h.rows.get('c1')?.html, '<p>body</p>')
})

test('edit refuses an ambiguous old_string and says how many it found', () => {
  const h = seeded('<td>1</td><td>1</td><td>1</td>')
  const out = runCanvasTool(h, ctx, 'edit', { id: 'c1', old_string: '<td>1</td>', new_string: '<td>2</td>' })
  assert.match(out.text, /appears 3 times/)
  assert.equal(h.rows.get('c1')?.html, '<td>1</td><td>1</td><td>1</td>')
})

test('replace_all changes every occurrence', () => {
  const h = seeded('<td>1</td><td>1</td>')
  runCanvasTool(h, ctx, 'edit', {
    id: 'c1',
    old_string: '<td>1</td>',
    new_string: '<td>2</td>',
    replace_all: true
  })
  assert.equal(h.rows.get('c1')?.html, '<td>2</td><td>2</td>')
})

test('a $ in the replacement is literal, not a substitution pattern', () => {
  // `String.replace` would read `$&` as "the match" and silently duplicate it.
  // A canvas is full of CSS and script that can contain either spelling.
  const h = seeded('<p>cost</p>')
  runCanvasTool(h, ctx, 'edit', { id: 'c1', old_string: 'cost', new_string: '$& $1 $$' })
  assert.equal(h.rows.get('c1')?.html, '<p>$& $1 $$</p>')
})

test('edit can rename without touching the body', () => {
  const h = seeded('<p>body</p>')
  runCanvasTool(h, ctx, 'edit', { id: 'c1', title: 'Report v2' })
  assert.equal(h.rows.get('c1')?.title, 'Report v2')
  assert.equal(h.rows.get('c1')?.html, '<p>body</p>')
})

test('edit needs an id that names a canvas, and something to do', () => {
  const h = seeded('<p>body</p>')
  assert.match(runCanvasTool(h, ctx, 'edit', {}).text, /id is required/)
  assert.match(
    runCanvasTool(h, ctx, 'edit', { id: 'nope', old_string: 'a', new_string: 'b' }).text,
    /No canvas with id nope/
  )
  assert.match(runCanvasTool(h, ctx, 'edit', { id: 'c1' }).text, /old_string is required/)
  // Omitting new_string would otherwise delete the match — a deletion the model
  // never asked for, from a field it merely forgot.
  assert.match(
    runCanvasTool(h, ctx, 'edit', { id: 'c1', old_string: 'body' }).text,
    /new_string is required/
  )
  assert.equal(h.rows.get('c1')?.html, '<p>body</p>')
  assert.match(
    runCanvasTool(h, ctx, 'edit', { id: 'c1', old_string: 'body', new_string: 'body' }).text,
    /identical/
  )
})

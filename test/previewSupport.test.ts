import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseKeyCombo } from '../src/main/previewInput.ts'
import {
  decodeVlq,
  inlineSourceMap,
  isLibraryFrame,
  originalPosition,
  parseStackFrame,
  sourceMappingUrl,
  sourcePathCandidates
} from '../src/main/sourceMap.ts'
import { resolveFrame, isLoopbackUrl } from '../src/main/previewSource.ts'
import { cwdBelongsTo, descendsFrom, parseLsofCwd, parseLsofListen, parsePsParents } from '../src/main/localServers.ts'
import { PreviewLog, formatConsoleArgs, formatNetwork } from '../src/main/previewLog.ts'
import { detectDevPlan } from '../src/main/devServerPlan.ts'
import {
  applyViewportPatch,
  describeViewport,
  previewDevice,
  viewportSize,
  VIEWPORT_MAX
} from '../src/shared/previewDevices.ts'

// ---- keys ----

test('parseKeyCombo agrees key, code, keyCode and text', () => {
  assert.deepEqual(parseKeyCombo('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 })
  assert.deepEqual(parseKeyCombo('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a' })
  assert.deepEqual(parseKeyCombo('Shift+a'), { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, text: 'A' })
  const tab = parseKeyCombo('Shift+Tab')
  assert.ok(!('error' in tab) && tab.modifiers === 8 && tab.key === 'Tab' && tab.text === undefined)
})

test('parseKeyCombo names the editing command a synthetic shortcut needs, and inserts no text', () => {
  const all = parseKeyCombo('Meta+A')
  assert.ok(!('error' in all))
  assert.equal(all.text, undefined)
  assert.deepEqual(all.commands, ['selectAll'])
  assert.equal(all.modifiers, 4)
  const ctrl = parseKeyCombo('ctrl+shift+ArrowLeft')
  assert.ok(!('error' in ctrl) && ctrl.modifiers === 10 && ctrl.code === 'ArrowLeft')
  const plus = parseKeyCombo('Control++')
  assert.ok(!('error' in plus) && plus.key === '+' && plus.modifiers === 2)
})

test('parseKeyCombo names a command only for the exact shortcut', () => {
  const redo = parseKeyCombo('Meta+Shift+Z')
  assert.ok(!('error' in redo) && redo.commands?.[0] === 'redo')
  const undo = parseKeyCombo('Control+z')
  assert.ok(!('error' in undo) && undo.commands?.[0] === 'undo')
  const other = parseKeyCombo('Alt+Meta+A')
  assert.ok(!('error' in other) && other.commands === undefined)
})

test('parseKeyCombo reports what it cannot place', () => {
  assert.ok('error' in parseKeyCombo('Hyper+K'))
  assert.ok('error' in parseKeyCombo('Enterr'))
  assert.ok('error' in parseKeyCombo(''))
})

// ---- source maps ----

test('decodeVlq reads base64 VLQ fields, negatives included', () => {
  assert.deepEqual(decodeVlq('AAAA'), [0, 0, 0, 0])
  assert.deepEqual(decodeVlq('AACA'), [0, 0, 1, 0])
  assert.deepEqual(decodeVlq('D'), [-1])
  assert.deepEqual(decodeVlq('gB'), [16])
})

// Generated line 1 maps to source line 1; generated line 3 col 4 to source line 2 col 2.
const MAP = { version: 3, sources: ['src/App.tsx'], sourceRoot: '', mappings: 'AAAA;;IACE', names: [] }

test('originalPosition finds the last mapping at or before the column', () => {
  assert.deepEqual(originalPosition(MAP, 1, 1), { source: 'src/App.tsx', line: 1, column: 1 })
  assert.deepEqual(originalPosition(MAP, 3, 10), { source: 'src/App.tsx', line: 2, column: 3 })
  assert.equal(originalPosition(MAP, 2, 1), null)
})

test('originalPosition stops at an unmapped segment', () => {
  const map = { version: 3, sources: ['a.ts'], mappings: 'AAAA,K' }
  assert.deepEqual(originalPosition(map, 1, 3), { source: 'a.ts', line: 1, column: 1 })
  assert.equal(originalPosition(map, 1, 8), null)
})

test('originalPosition walks index-map sections', () => {
  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: 'AAAA' } },
      { offset: { line: 10, column: 0 }, map: MAP }
    ]
  }
  assert.deepEqual(originalPosition(indexed, 1, 1), { source: 'a.ts', line: 1, column: 1 })
  assert.deepEqual(originalPosition(indexed, 13, 10), { source: 'src/App.tsx', line: 2, column: 3 })
})

test('sourceMappingUrl takes the last comment; inline maps decode', () => {
  assert.equal(sourceMappingUrl('a\n//# sourceMappingURL=one.map\nb\n//# sourceMappingURL=two.map'), 'two.map')
  const data = 'data:application/json;base64,' + Buffer.from(JSON.stringify(MAP)).toString('base64')
  assert.deepEqual(inlineSourceMap(data), MAP)
  assert.equal(inlineSourceMap('app.js.map'), null)
})

test('parseStackFrame and isLibraryFrame pick out the user frame of a React 19 _debugStack', () => {
  const stack = [
    'Error: react-stack-top-frame',
    '    at exports.jsxDEV (http://localhost:5199/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=8d:244:30)',
    '    at Counter (http://localhost:5199/src/App.jsx:7:26)',
    '    at Object.react_stack_bottom_frame (http://localhost:5199/node_modules/.vite/deps/react-dom_client.js?v=af:18507:20)'
  ]
  const frames = stack.slice(1).map(parseStackFrame)
  const user = frames.find((f) => f && !isLibraryFrame(f.url))
  assert.deepEqual(user, { fn: 'Counter', url: 'http://localhost:5199/src/App.jsx', line: 7, column: 26 })
})

test('sourcePathCandidates covers every bundler spelling, most specific first', () => {
  assert.deepEqual(sourcePathCandidates('http://localhost:5173/src/App.tsx?t=123', '/p'), ['/p/src/App.tsx'])
  assert.deepEqual(sourcePathCandidates('webpack://app/./src/pages/a.tsx', '/p'), ['/p/src/pages/a.tsx', '/p/pages/a.tsx'])
  assert.deepEqual(sourcePathCandidates('turbopack:///[project]/app/page.tsx', '/p'), ['/p/app/page.tsx'])
  assert.deepEqual(sourcePathCandidates('webpack-internal:///(app-pages-browser)/./src/x.tsx', '/p'), ['/p/src/x.tsx'])
  assert.deepEqual(sourcePathCandidates('/abs/proj/src/App.tsx', '/abs/proj'), [
    '/abs/proj/src/App.tsx',
    '/abs/proj/abs/proj/src/App.tsx',
    '/abs/proj/proj/src/App.tsx',
    '/abs/proj/src/App.tsx'
  ].filter((v, i, a) => a.indexOf(v) === i))
})

test('resolveFrame maps a served frame through the dev server map to a project path', async () => {
  const map = { version: 3, sources: ['/proj/src/App.jsx'], mappings: 'AAAA;;IACE' }
  const code = 'line1\n\n    jsx()\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')
  const fetched: string[] = []
  const res = await resolveFrame({ url: 'http://localhost:5199/src/App.jsx?t=1', line: 3, column: 5 }, '/proj', {
    fetchText: async (u) => (fetched.push(u), code),
    exists: (p) => p === '/proj/src/App.jsx'
  })
  assert.deepEqual(res, { file: 'src/App.jsx', line: 2, column: 3 })
  assert.deepEqual(fetched, ['http://localhost:5199/src/App.jsx?t=1'])
})

test('resolveFrame resolves a map source relative to the script, the way Vite names it', async () => {
  const map = { version: 3, sources: ['App.jsx'], mappings: 'AAAA;;IACE' }
  const code = 'x\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')
  const res = await resolveFrame({ url: 'http://localhost:5199/src/App.jsx?t=2', line: 3, column: 5 }, '/proj', {
    fetchText: async () => code,
    exists: (p) => p === '/proj/src/App.jsx'
  })
  assert.deepEqual(res, { file: 'src/App.jsx', line: 2, column: 3 })
})

test('resolveFrame never fetches a non-loopback origin, and falls back to the URL path', async () => {
  let fetched = false
  const res = await resolveFrame({ url: 'https://example.com/src/App.jsx', line: 9, column: 2 }, '/proj', {
    fetchText: async () => ((fetched = true), null),
    exists: (p) => p === '/proj/src/App.jsx'
  })
  assert.equal(fetched, false)
  assert.deepEqual(res, { file: 'src/App.jsx', line: 9, column: 2 })
  assert.equal(isLoopbackUrl('http://127.0.0.1:3000/x'), true)
  assert.equal(isLoopbackUrl('http://app.localhost:3000/'), true)
  assert.equal(isLoopbackUrl('http://localhost.evil.com/'), false)
})

// ---- local servers ----

test('parseLsofListen keeps one entry per port, preferring the IPv4 binding', () => {
  const out = ['p100', 'cnode', 'n[::1]:5173', 'n127.0.0.1:5173', 'p200', 'cruby', 'n*:3000', 'p300', 'cpostgres', 'n127.0.0.1:5432'].join('\n')
  assert.deepEqual(parseLsofListen(out), [
    { pid: 200, command: 'ruby', host: '*', port: 3000 },
    { pid: 100, command: 'node', host: '127.0.0.1', port: 5173 },
    { pid: 300, command: 'postgres', host: '127.0.0.1', port: 5432 }
  ])
})

test('parseLsofCwd, parsePsParents and descendsFrom match a listener to the process tree', () => {
  assert.deepEqual([...parseLsofCwd('p10\nfcwd\nn/Users/me/app\np11\nn/tmp').entries()], [
    [10, '/Users/me/app'],
    [11, '/tmp']
  ])
  const parents = parsePsParents('  1     0\n 50     1\n 60    50\n 70    60\n')
  assert.equal(descendsFrom(70, 50, parents), true)
  assert.equal(descendsFrom(70, 1, parents), true)
  assert.equal(descendsFrom(50, 60, parents), false)
})

test('cwdBelongsTo accepts the project and below, never a parent or a sibling', () => {
  assert.equal(cwdBelongsTo('/p/app', '/p/app'), true)
  assert.equal(cwdBelongsTo('/p/app/apps/web', '/p/app/'), true)
  assert.equal(cwdBelongsTo('/p', '/p/app'), false)
  assert.equal(cwdBelongsTo('/p/app-2', '/p/app'), false)
  assert.equal(cwdBelongsTo(undefined, '/p/app'), false)
})

// ---- the log ----

test('PreviewLog reads are per caller and only return what is new', () => {
  const log = new PreviewLog()
  log.addConsole('log', 'one')
  log.addConsole('debug', '[vite] connecting...')
  log.addConsole('error', 'boom')
  assert.deepEqual(log.readConsole('a').map((e) => e.text), ['one', 'boom'])
  assert.deepEqual(log.readConsole('a'), [])
  assert.deepEqual(log.readConsole('b').map((e) => e.text), ['one', 'boom'])
  log.addConsole('warn', 'later')
  assert.deepEqual(log.readConsole('a').map((e) => e.text), ['later'])
  assert.equal(log.readConsole('a', { all: true }).length, 4)
})

test('PreviewLog drops Electron and picker noise', () => {
  const log = new PreviewLog()
  log.addConsole('warn', '%cElectron Security Warning (Insecure Content-Security-Policy)')
  log.addConsole('log', '__KARBUN_PICK__{}')
  assert.equal(log.readConsole('a', { all: true }).length, 0)
})

test('PreviewLog network: settled requests, failures, and problems after a mark', () => {
  const log = new PreviewLog()
  log.requestStarted('1', 'GET', 'http://localhost:5173/api/a', 'Fetch')
  assert.equal(log.pending(), 1)
  const mark = log.mark()
  log.responseReceived('1', 500, 'Internal Server Error', 'application/json')
  log.requestFinished('1')
  log.requestStarted('2', 'GET', 'http://localhost:5173/img.png', 'Image')
  log.requestFailed('2', 'net::ERR_ABORTED', true)
  log.requestStarted('3', 'POST', 'http://localhost:1/x', 'XHR')
  log.requestFailed('3', 'net::ERR_CONNECTION_REFUSED', false)
  assert.equal(log.pending(), 0)
  const problems = log.problemsSince(mark).network.map((e) => e.id)
  assert.deepEqual(problems, ['1', '3'])
  const failed = log.readNetwork('a', { failedOnly: true })
  assert.deepEqual(failed.map((e) => e.id), ['1', '3'])
  assert.match(formatNetwork(failed, 'http://localhost:5173'), /^GET \/api\/a → 500 Internal Server Error \d+ms \[Fetch\]/)
})

test('formatConsoleArgs applies the format string and drops %c styling', () => {
  assert.equal(
    formatConsoleArgs([
      { type: 'string', value: '%cDownload %s now' },
      { type: 'string', value: 'font-weight:bold' },
      { type: 'string', value: 'it' }
    ]),
    'Download it now'
  )
  assert.equal(
    formatConsoleArgs([
      { type: 'string', value: 'user' },
      { type: 'object', preview: { properties: [{ name: 'id', type: 'number', value: '7' }, { name: 'n', type: 'string', value: 'x' }] } },
      { type: 'object', subtype: 'array', preview: { overflow: true, properties: [{ name: '0', type: 'number', value: '1' }] } }
    ]),
    'user {id: 7, n: "x"} [1, …]'
  )
  assert.equal(formatConsoleArgs([{ type: 'number', value: 3 }, { type: 'undefined' }]), '3 undefined')
})

// ---- dev server plan ----

test('detectDevPlan: root script, monorepo web app, and non-Node frameworks', () => {
  const root = mkdtempSync(join(tmpdir(), 'devplan-'))
  const write = (rel: string, body: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  write('a/package.json', JSON.stringify({ scripts: { build: 'x', dev: 'vite' } }))
  write('a/pnpm-lock.yaml', '')
  assert.deepEqual(detectDevPlan(join(root, 'a')), { command: 'pnpm dev', dir: join(root, 'a') })

  write('mono/package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }))
  write('mono/bun.lock', '')
  write('mono/packages/ui/package.json', JSON.stringify({ scripts: { dev: 'tsc -w' } }))
  write('mono/apps/web/package.json', JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '1' } }))
  assert.deepEqual(detectDevPlan(join(root, 'mono')), { command: 'bun run dev', dir: join(root, 'mono/apps/web') })

  write('rails/bin/rails', '')
  assert.deepEqual(detectDevPlan(join(root, 'rails')), { command: 'bin/rails server', dir: join(root, 'rails') })
  write('dj/manage.py', '')
  assert.equal(detectDevPlan(join(root, 'dj'))?.command, 'python3 manage.py runserver')
  mkdirSync(join(root, 'empty'))
  assert.equal(detectDevPlan(join(root, 'empty')), null)
})

// ---- devices ----

test('viewport presets: sizes, rotation, clamping and patches', () => {
  assert.equal(previewDevice('iPhone 15')?.id, 'iphone-15')
  assert.deepEqual(viewportSize({ device: 'iphone-15', rotated: true }), { width: 852, height: 393, dpr: 3, mobile: true, os: 'ios' })
  assert.equal(viewportSize({ device: 'fill' }), null)
  assert.equal(viewportSize({ device: 'custom', width: 99999, height: 10 })?.width, VIEWPORT_MAX)
  const v = applyViewportPatch({ device: 'iphone-15', rotated: true, colorScheme: 'dark' }, { device: 'pixel-8' })
  assert.deepEqual(v, { device: 'pixel-8', colorScheme: 'dark' })
  assert.deepEqual(applyViewportPatch(v, { colorScheme: null }), { device: 'pixel-8' })
  assert.match(describeViewport({ device: 'pixel-8', colorScheme: 'dark' }), /Pixel 8 412×915, dark scheme/)
})

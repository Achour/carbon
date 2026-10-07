import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { PreviewState } from '../src/shared/types.ts'
import {
  isPreviewSideEffect,
  isPreviewToolName,
  previewPlanBlock,
  runPreviewTool,
  viewportPatch,
  PREVIEW_TOOL_INFO,
  type PreviewToolHost
} from '../src/main/previewTools.ts'
import { carbonToolInput, carbonToolList, handleMcpCall, isCarbonSideEffect } from '../src/main/carbonMcp.ts'
import { previewArgErrors } from '../src/main/previewTools.ts'

function state(status: PreviewState['status'], extra: Partial<PreviewState> = {}): PreviewState {
  return { cwd: '/tmp/app', status, ...extra }
}

function host(overrides: Partial<PreviewToolHost> = {}): PreviewToolHost & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    status: async () => JSON.stringify(state('running', { url: 'http://localhost:5173' })),
    startAndWait: async () => state('running', { url: 'http://localhost:5173' }),
    stop: () => state('stopped'),
    screenshot: async () => 'png-bytes',
    page: async (cwd, caller, op, input) => {
      calls.push([cwd, caller, op, input])
      return `did ${op}`
    },
    ...overrides
  }
}

test('isPreviewToolName is the closed set of preview tools', () => {
  assert.equal(isPreviewToolName('screenshot'), true)
  assert.equal(isPreviewToolName('click'), true)
  assert.equal(isPreviewToolName('wait_for'), true)
  assert.equal(isPreviewToolName('Write'), false)
})

test('plan mode refuses the server and page side effects, and nothing that only reads', () => {
  for (const name of ['start', 'stop', 'click', 'type', 'press', 'evaluate'] as const) {
    assert.equal(isPreviewSideEffect(name), true, name)
    assert.ok(previewPlanBlock(name, true), name)
    assert.equal(previewPlanBlock(name, false), null, name)
  }
  for (const name of ['status', 'snapshot', 'screenshot', 'console', 'network', 'scroll', 'resize', 'navigate', 'wait_for'] as const) {
    assert.equal(isPreviewSideEffect(name), false, name)
    assert.equal(previewPlanBlock(name, true), null, name)
  }
  assert.match(previewPlanBlock('start', true) ?? '', /dev server/)
  assert.match(previewPlanBlock('click', true) ?? '', /snapshot/)
  // The permission gate reads the same table through the server's namespace.
  assert.equal(isCarbonSideEffect('mcp__carbon__preview_click'), true)
  assert.equal(isCarbonSideEffect('mcp__carbon__preview_snapshot'), false)
})

test('runPreviewTool status/start/stop answer from the host', async () => {
  const preview = host()
  const status = await runPreviewTool(preview, '/tmp/app', 'status')
  assert.equal(status.kind, 'text')
  if (status.kind === 'text') assert.match(status.text, /"status":"running"/)
  const stopped = await runPreviewTool(preview, '/tmp/app', 'stop')
  if (stopped.kind === 'text') assert.match(stopped.text, /"status":"stopped"/)
})

test('runPreviewTool validates required arguments before reaching the page', async () => {
  const preview = host()
  const nav = await runPreviewTool(preview, '/tmp/app', 'navigate')
  assert.equal(nav.kind === 'text' && /url, or an action/.test(nav.text), true)
  const press = await runPreviewTool(preview, '/tmp/app', 'press', {})
  assert.equal(press.kind === 'text' && /key is required/.test(press.text), true)
  const ev = await runPreviewTool(preview, '/tmp/app', 'evaluate', { expression: '  ' })
  assert.equal(ev.kind === 'text' && /expression is required/.test(ev.text), true)
  const wait = await runPreviewTool(preview, '/tmp/app', 'wait_for', {})
  assert.equal(wait.kind === 'text' && /text, a selector or a ref/.test(wait.text), true)
  assert.equal(preview.calls.length, 0)
})

test('runPreviewTool routes page ops with the caller that scopes cursors', async () => {
  const preview = host()
  const res = await runPreviewTool(preview, '/tmp/app', 'click', { ref: 'e3' }, { caller: 'chat-1' })
  assert.deepEqual(res, { kind: 'text', text: 'did click' })
  assert.deepEqual(preview.calls[0], ['/tmp/app', 'chat-1', 'click', { ref: 'e3' }])
  await runPreviewTool(preview, '/tmp/app', 'navigate', { action: 'back' })
  assert.equal(preview.calls[1][1], '/tmp/app')
})

test('runPreviewTool screenshot returns an image or the host error', async () => {
  let asked: unknown
  const ok = await runPreviewTool(host({ screenshot: async (_c, o) => ((asked = o), 'png') }), '/tmp/app', 'screenshot', { full_page: true })
  assert.deepEqual(ok, { kind: 'image', data: 'png', mimeType: 'image/png' })
  assert.deepEqual(asked, { fullPage: true })
  const missing = await runPreviewTool(host({ screenshot: async () => ({ error: 'No preview is open' }) }), '/tmp/app', 'screenshot')
  assert.deepEqual(missing, { kind: 'text', text: 'No preview is open' })
})

test('the wire schema is derived from the param table, enums and required included', () => {
  const tools = carbonToolList({ canvas: false })
  const type = tools.find((t) => t.name === 'preview_type')!
  assert.deepEqual((type.inputSchema as { required?: string[] }).required, ['text'])
  const resize = tools.find((t) => t.name === 'preview_resize')!
  const props = (resize.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
  assert.ok(props.device.enum?.includes('iphone-15'))
  assert.ok(props.device.enum?.includes('fill'))
  assert.deepEqual(props.color_scheme.enum, ['light', 'dark', 'system'])
  // Plus `chart_render` and `diagram_render`, which need no canvas host.
  assert.equal(tools.length, Object.keys(PREVIEW_TOOL_INFO).length + 2)
})

test('carbonToolInput coerces by declared type and drops what does not fit', () => {
  const input = carbonToolInput({
    ref: 'e4',
    x: '120',
    y: 40,
    dy: 'lots',
    double: 'true',
    full_page: false,
    text: 7,
    title: 'Canvas'
  })
  assert.equal(input.ref, 'e4')
  assert.equal(input.x, 120)
  assert.equal(input.y, 40)
  assert.equal(input.dy, undefined)
  assert.equal(input.double, true)
  assert.equal(input.full_page, false)
  assert.equal(input.text, undefined)
  assert.equal(input.title, 'Canvas')
})

test('carbonToolInput drops an enum value outside its list', () => {
  assert.equal(carbonToolInput({ button: 'left' }).button, 'left')
  assert.equal(carbonToolInput({ button: 'thumb' }).button, undefined)
  assert.equal(carbonToolInput({ color_scheme: 'sepia' }).color_scheme, undefined)
})

test('viewportPatch turns resize arguments into a patch, and names bad input', () => {
  assert.deepEqual(viewportPatch({ device: 'iPhone 15' }), { device: 'iphone-15' })
  assert.deepEqual(viewportPatch({ device: 'fill' }), { device: 'fill' })
  assert.deepEqual(viewportPatch({ width: 800, height: 600 }), { device: 'custom', width: 800, height: 600 })
  assert.deepEqual(viewportPatch({ color_scheme: 'system' }), { colorScheme: null })
  assert.deepEqual(viewportPatch({ rotate: true, color_scheme: 'dark' }), { rotated: true, colorScheme: 'dark' })
  assert.match((viewportPatch({ device: 'nokia' }) as { error: string }).error, /Unknown device/)
  assert.match((viewportPatch({ width: 800 }) as { error: string }).error, /both width and height/)
  assert.match((viewportPatch({}) as { error: string }).error, /Say what to change/)
})

test('invalid arguments are refused at the HTTP boundary, the way zod refuses them for Claude', async () => {
  assert.deepEqual(previewArgErrors('click', { button: 'left', x: '12' }), [])
  assert.match(previewArgErrors('click', { button: 'thumb' })[0], /button: expected one of left, right, middle/)
  assert.match(previewArgErrors('scroll', { dy: 'lots' })[0], /dy: expected a number/)
  let called = false
  const res = await handleMcpCall(
    { id: 1, method: 'tools/call', params: { name: 'preview_click', arguments: { button: 'thumb' } } },
    async () => ((called = true), { ok: true, kind: 'text', text: 'x' })
  )
  assert.equal(called, false)
  assert.equal((res.result as { isError?: boolean }).isError, true)
})

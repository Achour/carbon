import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { PreviewState } from '../src/shared/types.ts'
import {
  isPreviewSideEffect,
  isPreviewToolName,
  runPreviewTool,
  type PreviewToolHost
} from '../src/main/previewTools.ts'

function state(status: PreviewState['status'], extra: Partial<PreviewState> = {}): PreviewState {
  return { cwd: '/tmp/app', status, ...extra }
}

function host(overrides: Partial<PreviewToolHost> = {}): PreviewToolHost {
  return {
    state: () => state('running', { url: 'http://localhost:5173' }),
    startAndWait: async () => state('running', { url: 'http://localhost:5173' }),
    stop: () => state('stopped'),
    navigate: async () => ({ id: '1', ok: true }),
    screenshot: async () => 'png-bytes',
    recentConsole: () => 'TypeError: x',
    ...overrides
  }
}

test('isPreviewToolName is the closed set of preview tools', () => {
  assert.equal(isPreviewToolName('screenshot'), true)
  assert.equal(isPreviewToolName('start'), true)
  assert.equal(isPreviewToolName('Write'), false)
  assert.equal(isPreviewSideEffect('start'), true)
  assert.equal(isPreviewSideEffect('stop'), true)
  assert.equal(isPreviewSideEffect('screenshot'), false)
})

test('runPreviewTool status/start/stop return the state JSON', async () => {
  const preview = host()
  const status = await runPreviewTool(preview, '/tmp/app', 'status')
  assert.equal(status.kind, 'text')
  if (status.kind === 'text') assert.match(status.text, /"status":"running"/)
  const started = await runPreviewTool(preview, '/tmp/app', 'start')
  assert.equal(started.kind, 'text')
  const stopped = await runPreviewTool(preview, '/tmp/app', 'stop')
  assert.equal(stopped.kind, 'text')
  if (stopped.kind === 'text') assert.match(stopped.text, /"status":"stopped"/)
})

test('runPreviewTool navigate requires a url and reports failure', async () => {
  const preview = host({
    navigate: async () => ({ id: '1', ok: false, error: 'No preview open' })
  })
  const missing = await runPreviewTool(preview, '/tmp/app', 'navigate')
  assert.equal(missing.kind, 'text')
  if (missing.kind === 'text') assert.match(missing.text, /url is required/)
  const failed = await runPreviewTool(preview, '/tmp/app', 'navigate', { url: 'http://localhost:5173/x' })
  assert.equal(failed.kind, 'text')
  if (failed.kind === 'text') assert.match(failed.text, /No preview open/)
})

test('runPreviewTool screenshot returns an image or a missing-preview message', async () => {
  const ok = await runPreviewTool(host(), '/tmp/app', 'screenshot')
  assert.deepEqual(ok, { kind: 'image', data: 'png-bytes', mimeType: 'image/png' })
  const missing = await runPreviewTool(host({ screenshot: async () => null }), '/tmp/app', 'screenshot')
  assert.equal(missing.kind, 'text')
  if (missing.kind === 'text') assert.match(missing.text, /No preview is open/)
})

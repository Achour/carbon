import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accumulateAppServerUsage,
  appServerApprovalResponse,
  appServerImmediateResponse,
  CodexAppServerClient,
  isCodexCompactionItem,
  normalizeAppServerItem,
  threadOverlayConfig
} from '../src/main/codexAppServer.ts'
import { fetchCodexModels } from '../src/main/codex.ts'

test('App Server MCP results retain text, images, structured content and metadata', () => {
  const item = normalizeAppServerItem({
    id: 'mcp-1',
    type: 'mcpToolCall',
    server: 'images',
    tool: 'render',
    arguments: { prompt: 'diagram' },
    status: 'completed',
    result: {
      content: [
        { type: 'text', text: 'saved' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
      ],
      structuredContent: { path: '/tmp/result.png' },
      _meta: { requestId: 'one' }
    }
  })

  assert.equal(item?.type, 'mcp_tool_call')
  if (item?.type !== 'mcp_tool_call') return
  assert.deepEqual(item.result, {
    content: [
      { type: 'text', text: 'saved' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    ],
    structured_content: { path: '/tmp/result.png' },
    _meta: { requestId: 'one' }
  })
})

test('thread overlay keeps service-tier keys and layers extra MCP config', () => {
  const overlay = threadOverlayConfig({
    serviceTier: 'fast',
    extraConfig: { mcp_servers: { preview: { command: '/bin/echo' } } }
  })
  assert.equal(overlay.service_tier, 'fast')
  assert.deepEqual(overlay.features, { fast_mode: true })
  assert.deepEqual(overlay.mcp_servers, { preview: { command: '/bin/echo' } })
})

test('a started App Server file change stays running until completion', () => {
  const started = normalizeAppServerItem({
    id: 'patch-1',
    type: 'fileChange',
    status: 'inProgress',
    changes: [{ path: 'src/main.ts', kind: 'update' }]
  }) as unknown as { status?: string }
  const completed = normalizeAppServerItem({
    id: 'patch-1',
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: 'src/main.ts', kind: 'update' }]
  }) as unknown as { status?: string }

  assert.equal(started.status, 'in_progress')
  assert.equal(completed.status, 'completed')
})

test('native approval decisions use the exact App Server response shapes', () => {
  assert.deepEqual(
    appServerApprovalResponse('item/commandExecution/requestApproval', {}, true, true),
    { decision: 'acceptForSession' }
  )
  assert.deepEqual(
    appServerApprovalResponse('item/fileChange/requestApproval', {}, false),
    { decision: 'decline' }
  )
  assert.deepEqual(appServerApprovalResponse('execCommandApproval', {}, true, true), {
    decision: 'approved_for_session'
  })
  const requested = { network: { enabled: true }, fileSystem: null }
  assert.deepEqual(
    appServerApprovalResponse(
      'item/permissions/requestApproval',
      { permissions: requested },
      true
    ),
    { permissions: requested, scope: 'turn' }
  )
})

test('App Server host clock requests use whole Unix seconds', () => {
  assert.deepEqual(appServerImmediateResponse('currentTime/read', 1_788_263_328_987), {
    currentTimeAt: 1_788_263_328
  })
  assert.equal(appServerImmediateResponse('attestation/generate', 1_788_263_328_987), null)
})

test('MCP progress becomes live tool output and final results replace it', () => {
  const progress = normalizeAppServerItem({
    id: 'mcp-1',
    type: 'mcpToolCall',
    server: 'node_repl',
    tool: 'js',
    arguments: { code: 'browser.tabs.list()' },
    status: 'inProgress',
    carbonProgress: 'Reading Chrome tabs…'
  })
  const completed = normalizeAppServerItem({
    id: 'mcp-1',
    type: 'mcpToolCall',
    server: 'node_repl',
    tool: 'js',
    arguments: { code: 'browser.tabs.list()' },
    status: 'completed',
    carbonProgress: 'stale progress',
    result: { content: [{ type: 'text', text: 'Two tabs' }] }
  })

  if (progress?.type !== 'mcp_tool_call' || completed?.type !== 'mcp_tool_call') {
    assert.fail('Expected normalized MCP calls')
  }
  assert.deepEqual(progress.result?.content, [{ type: 'text', text: 'Reading Chrome tabs…' }])
  assert.deepEqual(completed.result?.content, [{ type: 'text', text: 'Two tabs' }])
})

test('App Server surfaces retry errors once and deduplicates fatal errors', async () => {
  const client = new CodexAppServerClient()
  const notify = client as unknown as {
    handleNotification(method: string, params: unknown): void
  }
  const run = client.attachTurn('thread-1', 'turn-1', 'gpt-test')

  notify.handleNotification('error', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    error: { message: 'Temporary network failure.' },
    willRetry: true
  })
  notify.handleNotification('error', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    error: { message: 'Authentication expired.' },
    willRetry: false
  })
  notify.handleNotification('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'failed', error: { message: 'Authentication expired.' } }
  })

  const events = []
  for await (const event of run.queue.iterate()) events.push(event)
  assert.deepEqual(
    events.map((event) => event.type),
    ['item.completed', 'error']
  )
  assert.equal(events[0]?.type === 'item.completed' ? events[0].item.type : null, 'error')
  assert.equal(events[1]?.type === 'error' ? events[1].message : null, 'Authentication expired.')
  client.dispose()
})

test('token notifications accumulate per-call usage while preserving live context', () => {
  const first = accumulateAppServerUsage(
    null,
    {
      last: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5
      },
      modelContextWindow: 8_000
    },
    'gpt-test'
  )
  const second = accumulateAppServerUsage(first, {
    last: {
      totalTokens: 190,
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 8
    },
    modelContextWindow: 8_000
  })

  assert.equal(second.input_tokens, 150)
  assert.equal(second.output_tokens, 50)
  assert.equal(second.cached_input_tokens, 50)
  assert.equal(second.reasoning_output_tokens, 13)
  assert.equal(second.context_tokens, 190)
  assert.equal(second.context_window, 8_000)
  assert.equal(second.model, 'gpt-test')
})

test('compaction and incomplete image generation are not assistant prose', () => {
  const compact = normalizeAppServerItem({ id: 'compact-1', type: 'contextCompaction' })
  const image = normalizeAppServerItem({ id: 'image-1', type: 'imageGeneration' })

  assert.equal(isCodexCompactionItem(compact), true)
  assert.equal(image, null)
})

test('App Server retains MCP startup notifications independently of turn events', () => {
  const client = new CodexAppServerClient()
  const notify = client as unknown as {
    handleNotification(method: string, params: unknown): void
  }

  notify.handleNotification('mcpServer/startupStatus/updated', {
    threadId: 'thread-1',
    name: 'computer-use',
    status: 'failed',
    error: 'Helper exited.',
    failureReason: null
  })

  assert.deepEqual(client.mcpStartupStatus('computer-use', 'thread-1'), {
    threadId: 'thread-1',
    name: 'computer-use',
    status: 'failed',
    error: 'Helper exited.',
    failureReason: null
  })
  assert.equal(client.mcpStartupStatus('computer-use', 'another-thread'), undefined)
  client.dispose()
})

test('Codex models come from the paginated App Server catalog', async () => {
  const calls: unknown[] = []
  const client = {
    request: async (_method: string, params: unknown) => {
      calls.push(params)
      const cursor = (params as { cursor?: string | null }).cursor
      return cursor
        ? {
            data: [
              {
                id: 'gpt-fast',
                model: 'gpt-fast',
                displayName: 'GPT Fast',
                description: 'Quick model',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                serviceTiers: [{ id: 'fast' }],
                hidden: false,
                isDefault: false
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                id: 'gpt-current',
                model: 'gpt-current-wire',
                displayName: 'GPT Current',
                description: 'Default model',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium' },
                  { reasoningEffort: 'high' }
                ],
                serviceTiers: [],
                hidden: false,
                isDefault: true
              }
            ],
            nextCursor: 'page-2'
          }
    }
  }

  const models = await fetchCodexModels(client as never)
  assert.equal(calls.length, 2)
  assert.deepEqual(models[0], {
    id: 'codex-default',
    label: 'Codex (default)',
    description: 'Model from your Codex config',
    provider: 'codex',
    resolvedModel: 'gpt-current-wire',
    supportedEfforts: ['medium', 'high'],
    supportsFastMode: false
  })
  assert.equal(models.find((model) => model.id === 'gpt-fast')?.supportsFastMode, true)
})

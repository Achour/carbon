import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Codex,
  Input,
  Thread,
  ThreadEvent,
  ThreadOptions,
  TurnOptions
} from '@openai/codex-sdk'
import type { ChatData, ChatEvent } from '../src/shared/types.ts'
import { CodexSession } from '../src/main/codex.ts'
import type {
  CodexRolloutEvent,
  CodexRolloutWatcher,
  CodexRolloutWatcherFactory
} from '../src/main/codexRollout.ts'
import type { Store } from '../src/main/store.ts'

type TurnFactory = (
  input: Input,
  options?: TurnOptions
) => AsyncGenerator<ThreadEvent>

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for CodexSession state')
}

class FakeCodex {
  readonly resumeCalls: { id: string; options?: ThreadOptions }[] = []
  readonly startCalls: { options?: ThreadOptions }[] = []
  runStreamedCalls = 0
  private readonly turns: TurnFactory[]

  constructor(turns: TurnFactory[]) {
    this.turns = turns
  }

  private thread(options?: ThreadOptions): Thread {
    return {
      runStreamed: async (input: Input, options?: TurnOptions) => {
        this.runStreamedCalls += 1
        const turn = this.turns.shift()
        assert.ok(turn, 'Unexpected Codex turn')
        return { events: turn(input, options) }
      },
      // Title generation uses a separate read-only thread. Keep it independent
      // from the queued conversation factories so tests can assert its timing.
      run: async () => ({
        items: [],
        finalResponse:
          options?.sandboxMode === 'read-only' ? 'Generated Chat Title' : '',
        usage: null
      })
    } as unknown as Thread
  }

  resumeThread(id: string, options?: ThreadOptions): Thread {
    this.resumeCalls.push({ id, options })
    return this.thread(options)
  }

  startThread(options?: ThreadOptions): Thread {
    this.startCalls.push({ options })
    return this.thread(options)
  }
}

class FakeRolloutWatcher implements CodexRolloutWatcher {
  readonly starts: { parentThreadId: string; sinceMs: number }[] = []
  stopped = false
  private readonly onEvent: (event: CodexRolloutEvent) => void

  constructor(onEvent: (event: CodexRolloutEvent) => void) {
    this.onEvent = onEvent
  }

  start(parentThreadId: string, sinceMs: number): void {
    this.starts.push({ parentThreadId, sinceMs })
    this.stopped = false
  }

  emit(event: CodexRolloutEvent): void {
    this.onEvent(event)
  }

  pollNow(): void {}

  async flush(): Promise<void> {}

  stop(): void {
    this.stopped = true
  }
}

function harness(
  turns: TurnFactory[],
  patch: Partial<ChatData> = {}
): {
  session: CodexSession
  chat: ChatData
  events: ChatEvent[]
  codex: FakeCodex
  watcher: FakeRolloutWatcher
  cwd: string
  saved: string[]
} {
  const cwd = mkdtempSync(join(tmpdir(), 'karbun-codex-test-'))
  const chat: ChatData = {
    id: 'chat-1',
    title: 'Existing chat',
    cwd,
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'low',
    permissionMode: 'default',
    sessionId: 'thread-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    ...patch
  }
  const events: ChatEvent[] = []
  const saved: string[] = []
  const store = {
    saveChat: (id: string) => saved.push(id),
    saveChatSoon: (id: string) => saved.push(id),
    markMessageDirty: () => {}
  } as unknown as Store
  const codex = new FakeCodex(turns)
  let watcher!: FakeRolloutWatcher
  const rolloutWatcherFactory: CodexRolloutWatcherFactory = (onEvent) => {
    watcher = new FakeRolloutWatcher(onEvent)
    return watcher
  }
  const session = new CodexSession(
    chat,
    (event) => events.push(event),
    store,
    () => {},
    codex as unknown as Codex,
    rolloutWatcherFactory
  )
  return { session, chat, events, codex, watcher, cwd, saved }
}

function cleanup(h: { session: CodexSession; cwd: string }): void {
  h.session.dispose()
  rmSync(h.cwd, { recursive: true, force: true })
}

test('a running turn keeps its original model attribution and thread options', async () => {
  const gate = deferred()
  let signal: AbortSignal | undefined
  const h = harness([
    async function* (_input, options) {
      signal = options?.signal
      yield { type: 'thread.started', thread_id: 'thread-1' }
      await gate.promise
      yield {
        type: 'item.completed',
        item: { id: 'answer', type: 'agent_message', text: 'Done.' }
      }
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Do work')
  await waitFor(() => signal != null)
  await h.session.setModel('gpt-5.6-luna')
  gate.resolve()
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(h.codex.resumeCalls[0]?.options?.model, 'gpt-5.6-sol')
  const turn = h.chat.messages.find((message) => message.role === 'event' && message.kind === 'turn')
  assert.equal(turn?.stats?.model, 'gpt-5.6-sol')
  cleanup(h)
})

test('changing permission mode aborts a turn running under the old sandbox', async () => {
  const gate = deferred()
  let signal: AbortSignal | undefined
  const h = harness([
    async function* (_input, options) {
      signal = options?.signal
      yield { type: 'thread.started', thread_id: 'thread-1' }
      await gate.promise
      if (signal?.aborted) throw new Error('aborted')
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Potentially edit files')
  await waitFor(() => signal != null)
  await h.session.setPermissionMode('plan')

  assert.equal(signal?.aborted, true)
  gate.resolve()
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))
  assert.equal(h.events.some((event) => event.type === 'permission-request'), false)
  cleanup(h)
})

test('interrupt cleans queued attachment temps and waits for active cleanup before idle', async () => {
  const gate = deferred()
  let signal: AbortSignal | undefined
  const h = harness([
    async function* (_input, options) {
      signal = options?.signal
      yield { type: 'thread.started', thread_id: 'thread-1' }
      await gate.promise
      if (signal?.aborted) throw new Error('aborted')
      yield { type: 'turn.completed', usage }
    }
  ])
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('karbun-codex-')))

  h.session.send('First')
  await waitFor(() => signal != null)
  h.session.send('Queued image', [
    {
      id: 'image-1',
      kind: 'image',
      name: 'pixel.png',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo='
    }
  ])
  const created = readdirSync(tmpdir()).filter(
    (name) => name.startsWith('karbun-codex-') && !before.has(name)
  )
  assert.equal(created.length, 1)

  await h.session.interrupt()
  assert.equal(existsSync(join(tmpdir(), created[0])), false)
  assert.notEqual(h.events.at(-1)?.type === 'status' && h.events.at(-1).status, 'idle')

  gate.resolve()
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))
  cleanup(h)
})

test('a pending plan is persisted and can be approved by a recreated session', async () => {
  const first = harness(
    [
      async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' }
        yield {
          type: 'item.completed',
          item: {
            id: 'plan',
            type: 'agent_message',
            text: '<proposed_plan>\n1. Edit the file.\n</proposed_plan>'
          }
        }
        yield { type: 'turn.completed', usage }
      }
    ],
    { permissionMode: 'plan', modeBeforePlan: 'default' }
  )

  first.session.send('Make a plan')
  await waitFor(() => first.chat.pendingPlanReview != null)
  const review = first.chat.pendingPlanReview
  assert.equal(review?.plan, '1. Edit the file.')
  first.session.dispose()
  assert.deepEqual(first.chat.pendingPlanReview, review)

  const events: ChatEvent[] = []
  const store = {
    saveChat: () => {},
    saveChatSoon: () => {},
    markMessageDirty: () => {}
  } as unknown as Store
  const codex = new FakeCodex([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      yield {
        type: 'item.completed',
        item: { id: 'answer', type: 'agent_message', text: 'Implemented.' }
      }
      yield { type: 'turn.completed', usage }
    }
  ])
  const resumed = new CodexSession(
    first.chat,
    (event) => events.push(event),
    store,
    () => {},
    codex as unknown as Codex
  )
  resumed.respondPermission(review!.requestId, {
    behavior: 'allow',
    model: 'gpt-5.6-terra',
    effort: 'ultra'
  })
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(first.chat.pendingPlanReview, undefined)
  assert.equal(first.chat.permissionMode, 'default')
  assert.equal(first.chat.model, 'gpt-5.6-terra')
  assert.equal(first.chat.effort, 'ultra')
  assert.equal(codex.resumeCalls[0]?.options?.model, 'gpt-5.6-terra')
  assert.equal(codex.resumeCalls[0]?.options?.modelReasoningEffort, 'ultra')
  resumed.dispose()
  rmSync(first.cwd, { recursive: true, force: true })
})

test('missing persisted threads retry the same turn once on a fresh thread', async () => {
  const h = harness([
    async function* () {
      throw new Error(
        'thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000'
      )
    },
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-fresh' }
      yield {
        type: 'item.completed',
        item: { id: 'answer', type: 'agent_message', text: 'Recovered.' }
      }
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Retry me')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(h.codex.resumeCalls.length, 1)
  assert.equal(h.codex.startCalls.length, 1)
  assert.equal(h.chat.sessionId, 'thread-fresh')
  assert.equal(h.chat.messages.filter((message) => message.role === 'user').length, 1)
  assert.equal(
    h.chat.messages.some(
      (message) =>
        message.role === 'event' &&
        message.kind === 'info' &&
        message.text.includes('started a fresh Codex session')
    ),
    true
  )
  cleanup(h)
})

test('a terminal-event-less stream retries the same prompt once before any item', async () => {
  const h = harness(
    [
      async function* () {
        yield { type: 'thread.started', thread_id: 'thread-fresh' }
      },
      async function* () {
        yield {
          type: 'item.completed',
          item: { id: 'answer', type: 'agent_message', text: 'Recovered.' }
        }
        yield { type: 'turn.completed', usage }
      }
    ],
    { sessionId: undefined, title: '' }
  )

  h.session.send('Do not lose me')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(h.codex.runStreamedCalls, 2)
  assert.equal(h.chat.messages.filter((message) => message.role === 'user').length, 1)
  assert.equal(
    h.chat.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some((part) => part?.type === 'text' && part.text === 'Recovered.')
    ),
    true
  )
  assert.equal(
    h.chat.messages.some((message) => message.role === 'event' && message.kind === 'error'),
    false
  )
  cleanup(h)
})

test('a truncated stream after an item fails loudly without retrying side effects', async () => {
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'touch changed.txt',
          aggregated_output: '',
          status: 'in_progress'
        }
      }
    }
  ])

  h.session.send('Make a change')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(h.codex.runStreamedCalls, 1)
  assert.equal(
    h.chat.messages.some(
      (message) =>
        message.role === 'event' &&
        message.kind === 'error' &&
        message.text.includes('output above may be incomplete')
    ),
    true
  )
  const assistant = h.chat.messages.find((message) => message.role === 'assistant')
  const tool = assistant?.parts.find((part) => part?.type === 'tool')
  assert.equal(tool?.type === 'tool' ? tool.status : undefined, 'error')
  cleanup(h)
})

test('two pre-item truncations report that the prompt was not processed', async () => {
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
    },
    async function* () {}
  ])

  h.session.send('Retry only once')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  assert.equal(h.codex.runStreamedCalls, 2)
  assert.equal(
    h.chat.messages.some(
      (message) =>
        message.role === 'event' &&
        message.kind === 'error' &&
        message.text.includes('It was not processed')
    ),
    true
  )
  cleanup(h)
})

test('AI title generation waits for the first substantive conversation item', async () => {
  const beforeItem = deferred()
  const afterItem = deferred()
  const h = harness(
    [
      async function* () {
        yield { type: 'thread.started', thread_id: 'thread-fresh' }
        yield { type: 'turn.started' }
        await beforeItem.promise
        yield {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'git status',
            aggregated_output: '',
            status: 'in_progress'
          }
        }
        await afterItem.promise
        yield {
          type: 'item.completed',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'git status',
            aggregated_output: '',
            exit_code: 0,
            status: 'completed'
          }
        }
        yield { type: 'turn.completed', usage }
      }
    ],
    { sessionId: undefined, title: '' }
  )

  h.session.send('Inspect the repository')
  await waitFor(() => h.codex.runStreamedCalls === 1)
  assert.equal(h.codex.startCalls.some((call) => call.options?.sandboxMode === 'read-only'), false)

  beforeItem.resolve()
  await waitFor(() =>
    h.codex.startCalls.some((call) => call.options?.sandboxMode === 'read-only')
  )
  afterItem.resolve()
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))
  cleanup(h)
})

test('an itemless completed turn still starts AI title generation', async () => {
  const h = harness(
    [
      async function* () {
        yield { type: 'thread.started', thread_id: 'thread-fresh' }
        yield { type: 'turn.completed', usage }
      }
    ],
    { sessionId: undefined, title: '' }
  )

  h.session.send('A silent request')
  await waitFor(() =>
    h.codex.startCalls.some((call) => call.options?.sandboxMode === 'read-only')
  )
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))
  cleanup(h)
})

test('streamed item lifecycle updates one tool part in place', async () => {
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: '',
          status: 'in_progress'
        }
      }
      yield {
        type: 'item.updated',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'running',
          status: 'in_progress'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'passed',
          exit_code: 0,
          status: 'completed'
        }
      }
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Test it')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  const assistant = h.chat.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant?.parts.length, 1)
  assert.deepEqual(assistant?.parts[0], {
    type: 'tool',
    toolUseId: 'cmd-1',
    name: 'Bash',
    input: { command: 'npm test' },
    output: 'passed',
    status: 'success'
  })
  cleanup(h)
})

test('Codex collaboration items render and update one Agent card', async () => {
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      yield {
        type: 'item.started',
        item: {
          id: 'collab-1',
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          sender_thread_id: 'thread-1',
          receiver_thread_ids: ['child-1'],
          prompt: 'Inspect the renderer',
          agents_states: { 'child-1': { status: 'running', message: null } },
          status: 'in_progress'
        }
      } as unknown as ThreadEvent
      yield {
        type: 'item.completed',
        item: {
          id: 'collab-2',
          type: 'collab_tool_call',
          tool: 'wait',
          sender_thread_id: 'thread-1',
          receiver_thread_ids: ['child-1'],
          prompt: null,
          agents_states: { 'child-1': { status: 'completed', message: 'Renderer inspected.' } },
          status: 'completed'
        }
      } as unknown as ThreadEvent
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Delegate the inspection')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  const assistant = h.chat.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant?.parts.length, 1)
  assert.deepEqual(assistant?.parts[0], {
    type: 'tool',
    toolUseId: 'codex-agent-child-1',
    name: 'Agent',
    input: {
      subagent_type: 'Codex',
      description: 'Inspect the renderer',
      agent_id: 'child-1'
    },
    status: 'success',
    children: [],
    output: 'Renderer inspected.'
  })
  cleanup(h)
})

test('rollout activity streams child text and tools into the Codex Agent card', async () => {
  const gate = deferred()
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      await gate.promise
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Use a sub-agent')
  await waitFor(() => h.watcher.starts.length > 0)
  h.watcher.emit({
    type: 'agent-start',
    threadId: 'child-2',
    callId: 'spawn-2',
    name: 'renderer scan'
  })
  assert.deepEqual(
    h.events.filter((event) => event.type === 'background-jobs').at(-1),
    {
      type: 'background-jobs',
      chatId: 'chat-1',
      jobs: [
        {
          id: 'child-2',
          type: 'subagent',
          description: 'renderer scan',
          stoppable: false
        }
      ]
    }
  )
  h.watcher.emit({ type: 'agent-text', threadId: 'child-2', text: 'Inspecting components.' })
  h.watcher.emit({
    type: 'agent-tool-start',
    threadId: 'child-2',
    toolUseId: 'tool-2',
    name: 'Bash',
    input: { command: 'rg --files src/renderer' }
  })
  h.watcher.emit({
    type: 'agent-tool-complete',
    threadId: 'child-2',
    toolUseId: 'tool-2',
    output: 'src/renderer/src/App.tsx',
    failed: false
  })
  h.watcher.emit({
    type: 'agent-complete',
    threadId: 'child-2',
    result: 'Renderer scan complete.',
    failed: false
  })
  assert.deepEqual(
    h.events.filter((event) => event.type === 'background-jobs').at(-1),
    { type: 'background-jobs', chatId: 'chat-1', jobs: [] }
  )
  gate.resolve()
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  const assistant = h.chat.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant?.parts.length, 1)
  const agent = assistant?.parts[0]
  assert.equal(agent?.type, 'tool')
  if (agent?.type !== 'tool') assert.fail('Expected an Agent tool part')
  assert.equal(agent.name, 'Agent')
  assert.equal(agent.status, 'success')
  assert.equal(agent.output, 'Renderer scan complete.')
  assert.deepEqual(agent.children, [
    { type: 'text', text: 'Inspecting components.' },
    {
      type: 'tool',
      toolUseId: 'child-2:tool-2',
      name: 'Bash',
      input: { command: 'rg --files src/renderer' },
      status: 'success',
      output: 'src/renderer/src/App.tsx'
    }
  ])
  cleanup(h)
})

test('unfinished Codex agents are explained as interrupted when the parent turn ends', async () => {
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      h.watcher.emit({
        type: 'agent-start',
        threadId: 'child-aborted',
        callId: 'spawn-aborted',
        name: 'background scan'
      })
      yield { type: 'turn.completed', usage }
    }
  ])

  h.session.send('Launch an agent and return')
  await waitFor(() => h.events.some((event) => event.type === 'status' && event.status === 'idle'))

  const assistant = h.chat.messages.find((message) => message.role === 'assistant')
  const agent = assistant?.parts.find(
    (part) => part?.type === 'tool' && part.name === 'Agent'
  )
  assert.equal(agent?.type, 'tool')
  if (agent?.type !== 'tool') assert.fail('Expected an Agent tool part')
  assert.equal(agent.status, 'error')
  assert.match(agent.output ?? '', /parent Codex turn ended before it finished/)
  assert.deepEqual(
    h.events.filter((event) => event.type === 'background-jobs').at(-1),
    { type: 'background-jobs', chatId: 'chat-1', jobs: [] }
  )
  cleanup(h)
})

test('generated images surface at the session boundary only when newly created', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'karbun-codex-home-'))
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  const image = join(codexHome, 'generated_images', 'thread-images', 'result.png')
  const h = harness([
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-images' }
      mkdirSync(join(codexHome, 'generated_images', 'thread-images'), { recursive: true })
      writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'))
      yield { type: 'turn.completed', usage }
    },
    async function* () {
      yield { type: 'thread.started', thread_id: 'thread-images' }
      yield { type: 'turn.completed', usage }
    }
  ])

  try {
    h.session.send('Generate an image')
    await waitFor(
      () =>
        h.events.filter((event) => event.type === 'status' && event.status === 'idle').length === 1
    )
    const assistantsAfterFirst = h.chat.messages.filter((message) => message.role === 'assistant')
    assert.equal(assistantsAfterFirst.length, 1)
    assert.equal(assistantsAfterFirst[0].parts[0]?.type, 'text')
    assert.match(
      assistantsAfterFirst[0].parts[0]?.type === 'text'
        ? assistantsAfterFirst[0].parts[0].text
        : '',
      /result\.png/
    )

    h.session.send('Do not regenerate it')
    await waitFor(
      () =>
        h.events.filter((event) => event.type === 'status' && event.status === 'idle').length === 2
    )
    assert.equal(h.chat.messages.filter((message) => message.role === 'assistant').length, 1)
  } finally {
    cleanup(h)
    rmSync(codexHome, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
  }
})

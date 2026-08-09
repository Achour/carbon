import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatData, ChatEvent, PermissionRequestPayload } from '../src/shared/types.ts'
import type { Store } from '../src/main/store.ts'
import { OpencodeSession } from '../src/main/opencode.ts'
import type {
  OpencodeClientLike,
  OpencodeEvent,
  OpencodePromptBody,
  OpencodeSessionCreate
} from '../src/main/opencodeServer.ts'

/**
 * OpencodeSession driven by a scripted client — no server, no binary.
 *
 * The behaviours pinned here are the ones that only show up under timing: that a
 * send waiting on a handoff brief cannot be overtaken, that interrupt drops a
 * queued turn instead of running it later, and that a disposed session emits
 * nothing however late its events arrive.
 */

async function waitFor(predicate: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Timed out waiting for ${what}`)
}

/**
 * The title and handoff one-shots run on the *same* client, each on a throwaway
 * session titled 'Carbon internal'. The fake separates them so a test asserting
 * on "the second turn" isn't really looking at a title prompt.
 */
const INTERNAL_TITLE = 'Carbon internal'

class FakeOpencode implements OpencodeClientLike {
  readonly created: OpencodeSessionCreate[] = []
  readonly allPrompts: { sessionID: string; body: OpencodePromptBody }[] = []
  readonly replies: { permissionID: string; reply: string; message?: string }[] = []
  readonly aborted: string[] = []
  readonly deleted: string[] = []
  handler: ((event: OpencodeEvent) => void) | null = null
  providers: unknown = { providers: [] }
  private readonly internal = new Set<string>()
  /** Resolvers for in-flight *turn* prompts, so a test decides when one ends. */
  private finishers: (() => void)[] = []
  private nextId = 1

  /** Sessions the chat itself opened, excluding one-shots. */
  get sessions(): OpencodeSessionCreate[] {
    return this.created.filter((c) => c.title !== INTERNAL_TITLE)
  }

  /** Prompts belonging to real turns, excluding one-shots. */
  get prompts(): { sessionID: string; body: OpencodePromptBody }[] {
    return this.allPrompts.filter((p) => !this.internal.has(p.sessionID))
  }

  async createSession(opts: OpencodeSessionCreate): Promise<{ id: string }> {
    this.created.push(opts)
    const id = `ses_${this.nextId++}`
    if (opts.title === INTERNAL_TITLE) this.internal.add(id)
    return { id }
  }

  async prompt(sessionID: string, body: OpencodePromptBody): Promise<unknown> {
    this.allPrompts.push({ sessionID, body })
    // One-shots resolve immediately; a real turn waits for the test.
    if (this.internal.has(sessionID)) return { parts: [{ type: 'text', text: 'Title' }] }
    return await new Promise((resolve) => {
      this.finishers.push(() => resolve({ parts: [{ type: 'text', text: 'done' }] }))
    })
  }

  /** End the oldest in-flight turn, the way the real POST resolving does. */
  finishTurn(): void {
    this.finishers.shift()?.()
  }

  async abort(sessionID: string): Promise<void> {
    this.aborted.push(sessionID)
  }

  async replyPermission(permissionID: string, reply: string, message?: string): Promise<void> {
    this.replies.push({ permissionID, reply, message })
  }

  async listMessages(): Promise<{ parts?: never[] }[]> {
    return []
  }

  async listProviders(): Promise<unknown> {
    return this.providers
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.deleted.push(sessionID)
  }

  subscribe(_sessionID: string, handler: (event: OpencodeEvent) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }

  emit(event: OpencodeEvent): void {
    this.handler?.(event)
  }
}

function makeChat(overrides: Partial<ChatData> = {}): ChatData {
  return {
    id: 'chat-1',
    title: 'Test',
    cwd: '/tmp/does-not-matter',
    provider: 'opencode',
    permissionMode: 'default',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as ChatData
}

function harness(chat: ChatData = makeChat()): {
  session: OpencodeSession
  client: FakeOpencode
  events: ChatEvent[]
  chat: ChatData
} {
  const events: ChatEvent[] = []
  const store = {
    saveChat: () => {},
    saveChatSoon: () => {},
    markMessageDirty: () => {},
    hiddenBefore: () => 0
  } as unknown as Store
  const client = new FakeOpencode()
  const session = new OpencodeSession(chat, (e) => events.push(e), store, () => {}, client)
  return { session, client, events, chat }
}

function statuses(events: ChatEvent[]): string[] {
  return events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status)
}

function permissionRequests(events: ChatEvent[]): PermissionRequestPayload[] {
  return events
    .filter((e) => e.type === 'permission-request')
    .map((e) => (e as { request: PermissionRequestPayload }).request)
}

test('a send echoes the user message and locks the composer before the turn starts', async () => {
  const { session, client, events, chat } = harness()
  session.send('hello')

  // The echo is synchronous: the user must never watch their own message appear.
  assert.equal(chat.messages[0].role, 'user')
  assert.equal(statuses(events)[0], 'starting')

  await waitFor(() => client.prompts.length === 1, 'the prompt to be sent')
  client.finishTurn()
  await waitFor(() => statuses(events).at(-1) === 'idle', 'the turn to finish')
})

test('a turn waiting on a handoff brief cannot be overtaken by a later send', async () => {
  const { session, client } = harness()
  let releaseBrief!: (v: string) => void
  const brief = new Promise<string>((resolve) => {
    releaseBrief = resolve
  })

  session.send('first', [], undefined, brief)
  session.send('second')
  // Nothing may reach the server while the first turn's context is unresolved.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(client.prompts.length, 0)

  releaseBrief('CONTEXT')
  await waitFor(() => client.prompts.length === 1, 'the first turn')
  const firstText = client.prompts[0].body.parts[0].text ?? ''
  assert.match(firstText, /CONTEXT/, 'the brief rides the prompt')
  assert.match(firstText, /first/)

  client.finishTurn()
  await waitFor(() => client.prompts.length === 2, 'the second turn')
  assert.match(client.prompts[1].body.parts[0].text ?? '', /second/)
  // The brief is prepended to the model's prompt only, never to the transcript.
  assert.doesNotMatch(client.prompts[1].body.parts[0].text ?? '', /CONTEXT/)
})

test('text deltas append to the stored part, and a full part supersedes them', async () => {
  const { session, client, events, chat } = harness()
  session.send('hi')
  await waitFor(() => client.prompts.length === 1)

  client.emit({ type: 'message.part.updated', part: { id: 'p1', type: 'text', text: '' } })
  client.emit({ type: 'message.part.delta', partID: 'p1', field: 'text', delta: 'Hel' })
  client.emit({ type: 'message.part.delta', partID: 'p1', field: 'text', delta: 'lo' })

  const assistant = chat.messages.find((m) => m.role === 'assistant')
  assert.ok(assistant)
  // The stored transcript tracks the deltas, so a reload mid-stream matches.
  assert.deepEqual(assistant.parts[0], { type: 'text', text: 'Hello' })

  client.emit({ type: 'message.part.updated', part: { id: 'p1', type: 'text', text: 'Hello there' } })
  assert.deepEqual(assistant.parts[0], { type: 'text', text: 'Hello there' })
  assert.ok(events.some((e) => e.type === 'part'), 'an authoritative part is emitted')

  client.finishTurn()
})

test('the echoed user prompt is not rendered again as assistant prose', async () => {
  const { session, client, chat } = harness()
  session.send('do the thing')
  await waitFor(() => client.prompts.length === 1)

  // The server replays the user's own message as a text part on a user-role
  // message. Rendering it would show every turn's prompt twice.
  client.emit({ type: 'message.updated', messageID: 'msg_user', role: 'user' })
  client.emit({
    type: 'message.part.updated',
    part: { id: 'p-user', messageID: 'msg_user', type: 'text', text: 'do the thing' }
  })
  client.emit({ type: 'message.updated', messageID: 'msg_asst', role: 'assistant' })
  client.emit({
    type: 'message.part.updated',
    part: { id: 'p-asst', messageID: 'msg_asst', type: 'text', text: 'Did it.' }
  })

  const assistants = chat.messages.filter((m) => m.role === 'assistant')
  const texts = assistants.flatMap((m) => m.parts.map((p) => (p?.type === 'text' ? p.text : '')))
  assert.deepEqual(texts.filter(Boolean), ['Did it.'])
  assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1)

  client.finishTurn()
})

test('a tool part updates in place across its lifecycle rather than stacking cards', async () => {
  const { session, client, chat } = harness()
  session.send('write a file')
  await waitFor(() => client.prompts.length === 1)

  for (const state of [
    { status: 'pending', input: {} },
    { status: 'running', input: { filePath: 'a.txt' } },
    { status: 'completed', input: { filePath: 'a.txt' }, output: 'Wrote file successfully.' }
  ]) {
    client.emit({
      type: 'message.part.updated',
      part: { id: 'tool-1', type: 'tool', tool: 'write', callID: 'call-1', state }
    })
  }

  const assistant = chat.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant?.parts.length, 1, 'one card, not three')
  const part = assistant!.parts[0]
  assert.equal(part.type, 'tool')
  if (part.type !== 'tool') return
  assert.equal(part.name, 'Write')
  assert.equal(part.status, 'success')
  assert.equal(part.output, 'Wrote file successfully.')

  client.finishTurn()
})

test('a permission request surfaces as a card and its answer reaches the server', async () => {
  const { session, client, events } = harness()
  session.send('edit something')
  await waitFor(() => client.prompts.length === 1)

  client.emit({
    type: 'permission.asked',
    request: {
      id: 'per_1',
      permission: 'edit',
      patterns: ['a.txt'],
      metadata: { diff: '--- a\n+++ b\n+x' },
      always: ['*'],
      tool: { callID: 'call-1' }
    }
  })
  const [request] = permissionRequests(events)
  assert.equal(request.toolName, 'Edit')
  assert.equal(request.hasSuggestions, true)
  assert.equal(statuses(events).at(-1), 'waiting-permission')

  session.respondPermission('per_1', { behavior: 'allow', always: true })
  assert.deepEqual(client.replies, [{ permissionID: 'per_1', reply: 'always', message: undefined }])
  assert.ok(events.some((e) => e.type === 'permission-resolved'))

  client.finishTurn()
})

test('a denial carries its message through as OpenCode has no "deny always"', async () => {
  const { session, client, events } = harness()
  session.send('rm -rf')
  await waitFor(() => client.prompts.length === 1)
  client.emit({ type: 'permission.asked', request: { id: 'per_2', permission: 'bash' } })
  await waitFor(() => permissionRequests(events).length === 1)

  session.respondPermission('per_2', { behavior: 'deny', message: 'not that' })
  assert.deepEqual(client.replies, [{ permissionID: 'per_2', reply: 'reject', message: 'not that' }])
  client.finishTurn()
})

test('full access answers permissions itself and never draws a card', async () => {
  const { session, client, events } = harness(makeChat({ permissionMode: 'bypassPermissions' }))
  session.send('do it')
  await waitFor(() => client.prompts.length === 1)

  // The session ruleset already allows everything; anything that still asks is
  // answered silently, because the mode promises not to interrupt.
  assert.ok(client.sessions[0].permission?.every((r) => r.action === 'allow'))
  client.emit({ type: 'permission.asked', request: { id: 'per_3', permission: 'bash' } })
  await waitFor(() => client.replies.length === 1, 'the silent reply')
  assert.equal(client.replies[0].reply, 'once')
  assert.equal(permissionRequests(events).length, 0, 'no card is drawn')

  client.finishTurn()
})

test('plan mode runs the plan agent and ends in a review, not a finished turn', async () => {
  const chat = makeChat({ permissionMode: 'plan' })
  const { session, client, events } = harness(chat)
  session.send('plan it')
  await waitFor(() => client.prompts.length === 1)
  assert.equal(client.sessions[0].agent, 'plan')
  assert.equal(client.prompts[0].body.agent, 'plan')

  client.emit({
    type: 'message.part.updated',
    part: { id: 'p1', type: 'text', text: '# Plan\n1. do the thing' }
  })
  client.finishTurn()

  await waitFor(
    () => permissionRequests(events).some((r) => r.toolName === 'ExitPlanMode'),
    'the plan review'
  )
  // Persisted, so the review survives a restart.
  assert.ok(chat.pendingPlanReview?.plan.includes('do the thing'))
  // A chat parked on a review must not look idle, or the LRU would evict it.
  assert.equal(session.idle, false)
})

test('approving a plan restores the mode and rebuilds the session with a new ruleset', async () => {
  const chat = makeChat({ permissionMode: 'plan', modeBeforePlan: 'acceptEdits' })
  const { session, client, chat: live } = harness(chat)
  session.send('plan it')
  await waitFor(() => client.prompts.length === 1)
  client.emit({ type: 'message.part.updated', part: { id: 'p1', type: 'text', text: 'THE PLAN' } })
  client.finishTurn()
  await waitFor(() => !!live.pendingPlanReview, 'the review')

  session.respondPermission(live.pendingPlanReview!.requestId, { behavior: 'allow' })
  await waitFor(() => client.prompts.length === 2, 'the implementation turn')

  assert.equal(live.permissionMode, 'acceptEdits')
  assert.equal(live.pendingPlanReview, undefined)
  assert.match(client.prompts[1].body.parts[0].text ?? '', /<approved_plan>\nTHE PLAN/)
  // A ruleset is fixed at session creation, so leaving plan mode needs a new
  // session — the old one would go on denying every edit.
  assert.equal(client.sessions.length, 2)
  assert.equal(client.sessions[1].agent, undefined)
  assert.equal(client.sessions[1].permission?.find((r) => r.permission === 'edit')?.action, 'allow')
})

test('rejecting a plan with notes stays in plan mode and asks again', async () => {
  const chat = makeChat({ permissionMode: 'plan' })
  const { session, client, chat: live } = harness(chat)
  session.send('plan it')
  await waitFor(() => client.prompts.length === 1)
  client.emit({ type: 'message.part.updated', part: { id: 'p1', type: 'text', text: 'THE PLAN' } })
  client.finishTurn()
  await waitFor(() => !!live.pendingPlanReview, 'the review')

  session.respondPermission(live.pendingPlanReview!.requestId, {
    behavior: 'deny',
    message: 'use fewer files'
  })
  await waitFor(() => client.prompts.length === 2, 'the revision turn')
  assert.equal(live.permissionMode, 'plan')
  assert.match(client.prompts[1].body.parts[0].text ?? '', /<plan_feedback>\nuse fewer files/)
})

test('interrupt drops a queued turn instead of running it afterwards', async () => {
  const { session, client, events } = harness()
  let release!: (v: string) => void
  const blocked = new Promise<string>((resolve) => {
    release = resolve
  })
  session.send('queued', [], undefined, blocked)

  await session.interrupt()
  release('ctx')
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(client.prompts.length, 0, 'a swept turn is dropped, never sent later')
  assert.equal(statuses(events).at(-1), 'idle')
})

test('interrupt denies an outstanding permission rather than stranding it', async () => {
  const { session, client, events } = harness()
  session.send('go')
  await waitFor(() => client.prompts.length === 1)
  client.emit({ type: 'permission.asked', request: { id: 'per_9', permission: 'bash' } })
  await waitFor(() => permissionRequests(events).length === 1)

  await session.interrupt()
  assert.equal(client.replies[0].reply, 'reject')
  assert.ok(events.some((e) => e.type === 'permission-resolved'))
})

test('a disposed session emits nothing, however late its events arrive', async () => {
  const { session, client, events } = harness()
  session.send('go')
  await waitFor(() => client.prompts.length === 1)
  session.dispose()

  const after = events.length
  client.emit({ type: 'message.part.updated', part: { id: 'p1', type: 'text', text: 'ignored' } })
  client.emit({ type: 'session.idle' })
  client.finishTurn()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(events.length, after, 'no event may be emitted after dispose')
  assert.equal(session.dead, true)
})

test('a resumed chat adopts its persisted plan review and stays un-evictable', () => {
  const chat = makeChat({
    sessionId: 'ses_prev',
    pendingPlanReview: { requestId: 'opencode-plan-x', plan: 'THE PLAN', userMessageId: 'u1' }
  })
  const { session } = harness(chat)
  assert.equal(session.idle, false)
  assert.equal(session.pendingPlan('opencode-plan-x'), 'THE PLAN')
  assert.equal(session.pendingPlan('something-else'), null)
})

test('the session exposes no service tier, which is how the manager knows to respawn', () => {
  const { session } = harness()
  // ChatManager gates its live tier switch on the method existing; its absence
  // is the capability flag, so this is load-bearing rather than an omission.
  assert.equal((session as { setServiceTier?: unknown }).setServiceTier, undefined)
})

test('the chosen effort rides the turn as OpenCode’s variant', async () => {
  const { session, client } = harness(makeChat({ effort: 'high' }))
  session.send('go')
  await waitFor(() => client.prompts.length === 1)
  assert.equal(client.prompts[0].body.variant, 'high')
  client.finishTurn()
})

test('the Default effort sends no variant, leaving the model’s own', async () => {
  const { session, client } = harness(makeChat())
  session.send('go')
  await waitFor(() => client.prompts.length === 1)
  assert.equal(client.prompts[0].body.variant, undefined)
  client.finishTurn()
})

test('a turn keeps the effort it was sent with, not a later change', async () => {
  const { session, client } = harness(makeChat({ effort: 'low' }))
  let release!: (v: string) => void
  const brief = new Promise<string>((r) => {
    release = r
  })
  session.send('first', [], undefined, brief)
  // Changing effort mid-flight must not rewrite a turn already committed.
  await session.setModel('opencode:openai/gpt-5.6-luna')
  release('ctx')
  await waitFor(() => client.prompts.length === 1)
  assert.equal(client.prompts[0].body.variant, 'low')
  client.finishTurn()
})

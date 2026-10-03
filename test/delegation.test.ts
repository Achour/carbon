import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { ChatMessage } from '../src/shared/types.ts'
import {
  DELEGATION_TASK_CAP,
  deliveryLabel,
  deliveryText,
  delegationOutcome,
  delegationResult,
  autoName,
  isAgentsSideEffect,
  resolveDelegate,
  runAgentsTool,
  slugName,
  validateDelegateRequest,
  type AgentsToolHost,
  type DelegationView
} from '../src/main/delegation.ts'

const user = (text: string): ChatMessage => ({ id: `u-${text}`, role: 'user', text, ts: 0 })
const said = (...texts: string[]): ChatMessage => ({
  id: `a-${texts.join()}`,
  role: 'assistant',
  ts: 0,
  parts: texts.map((t) => ({ type: 'text' as const, text: t }))
})
const toolOnly = (): ChatMessage => ({
  id: 'a-tool',
  role: 'assistant',
  ts: 0,
  parts: [{ type: 'tool', id: 't', name: 'Read', input: {}, status: 'done' } as never]
})
const error = (text: string): ChatMessage => ({ id: `e-${text}`, role: 'event', kind: 'error', text, ts: 0 })

const none = (): undefined => undefined

test('validate: refuses an empty task, an unknown or unavailable provider', () => {
  assert.deepEqual(validateDelegateRequest({ task: '  ', provider: 'codex' }, ['codex'], none), {
    ok: false,
    error: 'task is required.'
  })
  const unknown = validateDelegateRequest({ task: 'x', provider: 'gemini' }, ['codex'], none)
  assert.equal(unknown.ok, false)
  const missing = validateDelegateRequest({ task: 'x', provider: 'grok' }, ['codex'], none)
  assert.equal(missing.ok, false)
  assert.match((missing as { error: string }).error, /not available.*Available: codex/)
})

test('validate: a task over the cap is refused rather than truncated', () => {
  const r = validateDelegateRequest(
    { task: 'x'.repeat(DELEGATION_TASK_CAP + 1), provider: 'codex' },
    ['codex'],
    none
  )
  assert.equal(r.ok, false)
})

test('validate: a model certainly owned by another provider is refused; an unplaced one passes', () => {
  const owner = (m: string): 'claude' | undefined => (m.startsWith('claude') ? 'claude' : undefined)
  const foreign = validateDelegateRequest(
    { task: 'x', provider: 'codex', model: 'claude-opus-5' },
    ['codex', 'claude'],
    owner
  )
  assert.equal(foreign.ok, false)
  const unplaced = validateDelegateRequest(
    { task: 'x', provider: 'Codex', model: 'gpt-next', role: ' review ' },
    ['codex'],
    owner
  )
  assert.deepEqual(unplaced, {
    ok: true,
    request: { task: 'x', provider: 'codex', model: 'gpt-next', role: 'review', name: 'codex-a' }
  })
})

test('names: automatic per provider in letters, given ones slugged and unique', () => {
  assert.equal(autoName('codex', []), 'codex-a')
  assert.equal(autoName('codex', ['codex-a', 'claude-a']), 'codex-b')
  assert.equal(autoName('claude', ['codex-a', 'codex-b']), 'claude-a')
  const many = Array.from({ length: 26 }, (_, i) => `grok-${String.fromCharCode(97 + i)}`)
  assert.equal(autoName('grok', many), 'grok-aa')
  assert.equal(slugName('  Math Reviewer_2! '), 'math-reviewer-2')
  const second = validateDelegateRequest({ task: 'x', provider: 'codex' }, ['codex'], none, ['codex-a'])
  assert.equal(second.ok && second.request.name, 'codex-b')
  const named = validateDelegateRequest({ task: 'x', provider: 'codex', name: 'Math Reviewer' }, ['codex'], none)
  assert.equal(named.ok && named.request.name, 'math-reviewer')
  // A name already in use points the model at agents_send instead.
  const reused = validateDelegateRequest({ task: 'x', provider: 'codex', name: 'codex-a' }, ['codex'], none, ['codex-a'])
  assert.equal(reused.ok, false)
  assert.match((reused as { error: string }).error, /agents_send with agent "codex-a"/)
  assert.equal(validateDelegateRequest({ task: 'x', provider: 'codex', name: '!!' }, ['codex'], none).ok, false)
})

test('resolve: by id, by name in any spelling, by provider only when unambiguous', () => {
  const v = (id: string, name: string, provider: 'codex' | 'claude'): DelegationView => ({
    id,
    name,
    provider,
    parentId: 'p',
    task: 't',
    status: 'running',
    createdAt: 0
  })
  const views = [v('1', 'codex-a', 'codex'), v('2', 'codex-b', 'codex'), v('3', 'claude-a', 'claude')]
  const pick = (ref: string): string | null => {
    const r = resolveDelegate(views, ref)
    return r.ok ? r.view.id : null
  }
  assert.equal(pick('2'), '2')
  assert.equal(pick('Codex B'), '2')
  assert.equal(pick('codex_a'), '1')
  assert.equal(pick('claude'), '3')
  assert.equal(pick('codex'), null)
  const missing = resolveDelegate(views, 'grok-a')
  assert.match((missing as { error: string }).error, /codex-a, codex-b, claude-a/)
})

test('result: every assistant text since the last prompt, not just the last message', () => {
  const messages = [
    user('old'),
    said('stale answer'),
    user('task'),
    said('Finding one.'),
    toolOnly(),
    said('Finding two.')
  ]
  assert.equal(delegationResult(messages), 'Finding one.\n\nFinding two.')
})

test('result: a round reads from its opening prompt, so a mid-run follow-up keeps the start', () => {
  const opening = user('task')
  const messages = [user('older round'), said('old'), opening, said('Part one.'), user('also check X'), said('Part two.')]
  assert.equal(delegationResult(messages, undefined, opening.id), 'Part one.\n\nPart two.')
  // Without the round's prompt it falls back to the last one.
  assert.equal(delegationResult(messages), 'Part two.')
  assert.equal(delegationOutcome(messages, false, opening.id).result, 'Part one.\n\nPart two.')
})

test('result: an over-long report keeps its end and says what it dropped', () => {
  const out = delegationResult([user('t'), said('a'.repeat(50) + 'END')], 20)
  assert.match(out, /^…\(truncated, 33 earlier characters omitted\)\n/)
  assert.ok(out.endsWith('END'))
})

test('outcome: completed, failed, recovered error, and stopped', () => {
  assert.equal(delegationOutcome([user('t'), said('done')], false).status, 'completed')
  const failed = delegationOutcome([user('t'), said('trying'), error('rate limited')], false)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'rate limited')
  assert.equal(failed.result, 'trying')
  assert.equal(
    delegationOutcome([user('t'), error('transient'), said('recovered')], false).status,
    'completed'
  )
  // An error from an earlier turn is not this turn's outcome.
  assert.equal(delegationOutcome([user('a'), error('old'), user('t'), said('ok')], false).status, 'completed')
  assert.equal(delegationOutcome([user('t'), said('half')], true).status, 'cancelled')
})

test('delivery: never starts with a slash, carries name, id, task, report and how to follow up', () => {
  const view = {
    id: 'c1',
    name: 'codex-a',
    status: 'completed' as const,
    task: '/src/auth.ts review',
    result: 'No bugs.'
  }
  const body = deliveryText('Codex', view)
  assert.ok(!body.startsWith('/'))
  assert.match(body, /^Your agent codex-a \(Codex\) has finished\./)
  assert.match(body, /Agent: codex-a \(id c1\)/)
  assert.match(body, /codex-a's report:\nNo bugs\./)
  assert.match(body, /agents_send with agent "codex-a"/)
  assert.equal(deliveryLabel({ name: 'codex-b', status: 'failed', task: 'a\nb' }), 'codex-b failed · a b')
  // A follow-up round is labelled with its own instruction, not the first task.
  const again = { ...view, followUp: 'also write a test' }
  assert.equal(deliveryLabel(again), 'codex-a finished · also write a test')
  assert.match(deliveryText('Codex', again), /Task: \/src\/auth\.ts review\nFollow-up you sent it: also write a test/)
})

test('side effects: delegate, send and cancel are refused in plan mode, status is not', () => {
  assert.equal(isAgentsSideEffect('delegate'), true)
  assert.equal(isAgentsSideEffect('send'), true)
  assert.equal(isAgentsSideEffect('cancel'), true)
  assert.equal(isAgentsSideEffect('status'), false)
})

test('tools: need a calling chat, and pass the parent through', async () => {
  const seen: string[] = []
  const views: DelegationView[] = [
    {
      id: 'c1',
      name: 'codex-a',
      parentId: 'p',
      provider: 'codex',
      task: 'review',
      status: 'completed',
      result: 'fine',
      createdAt: 0
    }
  ]
  const host: AgentsToolHost = {
    delegate: async (parentId, req) => {
      seen.push(`${parentId}:${req.provider}:${req.name ?? ''}`)
      return { ok: true, id: 'c2', name: 'codex-b', label: 'Codex' }
    },
    send: async (parentId, agent, message) => {
      seen.push(`send ${parentId}:${agent}:${message}`)
      return { ok: true, text: `Sent to ${agent}` }
    },
    list: (parentId) => (parentId === 'p' ? views : []),
    cancel: async (parentId, agent) =>
      parentId === 'p' && agent === 'codex-a' ? { ok: true, text: 'Stopped codex-a.' } : { ok: false, error: 'No such agent.' }
  }
  const ctx = { chatId: 'p', agentLabel: () => 'Codex' }
  const none = await runAgentsTool(host, { ...ctx, chatId: null }, 'status')
  assert.equal(none.isError, true)
  const started = await runAgentsTool(host, ctx, 'delegate', { task: 'x', provider: 'codex', name: 'b' })
  assert.match(started.text, /as "codex-b" \(id c2\)/)
  const sent = await runAgentsTool(host, ctx, 'send', { agent: 'codex-a', message: ' also X ' })
  assert.equal(sent.text, 'Sent to codex-a')
  assert.equal((await runAgentsTool(host, ctx, 'send', { agent: 'codex-a' })).isError, true)
  assert.equal((await runAgentsTool(host, ctx, 'send', { message: 'x' })).isError, true)
  assert.deepEqual(seen, ['p:codex:b', 'send p:codex-a:also X'])
  assert.match((await runAgentsTool(host, ctx, 'status')).text, /^codex-a\tCodex\tcompleted[\s\S]*result:\nfine/)
  assert.match((await runAgentsTool(host, ctx, 'status', { agent: 'Codex A' })).text, /^codex-a/)
  assert.equal((await runAgentsTool(host, ctx, 'status', { agent: 'zz' })).isError, true)
  assert.equal((await runAgentsTool(host, ctx, 'cancel', { agent: 'codex-a' })).text, 'Stopped codex-a.')
  assert.equal((await runAgentsTool(host, { ...ctx, chatId: 'other' }, 'cancel', { agent: 'codex-a' })).isError, true)
})

test('promptReached: only assistant output after the last prompt counts', async () => {
  const { promptReached } = await import('../src/main/delegation.ts')
  assert.equal(promptReached([user('a'), said('x'), user('b')]), false)
  assert.equal(promptReached([user('b'), error('could not start')]), false)
  assert.equal(promptReached([user('b'), toolOnly()]), true)
  assert.equal(promptReached([user('b'), said('  ')]), false)
  assert.equal(promptReached([user('b'), said('ok')]), true)
})

test('promptReached: bound to one prompt, a later answer cannot vouch for it', async () => {
  const { promptReached } = await import('../src/main/delegation.ts')
  const carrier = user('report')
  // The carrying prompt was dropped (session disposed) and the user's next
  // turn was answered: that answer is not the report's.
  assert.equal(promptReached([carrier, user('next'), said('answer')], carrier.id), false)
  assert.equal(promptReached([carrier, said('got it'), user('next')], carrier.id), true)
  assert.equal(promptReached([said('x')], 'missing'), false)
})

test('resolveModel: a nickname finds the catalog id; nothing matching names the real ones', async () => {
  const { resolveModel } = await import('../src/main/delegation.ts')
  const m = (id: string, label: string, provider: 'codex' | 'claude') => ({ id, label, description: '', provider })
  const catalog = [
    m('codex-default', 'Codex (default)', 'codex'),
    m('gpt-6.1-sol', 'GPT-6.1-Sol', 'codex'),
    m('gpt-6.1-terra', 'GPT-6.1-Terra', 'codex'),
    m('gpt-5.6-sol', 'GPT-5.6-Sol', 'codex'),
    m('claude-opus-5', 'Opus 5', 'claude')
  ]
  const pick = (raw: string, p: 'codex' | 'claude' = 'codex') => {
    const r = resolveModel(raw, p, catalog)
    return r.ok ? r.model : r.error
  }
  assert.equal(pick('Sol'), 'gpt-6.1-sol')
  assert.equal(pick('gpt 6.1 sol'), 'gpt-6.1-sol')
  assert.equal(pick('GPT-5.6-Sol'), 'gpt-5.6-sol')
  assert.equal(pick('terra'), 'gpt-6.1-terra')
  assert.equal(pick('opus', 'claude'), 'claude-opus-5')
  assert.match(pick('luna'), /No codex model matches "luna"\. Its models: gpt-6.1-sol, gpt-6.1-terra, gpt-5.6-sol/)
  // A default row's exact id is a real id, though nicknames never land on it.
  assert.equal(pick('codex-default'), 'codex-default')
  // No catalog to check against: passed through rather than refused.
  assert.deepEqual(resolveModel('anything', 'codex', []), { ok: true, model: 'anything' })
})

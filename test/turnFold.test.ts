import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantPart, ChatMessage } from '../src/shared/types.ts'
import { carryDisclosure, foldState, foldTurns, reportedDelegates } from '../src/renderer/src/lib/turnFold.ts'

let clock = 0
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', ts: (clock += 1000) })
const assistant = (id: string, parts: AssistantPart[]): ChatMessage => ({
  id,
  role: 'assistant',
  parts,
  ts: (clock += 1000)
})
const text = (t: string): AssistantPart => ({ type: 'text', text: t })
const thinking = (t: string): AssistantPart => ({ type: 'thinking', text: t })
const tool = (id: string, over: Partial<AssistantPart & { type: 'tool' }> = {}): AssistantPart => ({
  type: 'tool',
  toolUseId: id,
  name: 'Bash',
  status: 'success',
  ...over
})

test('the answer is the trailing text run, across messages', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('let me check')]),
    assistant('a2', [tool('t1')]),
    assistant('a3', [text('done'), text('and here is why')])
  ])
  const fold = folds.get('u1')
  // The preamble folds away with the call it introduces — and is not copied
  // either: the copy is what the folded turn still shows.
  assert.deepEqual(fold?.answerFrom, { messageId: 'a3', partIndex: 0 })
  assert.equal(fold?.answer, 'done\n\nand here is why')
  assert.equal(fold?.collapsible, true)
})

test('the boundary can fall inside one message (Codex accumulates a turn)', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('checking'), tool('t1'), tool('t2'), text('all good')])
  ])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 3 })
  assert.equal(folds.get('u1')?.answer, 'all good')
})

test('a thought with text ends the answer run, a withheld one does not', () => {
  const visible = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1'), thinking('so the fix is…'), text('here it is')])
  ])
  assert.deepEqual(visible.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 2 })

  // Claude withholds the text, so the block draws nothing and decides nothing:
  // the answer still starts at the text part above it.
  const withheld = foldTurns([
    user('u1'),
    assistant('a1', [text('first'), thinking(''), text('second')]),
    assistant('a2', [thinking('')])
  ])
  assert.deepEqual(withheld.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 0 })
  assert.equal(withheld.get('u1')?.answer, 'first\n\nsecond')
  assert.equal(withheld.get('u1')?.collapsible, false)
})

test('a turn that ends on work keeps its last prose and the calls after it', () => {
  // Folding to the header alone hid every word the turn said when its last
  // step happened to be a call — measured at 1-4 trailing calls in practice.
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [tool('t0'), text('found it: the cache key drops the tenant')]),
    assistant('a2', [tool('t1')])
  ])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 1 })
  assert.equal(folds.get('u1')?.answer, 'found it: the cache key drops the tenant')
  assert.equal(folds.get('u1')?.collapsible, true)
})

test('a turn with no prose at all keeps the call it ended on', () => {
  const fold = foldTurns([user('u1'), assistant('a1', [tool('t0')]), assistant('a2', [tool('t1')])]).get('u1')!
  assert.deepEqual(fold.answerFrom, { messageId: 'a2', partIndex: 0 })
  assert.equal(fold.answer, '')
  assert.equal(fold.collapsible, true)
})

test('a turn that only talked hides nothing', () => {
  const folds = foldTurns([user('u1'), assistant('a1', [text('yes')])])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 0 })
  assert.equal(folds.get('u1')?.collapsible, false)
})

test('elapsed runs from the prompt to the turn’s last message, whatever its role', () => {
  clock = 0
  const messages: ChatMessage[] = [
    user('u1'),
    assistant('a1', [text('hi')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: 9000 },
    user('u2')
  ]
  const folds = foldTurns(messages)
  assert.equal(folds.get('u1')?.startTs, 1000)
  assert.equal(folds.get('u1')?.endTs, 9000)
  assert.equal(folds.get('u1')?.replied, true)
  // A prompt with nothing after it yet: no reply, so the header has no settled
  // reading to show and `renderMessages` draws none.
  assert.equal(folds.get('u2')?.replied, false)
  assert.equal(folds.get('u2')?.endTs, folds.get('u2')?.startTs)
})

test('work that outlives the turn keeps the turn open', () => {
  const idle = foldTurns([user('u1'), assistant('a1', [tool('t1'), text('done')])])
  assert.equal(idle.get('u1')?.running, false)

  // A backgrounded job's card stays live past the result (`claude.ts` skips
  // `terminalizeRunning` while one is open).
  const job = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1', { status: 'running' }), text('started it')])
  ])
  assert.equal(job.get('u1')?.running, true)

  // A backgrounded agent's own call returns at spawn; its children keep going.
  const agent = foldTurns([
    user('u1'),
    assistant('a1', [
      tool('t1', {
        name: 'Agent',
        children: [{ type: 'tool', toolUseId: 'c1', name: 'Read', status: 'running' }]
      }),
      text('spawned')
    ])
  ])
  assert.equal(agent.get('u1')?.running, true)
})

test('an interrupted turn dates itself by its last call, not its one message', () => {
  clock = 0
  // Codex accumulates the whole turn into one message, stamped when it opened,
  // and an interrupt closes no event — so the message stamp alone reports 0s.
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('working'), tool('t1', { startedAt: 100_000 })])
  ])
  assert.equal(folds.get('u1')?.startTs, 1000)
  assert.equal(folds.get('u1')?.endTs, 100_000)
})

test('assistant messages before the first prompt belong to no turn', () => {
  // The loaded window can start mid-turn. Those messages get no fold, so they
  // are never folded away behind a header that is not on screen.
  const folds = foldTurns([assistant('a0', [tool('t0')]), user('u1'), assistant('a1', [text('k')])])
  assert.equal(folds.size, 1)
  assert.ok(folds.has('u1'))
})

test('a turn the CLI closed mid-way keeps what it said at each close', () => {
  // `/simplify`: four review agents are spawned in the background, the model
  // says it will wait, and the CLI ends the turn. Each agent's notification
  // then starts a continuation under the *same* prompt, with a `result` — and
  // so a stats row — of its own.
  const event = (id: string): ChatMessage => ({
    id,
    role: 'event',
    kind: 'turn',
    text: '',
    ts: (clock += 1000)
  })
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1', { name: 'Agent' })]),
    assistant('a2', [text('four agents are running, I will apply what they find')]),
    event('e1'),
    assistant('a3', [text('reuse review is in, waiting on three')]),
    event('e2'),
    assistant('a4', [text('all in; here is the result')]),
    event('e3')
  ])
  const fold = folds.get('u1')
  // The last stretch's answer is the turn's own…
  assert.deepEqual(fold?.answerFrom, { messageId: 'a4', partIndex: 0 })
  // …and each earlier stretch keeps what it said when it closed. Dropping
  // those folded a full diagnosis down to a two-line follow-up.
  assert.deepEqual(
    fold?.stretches.map((stretch) => [stretch.closeId, stretch.answerFrom?.messageId]),
    [['e1', 'a2'], ['e2', 'a3'], ['e3', 'a4']]
  )
  assert.equal(
    fold?.answer,
    'four agents are running, I will apply what they find\n\nreuse review is in, waiting on three\n\nall in; here is the result'
  )
  assert.deepEqual(
    foldState(fold!, false).stretches.map((stretch) => stretch.folded),
    [true, true, true]
  )
  assert.equal(fold?.collapsible, true)
  // The interim stats rows fold with the work; the row that closes the turn
  // is not work and stays.
  assert.deepEqual([...(fold?.workEvents ?? [])].sort(), ['e1', 'e2'])
})

test('a turn closed once has no work events, whatever follows its last reply', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1'), text('done')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: (clock += 1000) },
    user('u2')
  ])
  assert.equal(folds.get('u1')?.workEvents.size, 0)
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a1', partIndex: 1 })
})

test('an interim result followed only by work: each stretch folds to what it last showed', () => {
  const fold = foldTurns([
    user('u1'),
    assistant('a1', [text('waiting on the agent')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: (clock += 1000) },
    assistant('a2', [tool('t1')])
  ]).get('u1')!
  assert.equal(fold.collapsible, true)
  assert.ok(fold.workEvents.has('e1'))
  assert.equal(fold.answer, 'waiting on the agent')
  assert.deepEqual(foldState(fold, false).stretches, [
    { folded: true, start: { messageId: 'a1', partIndex: 0 } },
    { folded: true, start: { messageId: 'a2', partIndex: 0 } }
  ])
})

test('a turn is closed once a result has landed, and not before', () => {
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [text('started')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: (clock += 1000) },
    user('u2'),
    assistant('a2', [tool('t1', { status: 'running' })])
  ])
  assert.equal(folds.get('u1')?.closed, true)
  assert.equal(folds.get('u2')?.closed, false)
})

test('only a turn row is a mid-turn close; a switch or an error keeps drawing', () => {
  const folds = foldTurns([
    user('u1'),
    { id: 'sw', role: 'event', kind: 'switch', text: 'a → b', ts: (clock += 1000) },
    assistant('a1', [text('hello from the new model')]),
    { id: 'e1', role: 'event', kind: 'turn', text: '', ts: (clock += 1000) }
  ])
  const fold = folds.get('u1')
  // The divider is not work: a switched turn that only talked still hides nothing.
  assert.equal(fold?.collapsible, false)
  assert.equal(fold?.workEvents.size, 0)
  assert.deepEqual(fold?.answerFrom, { messageId: 'a1', partIndex: 0 })

  const failed = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1')]),
    { id: 'err', role: 'event', kind: 'error', text: 'boom', ts: (clock += 1000) },
    assistant('a2', [text('woken; recovered')])
  ])
  // The error row drew a turn end, so what follows is a continuation — and the
  // row itself is never folded away.
  assert.equal(failed.get('u1')?.closed, true)
  assert.equal(failed.get('u1')?.workEvents.size, 0)
})

// --- Folding on screen: steered turns and continuations (`foldState`) ---

const close = (id: string, kind: 'turn' | 'error' = 'turn'): ChatMessage => ({
  id,
  role: 'event',
  kind,
  text: '',
  ts: (clock += 1000)
})

test('a turn cut off by a steered message folds to what it last said', () => {
  // "Send now" interrupts: the turn gets no result row and is usually mid-call.
  // Folded to the header alone, the turn vanished as the reader sent; left
  // open, a wall of work sat above the message they had just sent. It keeps
  // its last words and the call it was on.
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [tool('t0'), text('looking'), tool('t1', { status: 'error' })]),
    user('u2'),
    assistant('a2', [text('ok')]),
    close('e2')
  ])
  const cut = folds.get('u1')!
  assert.equal(cut.closed, false)
  assert.deepEqual(foldState(cut, false).stretches, [{ folded: true, start: { messageId: 'a1', partIndex: 1 } }])
  assert.equal(foldState(cut, false, 'open').folded, false)
  // A turn that ended on its own folds the same way.
  const done = folds.get('u2')!
  assert.equal(foldState(done, false).folded, true)
  assert.equal(foldState(done, false, 'open').folded, false)
})

test('a live turn never folds, and a choice cannot fold it', () => {
  const fold = foldTurns([user('u1'), assistant('a1', [tool('t1'), text('working')])]).get('u1')!
  assert.deepEqual(
    [foldState(fold, true).folded, foldState(fold, true, 'folded').folded, foldState(fold, true).canFold],
    [false, false, false]
  )
})

test('a continuation keeps what folded before it woke and draws the rest open', () => {
  // A backgrounded shell finished after the turn closed; its notification woke
  // the model under the same prompt. Before: the whole turn re-folded from its
  // *current* boundary, so each continuation message dropped into the fold the
  // moment the next one started.
  const folds = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1')]),
    assistant('a2', [text('started the build, will report')]),
    close('e1'),
    assistant('a3', [tool('t2')]),
    assistant('a4', [text('build passed, now')])
  ])
  const fold = folds.get('u1')!
  assert.deepEqual(fold.resumeFrom, { closeId: 'e1', answerFrom: { messageId: 'a2', partIndex: 0 } })
  const state = foldState(fold, true)
  assert.equal(state.folded, true)
  // Folding stops at what the turn said when it closed, and everything after
  // that close is open — not the current answer, which would hide a3 and
  // every continuation message before the last.
  assert.deepEqual(state.stretches, [
    { folded: true, start: { messageId: 'a2', partIndex: 0 } },
    { folded: false, start: { messageId: 'a4', partIndex: 0 } }
  ])
  assert.equal(state.keepRow, 'e1')
  // Settled, the cut-off continuation folds too, to its last prose.
  assert.deepEqual(
    foldState(fold, false).stretches.map((stretch) => stretch.folded),
    [true, true]
  )
})

test('a close made while agents still ran was never folded, so its continuation is not either', () => {
  // `/simplify`-shaped: the turn ends while four agents work, so it stays live
  // and open. When the last one reports, the model writes — and the turn used
  // to fold the whole card list away under the reader at that moment.
  clock = 10_000
  const spawn = (id: string, endedAt?: number): AssistantPart =>
    tool(id, { name: 'Agent', status: endedAt ? 'success' : 'running', agent: { startedAt: 10_500, ...(endedAt ? { endedAt } : {}) } })
  const messages = [
    user('u1'),
    assistant('a1', [spawn('s1', 20_000), spawn('s2', 30_000)]),
    assistant('a2', [text('two agents are running')]),
    close('e1'), // ts 14_000: both still running
    assistant('a3', [text('one is in')]),
    close('e2'), // ts 16_000: s2 still running
    assistant('a4', [text('both in, applying')])
  ]
  const fold = foldTurns(messages).get('u1')!
  assert.equal(fold.resumeFrom, null)
  assert.equal(foldState(fold, true).folded, false)
  // Settled, it folds once like any turn.
  assert.equal(foldState(fold, false).folded, true)

  // A close after every agent had reported does count.
  clock = 40_000
  const later = foldTurns([...messages, close('e3'), assistant('a5', [text('one more thing')])]).get('u1')!
  assert.equal(later.resumeFrom?.closeId, 'e3')
})

test('a spawn written before agent clocks existed does not block a close', () => {
  const fold = foldTurns([
    user('u1'),
    assistant('a1', [tool('s1', { name: 'Agent', agent: { startedAt: 0 } })]),
    close('e1'),
    assistant('a2', [text('more')])
  ]).get('u1')!
  assert.equal(fold.resumeFrom?.closeId, 'e1')
})

// --- Delegation rounds (`FoldOptions`) ---

test("a delegate's report continues the turn that sent it", () => {
  const delivery = (id: string): ChatMessage => ({
    id,
    role: 'user',
    text: 'Your agent sol (Codex) has finished.',
    label: 'sol finished',
    ts: (clock += 1000)
  })
  const continues = (m: { text: string; label?: string }) => !!m.label && m.text.startsWith('Your agent ')
  const messages = [
    user('u1'),
    assistant('a1', [tool('d1', { name: 'mcp__carbon__agents_delegate' }), text('sent sol, waiting')]),
    close('e1'),
    delivery('r1'),
    assistant('a2', [tool('t2'), text('sol found two bugs, both fixed')]),
    close('e2')
  ]
  const folds = foldTurns(messages, { continues })
  // One turn: the report is work inside it, and its answer is the last one.
  assert.deepEqual([...folds.keys()], ['u1'])
  assert.deepEqual(folds.get('u1')?.answerFrom, { messageId: 'a2', partIndex: 1 })
  // Without the option every report opened a turn of its own.
  assert.deepEqual([...foldTurns(messages).keys()], ['u1', 'r1'])
})

test('a report with no turn before it in the window opens one', () => {
  const folds = foldTurns(
    [{ id: 'r1', role: 'user', text: 'Your agent sol (Codex) has finished.', label: 'x', ts: 1 }, assistant('a1', [text('ok')])],
    { continues: () => true }
  )
  assert.deepEqual([...folds.keys()], ['r1'])
})


test('a diagnosis followed by a short follow-up after a wake keeps both', () => {
  // The reported case: a full answer, a close, a background notification, a
  // two-line reply, a close. The fold showed only the two lines.
  const fold = foldTurns([
    user('u1'),
    assistant('a1', [tool('t1'), text('BUG-98: the tags input drops typed text. BUG-99: search skips alternates.')]),
    close('e1'),
    assistant('a2', [text('That failed fetch was my first attempt; the diagnosis stands.')]),
    close('e2')
  ]).get('u1')!
  assert.deepEqual(
    foldState(fold, false).stretches,
    [
      { folded: true, start: { messageId: 'a1', partIndex: 1 } },
      { folded: true, start: { messageId: 'a2', partIndex: 0 } }
    ]
  )
})

// --- Second review round: stretch by stretch ---

const report = (id: string): ChatMessage => ({
  id,
  role: 'user',
  text: 'Your agent sol (Codex) has finished.',
  label: 'sol finished',
  ts: (clock += 1000)
})
const isReport = (m: { text: string; label?: string }) => !!m.label && m.text.startsWith('Your agent ')

test('a continuation the reader steered away from folds to the call it was on', () => {
  const fold = foldTurns([
    user('u1'),
    assistant('a1', [text('answer')]),
    close('e1'),
    assistant('a2', [tool('t1'), tool('t2')]),
    user('u2')
  ]).get('u1')!
  assert.deepEqual(foldState(fold, false).stretches, [
    { folded: true, start: { messageId: 'a1', partIndex: 0 } },
    { folded: true, start: { messageId: 'a2', partIndex: 1 } }
  ])
})

test('a diagnosis before a report keeps showing when its stretch was stopped', () => {
  const fold = foldTurns(
    [
      user('u1'),
      assistant('a1', [tool('t0'), text('the diagnosis')]),
      report('r1'),
      assistant('a2', [tool('t1'), tool('t2')]),
      close('e2')
    ],
    { continues: isReport }
  ).get('u1')!
  // Both fold: the stopped stretch to its diagnosis, the report's to its last call.
  assert.deepEqual(foldState(fold, false).stretches, [
    { folded: true, start: { messageId: 'a1', partIndex: 1 } },
    { folded: true, start: { messageId: 'a2', partIndex: 1 } }
  ])
  assert.equal(fold.answer, 'the diagnosis')
})

test('two closes in a row copy the answer once', () => {
  const fold = foldTurns([
    user('u1'),
    assistant('a1', [text('A')]),
    close('e1'),
    close('e2'),
    assistant('a2', [text('B')]),
    close('e3')
  ]).get('u1')!
  assert.equal(fold.answer, 'A\n\nB')
})




// --- Third review round: rounds off the transcript, a bounded wake, choices ---

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'

/** A fake `Delegates`: calls name their child in `input.child`. */
const delegates = (records: Record<string, { running?: boolean; endedAt?: number }>) => ({
  childOf: (part: { name: string; input?: unknown }) =>
    part.name.startsWith('mcp__carbon__agents_') ? ((part.input as { child?: string })?.child ?? null) : null,
  running: (child: string) => !!records[child]?.running,
  endedAt: (child: string) => records[child]?.endedAt
})
const call = (id: string, child: string, name = 'mcp__carbon__agents_delegate') =>
  tool(id, { name, input: { child } })
const reportOf = (id: string, child: string): ChatMessage => ({
  id,
  role: 'user',
  text: `Your agent sol (Codex) has finished.\n\nAgent: sol (id ${child})`,
  label: 'sol finished',
  ts: (clock += 1000)
})

test('a running delegate holds its turn live, and a close made meanwhile is no resume point', () => {
  clock = 50_000
  const messages = [user('u1'), assistant('a1', [call('d1', C1), text('sent sol')]), close('e1')]
  const running = foldTurns(messages, { continues: isReport, delegates: delegates({ [C1]: { running: true } }) }).get('u1')!
  assert.equal(running.running, true)
  assert.equal(running.resumeFrom, null)
  // Its report came back: the round is over at the report, read off the
  // transcript — whatever the record says later, or with no record at all.
  const reported = [...messages, reportOf('r1', C1), assistant('a2', [text('sol is in')]), close('e2')]
  for (const records of [{}, { [C1]: { running: true } }]) {
    const fold = foldTurns(reported, { continues: isReport, delegates: delegates(records) }).get('u1')!
    assert.equal(fold.resumeFrom?.closeId, 'e2', JSON.stringify(records))
  }
})

test("re-arming or deleting a delegate does not move an earlier close's eligibility", () => {
  clock = 60_000
  // Spawn, close while it runs, report, then the parent re-arms it in the same turn.
  const messages = [
    user('u1'),
    assistant('a1', [call('d1', C1), text('sent')]),
    close('e1'),
    reportOf('r1', C1),
    assistant('a2', [call('s1', C1, 'mcp__carbon__agents_send'), text('asked again')]),
    close('e2')
  ]
  const live = foldTurns(messages, { continues: isReport, delegates: delegates({ [C1]: { running: true } }) }).get('u1')!
  // e1 was made while round one ran; e2 while round two does.
  assert.equal(live.resumeFrom, null)
  assert.equal(live.running, true)
  const gone = foldTurns(messages, { continues: isReport, delegates: delegates({}) }).get('u1')!
  assert.equal(gone.stretches[0].closed, true)
  // e1 still was made while round one ran (its end is r1, in the transcript).
  assert.notEqual(gone.resumeFrom?.closeId, 'e1')
})

test("a follow-up round makes its own turn live, not the spawn's", () => {
  clock = 100_000
  const folds = foldTurns(
    [
      user('u1'),
      assistant('a1', [call('d1', C1), text('sent sol')]),
      close('e1'),
      reportOf('r1', C1),
      close('e1b'),
      user('u2'),
      assistant('a2', [call('s1', C1, 'mcp__carbon__agents_send'), text('asked sol again')]),
      close('e2')
    ],
    { continues: isReport, delegates: delegates({ [C1]: { running: true } }) }
  )
  assert.equal(folds.get('u1')?.running, false)
  assert.equal(folds.get('u2')?.running, true)
})

test('a wake that is due holds the last turn for a bounded time', () => {
  clock = 200_000
  const spawn = tool('s1', { name: 'Agent', agent: { startedAt: 200_500, endedAt: 210_000 } })
  const waking = foldTurns([user('u1'), assistant('a1', [spawn, text('waiting')]), close('e1')]).get('u1')!
  assert.equal(waking.running, false)
  // Bounded by the grace main gives the same wake, from the agent's end.
  assert.equal(waking.awaitingWakeUntil, 210_000 + 30_000)
  // A side question after the close is not the turn's last step.
  const asked = foldTurns([
    user('u1'),
    assistant('a1', [spawn, text('waiting')]),
    close('e1'),
    { id: 'q1', role: 'event', kind: 'btw', text: '', ts: (clock += 1000) }
  ]).get('u1')!
  assert.equal(asked.awaitingWakeUntil, 240_000)
  // Once the wake has written anything, it is an ordinary continuation.
  const woke = foldTurns([user('u1'), assistant('a1', [spawn, text('waiting')]), close('e1'), assistant('a2', [text('in')])]).get('u1')!
  assert.equal(woke.awaitingWakeUntil, 0)
})

test("a prepend carries the reader's choice from a leading report onto its turn", () => {
  clock = 300_000
  const older = [user('u1'), assistant('a1', [tool('t1'), text('sent')]), close('e1')]
  const current = [report('r1'), assistant('a2', [tool('t2'), text('done')]), close('e2')]
  const opened = carryDisclosure(older, current, new Map([['r1', 'open']]), isReport)
  assert.deepEqual(opened && [...opened], [['u1', 'open']])
  // A collapse made on an interrupted report folds the whole merged turn.
  const stopped = [report('r1'), assistant('a2', [tool('t2')])]
  const folded = carryDisclosure(older, stopped, new Map([['r1', 'folded']]), isReport)
  assert.deepEqual(folded && [...folded], [['u1', 'folded']])
  const merged = foldTurns([...older, ...stopped], { continues: isReport }).get('u1')!
  assert.deepEqual(foldState(merged, false, 'folded').stretches.map((x) => x.folded), [true, true])
  // Untouched, nothing moves.
  assert.equal(carryDisclosure(older, current, new Map(), isReport), null)
  // A window that opened on a reply drew it open, so the merged turn opens.
  const mid = [assistant('a2', [tool('t2'), text('done')]), close('e2')]
  assert.deepEqual([...(carryDisclosure(older, mid, new Map(), isReport) ?? [])], [['u1', 'open']])
})

// --- Fourth review round ---

test('a round stays outstanding until its report, so a late report moves nothing', () => {
  clock = 400_000
  // The delegate finished at 400_500, the parent closed at 403_000, and the
  // report waited for the parent (`flushDeliveries`) until after that.
  const before = [user('u1'), assistant('a1', [call('d1', C1), text('sent')]), close('e1')]
  const records = { [C1]: { endedAt: 400_500 } }
  const waiting = foldTurns(before, { continues: isReport, delegates: delegates(records) }).get('u1')!
  assert.equal(waiting.resumeFrom, null)
  assert.equal(waiting.running, false)
  // Its report is due: the bounded wake, from the close it waited behind —
  // not from when the delegate finished, which can be minutes earlier.
  assert.equal(waiting.awaitingWakeUntil, 403_000 + 30_000)
  const after = foldTurns([...before, reportOf('r1', C1), assistant('a2', [text('in')])], {
    continues: isReport,
    delegates: delegates(records)
  }).get('u1')!
  assert.equal(after.resumeFrom, null)
})

test("a report's own words naming another delegate do not end that one's round", () => {
  const text = [
    'Your agent sol (Codex) has finished.',
    '',
    `Agent: sol (id ${C1})`,
    'Task: review',
    '',
    `Its report: the other reviewer (id ${C2}) is still running.`
  ].join('\n')
  assert.deepEqual([...reportedDelegates(text)], [C1])
  // Nor does a header line the delegate quoted from a log.
  assert.deepEqual([...reportedDelegates(`${text}\n\nAgent: b (id ${C2})`)], [C1])
  // A batch names each of its delegates under its own opener.
  const batch = `Agents from this conversation finished while Carbon could not report them:\n\n---\nYour agent a (Codex) has finished.\n\nAgent: a (id ${C1})\n\n---\nYour agent b (Grok) failed.\n\nAgent: b (id ${C2})`
  assert.deepEqual([...reportedDelegates(batch)].sort(), [C1, C2].sort())
})

test('a report choice made on screen wins over an older choice on its turn', () => {
  clock = 500_000
  const older = [user('u1'), assistant('a1', [tool('t1'), text('sent')]), close('e1')]
  const current = [report('r1'), assistant('a2', [tool('t2'), text('done')]), close('e2')]
  const next = carryDisclosure(older, current, new Map([['u1', 'folded'], ['r1', 'open']]), isReport)
  assert.deepEqual(next && [...next], [['u1', 'open']])
  // Untouched on screen, an older choice on the turn gives way to the default
  // the report was drawn with.
  const cleared = carryDisclosure(older, current, new Map([['u1', 'folded']]), isReport)
  assert.deepEqual(cleared && [...cleared], [])
})

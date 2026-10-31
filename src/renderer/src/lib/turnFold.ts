import type {
  AssistantMessage,
  AssistantPart,
  ChatMessage,
  EventMessage,
  ToolPart,
  UserMessage
} from '@shared/types'

/**
 * A turn, seen from its header: when it started, when it stopped, and where its
 * **answer** begins.
 *
 * The transcript draws a turn as a header row (`TurnHeader`) followed by
 * everything the agent did, and a settled turn folds down to the header plus
 * the answer. Folding is *omission* — `renderMessages` leaves the hidden nodes
 * out of the flat array it returns — so the only thing that has to be decided
 * up front is the boundary, and it cannot be decided message by message:
 * Claude ends a turn with a separate text-only message, while Codex accumulates
 * one message for the whole turn, so on Codex the boundary falls *inside* a
 * message and `AssistantBlock` has to render from a part index.
 */
export interface TurnFold {
  /** The user message that opened the turn — the key, and the toggle's id. */
  userId: string
  startTs: number
  /**
   * When the turn stopped, as far as the transcript can tell: the latest of its
   * messages' stamps and its calls' own start stamps.
   *
   * The calls matter because **an interrupted turn closes no event.** Claude
   * pushes its `turn` row only on a `success` result and Codex accumulates the
   * whole turn into *one* message stamped when it opened — so on a two-minute
   * turn the user stopped, the last stamp is the turn's own beginning, and the
   * header would report `0s`. A call's `startedAt` is a floor under the truth
   * rather than the truth, which is the honest direction to be wrong in.
   */
  endTs: number
  /** False until anything at all followed the prompt. */
  replied: boolean
  /**
   * Something in this turn is still going, after the turn itself has ended.
   *
   * Not a contradiction and not rare: a backgrounded job keeps its tool cards
   * live past the result (`claude.ts` skips `terminalizeRunning` while
   * `backgroundJobCount > 0`), and a backgrounded *agent*'s spawning call
   * returns at spawn while its children keep arriving. Such a turn does not
   * fold — folding it would take a running card off screen.
   */
  running: boolean
  /**
   * The first part of the turn's answer, or null when the turn ends on work
   * rather than on prose. Everything before it folds away.
   */
  answerFrom: { messageId: string; partIndex: number } | null
  /**
   * The answer's prose — the text parts from `answerFrom` on, joined — and so
   * exactly what "copy the answer" hands over: what a folded turn still shows.
   *
   * **The unit is the turn, not the message.** Claude persists a turn as many
   * assistant messages and Codex as one, so a per-message copy would hand over
   * a fragment on one provider and the answer on the other. And the boundary
   * is the fold's, not "every text part in the turn": the reason to copy is to
   * hand an answer to another agent, and a "let me check" preamble folded away
   * above twenty `Read` rows is the same noise the rows are.
   *
   * Empty when the turn ends on work, which draws no copy control at all.
   */
  answer: string
  /** True when folding would actually hide something. */
  collapsible: boolean
  /**
   * Event rows that fall *inside* the turn's work — a `turn` stats row with
   * more of the turn after it — and so fold with it.
   *
   * The CLI closes a turn more than once when a background task wakes the
   * model: `/simplify` spawns four review agents, says it will wait, and ends
   * the turn; each agent's notification then starts a continuation under the
   * same prompt with a `result` of its own. Every one of those pushes a stats
   * row, and event rows are otherwise never folded — so a folded `/simplify`
   * turn stacked four cost readings above its answer. The row that closes the
   * turn (nothing of the turn after it) is not in here and still survives.
   */
  workEvents: ReadonlySet<string>
  /**
   * The CLI has ended this turn at least once — some stretch closed.
   *
   * A turn that is live again after that is a **continuation**: something
   * woke the model under the same prompt (a background task's notification, a
   * delegate's report, a scheduled wake-up) and nothing the user did. What
   * folds while it streams is `resumeFrom`'s to decide.
   */
  closed: boolean
  /**
   * The turn cut where it stopped and started again: at each close (a `turn`
   * or `error` row) and at each delegate report that joined it. **The fold is
   * decided per stretch**: each folds its work and keeps its own answer — what
   * it last said and the calls after, or with nothing said the call it was on,
   * which for one cut off by a steer is where the reader interrupted it.
   *
   * One answer for the whole turn got the mixed cases wrong: a full diagnosis,
   * a close, a background wake and a two-line follow-up folded to the two
   * lines; a diagnosis before a report folded away with the work after it.
   */
  stretches: Stretch[]
  /** Which stretch each message after the prompt belongs to, by index. */
  stretchOf: ReadonlyMap<string, number>
  /**
   * Where a continuation's fold stops: the last close at which nothing in the
   * turn was still running. Stretches up to it fold as they would settled;
   * everything after it draws open, the way a live turn draws, until the turn
   * settles and each stretch folds once. Folding from the *current* boundary
   * instead hid each continuation message the moment the next one started.
   *
   * "Nothing running" is read off the spawns' own clocks (`agent.endedAt`, a
   * delegate's span) because a close made while agents were still working was
   * never shown folded — the turn stayed live, every card open — and a
   * continuation of *that* close must not fold it either. Null when no close
   * qualifies, so the turn is simply live until it settles.
   */
  resumeFrom: { closeId: string; answerFrom: TurnFold['answerFrom'] } | null
  /**
   * Until when the model is expected to wake (epoch ms), or 0. Set when the
   * turn closed while agents it spawned were working, every one of them has
   * finished since, and nothing of the turn has come after: their reports are
   * about to wake it. Read as live until then, or the turn folds for the
   * second between the last report and the wake and opens again under the
   * reader. Bounded by `WAKE_GRACE_MS` from the last one's end — the grace
   * main gives the same wake (`wakeTimer` in `claude.ts`) — because a wake
   * that never comes (a job the user stopped) must not hold the turn for good.
   */
  awaitingWakeUntil: number
}

/** Where a stretch's answer starts. */
export interface AnswerStart {
  messageId: string
  partIndex: number
}

/** One stretch of a turn (`TurnFold.stretches`). */
export interface Stretch {
  /** The `turn` or `error` row that ended it; absent when it was cut off. */
  closeId?: string
  closed: boolean
  /** Its answer — the trailing prose, or its last prose before a few calls. */
  answerFrom: AnswerStart | null
  answer: string
  /** Folding it would hide something. */
  collapsible: boolean
}

/**
 * The messages a turn is made of, after its prompt. A user message among them
 * is one `FoldOptions.continues` names — a delegate reporting back — and is
 * work: what the turn was doing, not what it arrived at.
 */
type TurnMessage = AssistantMessage | EventMessage | UserMessage

/**
 * This chat's delegates, as the transcript cannot tell them: which one a call
 * names, and what its chat's record says of its *current* round. Everything
 * else about a round — when it started and when its report came back — is
 * read off the transcript, which never changes after the fact, so re-arming a
 * delegate or deleting it does not move an earlier turn's fold.
 */
export interface Delegates {
  /** The delegate a call names — its spawn or a follow-up — or null. */
  childOf(part: ToolPart): string | null
  /** Its chat's record says it is working on its current round. */
  running(child: string): boolean
  /** When its current round ended, by its chat's record, if it has. */
  endedAt(child: string): number | undefined
}

/** The grace main gives a wake that is due (`WAKE_GRACE_MS` in `claude.ts`). */
export const WAKE_GRACE_MS = 30_000

export interface FoldOptions {
  /**
   * A user message that continues the turn before it rather than opening one:
   * a delegate's report (`isDelivery`). It reaches the model as a user message
   * only because that is how an outcome gets to it; a turn split at each one
   * folded the parent's work the moment the report landed, and the rail —
   * which already merged them — disagreed with the transcript about where a
   * turn ended.
   */
  continues?: (message: UserMessage) => boolean
  /**
   * A delegate's spawn returns at once and its work goes on in another chat,
   * so the call's own status says nothing about it. Given this, a delegate
   * still working holds its turn live (`running`), as a backgrounded agent's
   * held call does, and a close made while it worked is not a resume point.
   *
   * Each call naming a delegate is one round, from the call to the first
   * report naming it after (or the next call naming it, whichever is first).
   * Only the latest call's round can still be open, and the record says
   * whether it is: an `agents_send` re-arming a finished delegate holds that
   * call's turn live, not the spawn's.
   */
  delegates?: Delegates
}

/** A part that draws nothing: a hole, or text/thinking whose text is withheld. */
function blank(part: AssistantPart | null | undefined): boolean {
  return !part || ((part.type === 'text' || part.type === 'thinking') && !part.text)
}

/**
 * **The answer is the trailing run of `text` parts**, walked back across the
 * turn's assistant messages, and *anything else* ends it.
 *
 * Not every text part in the turn: a turn that says "let me check" before
 * running six commands would keep that preamble on screen and fold away the
 * work it introduces. The same run is what gets copied (`TurnFold.answer`).
 *
 * A thought with text ends the run exactly as a tool call does. Codex streams
 * its reasoning visibly, so a `thinking` part is a rendered "Thought process"
 * row — work the turn did, not the answer it arrived at — and treating it as
 * answer prose would leave that row hanging above every folded Codex turn.
 * Withheld thoughts (Claude's) draw nothing and so decide nothing.
 *
 * **A `turn` row between assistant messages ends it too**, and is work. The
 * rows after the last assistant message close the turn — the stats row — and
 * decide nothing; one *between* two of them is a turn boundary the CLI drew
 * mid-turn (see `workEvents`), so this run is the *last stretch's* answer.
 * The prose above that row is an earlier stretch's, and `foldTurns` keeps it
 * as its own stretch (`TurnFold.stretches`) rather than folding it away.
 */
function answerBoundary(turn: TurnMessage[]): {
  answerFrom: TurnFold['answerFrom']
  answer: string
  collapsible: boolean
  workEvents: Set<string>
} {
  let answerFrom: TurnFold['answerFrom'] = null
  // Collected back to front, as the walk meets them.
  const prose: string[] = []
  const answer = (): string => prose.reverse().join('\n\n')
  // Every event with any of the turn's replies after it is interim — decided
  // up front rather than inside the walk below, which stops at the first work
  // it meets and would leave an earlier row unmarked behind it.
  // Only `turn` rows: a switch divider, an error, a compaction mark inside a
  // turn are not turn ends, decide nothing here, and keep drawing as before.
  const workEvents = new Set<string>()
  const lastReply = turn.findLastIndex((message) => message.role === 'assistant')
  for (let i = 0; i < lastReply; i++) {
    const message = turn[i]
    if (message.role === 'event' && message.kind === 'turn') workEvents.add(message.id)
  }
  for (let mi = turn.length - 1; mi >= 0; mi--) {
    const message = turn[mi]
    if (message.role === 'user') return { answerFrom, answer: answer(), collapsible: true, workEvents }
    if (message.role === 'event') {
      if (mi > lastReply || message.kind !== 'turn') continue
      return { answerFrom, answer: answer(), collapsible: true, workEvents }
    }
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi]
      if (blank(part)) continue
      if (part.type === 'text') {
        answerFrom = { messageId: message.id, partIndex: pi }
        prose.push(part.text)
        continue
      }
      // Work. Everything from here back is what the fold hides.
      if (answerFrom) return { answerFrom, answer: answer(), collapsible: true, workEvents }
      // The turn ended on work — a last check, a status call — after saying
      // what it found. Folding to the header alone hid every word of it, so
      // the fold stops at the turn's last prose instead, and the few calls
      // after it stay on screen with it.
      const last = lastProse(turn, mi, pi)
      // With no prose at all, it keeps the call it ended on — for a turn cut
      // off by a steer, the one it was in the middle of — so a folded stretch
      // still shows where it stopped. Nothing to copy, though.
      return { ...(last ?? { answerFrom: { messageId: message.id, partIndex: pi }, answer: '' }), collapsible: true, workEvents }
    }
  }
  // A turn that never did anything but talk. The boundary still points at its
  // first drawn part so the renderer takes one path, and nothing folds.
  return { answerFrom, answer: answer(), collapsible: false, workEvents }
}

/**
 * The last run of prose before position (`mi`, `pi`), walking back across the
 * turn's messages and stopping where the turn's earlier stretch begins (a
 * report, or a mid-turn close): the run's first part, and its text.
 */
function lastProse(
  turn: TurnMessage[],
  mi: number,
  pi: number
): { answerFrom: NonNullable<TurnFold['answerFrom']>; answer: string } | null {
  let from: NonNullable<TurnFold['answerFrom']> | null = null
  const prose: string[] = []
  for (let m = mi; m >= 0; m--) {
    const message = turn[m]
    if (message.role === 'user' || (message.role === 'event' && message.kind === 'turn')) break
    if (message.role !== 'assistant') continue
    for (let p = m === mi ? pi : message.parts.length - 1; p >= 0; p--) {
      const part = message.parts[p]
      if (blank(part)) continue
      if (part.type === 'text') {
        from = { messageId: message.id, partIndex: p }
        prose.push(part.text)
      } else if (from) {
        return { answerFrom: from, answer: prose.reverse().join('\n\n') }
      }
    }
  }
  return from ? { answerFrom: from, answer: prose.reverse().join('\n\n') } : null
}

/** A spawn's working span, for "was anything running at this close". */
interface Span {
  from: number
  to: number
  /** It holds its turn live (`running`): still working, by its own word. */
  live?: boolean
  /**
   * It is done and its report is due, since this moment: the wake that report
   * brings is expected within `WAKE_GRACE_MS` of it — or of the close, if the
   * parent was still busy then and the report waited for it.
   */
  dueFrom?: number
}

/**
 * Every spawn in the turn with its span: a native agent off its own clocks
 * (`AgentRun`), a delegate's call off its round (`roundsOf`). A native spawn
 * with no `endedAt` runs for as long as its call says it does; a settled one
 * with none (written before the field existed) is taken as done.
 */
function spansOf(turn: TurnMessage[], rounds: ReadonlyMap<string, Span>): Span[] {
  const spans: Span[] = []
  for (const message of turn) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (!part || part.type !== 'tool') continue
      const round = rounds.get(part.toolUseId)
      if (round) {
        spans.push(round)
        continue
      }
      if (!part.agent) continue
      const open = part.status === 'pending' || part.status === 'running'
      const end = part.agent.endedAt
      spans.push({
        from: part.agent.startedAt,
        to: end ?? (open ? Infinity : -Infinity),
        ...(end !== undefined ? { dueFrom: end } : {})
      })
    }
  }
  return spans
}

/**
 * Each delegate call's round, by call id: from the call to the first report
 * naming that delegate after it, or to the next call naming it. **A round is
 * outstanding until its report arrives** — the end is the report, never the
 * moment the delegate finished: reports wait while the parent is busy
 * (`flushDeliveries`), and a round that ended at its finish before the report
 * and at the report after it moved an earlier close's fold when the report
 * landed. So the latest call with no report yet is open; the record says
 * whether it still holds the turn live (working) or is done with its report
 * due (`dueFrom`, the bounded wake). With no record left — the delegate was
 * deleted — and no report, it ended at nothing anyone can see.
 */
function roundsOf(
  messages: ChatMessage[],
  delegates: Delegates | undefined,
  continues: FoldOptions['continues']
): Map<string, Span> {
  const rounds = new Map<string, Span>()
  if (!delegates) return rounds
  const calls: { id: string; child: string; from: number }[] = []
  const reports: { ts: number; children: ReadonlySet<string> }[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part?.type !== 'tool') continue
        const child = delegates.childOf(part)
        if (child) calls.push({ id: part.toolUseId, child, from: part.startedAt ?? message.ts })
      }
    } else if (message.role === 'user' && continues?.(message)) {
      reports.push({ ts: message.ts, children: reportedDelegates(message.text) })
    }
  }
  calls.forEach((call, i) => {
    const next = calls.find((other, j) => j > i && other.child === call.child)
    const report = reports.find((r) => r.ts >= call.from && r.children.has(call.child))
    const ends = [next?.from, report?.ts].filter((t): t is number => t !== undefined)
    if (ends.length) {
      rounds.set(call.id, { from: call.from, to: Math.min(...ends) })
      return
    }
    const working = delegates.running(call.child)
    const ended = delegates.endedAt(call.child)
    rounds.set(
      call.id,
      working
        ? { from: call.from, to: Infinity, live: true }
        : ended !== undefined
          ? { from: call.from, to: Infinity, dueFrom: ended }
          : { from: call.from, to: -Infinity }
    )
  })
  return rounds
}

/**
 * The delegates a report is about, read off the header main generates for each
 * one (`deliveryText`: its "Your agent …" line, a blank line, then
 * `Agent: <name> (id <uuid>)`) and nowhere else: the report also carries the
 * task and the delegate's own words, which can name another delegate's id —
 * or quote a whole line that looks like one — and that one is still working.
 */
export function reportedDelegates(text: string): Set<string> {
  const ids = new Set<string>()
  for (const match of text.matchAll(/^Your agent .*\n\nAgent: .+ \(id ([0-9a-f-]{36})\)$/gm)) ids.add(match[1])
  return ids
}

/** A close made while something spawned was working: never shown folded. */
function busyAt(spans: Span[], ts: number): boolean {
  return spans.some((span) => span.from <= ts && span.to > ts)
}

/**
 * Anything in this message still in flight — the call itself, or a child of it.
 *
 * The child half is `agentRuns.ts`'s `childrenBusy` rule, which that file keeps
 * in one place so a card and the roster cannot disagree about one agent. This
 * asks a different question — *is the turn still doing anything* — and repeats
 * two lines of it rather than exporting from a file this pass does not own;
 * worth reconciling if a third caller ever wants it.
 *
 * A Grok background agent (`untrackedBackground`) reports no completion at
 * all, so it is not counted: waiting on a signal that never comes would hold
 * its turn live for good.
 */
function messageRunning(message: AssistantMessage, rounds: ReadonlyMap<string, Span>): boolean {
  for (const part of message.parts) {
    if (!part || part.type !== 'tool') continue
    if (part.status === 'pending' || part.status === 'running') return true
    if (rounds.get(part.toolUseId)?.live) return true
    for (const child of part.children ?? []) {
      if (child?.type === 'tool' && (child.status === 'pending' || child.status === 'running')) {
        return true
      }
    }
  }
  return false
}

/** The latest moment a message can prove: its own stamp, or a call it started. */
function lastStamp(message: ChatMessage): number {
  let latest = message.ts
  if (message.role !== 'assistant') return latest
  for (const part of message.parts) {
    if (part && part.type === 'tool' && part.startedAt && part.startedAt > latest) {
      latest = part.startedAt
    }
  }
  return latest
}

const isClose = (message: TurnMessage): message is EventMessage =>
  message.role === 'event' && (message.kind === 'turn' || message.kind === 'error')

/**
 * Cut a turn into stretches and settle each one's answer. A close ends the
 * stretch it closes and belongs to it; a joined report opens the next one.
 */
function cutStretches(turn: TurnMessage[]): { stretches: Stretch[]; stretchOf: Map<string, number> } {
  const stretches: Stretch[] = []
  const stretchOf = new Map<string, number>()
  let piece: TurnMessage[] = []
  const end = (close?: EventMessage): void => {
    const { answerFrom, answer, collapsible } = answerBoundary(piece)
    stretches.push({
      ...(close ? { closeId: close.id } : {}),
      closed: !!close,
      answerFrom,
      answer,
      collapsible
    })
    piece = []
  }
  for (const message of turn) {
    if (message.role === 'user' && piece.length) end()
    stretchOf.set(message.id, stretches.length)
    if (isClose(message)) end(message)
    else piece.push(message)
  }
  if (piece.length) end()
  return { stretches, stretchOf }
}

/**
 * One fold per turn, keyed by the user message that opened it.
 *
 * Fed the same **filtered** list `renderMessages` draws — blank messages
 * already dropped — so every message named here is one the transcript renders,
 * and a boundary can never land on a message nothing draws.
 *
 * Assistant messages before the first prompt (the loaded window can start
 * mid-turn) belong to no turn: they get no fold, no header, and therefore never
 * fold away behind a control that isn't on screen.
 */
export function foldTurns(messages: ChatMessage[], options: FoldOptions = {}): Map<string, TurnFold> {
  const { continues, delegates } = options
  const folds = new Map<string, TurnFold>()
  const rounds = roundsOf(messages, delegates, continues)
  let current: TurnFold | null = null
  let turn: TurnMessage[] = []

  const close = (): void => {
    if (current) {
      const { stretches, stretchOf } = cutStretches(turn)
      const answered = stretches.filter((stretch) => stretch.answerFrom)
      const spans = spansOf(turn, rounds)
      let resumeFrom: TurnFold['resumeFrom'] = null
      for (const stretch of stretches) {
        const row = stretch.closeId ? turn.find((message) => message.id === stretch.closeId) : undefined
        if (row && !busyAt(spans, row.ts)) resumeFrom = { closeId: row.id, answerFrom: stretch.answerFrom }
      }
      // The turn's last step: a side question or a note after its close is
      // not one, and must not hide that the close is still the turn's last.
      const tail = turn.findLast((message) => message.role !== 'event' || isClose(message))
      Object.assign(current, {
        stretches,
        stretchOf,
        // What the folded turn shows is what "copy the answer" hands over.
        answer: answered.map((stretch) => stretch.answer).filter(Boolean).join('\n\n'),
        answerFrom: answered[answered.length - 1]?.answerFrom ?? null,
        collapsible: stretches.some((stretch) => stretch.collapsible),
        workEvents: answerBoundary(turn).workEvents,
        closed: stretches.some((stretch) => stretch.closed),
        resumeFrom,
        awaitingWakeUntil:
          tail && isClose(tail) && !current.running
            ? Math.max(
                0,
                ...spans
                  .filter((span) => span.from <= tail.ts && span.to > tail.ts && span.dueFrom !== undefined)
                  // A report that waited for the parent is due from the close,
                  // not from when its delegate finished minutes before.
                  .map((span) => Math.max(span.dueFrom!, tail.ts) + WAKE_GRACE_MS)
              )
            : 0
      })
    }
    current = null
    turn = []
  }

  for (const message of messages) {
    if (message.role === 'user' && current && continues?.(message)) {
      current.replied = true
      current.endTs = Math.max(current.endTs, message.ts)
      turn.push(message)
      continue
    }
    if (message.role === 'user') {
      close()
      current = {
        userId: message.id,
        startTs: message.ts,
        endTs: message.ts,
        replied: false,
        running: false,
        answerFrom: null,
        answer: '',
        collapsible: false,
        workEvents: new Set(),
        closed: false,
        stretches: [],
        stretchOf: new Map(),
        resumeFrom: null,
        awaitingWakeUntil: 0
      }
      folds.set(message.id, current)
      continue
    }
    if (!current) continue
    current.replied = true
    // `ts` is stamped by main when the message is created and never restamped,
    // so this is monotonic in practice; the max is what keeps a clock that
    // cannot run backwards out of the "one source" rule below.
    current.endTs = Math.max(current.endTs, lastStamp(message))
    turn.push(message)
    if (message.role === 'assistant' && !current.running && messageRunning(message, rounds)) {
      current.running = true
    }
  }
  close()
  return folds
}

/** How one turn draws: whether it folds, which stretches, and the control. */
export interface FoldState {
  /** Some of the turn's work is folded away. */
  folded: boolean
  /** The header offers the fold control at all. */
  canFold: boolean
  /** Per stretch (`TurnFold.stretches`): folded, and where its answer starts. */
  stretches: { folded: boolean; start: AnswerStart | null }[]
  /**
   * A mid-turn close row that stays although its stretch folds: the one a
   * continuation woke from, which was the turn's closing row a moment ago.
   */
  keepRow?: string
}

/** What the reader chose for a turn with its header: everything open, or everything folded. */
export type TurnChoice = 'open' | 'folded'

/**
 * The fold for one turn, given whether it is live and what the reader chose
 * (`turnChoices`), if anything.
 *
 * - **Settled**, untouched: every stretch folds to its answer — what it last
 *   said, and the few calls after; or, with nothing said, the call it was on.
 *   That includes one cut off by Stop or a steered message: folding it to the
 *   header alone lost the turn the reader was watching, and leaving it open
 *   kept a wall of work above the message they had just sent.
 * - **Live** (the running turn, or one whose work outlives it) never folds —
 *   unless it is a *continuation* of a close that had folded (`resumeFrom`):
 *   stretches up to that close fold as settled, and everything after is open.
 * - **Chosen**: the header folds every stretch, or opens every one. A choice is
 *   explicit rather than a flip of the default, because the default can be
 *   half-folded and can change under it (a prepend merging a turn), and a
 *   flip of something that moved means the opposite of what was clicked.
 */
export function foldState(fold: TurnFold, live: boolean, choice?: TurnChoice): FoldState {
  const continuing = live && !!fold.resumeFrom
  const canFold = !live || continuing
  const resumeAt = continuing && fold.resumeFrom ? fold.stretchOf.get(fold.resumeFrom.closeId) : undefined
  const stretches = fold.stretches.map((stretch, i) => ({
    folded:
      canFold &&
      choice !== 'open' &&
      // While a continuation runs, what came after the close it woke from is
      // still being written and stays open.
      (choice === 'folded' || resumeAt === undefined || i <= resumeAt),
    start: stretch.answerFrom
  }))
  return {
    folded: stretches.some((stretch) => stretch.folded),
    canFold,
    stretches,
    ...(continuing && fold.resumeFrom && choice !== 'open' ? { keepRow: fold.resumeFrom.closeId } : {})
  }
}

/**
 * The reader's choices after a prepend (`loadOlder`), or null when none moves.
 * A window can open mid-turn — on a reply with no prompt above it, or on a
 * delegate's report that headed a turn only because its own turn's prompt was
 * not loaded — and the prepend merges that leading piece into the turn it
 * belongs to. A choice made on the report moves to the merged turn; a reply
 * with no prompt above it drew open, so the merged turn opens, rather than
 * folding the rows under the cursor (measured once: a 1,079px jump).
 */
export function carryDisclosure(
  older: ChatMessage[],
  current: ChatMessage[],
  choices: ReadonlyMap<string, TurnChoice>,
  continues: (message: UserMessage) => boolean
): Map<string, TurnChoice> | null {
  const first = current[0]
  if (!first || (first.role === 'user' && !continues(first))) return null
  const folds = foldTurns([...older, ...current], { continues })
  const prompt = older.findLast((m) => m.role === 'user' && folds.has(m.id))
  if (!prompt) return null
  // What is on screen wins over a choice made on the turn in an earlier
  // session: the report's own choice, or its default (none) — and a reply
  // with no prompt above it, which drew open.
  const shown = first.role === 'user' ? choices.get(first.id) : 'open'
  if (choices.get(prompt.id) === shown && !(first.role === 'user' && choices.has(first.id))) return null
  const next = new Map(choices)
  next.delete(first.id)
  if (shown) next.set(prompt.id, shown)
  else next.delete(prompt.id)
  return next
}

import * as React from 'react'
import type { AssistantMessage, ChatMessage, ChatMeta, PermissionRequestPayload, ToolPart } from '@shared/types'
import { isAgentish } from '@shared/agentRuns'
import { foldTaskTimeline, NO_TASK_TIMELINE, reconcileTimeline } from '@/lib/taskList'
import type { TaskItem, TaskTimeline } from '@/lib/taskList'
import { AssistantBlock, EventRow, UserBubble } from '@/components/messages/Parts'
import {
  FILE_MUTATION_TOOLS,
  groupRunning,
  isGroupableTool,
  ToolCard,
  ToolGroup,
  ToolOutputImages
} from '@/components/messages/ToolCard'
import { TasksCard } from '@/components/messages/TasksCard'
import { AgentGroupCard, AgentPartRow } from '@/components/messages/AgentRows'
import { TurnChangesCard } from '@/components/messages/TurnChangesCard'
import { TurnHeader } from '@/components/messages/TurnHeader'
import { InlineVisual, isInlineVisual } from '@/components/messages/InlineVisual'
import { turnPresentations } from '@/lib/turnChanges'
import { foldTurns, type TurnFold } from '@/lib/turnFold'
import { useApp } from '@/store'

/**
 * What a chat's transcript draws, as a keyed node array — the desktop's
 * `ChatView` and the phone's chat screen both render this, so the phone shows
 * every block the desktop does (Mermaid, charts and diagrams, diffs, agents,
 * the checklist, a turn's changes) rather than a second, smaller set of
 * renderers that falls behind each time a block is added. The scroller, the
 * composer and everything around the transcript stay each surface's own.
 */

/**
 * Coalesce a run of this many consecutive read/search-only messages into one
 * row — 1 under "Fold activity while working", where every step is a row.
 */
const GROUP_MIN = 2
const groupMin = (foldActivity: boolean): number => (foldActivity ? 1 : GROUP_MIN)

/**
 * How long the transcript's tail has to be still before the foot says
 * "Working…". Longer than the ~400ms the held last word takes to land after a
 * reply's final delta, so the label never shows under text that is still
 * being revealed; shorter than the pause between a result and the next call
 * on a slow step, which is the silence it exists to explain.
 */
const QUIET_MS = 700

/**
 * How much of a streaming tool input has arrived, without serializing it.
 *
 * The clock below only needs a number that *moves* as the input fills in, and
 * it used to get one from `JSON.stringify(input).length` — which is the whole
 * input re-serialized on every event of the turn, for a value that is then
 * thrown away. On the inputs this exists for that is the pathological case:
 * main scales its emit window precisely because a big `Write` or canvas page
 * reaches tens of kilobytes, and re-encoding it per emit is the cost the
 * scaling was added to bound, paid again one layer up. Summing string lengths
 * instead allocates nothing of size and changes on exactly the same emits.
 *
 * **It has to walk nested values, not just the top level.** A `Write`'s growth
 * is one top-level string, but an MCP tool's argument is an object and
 * `TodoWrite`'s is an array of them — count those as a constant and the clock
 * stops re-arming while the call is still filling in, so "Working…" appears
 * under a row that is visibly moving. Depth is bounded by `MAX_DEPTH` because
 * this runs per part per event and a tool input is shallow by construction;
 * past it the count is constant again, which is the same wrong answer as
 * before but only for a shape no provider produces.
 */
const MAX_DEPTH = 4

function partialWeight(input: unknown, depth = 0): number {
  if (typeof input === 'string') return input.length
  if (!input || typeof input !== 'object') return 1
  if (depth >= MAX_DEPTH) return 1
  let n = 0
  for (const value of Object.values(input as Record<string, unknown>)) {
    n += partialWeight(value, depth + 1)
  }
  return n
}

/** True when a message is nothing but read/search tool calls — each such call
 *  arrives as its own assistant message, so these are what pile up. A withheld
 *  thought riding along with one draws nothing (see `isBlankMsg`), so it must
 *  not break the run either: Claude Code puts one on almost every message, and
 *  a message-level test that counted it split a ten-call sequence into ten
 *  cards with a "Thought" row between each pair. */
function isGroupableMsg(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return false
  // Empty text is dropped alongside withheld thinking, because it draws exactly
  // as much: nothing. `isBlankMsg` already treats the two the same, and the
  // disagreement was load-bearing in the wrong direction — a `[text(''), tool]`
  // message broke a run that a `[thinking(''), tool]` one joined.
  const parts = m.parts.filter(
    (p) => !!p && !((p.type === 'thinking' || p.type === 'text') && !p.text)
  )
  return (
    parts.length > 0 && parts.every((p) => p.type === 'tool' && isGroupableTool(p.name))
  )
}

/** An assistant message that renders nothing — the CLI ships thinking blocks
 *  with their text withheld, and each one arrives as its own message. Left in
 *  the list it would both split a run of groupable tool calls in two and, being
 *  a zero-height flex item, open a message-sized gap where no message is.
 *
 *  Its reported *size* does not rescue it. A "Thought · 450 tokens" row is a
 *  number the reader can do nothing with, and one lands between every pair of
 *  tool calls — so the transcript became a ladder of token counts with the
 *  grouping they broke on either side. The live record of the model reasoning
 *  is the "Thinking…" / "Working…" indicator at the foot of the transcript,
 *  which runs for exactly as long as the turn does; a withheld thought leaves
 *  no trace in history, because it has nothing to say there. */
/** A `/btw` side question's row: in the transcript, never part of the agent's turn. */
const isBtwRow = (m: ChatMessage | undefined): boolean => m?.role === 'event' && m.kind === 'btw'

function isBlankMsg(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    m.parts.every((p) => !p || ((p.type === 'text' || p.type === 'thinking') && !p.text))
  )
}

interface RenderCtx {
  /** The chat being drawn. Edits and undos act on it, so it is part of the cache key. */
  chatId: string
  cwd: string
  busy: boolean
  onOpenPlan?: (plan: string) => void
  /** Assistant message id → the finished checklist to draw after it. */
  taskCompletions?: ReadonlyMap<string, TaskItem[]>
  /** Switch divider currently mid-handoff (brief still generating), if any. */
  switchPendingId?: string
  /**
   * Turns the reader has opened, by their user message id. Everything else that
   * has settled is folded down to its header and its answer.
   *
   * It comes from the store rather than from a `useState` inside the header,
   * because the header cannot reach the decision: folding is *omission* from
   * the flat array `renderMessages` returns, so the answer is needed one level
   * above any component the disclosure could own. `sameHistory` compares this
   * by identity — a toggle that mutated the set in place would leave the cached
   * history nodes exactly as they were and the click would draw nothing.
   */
  expandedTurns: ReadonlySet<string>
  onToggleTurn: (userMessageId: string) => void
  /** Calls a run needs to draw as a group (`groupMin`). */
  groupMin: number
}

/**
 * App Server builds before native plan-item support persisted the proposed plan
 * as assistant prose. While that plan is still awaiting review, replace only
 * the matching trailing block at render time with the same compact Plan row new
 * turns use. The stored transcript stays untouched.
 */
function withCompactLegacyCodexPlan(
  messages: ChatMessage[],
  plan: string,
  requestId: string
): ChatMessage[] {
  const expected = plan.trim()
  if (!expected) return messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]
      if (!part || part.type !== 'text') continue
      const planIndex = part.text.lastIndexOf(expected)
      if (planIndex < 0 || part.text.slice(planIndex + expected.length).trim()) continue
      const prefix = part.text.slice(0, planIndex).trim()
      const replacement: AssistantMessage['parts'] = [
        ...(prefix ? [{ type: 'text' as const, text: prefix }] : []),
        {
          type: 'tool',
          toolUseId: `legacy-codex-plan-${requestId}`,
          name: 'ExitPlanMode',
          input: { plan: expected },
          status: 'success'
        }
      ]
      const nextMessage: AssistantMessage = {
        ...message,
        parts: [
          ...message.parts.slice(0, partIndex),
          ...replacement,
          ...message.parts.slice(partIndex + 1)
        ]
      }
      const next = [...messages]
      next[messageIndex] = nextMessage
      return next
    }
  }
  return messages
}

/**
 * Early native-goal builds wrote a Markdown snapshot into the transcript after
 * every `/goal` command. The composer dock now owns that live state, so drawing
 * the persisted snapshot as well is both stale and duplicated. Keep the stored
 * history untouched and suppress only that exact generated event shape.
 */
function isLegacyCodexGoalSummary(message: ChatMessage): boolean {
  return (
    message.role === 'event' &&
    message.kind === 'info' &&
    message.text.startsWith('**Codex goal**\n- Objective: ') &&
    message.text.includes('\n- Status: ') &&
    message.text.includes('\n- Used: ')
  )
}

/** The key a run of groupable messages renders under, live or settled. */
const groupKey = (firstId: string): string => `grp-${firstId}`

/**
 * Renders the message list, collapsing runs of consecutive read/search-only
 * assistant messages into a single ToolGroup ("Read 12 files"). Since every tool
 * call is its own assistant message, a task that reads many files would otherwise
 * bury the conversation under a wall of identical cards.
 *
 * The keys and element shapes here are a contract with the live slot below
 * (`liveNode` in `ChatView`): a message renders under the *same* key, as the
 * same element type, whether it is the turn's live message or history — that
 * is what lets it cross over without React rebuilding it.
 *
 * **A turn also carries a header, and folding one is omission from this
 * array.** Every prompt is followed by a keyed `TurnHeader` sibling — never a
 * wrapper around the turn's nodes, which would put those nodes in a parent of
 * their own and remount every settled row the moment the turn ended. A folded
 * turn simply pushes fewer nodes: the header, the answer (from `foldTurns`'
 * boundary, which can fall mid-message), and the things that never fold — the
 * prompt itself, the event rows, and the turn's changes card.
 */
function renderMessages(all: ChatMessage[], ctx: RenderCtx): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let run: AssistantMessage[] = []
  const messages = all.filter((m) => !isBlankMsg(m) && !isLegacyCodexGoalSummary(m))
  const folds = foldTurns(messages)
  // The live turn is never folded. It is the last one, and only while the chat
  // is busy — the live assistant message itself is not in this slice (it is the
  // live node), so the prompt that opened it is still the last user message
  // here whether or not the reply has started.
  let lastFold: TurnFold | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastFold = folds.get(messages[i].id)
      break
    }
  }
  const liveUserId = ctx.busy ? lastFold?.userId : undefined
  // The last turn is *settled* only when the chat is idle **and** nothing in
  // it is still working. A turn whose background agents are still running is
  // idle between their notifications — the CLI ends the turn, then starts a
  // continuation under the same prompt when each one reports — and a changes
  // card drawn at each of those pauses would be taken back at each
  // continuation, along with the mutation rows it stands in for.
  const settled = !ctx.busy && !lastFold?.running
  const presentations = turnPresentations(messages, ctx.cwd, !settled)

  /** The turn being walked, and whether its work is folded away. */
  let fold: TurnFold | undefined
  let folded = false
  /**
   * The turn being walked is still working, so its activity runs stay open.
   *
   * The same `live` the header is given below, hoisted to where `flush` can
   * reach it. `flush` for a turn's run always runs *before* the next prompt
   * reassigns these, so the value a run reads is its own turn's.
   */
  let turnLive = false
  /** Within a folded turn: has the walk reached the answer yet? */
  let reachedAnswer = false

  /**
   * How much of an assistant message survives the fold — called once per
   * message, in order, because reaching the answer is what ends the folding.
   */
  const foldOf = (m: AssistantMessage): { hidden: boolean; fromPart?: number } => {
    if (!folded || reachedAnswer) return { hidden: false }
    const from = fold?.answerFrom
    if (from && from.messageId === m.id) {
      reachedAnswer = true
      return { hidden: false, fromPart: from.partIndex }
    }
    return { hidden: true }
  }

  const renderAssistant = (m: AssistantMessage): React.ReactNode => {
    const turn = presentations.get(m.id)
    const showSummary = turn?.summary?.id === m.id
    const finishedTasks = ctx.taskCompletions?.get(m.id)
    const { hidden, fromPart } = foldOf(m)
    // A folded message is still *rendered*, at a boundary past its last part:
    // everything is hidden, but a call that produced a screenshot still shows
    // the picture (see `AssistantBlock`). It returns null when nothing is left,
    // so a message with no images costs the same nothing it did before.
    // The three slots stay positional whatever is drawn: `false` holds a place
    // where an element would be, so the block at position 0 still meets the
    // live node's own position 0 when a message crosses out of the live slot.
    return (
      <React.Fragment key={m.id}>
        <AssistantBlock
          message={m}
          cwd={ctx.cwd}
          streaming={false}
          onOpenPlan={ctx.onOpenPlan}
          summarizeEdits={turn?.hasChanges ?? false}
          fromPart={hidden ? m.parts.length : fromPart}
          turnLive={turnLive}
        />
        {/* A finished checklist hangs off this message, so it folds with it —
            and stays when the message is only *partly* folded, since the block
            it belongs to is still on screen. */}
        {!hidden && finishedTasks && <TasksCard tasks={finishedTasks} />}
        {/* What a turn changed is the turn's result, not its work: it survives
            the fold the way the answer does. */}
        {showSummary && turn?.summary && (
          <TurnChangesCard
            message={turn.summary}
            cwd={ctx.cwd}
            chatId={ctx.chatId}
            userMessageId={turn.userMessageId}
          />
        )}
      </React.Fragment>
    )
  }

  const flush = (): void => {
    // Called at every non-groupable message, so most calls have nothing in hand.
    if (run.length === 0) return
    // **Counted in tool calls, not in messages, because `liveRun` counts calls.**
    // Claude ships one call per assistant message, so for it the two agree; a
    // provider that puts two calls in one message did not, and the disagreement
    // is a remount at the live→history handoff: `liveRun` drew a top-level
    // `ToolGroup` and this drew `Fragment > AssistantBlock > ToolGroup`, a
    // different parent under a different key, so every settled row in the run
    // was rebuilt the moment the turn moved on. A run is a run at the same size
    // on both sides of the seam.
    const runCalls = run.reduce(
      (n, m) => n + m.parts.filter((p) => !!p && p.type === 'tool').length,
      0
    )
    if (runCalls >= ctx.groupMin) {
      // A run of tool-only messages is work by definition — it can never be the
      // turn's answer — so a folded turn omits the group and the checklist hung
      // off its last message, and keeps the changes card, which is the turn's
      // result rather than its work. The card is pushed under the same key
      // either way, so folding and unfolding never rebuild it.
      const hidden = folded && !reachedAnswer
      const last = run[run.length - 1]
      if (hidden) {
        // Same rule as a folded message: the rows go, the pictures stay. A run
        // of read/search calls rarely carries one, but a browser or preview
        // sequence is exactly a run, and it is all screenshots.
        const images = run.flatMap((message) =>
          message.parts.flatMap((part) =>
            part && part.type === 'tool' ? (part.outputImages ?? []) : []
          )
        )
        if (images.length) {
          out.push(<ToolOutputImages key={`images-${run[0].id}`} images={images} />)
        }
        // A chart or diagram the run drew is a result the same way.
        for (const message of run) {
          for (const part of message.parts) {
            if (part?.type === 'tool' && part.status === 'success' && isInlineVisual(part)) {
              out.push(<InlineVisual key={`visual-${part.toolUseId}`} part={part} />)
            }
          }
        }
        // …and the agents stay too: a spawned agent outlives the turn that
        // started it, and its card is the way back into its column.
        const agents = run.flatMap((message) =>
          message.parts.filter((part): part is ToolPart => !!part && part.type === 'tool' && isAgentish(part))
        )
        if (agents.length === 1) {
          out.push(<AgentPartRow key={`agent-${agents[0].toolUseId}`} part={agents[0]} />)
        } else if (agents.length > 1) {
          out.push(<AgentGroupCard key={`agents-${run[0].id}`} parts={agents} />)
        }
      }
      if (!hidden) {
        const turn = presentations.get(run[0].id)
        const parts = run.flatMap((m) =>
          m.parts.filter((p): p is ToolPart => !!p && p.type === 'tool')
        )
        const visibleParts = turn?.hasChanges
          ? parts.filter(
              (part) => !(part.status === 'success' && FILE_MUTATION_TOOLS.has(part.name))
            )
          : parts
        if (visibleParts.length >= ctx.groupMin) {
          out.push(
            <ToolGroup
              key={groupKey(run[0].id)}
              parts={visibleParts}
              cwd={ctx.cwd}
              // An earlier batch of a turn that is still working. Without this
              // the group folded the instant the turn's next sentence began —
              // see `ToolGroup`'s `live`.
              live={turnLive}
            />
          )
        } else if (visibleParts.length === 1) {
          out.push(
            <ToolCard key={visibleParts[0].toolUseId} part={visibleParts[0]} cwd={ctx.cwd} />
          )
        }
        const finishedTasks = ctx.taskCompletions?.get(last.id)
        if (finishedTasks) {
          out.push(<TasksCard key={`tasks-${last.id}`} tasks={finishedTasks} />)
        }
      }
      const lastTurn = presentations.get(last.id)
      if (lastTurn?.summary?.id === last.id) {
        out.push(
          <TurnChangesCard
            key={`changes-${last.id}`}
            message={lastTurn.summary}
            cwd={ctx.cwd}
            chatId={ctx.chatId}
            userMessageId={lastTurn.userMessageId}
          />
        )
      }
    } else {
      // Too short to group — these draw as ordinary blocks, which is also where
      // the fold is applied to them (`renderAssistant` → `foldOf`).
      for (const m of run) out.push(renderAssistant(m))
    }
    run = []
  }

  let lastAssistantId: string | undefined
  for (const m of messages) {
    if (m.role === 'assistant') lastAssistantId = m.id
    if (m.role === 'assistant' && isGroupableMsg(m)) {
      run.push(m)
      continue
    }
    flush()
    if (m.role === 'user') {
      out.push(<UserBubble key={m.id} message={m} chatId={ctx.chatId} />)
      // The turn's header, as a keyed sibling of everything below it. It is
      // pushed on the prompt rather than on the first reply so it is there the
      // moment the message is sent — the send's own acknowledgement, before
      // anything has come back to hang it on.
      fold = folds.get(m.id)
      // A turn whose work outlives it (a backgrounded agent, still running
      // between the notifications that wake the model) is *live*, not settled,
      // however idle the chat is between them: its header keeps ticking
      // "Working for", it neither folds nor offers the control — the rhythm
      // `useRunDisclosure` gives a running group, at turn scale — and the
      // continuation lands under a header that never stopped. Folding it would
      // take a card that is still moving off screen.
      const live = !!fold && (fold.userId === liveUserId || fold.running)
      turnLive = live
      // A turn the CLI has already closed once and that is live again is a
      // *continuation* (`TurnFold.closed`): it folded when it closed, and the
      // continuation streams under the fold rather than throwing the work open
      // — otherwise a backgrounded shell's notification, or any wake-up with
      // no prompt behind it, is the turn expanding and collapsing under the
      // reader once per wake. A turn whose own work is still running is not in
      // that state: nothing of it has folded.
      const continuing = live && !!fold && fold.closed && !fold.running
      folded = !!fold && (!live || continuing) && !ctx.expandedTurns.has(m.id)
      reachedAnswer = false
      if (fold && (live || fold.replied)) {
        out.push(
          <TurnHeader
            key={`turn-${m.id}`}
            userMessageId={m.id}
            startTs={fold.startTs}
            endTs={fold.endTs}
            live={live}
            // A turn that is folded can always be opened, live or not; one
            // that is live and has never folded offers nothing.
            collapsible={fold.collapsible && (!live || continuing)}
            expanded={!folded}
            onToggle={ctx.onToggleTurn}
          />
        )
      }
    }
    else if (m.role === 'assistant') out.push(renderAssistant(m))
    else {
      // The stats row that closes a turn carries the copy control, and copies
      // the fold's answer (`TurnFold.answer`) — what the folded turn shows, not
      // the preamble folded away with the work. The gate is whether the turn is
      // complete: an event message is not in `presentations` (it walks users
      // and assistants), so that is read through the last assistant seen, whose
      // `summary` is only set once the turn has ended — a turn still running has
      // no answer to copy. An interim stats row (`workEvents`) sits above the
      // answer, so it does not offer it.
      const closing = lastAssistantId ? presentations.get(lastAssistantId)?.summary : undefined
      const answer =
        m.kind === 'turn' && closing && fold && !fold.workEvents.has(m.id)
          ? fold.answer
          : undefined
      // A stats row the CLI pushed mid-turn — a background task's notification
      // woke the model and the turn went on under the same prompt — is work,
      // and folds with it. Only the row that actually closes the turn is an
      // event row in the "never folded" sense.
      if (folded && fold?.workEvents.has(m.id)) continue
      out.push(
        <EventRow
          key={m.id}
          message={m}
          pending={m.id === ctx.switchPendingId}
          answer={answer || undefined}
          cwd={ctx.cwd}
        />
      )
    }
  }
  flush()
  return out
}

interface HistoryRender {
  messages: ChatMessage[]
  end: number
  ctx: RenderCtx
  nodes: React.ReactNode[]
}

/**
 * The settled part of the transcript, as a cached array of elements.
 *
 * Two things have to be true of it at once, and a component can only give one.
 * History must stay out of the live-stream render loop: zustand replaces the
 * active assistant message on every delta but preserves every earlier message
 * object, so a reference walk over the prefix is enough to know nothing there
 * moved, and the same *element objects* are handed back — React skips a child
 * whose element is identical to last time, so a streamed token re-renders
 * nothing above the live message. That half used to be a memoized
 * `MessageHistory` component, and it was right.
 *
 * But it also has to share a parent with the live message. A component's
 * children are their own subtree, so when the turn's message crossed from the
 * live slot into history it changed parents, and React cannot match keys
 * across parents: the whole message was unmounted and mounted again. On
 * Claude that fired the moment the *next* message opened — every settled Edit
 * or Bash row replayed its enter animation once its call had returned, every
 * finished reply was re-parsed as the next step began; on both providers it
 * fired again at the turn's end, for the last message. Returning the nodes to
 * `ChatView` instead lets it spread them into one keyed array with the live
 * node, where a message that stops being live is the same key in the same
 * parent, and crossing over is a prop change.
 */
function useHistoryNodes(messages: ChatMessage[], end: number, ctx: RenderCtx): React.ReactNode[] {
  const cache = React.useRef<HistoryRender | null>(null)
  return React.useMemo(() => {
    const prev = cache.current
    if (prev && sameHistory(prev, messages, end, ctx)) return prev.nodes
    const nodes = renderMessages(messages.slice(0, end), ctx)
    cache.current = { messages, end, ctx, nodes }
    return nodes
  }, [messages, end, ctx])
}

function sameHistory(
  prev: HistoryRender,
  messages: ChatMessage[],
  end: number,
  ctx: RenderCtx
): boolean {
  if (
    prev.end !== end ||
    prev.ctx.chatId !== ctx.chatId ||
    prev.ctx.cwd !== ctx.cwd ||
    // `busy` is what flips the last turn from live to settled: its header stops
    // ticking and the turn folds. Left out here, the cached nodes would survive
    // the turn's end and the header would count upwards forever.
    prev.ctx.busy !== ctx.busy ||
    prev.ctx.onOpenPlan !== ctx.onOpenPlan ||
    prev.ctx.switchPendingId !== ctx.switchPendingId ||
    prev.ctx.taskCompletions !== ctx.taskCompletions ||
    prev.ctx.expandedTurns !== ctx.expandedTurns ||
    prev.ctx.onToggleTurn !== ctx.onToggleTurn ||
    prev.ctx.groupMin !== ctx.groupMin
  ) {
    return false
  }
  for (let i = 0; i < end; i++) {
    if (prev.messages[i] !== messages[i]) return false
  }
  return true
}

export interface TranscriptView {
  /** History and the live block in ONE keyed array — see `useHistoryNodes`. */
  nodes: React.ReactNode[]
  /** The turn's indicator slot is held while this is true. */
  showActivity: boolean
  activityLabel: string
  /** …and its label drawn only while this is. */
  showActivityLabel: boolean
  /** The live checklist, for a dock; a finished one is drawn in `nodes`. */
  tasks: TaskItem[]
}

export function useTranscript({
  chat,
  messages,
  busy,
  permissions,
  expandedTurns,
  onToggleTurn,
  onOpenPlan
}: {
  chat: ChatMeta
  messages: ChatMessage[]
  busy: boolean
  permissions: PermissionRequestPayload[]
  expandedTurns: ReadonlySet<string>
  onToggleTurn: (userMessageId: string) => void
  /** Stable across renders, or every settled row re-renders with it. */
  onOpenPlan?: (plan: string, requestId: string | null) => void
}): TranscriptView {
  // The live turn's message — only the *last* message counts, so a just-sent user
  // message (before the reply starts) isn't mistaken for the previous reply.
  //
  // Last, that is, but for `/btw` rows after it. A side question asked while a
  // reply streams lands after that reply, and the reply goes on streaming
  // above it; read strictly, the live message would drop into history for the
  // rest of the step and every token would re-walk the whole history render.
  // Those rows are drawn after the live block instead (`trailing`).
  let liveIndex = messages.length - 1
  while (liveIndex >= 0 && isBtwRow(messages[liveIndex])) liveIndex--
  const lastMsg = messages[liveIndex]
  const liveAssistant = busy && lastMsg?.role === 'assistant' ? lastMsg : undefined
  // Has the live *turn* shown anything yet? Scanned back to the prompt that
  // started it rather than read off the last message alone: the CLI opens a
  // fresh assistant message per thinking block, and each one arrives empty —
  // so keyed on the last message, the label fell back to "Thinking…" after
  // every tool call and returned to "Working…" on the next, once per step.
  // Thinking *text* counts (Codex streams its reasoning visibly), which is what
  // keeps the foot from reading "Thinking…" two lines under a block header
  // that already does; Claude withholds the text, so there it stays honest.
  const producedSomething = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') break
      if (
        m.role === 'assistant' &&
        m.parts.some((p) => p && (p.type === 'tool' || p.text.length > 0))
      )
        return true
    }
    return false
  }, [messages])
  // The turn's indicator has a *slot* for exactly as long as the turn runs, and
  // a *label* only while nothing else on screen is moving.
  //
  // The slot is the part that must not come and go. It used to stand down
  // whenever the tail was a running tool, and between any two calls in a run
  // there is a moment when the last has returned and the next has not started
  // — so the row unmounted and remounted once per call, and the ~28px it takes
  // moved the foot of the column (and the follow-scroll with it) each time. So
  // the height is reserved while the chat is busy, whatever the label does.
  //
  // The label is the part that must not *repeat*. Drawn unconditionally it sat
  // under a tool row that already carried a spinner, and under a paragraph that
  // was itself still growing — "Working…" beneath the work, twice over. So it
  // draws in exactly two states: before the turn has produced anything (the
  // only feedback the send gets), and once the tail has been still for
  // `QUIET_MS` with no spinner in the live block — the pause after a paragraph
  // or a result, where a silent transcript would otherwise read as a hang. A
  // gap shorter than that between two calls shows nothing, which is what keeps
  // a run from blinking a label per call.
  // The prompts moved onto the composer, so the transcript no longer holds the
  // one thing that said the turn was blocked. Gating the slot on
  // `permissions.length === 0` would now leave the foot empty at exactly the
  // moment the reader is looking at it and nothing anywhere is moving — a
  // finished-looking turn that is in fact waiting. It says so instead, and
  // *immediately*: `QUIET_MS` exists to tell a lull from a pause between two
  // steps, and there is nothing to disambiguate when the agent has stopped to
  // ask.
  const awaitingAnswer = permissions.length > 0
  const showActivity = busy
  // "Fold activity while working" makes the foot the turn's *next step*: it
  // says "Thinking…" the moment a step lands and gives way to the step that
  // follows, rather than "Working…" after a lull (see `showActivityLabel`).
  const foldActivity = useApp((s) => s.foldActivity)
  // "Thinking…" until the model has produced something this turn; "Working…" after.
  const activityLabel = awaitingAnswer
    ? 'Waiting for your answer…'
    : producedSomething && !foldActivity
      ? 'Working…'
      : 'Thinking…'

  const pendingPlanRequest = permissions.find((r) => r.toolName === 'ExitPlanMode')
  const pendingPlan = (pendingPlanRequest?.input as { plan?: unknown } | null)?.plan
  const displayedMessages = React.useMemo(
    () =>
      chat.provider === 'codex' &&
      pendingPlanRequest &&
      typeof pendingPlan === 'string'
        ? withCompactLegacyCodexPlan(messages, pendingPlan, pendingPlanRequest.id)
        : messages,
    [chat.provider, messages, pendingPlan, pendingPlanRequest]
  )

  // The chat's checklist, folded out of the whole loaded window: Claude Code's
  // TaskCreate/TaskUpdate calls carry no list of their own, and a TaskUpdate's
  // matching TaskCreate is never in the same message, so nothing smaller than
  // the window can answer. Cheap in practice — the window is HYDRATE_TAIL
  // -bounded, and a chat with no checklist costs one name check per tool part.
  //
  // It answers two things at once, and has to: `tasks` is the live list the
  // dock draws, `completions` is where a *finished* list lands in the
  // transcript instead — one is empty exactly when the other holds it. The
  // blank messages are filtered here rather than downstream because
  // `renderMessages` drops them too, and an anchor on a message nothing draws
  // is a card nothing draws. `reconcileTimeline` keeps both halves at their old
  // identity when nothing moved, so a streamed token re-renders neither the
  // dock nor the history.
  const timelineRef = React.useRef<TaskTimeline>(NO_TASK_TIMELINE)
  const timeline = React.useMemo(() => {
    const next = reconcileTimeline(
      timelineRef.current,
      foldTaskTimeline(
        messages.filter((m) => !isBlankMsg(m)),
        busy
      )
    )
    timelineRef.current = next
    return next
  }, [messages, busy])
  const tasks = timeline.tasks

  const openPlan = React.useCallback(
    (plan: string) => onOpenPlan?.(plan, pendingPlanRequest?.id ?? null),
    [onOpenPlan, pendingPlanRequest?.id]
  )


  const historyEnd = liveAssistant ? liveIndex : messages.length
  // A live message that is itself only tool calls joins the trailing run of
  // tool-only history messages in ONE live ToolGroup — the same row history
  // will render once the turn ends. Without this, each new search/read/agent
  // streams as its own card and only collapses after the fact (each call is
  // its own assistant message on the Claude side, unlike Codex's single
  // accumulating message).
  const liveRun = React.useMemo(() => {
    // A blank live message keeps the run alive rather than ending it — the same
    // rule the walk below already applies to previous messages, and the live
    // check simply disagreed with it. The CLI ships each withheld thought as its
    // own message, so one lands between *every* pair of tool calls; ending the
    // run on it tore the group out of the live slot and remounted it from
    // history, collapsed, once per call. Nothing was drawn in the gap, so the
    // whole effect was a row folding and unfolding under the reader with no
    // content to show for it.
    if (!liveAssistant || !(isGroupableMsg(liveAssistant) || isBlankMsg(liveAssistant))) {
      return null
    }
    let start = historyEnd
    while (start > 0) {
      const prev = displayedMessages[start - 1]
      if (prev.role === 'assistant' && (isGroupableMsg(prev) || isBlankMsg(prev))) start -= 1
      else break
    }
    const members = [...displayedMessages.slice(start, historyEnd), liveAssistant]
    const parts = members.flatMap((m) =>
      m.role === 'assistant'
        ? m.parts.filter((p): p is ToolPart => !!p && p.type === 'tool')
        : []
    )
    if (parts.length < groupMin(foldActivity)) return null
    // Keyed as history will key it — off the run's first message that draws,
    // since `renderMessages` drops the blank ones before it names a run — so
    // the group folds in place when the turn ends instead of being remade.
    const first = members.find((m) => !isBlankMsg(m)) ?? liveAssistant
    return { start, parts, key: groupKey(first.id) }
  }, [liveAssistant, displayedMessages, historyEnd, foldActivity])
  // Where the label draws — see `showActivity` above for the slot.
  // A thought with text is Codex's shape (Claude withholds the text): while it
  // is the message's last part, `ThinkingBlock` shimmers "Thinking…" — through
  // the pause after the last reasoning delta too — so that header is the
  // motion, and "Working…" two lines under it would say the same thing twice.
  const livePart = liveAssistant?.parts[liveAssistant.parts.length - 1]
  const thinkingShown = livePart?.type === 'thinking' && livePart.text.length > 0
  // Folded, the turn moves in *steps*: a trailing run of calls is one step
  // from its first call until the model writes text, gaps between its calls
  // included (`ToolGroup`'s `active`). Keyed on a call running, the step read
  // "Ran" and "Thinking…" in every gap and flipped back at the next call.
  // `liveRun` is Claude's shape; Codex accumulates the turn into one message,
  // so there the step is the message's trailing call.
  const tailPart = liveAssistant?.parts.findLast(
    (p) => !!p && (p.type === 'tool' || p.text.length > 0)
  )
  const activeTail = !!liveRun || tailPart?.type === 'tool'
  const tailMoving = foldActivity
    ? activeTail || thinkingShown
    : liveRun
      ? groupRunning(liveRun.parts)
      : !!liveAssistant &&
        (thinkingShown ||
          groupRunning(liveAssistant.parts.filter((p): p is ToolPart => !!p && p.type === 'tool')))
  // The clock is what the tail *draws*, not the last message's identity.
  // Every streamed event replaces the message object, and several of them draw
  // nothing — a withheld thought's once-a-second token ping, a blank thinking
  // message opening between two of Claude's calls, a reasoning item Codex
  // re-states on completion with no text in it. Keyed on identity, each of
  // those hid the label and showed it again `QUIET_MS` later, two or three
  // times per step, which read as flashing. So the key is the drawn shape of
  // the last message that draws anything: each call's status and how much of
  // its input has arrived, each text's length; blank parts and blank messages
  // contribute nothing and re-arm nothing.
  const drawn = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') return ''
      if (isBlankMsg(m)) continue
      return (
        m.id +
        ':' +
        m.parts
          .map((p) =>
            !p
              ? ''
              : p.type === 'tool'
                ? p.status + (p.partial ? '~' + partialWeight(p.input) : '')
                : p.text.length
                  ? String(p.text.length)
                  : ''
          )
          // Dropped before the join, not after: a blank part that stayed in
          // the array would still add a separator, and that separator was
          // enough to re-arm the clock once per blank reasoning item.
          .filter(Boolean)
          .join(',')
      )
    }
    return ''
  }, [messages])
  const [quiet, setQuiet] = React.useState(false)
  React.useEffect(() => {
    // Re-armed on every drawn change and fires only in a lull.
    // `setQuiet(false)` on an already-false state is a bail-out, not a render.
    setQuiet(false)
    if (!busy) return undefined
    const t = setTimeout(() => setQuiet(true), QUIET_MS)
    return () => clearTimeout(t)
  }, [drawn, busy])
  // Folded, the label is the step *after* the prose: hidden while a run of
  // calls trails (that row is the step), drawn at once when a thought opens
  // after text, and otherwise `QUIET_MS` after a text tail — nothing marks a
  // paragraph finished, and the label must not sit under one still growing.
  const tailText = tailPart?.type === 'text'
  const showActivityLabel =
    showActivity &&
    (awaitingAnswer ||
      !producedSomething ||
      (!tailMoving && (foldActivity ? !tailText || quiet : quiet)))
  // The most recent switch divider renders live ("writing handoff brief…")
  // exactly while main reports the handoff in flight; the busy gate means a
  // crash or restart can never leave a divider shimmering forever.
  const switchPendingId = React.useMemo(() => {
    if (!busy || !chat.switchingNote) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'event' && m.kind === 'switch') return m.id
    }
    return undefined
  }, [busy, chat.switchingNote, messages])
  const historyCtx = React.useMemo<RenderCtx>(
    () => ({
      chatId: chat.id,
      cwd: chat.cwd,
      busy,
      onOpenPlan: openPlan,
      switchPendingId,
      taskCompletions: timeline.completions,
      expandedTurns,
      onToggleTurn,
      groupMin: groupMin(foldActivity)
    }),
    [
      chat.id,
      chat.cwd,
      busy,
      openPlan,
      switchPendingId,
      timeline.completions,
      expandedTurns,
      onToggleTurn,
      foldActivity
    ]
  )
  const historyNodes = useHistoryNodes(
    displayedMessages,
    liveRun ? liveRun.start : historyEnd,
    historyCtx
  )
  // The turn's live block, under exactly the key and element shape
  // `renderMessages` will give the same message once it is history — a
  // run's group under the run's key, a lone message under its own id inside
  // the same Fragment. Both go into ONE keyed array below, so when the turn
  // moves on React updates the block in place rather than rebuilding it.
  const liveNode = liveRun ? (
    <ToolGroup key={liveRun.key} parts={liveRun.parts} cwd={chat.cwd} live active />
  ) : liveAssistant ? (
    <React.Fragment key={liveAssistant.id}>
      {/* The live message of a live turn, so its runs stay open — and it takes
          exactly the props `renderMessages` will give this same message once it
          is history, so crossing over is a prop change rather than a rebuild. */}
      <AssistantBlock
        message={liveAssistant}
        cwd={chat.cwd}
        streaming
        onOpenPlan={openPlan}
        turnLive={busy}
      />
    </React.Fragment>
  ) : null

  // Under the keys `renderMessages` gives them, in the same array, so a row
  // that history takes over once the next step opens is updated in place.
  const trailing = liveAssistant
    ? displayedMessages
        .slice(liveIndex + 1)
        .map((m) =>
          m.role === 'event' ? <EventRow key={m.id} message={m} cwd={chat.cwd} /> : null
        )
    : []

  return {
    nodes: liveNode ? [...historyNodes, liveNode, ...trailing] : historyNodes,
    showActivity,
    activityLabel,
    showActivityLabel,
    tasks
  }
}

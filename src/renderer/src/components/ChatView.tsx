import * as React from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  FileDiff,
  Folder,
  GitBranch,
  MessageSquarePlus,
  X
} from 'lucide-react'
import type { AssistantMessage, ChatMessage, ChatMeta, ToolPart } from '@shared/types'
import { PROVIDER_SHORT_LABELS, projectRoot } from '@shared/types'
import { CHAT_BLEED } from '@/lib/chatColumn'
import { basename } from '@/lib/format'
import { messagesOf, severalChatsShown, useApp } from '@/store'
import { useTaskList } from '@/taskListStore'
import { useAgents } from '@/agentsStore'
import { foldAgentRuns, reconcileAgentRuns, type AgentRunView } from '@shared/agentRuns'
import { foldTaskTimeline, NO_TASK_TIMELINE, reconcileTimeline } from '@/lib/taskList'
import type { TaskItem, TaskTimeline } from '@/lib/taskList'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/Composer'
import { CodexReviewMenu } from '@/components/CodexReviewDialog'
import { ContextStrip } from '@/components/ContextStrip'
import { AgentActivityBar } from '@/components/AgentsPanel'
import { TaskDock } from '@/components/TaskDock'
import { CodexGoalBar } from '@/components/CodexGoalBar'
import {
  AssistantBlock,
  EventRow,
  StreamingIndicator,
  UserBubble
} from '@/components/messages/Parts'
import {
  FILE_MUTATION_TOOLS,
  groupRunning,
  isGroupableTool,
  ToolCard,
  ToolGroup,
  ToolOutputImages
} from '@/components/messages/ToolCard'
import { PromptDock } from '@/components/PromptDock'
import { TasksCard } from '@/components/messages/TasksCard'
import { TurnChangesCard } from '@/components/messages/TurnChangesCard'
import { TurnHeader } from '@/components/messages/TurnHeader'
import { turnPresentations } from '@/lib/turnChanges'
import { foldTurns, type TurnFold } from '@/lib/turnFold'

const NO_PERMISSIONS: never[] = []
const NO_QUEUED: never[] = []

/** Coalesce a run of this many consecutive read/search-only messages into one row. */
const GROUP_MIN = 2

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
    if (runCalls >= GROUP_MIN) {
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
        if (visibleParts.length >= GROUP_MIN) {
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
      // take a card that is still moving off screen, and take with it the node
      // `AgentsPanel`'s row click scrolls to.
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
    prev.ctx.onToggleTurn !== ctx.onToggleTurn
  ) {
    return false
  }
  for (let i = 0; i < end; i++) {
    if (prev.messages[i] !== messages[i]) return false
  }
  return true
}

/**
 * A terminal chat's CLI pane. Lazy for the reason the right panel's tabs are:
 * xterm is ~410 KB and most chats never draw one — and `preloadHeavyChunks`
 * already fetches this module on idle, so opening one waits on nothing.
 */
const ChatTerminal = React.lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.ChatTerminal }))
)

/**
 * One chat's transcript and composer — a column of a thread. The thread's
 * header, its ⋯ menu and their dialogs belong to `ThreadView`, which draws one
 * of these per chat.
 */
export const ChatView = React.memo(function ChatView({
  chat,
  side = false
}: {
  chat: ChatMeta
  /**
   * A **side chat** — any column but the thread's first. Its transcript lives
   * in a keyed slot rather than the store's bare fields, it never draws as a
   * terminal (only a chat the sidebar can show is one), and it leaves the
   * project strip to the first column, which already names the folder and
   * branch every column shares.
   */
  side?: boolean
}): React.JSX.Element {
  // The CLI draws this chat itself, in a pty, where the transcript and composer
  // would be. Everything else on screen is unchanged — header, ⋯ menu, right
  // panel, sidebar row — because none of it reads messages. A side chat is
  // never one: the flag is only ever set on a chat the sidebar can show.
  const terminalSurface = chat.surface === 'terminal' && !side

  // Read by id: the thread's first chat keeps the store's singular slice, every
  // other column a keyed slot (`messagesOf`). Everything else about a chat is
  // already keyed by id.
  const messages = useApp((s) => messagesOf(s, chat.id))
  const hiddenBefore = useApp((s) =>
    chat.id === s.activeId ? s.hiddenBefore : (s.sideChats[chat.id]?.hiddenBefore ?? 0)
  )
  // With several chats on screen, a composer nobody is writing in folds to its
  // input line — see `Composer`'s `collapsible`.
  const collapsible = useApp(severalChatsShown)
  // The folder, branch and changes chips describe the thread, which every
  // column shares. With several chats on screen the thread header carries them
  // once; otherwise they sit above the one conversation showing — the thread's
  // own chat, or whichever column is expanded.
  const stripHere = useApp(
    (s) => !severalChatsShown(s) && (s.expandedChatId ?? s.activeId) === chat.id
  )
  const loadingOlder = useApp((s) =>
    chat.id === s.activeId ? s.loadingOlder : !!s.sideChats[chat.id]?.loadingOlder
  )
  const loadOlderMessages = useApp((s) => s.loadOlderMessages)
  const status = useApp((s) => s.statuses[chat.id] ?? 'idle')
  // Fall back to a stable constant — a fresh `[]` per render makes zustand's
  // snapshot comparison always fail and loops React into a crash.
  const lockedElsewhere = useApp((s) => !!s.lockedChats[chat.id])
  const permissions = useApp((s) => s.permissions[chat.id] ?? NO_PERMISSIONS)
  const queued = useApp((s) => s.queued[chat.id] ?? NO_QUEUED)
  const removeQueued = useApp((s) => s.removeQueued)
  const sendQueuedNow = useApp((s) => s.sendQueuedNow)
  const git = useApp((s) => s.git)
  const commands = useApp((s) => s.commands)
  const openPlanPanel = useApp((s) => s.openPlanPanel)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const runGitAction = useApp((s) => s.runGitAction)
  const worktreeNotice = useApp((s) =>
    s.worktreeNotice?.chatId === chat.id ? s.worktreeNotice.kind : null
  )
  const dismissWorktreeNotice = useApp((s) => s.dismissWorktreeNotice)
  const sendMessage = useApp((s) => s.sendMessage)
  const startCodexReview = useApp((s) => s.startCodexReview)
  const interrupt = useApp((s) => s.interrupt)
  const setChatOptions = useApp((s) => s.setChatOptions)
  const saveChatDraft = useApp((s) => s.saveChatDraft)
  // Read imperatively, not subscribed: the composer writes a debounced copy back
  // a couple of times a second while you type, and a subscription here would
  // re-render the whole transcript on every one of them. `App` keys this
  // component by chat id, so a mount *is* a chat switch — which is the only
  // moment the draft needs reading.
  const initialDraft = React.useMemo(() => useApp.getState().chatDrafts[chat.id], [chat.id])
  const modelEfforts = useApp((s) => s.defaults?.modelEfforts)
  // A cross-provider pick is only armed until the next send; the composer
  // previews its provider (efforts, placeholder, labels) while the chat itself
  // stays on the current backend.
  const composerProvider =
    chat.pendingModel !== undefined ? (chat.pendingProvider ?? chat.provider) : chat.provider
  // Which settled turns are showing their work. A gesture, not a stream: this
  // changes on a click and nowhere else, so subscribing the transcript to it
  // costs nothing between clicks — and it has to be read here rather than in
  // the header, since folding is decided while the node array is built.
  const expandedTurns = useApp((s) => s.expandedTurns)
  const toggleTurnExpanded = useApp((s) => s.toggleTurnExpanded)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  /** The reading column inside the scroller — what the follow observer measures. */
  const columnRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  /**
   * Distance from the BOTTOM of the scroller, captured just before older
   * messages are prepended. Anchoring on the bottom rather than on scrollTop is
   * what keeps the message under the cursor still: prepending changes
   * scrollHeight, and the gap below the viewport is the part that doesn't move.
   */
  const bottomAnchor = React.useRef<number | null>(null)
  const [showJump, setShowJump] = React.useState(false)
  const [reviewOpen, setReviewOpen] = React.useState(false)

  const busy = status !== 'idle'

  const scrollToBottom = React.useCallback((smooth = false): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // Fires per scroll event — dozens a second on a wheel — so the state write
  // is skipped unless the answer moved; the pin itself is a ref and free.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    if (pinned === pinnedRef.current) return
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }

  // Follow the stream while the user is pinned to the bottom.
  //
  // This keys on the column's *height*, not on the store. A store-keyed effect
  // (`[messages, permissions, status]`) was the first version, and it missed
  // most of what actually moves the bottom edge: `useStreamText` reveals words
  // on animation frames *between* deltas, releases the held last word 400ms
  // after the final one with no store change at all, images decode late, a
  // code block's rows land one at a time, and a collapsible animates its height
  // over 200ms. Each of those grew the column under a scroller that was still
  // parked at the previous height, so the reply's last line sat just below the
  // fold — a lag that read as the stream stuttering. A ResizeObserver fires
  // after layout for every one of them, and `pinnedRef` is the only guard it
  // needs: `loadEarlier` unpins before it prepends, so a prepend never snaps
  // the reader back down. The scroller itself is observed too, so a window
  // resize while pinned keeps the bottom rather than the top.
  React.useEffect(() => {
    const scroller = scrollRef.current
    const column = columnRef.current
    if (!scroller || !column) return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom()
    })
    observer.observe(column)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scrollToBottom])

  // Jump to the bottom when switching chats.
  React.useEffect(() => {
    pinnedRef.current = true
    // The scroll handler now writes state only on a transition, so the pin
    // and the control have to be reset together here rather than by the
    // scroll event that follows.
    setShowJump(false)
    requestAnimationFrame(() => scrollToBottom())
  }, [chat.id, scrollToBottom])

  /**
   * Fold or unfold a turn, animated, with the row you clicked held still.
   *
   * **A view transition rather than a height animation**, because there is
   * nothing here whose height could animate: a fold is *omission from a flat
   * keyed array* (see `renderMessages`), so the nodes that leave have no shared
   * parent, and giving them one is precisely what `useHistoryNodes` forbids —
   * every settled row in the turn would remount the moment the turn ended.
   * Chromium snapshots the viewport, so the cost is bounded by what is on
   * screen rather than by the length of the transcript.
   *
   * The scroll correction is not optional and has to run *inside* the
   * transition callback, before the new state is captured. Folding removes
   * height above the answer; without it the transcript slides out from under
   * the pointer by however much work the turn did, which on a long turn throws
   * the reader somewhere else entirely. Anchoring on the header — the thing
   * that was clicked — rather than on the bottom of the scroller is what makes
   * the gesture read as a disclosure: the row stays put and the content below
   * it moves.
   */
  const onToggleTurn = React.useCallback(
    (userMessageId: string): void => {
      const el = scrollRef.current
      const header = el?.querySelector<HTMLElement>(
        `[data-turn-header="${CSS.escape(userMessageId)}"]`
      )
      const before = header?.getBoundingClientRect().top ?? null
      const apply = (): void => {
        // Synchronous, so the measurement below sees the folded DOM: React
        // would otherwise batch this past the end of the callback and the
        // transition would capture the state it started from.
        flushSync(() => toggleTurnExpanded(userMessageId))
        if (el && header && before !== null && header.isConnected) {
          el.scrollTop += header.getBoundingClientRect().top - before
        }
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced || typeof document.startViewTransition !== 'function') {
        apply()
        return
      }
      document.startViewTransition(apply)
    },
    [toggleTurnExpanded]
  )

  const loadEarlier = React.useCallback((): void => {
    const el = scrollRef.current
    bottomAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    // Asking for older messages is a statement that you want to read up, not
    // follow the stream — otherwise the follow-the-tail effect below would
    // immediately undo the restore.
    pinnedRef.current = false
    setShowJump(true)
    void loadOlderMessages(chat.id)
  }, [loadOlderMessages])

  // Restore the reading position after a prepend, before the browser paints.
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = bottomAnchor.current
    if (!el || anchor === null) return
    bottomAnchor.current = null
    el.scrollTop = el.scrollHeight - anchor
  }, [hiddenBefore])

  // The live turn's message — only the *last* message counts, so a just-sent user
  // message (before the reply starts) isn't mistaken for the previous reply.
  const lastMsg = messages[messages.length - 1]
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
  // "Thinking…" until the model has produced something this turn; "Working…" after.
  const activityLabel = awaitingAnswer
    ? 'Waiting for your answer…'
    : producedSomething
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

  // Sub-agent runs are folded out of the same window, for the panel and the
  // activity bar rather than for the transcript — which is why the result goes
  // to `agentsStore` instead of down through props. `reconcileAgentRuns` keeps
  // an unmoved list at its old identity so neither subscriber re-renders on a
  // token that changed nothing about any agent.
  const agentRunsRef = React.useRef<AgentRunView[]>([])
  const agentRuns = React.useMemo(() => {
    const next = reconcileAgentRuns(agentRunsRef.current, foldAgentRuns(messages))
    agentRunsRef.current = next
    return next
  }, [messages])
  const setAgentRuns = useAgents((s) => s.setRuns)
  const clearAgentRuns = useAgents((s) => s.clearRuns)
  React.useEffect(() => {
    setAgentRuns(chat.id, agentRuns)
  }, [chat.id, agentRuns, setAgentRuns])
  // Cleared on unmount, in an effect of its own so it fires *only* then: folded
  // into the publish above it would empty the entry between every two updates
  // and flicker the Agents tab out of the strip on each one. The store outlives
  // this component — without this, leaving a thread, or closing a column, would
  // leave that chat's roster standing in the panel.
  React.useEffect(() => () => clearAgentRuns(chat.id), [chat.id, clearAgentRuns])

  // Published to its own store so the dock — and only the dock — re-renders
  // when a task moves; see `taskListStore`. Kept out of the history render path,
  // and keyed by chat, because every column of a thread has its own dock.
  const setTasks = useTaskList((s) => s.setTasks)
  const clearTasks = useTaskList((s) => s.clearTasks)
  React.useEffect(() => {
    setTasks(chat.id, tasks)
  }, [chat.id, tasks, setTasks])
  React.useEffect(() => () => clearTasks(chat.id), [chat.id, clearTasks])

  const openPlan = React.useCallback(
    (plan: string) => {
      openPlanPanel({
        chatId: chat.id,
        plan,
        requestId: pendingPlanRequest?.id ?? null
      })
    },
    [openPlanPanel, chat.id, pendingPlanRequest?.id]
  )
  const historyEnd = liveAssistant ? messages.length - 1 : messages.length
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
    if (parts.length < GROUP_MIN) return null
    // Keyed as history will key it — off the run's first message that draws,
    // since `renderMessages` drops the blank ones before it names a run — so
    // the group folds in place when the turn ends instead of being remade.
    const first = members.find((m) => !isBlankMsg(m)) ?? liveAssistant
    return { start, parts, key: groupKey(first.id) }
  }, [liveAssistant, displayedMessages, historyEnd])
  // Where the label draws — see `showActivity` above for the slot.
  // A thought with text is Codex's shape (Claude withholds the text): while it
  // is the message's last part, `ThinkingBlock` shimmers "Thinking…" — through
  // the pause after the last reasoning delta too — so that header is the
  // motion, and "Working…" two lines under it would say the same thing twice.
  const livePart = liveAssistant?.parts[liveAssistant.parts.length - 1]
  const thinkingShown = livePart?.type === 'thinking' && livePart.text.length > 0
  const tailMoving = liveRun
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
  const showActivityLabel =
    showActivity && (awaitingAnswer || !producedSomething || (quiet && !tailMoving))
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
      onToggleTurn
    }),
    [
      chat.id,
      chat.cwd,
      busy,
      openPlan,
      switchPendingId,
      timeline.completions,
      expandedTurns,
      onToggleTurn
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
    <ToolGroup key={liveRun.key} parts={liveRun.parts} cwd={chat.cwd} live />
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

  return (
    <div
      // `data-chat-surface` is the "which chat is this" marker: it is how a
      // permission keypress finds the transcript it happened in (see
      // `PromptDock`). The frosted wash (`data-chatview`) is the thread's, one
      // level up, so the columns share one material.
      data-chat-surface={chat.id}
      className="relative flex h-full min-w-0 flex-1 flex-col"
    >
      {/* userData is shared between the dev and packaged builds on purpose, so
          the same chat can be open twice. The other instance owns the write
          lock; this one still works, it just is not persisting. */}
      {lockedElsewhere && (
        <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-200/90">
          This chat is open in another Carbon instance, which owns it. Changes made here
          are <span className="font-medium">not being saved</span>. Close it there, then reopen this chat.
        </div>
      )}

      {/* What a fresh worktree cannot say for itself. Without these, the agent's
          first "command not found" — or its first look at an empty folder —
          reads as a bug in the project rather than a fact about the checkout. */}
      {worktreeNotice && (
        <div className="flex items-start gap-2 border-b border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {worktreeNotice === 'empty-base' ? (
              <>
                This worktree is empty: a worktree checks out{' '}
                <em>committed</em> work, and nothing in{' '}
                <span className="text-foreground">{basename(chat.worktree?.repoRoot ?? '')}</span>{' '}
                has been committed yet. Commit the project on This Mac first, or let the agent build
                here and merge it back.
              </>
            ) : (
              <>
                This worktree is a fresh checkout with no dependencies installed — the project has
                no <code className="font-mono text-[11px] text-foreground">.karbun/setup.sh</code>.
                Add one (or run your install command in a terminal tab) if the agent needs them.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={dismissWorktreeNotice}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {terminalSurface ? (
        <>
          <React.Suspense fallback={<div className="min-h-0 flex-1" />}>
            <ChatTerminal chat={chat} />
          </React.Suspense>
          {/* The one thing the pane below cannot say for itself. A terminal chat
              has no turn, so it has no TurnChangesCard and no idle moment to
              draw one — this is where "what has changed here" lives, and the
              route to the stacked diff. */}
          <div className="shrink-0 px-4 pt-2">
            <ContextStrip
              cwd={chat.cwd}
              project={projectRoot(chat)}
              git={git}
              onReviewChanges={() => void reviewChanges()}
              onUpdateFromDefault={() => void runGitAction('update-from-main')}
            />
          </div>
        </>
      ) : (
        <>
      {/* Messages */}
      {/* `scrollbar-gutter: stable` so the column does not step sideways the
          moment a chat grows long enough to scroll — and so the gutter the
          composer reserves below (`--scrollbar-width`) is always the right one. */}
      {/* The jump button is anchored to the scroller, not the view: a fixed
          offset from the view's bottom put it wherever the composer stack
          happened to end — over the context strip, or over the last line of
          the prompt above it once a queued row or a taller composer moved
          the stack. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div ref={columnRef} className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {/* A new column opens on an empty pane, which on its own reads as a
                conversation that failed to load. What it has to say is the one
                thing a reader cannot infer from it: where it runs, and where it
                goes when its column closes. */}
            {side && messages.length === 0 && hiddenBefore === 0 && (
              <div className="flex flex-col items-center gap-1.5 px-4 py-16 text-center">
                <MessageSquarePlus className="size-5 text-muted-foreground/70" />
                <div className="text-[13px] font-medium">New chat in this thread</div>
                <p className="max-w-[38ch] text-xs text-balance text-muted-foreground">
                  Runs in {basename(chat.cwd)} beside the other chats and shares their panel.
                  Closing its column keeps it — reopen it from ＋.
                </p>
              </div>
            )}
            {hiddenBefore > 0 && (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  onClick={loadEarlier}
                  disabled={loadingOlder}
                >
                  {loadingOlder
                    ? 'Loading…'
                    : `Load earlier messages (${hiddenBefore.toLocaleString()})`}
                </Button>
              </div>
            )}
            {/* One array, deliberately: written as `{historyNodes}{liveNode}`
                the two are separate children and the array is its own implicit
                fragment, which puts the live node in a different parent again. */}
            {liveNode ? [...historyNodes, liveNode] : historyNodes}
            {showActivity && (
              <div className="min-h-7">
                <StreamingIndicator label={activityLabel} visible={showActivityLabel} />
              </div>
            )}
            <div className="h-2" />
          </div>
        </div>

        {/* Jump to bottom */}
        {showJump && (
          <div className="pointer-events-none absolute right-0 bottom-3 left-0 flex justify-center pr-[var(--scrollbar-width)]">
            <Button
              size="icon-sm"
              variant="secondary"
              className="pointer-events-auto rounded-full shadow-lg"
              onClick={() => scrollToBottom(true)}
              aria-label="Scroll to bottom"
            >
              <ArrowDown />
            </Button>
          </div>
        )}
      </div>

      {/* Composer.

          The padding sits *inside* `max-w-3xl`, exactly as it does on the
          transcript above — spelled the other way round it made `max-w-3xl`
          mean the box in one place and the text column in the other, so the
          composer ran 48px wider than the reply it answers. `pr` is the
          scrollbar the scroller reserves and this element does not, without
          which the two columns are centered 6px apart. */}
      <div className="shrink-0 pb-5 pr-[var(--scrollbar-width)]">
        <div className="mx-auto max-w-3xl px-6">
          {/* One bleed for the whole stack: the pill rows are framed objects
              like the composer, and they read as one column only while their
              borders share an edge. */}
          <div className={CHAT_BLEED}>
            <AgentActivityBar chatId={chat.id} />
            {stripHere && (
              <ContextStrip
                cwd={chat.cwd}
                project={projectRoot(chat)}
                git={git}
                onReviewChanges={() => void reviewChanges()}
                onUpdateFromDefault={() => void runGitAction('update-from-main')}
              />
            )}
            {queued.length > 0 && (
              <div className="mb-2 space-y-1.5">
                {queued.map((q) => (
                  <div
                    key={q.id}
                    className="flex animate-enter items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground"
                  >
                    <Clock className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {q.text || q.attachments?.map((a) => a.name).join(', ')}
                    </span>
                    <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
                      queued
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendQueuedNow(chat.id, q.id)}
                      aria-label="Send now"
                      title="Send now — interrupts the current turn"
                      className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <ArrowUp className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQueued(chat.id, q.id)}
                      aria-label="Remove queued message"
                      className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Composer
              // Everything that belongs to the input rides the composer's own
              // box rather than sitting above it, so the stack reads as one
              // object however the border moves.
              //
              // Order is by what is waiting on whom, and the prompts come last
              // because last is *adjacent to the textarea*: the checklist and
              // the goal bar grow and collapse on their own, and above the
              // prompt their movement never pushes the question you have to
              // answer away from the keys that answer it.
              //
              // Every column carries its own: the goal bar, the checklist and
              // the prompts are all keyed by chat id.
              header={
                <>
                  {chat.provider === 'codex' && (
                    <CodexGoalBar chatId={chat.id} threadId={chat.sessionId} working={busy} />
                  )}
                  <TaskDock chatId={chat.id} />
                  <CodexReviewMenu
                    open={reviewOpen}
                    onOpenChange={setReviewOpen}
                    cwd={chat.cwd}
                    currentBranch={git?.branch}
                    defaultBranch={git?.defaultBranch}
                    onStart={(target) => startCodexReview(chat.id, target)}
                  />
                  <PromptDock
                    chatId={chat.id}
                    provider={chat.provider}
                    requests={permissions}
                    onReviewPlan={openPlan}
                  />
                </>
              }
              // Returned, not voided: the composer needs the promise so a failed
              // send restores the draft instead of discarding it.
              onSend={(text, attachments) => {
                if (
                  composerProvider === 'codex' &&
                  text.trim().toLowerCase() === '/review' &&
                  attachments.length === 0
                ) {
                  setReviewOpen(true)
                  return Promise.resolve()
                }
                return sendMessage(chat.id, text, attachments)
              }}
              draft={initialDraft}
              onDraftChange={(next) => saveChatDraft(chat.id, next)}
              collapsible={collapsible}
              // Only the thread's own chat takes the caret on mount. Every
              // column mounts at once when a thread opens, and each grabbing it
              // left focus — and with it the thread's focused chat — on the
              // last column. A column added or jumped to is handed the caret
              // explicitly (`focusComposer`).
              autoFocus={!side}
              streaming={busy}
              onStop={() => void interrupt(chat.id)}
              // A cross-provider pick is only armed until the next send; the
              // composer previews it (chip, efforts, placeholder) while the chat
              // itself stays on its current backend.
              model={chat.pendingModel ?? chat.model ?? ''}
              onModelChange={(model, modelProvider) =>
                void setChatOptions(chat.id, { model, modelProvider })
              }
              effort={chat.effort ?? ''}
              onEffortChange={(effort, opts) => void setChatOptions(chat.id, { effort, ...opts })}
              modelEfforts={modelEfforts}
              serviceTier={chat.serviceTier ?? 'standard'}
              onServiceTierChange={(serviceTier, opts) =>
                void setChatOptions(chat.id, { serviceTier, ...opts })
              }
              permissionMode={chat.permissionMode}
              onPermissionModeChange={(permissionMode) =>
                void setChatOptions(chat.id, { permissionMode })
              }
              contextTokens={chat.contextTokens}
              contextWindow={chat.contextWindow}
              provider={composerProvider}
              chatId={chat.id}
              cwd={chat.cwd}
              commands={commands}
              // Busy-gated so a note left behind by a crash can never stick.
              switchingNote={busy ? chat.switchingNote : undefined}
              placeholder={
                composerProvider === 'claude'
                  ? undefined
                  : `Ask ${PROVIDER_SHORT_LABELS[composerProvider]} anything…`
              }
            />
          </div>
        </div>
      </div>
        </>
      )}

    </div>
  )
})

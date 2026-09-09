import type { AssistantMessage, AssistantPart, ChatMessage } from '@shared/types'

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
   * fold — folding it would take a running card off screen, and with it the
   * only thing `AgentsPanel`'s row click has to scroll to.
   */
  running: boolean
  /**
   * The first part of the turn's answer, or null when the turn ends on work
   * rather than on prose. Everything before it folds away.
   */
  answerFrom: { messageId: string; partIndex: number } | null
  /** True when folding would actually hide something. */
  collapsible: boolean
}

/** A part that draws nothing: a hole, or text/thinking whose text is withheld. */
function blank(part: AssistantPart | null | undefined): boolean {
  return !part || ((part.type === 'text' || part.type === 'thinking') && !part.text)
}

/**
 * **The answer is the trailing run of `text` parts**, walked back across the
 * turn's assistant messages, and *anything else* ends it.
 *
 * That is deliberately not `turnAnswerText`'s rule, which concatenates every
 * text part in the turn — the right definition for *copying* an answer, and the
 * wrong one for a boundary: a turn that says "let me check" before running six
 * commands would keep that preamble on screen and fold away the work it
 * introduces.
 *
 * A thought with text ends the run exactly as a tool call does. Codex streams
 * its reasoning visibly, so a `thinking` part is a rendered "Thought process"
 * row — work the turn did, not the answer it arrived at — and treating it as
 * answer prose would leave that row hanging above every folded Codex turn.
 * Withheld thoughts (Claude's) draw nothing and so decide nothing.
 */
function answerBoundary(assistants: AssistantMessage[]): {
  answerFrom: TurnFold['answerFrom']
  collapsible: boolean
} {
  let answerFrom: TurnFold['answerFrom'] = null
  for (let mi = assistants.length - 1; mi >= 0; mi--) {
    const message = assistants[mi]
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi]
      if (blank(part)) continue
      if (part.type === 'text') {
        answerFrom = { messageId: message.id, partIndex: pi }
        continue
      }
      // Work. Everything from here back is what the fold hides — including,
      // when nothing has been marked as answer yet, the whole turn.
      return { answerFrom, collapsible: true }
    }
  }
  // A turn that never did anything but talk. The boundary still points at its
  // first drawn part so the renderer takes one path, and nothing folds.
  return { answerFrom, collapsible: false }
}

/**
 * Anything in this message still in flight — the call itself, or a child of it.
 *
 * The child half is `agentRuns.ts`'s `childrenBusy` rule, which that file keeps
 * in one place so a card and the roster cannot disagree about one agent. This
 * asks a different question — *is the turn still doing anything* — and repeats
 * two lines of it rather than exporting from a file this pass does not own;
 * worth reconciling if a third caller ever wants it.
 */
function messageRunning(message: AssistantMessage): boolean {
  for (const part of message.parts) {
    if (!part || part.type !== 'tool') continue
    if (part.status === 'pending' || part.status === 'running') return true
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
export function foldTurns(messages: ChatMessage[]): Map<string, TurnFold> {
  const folds = new Map<string, TurnFold>()
  let current: TurnFold | null = null
  let assistants: AssistantMessage[] = []

  const close = (): void => {
    if (current) Object.assign(current, answerBoundary(assistants))
    current = null
    assistants = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      close()
      current = {
        userId: message.id,
        startTs: message.ts,
        endTs: message.ts,
        replied: false,
        running: false,
        answerFrom: null,
        collapsible: false
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
    if (message.role === 'assistant') {
      assistants.push(message)
      if (!current.running && messageRunning(message)) current.running = true
    }
  }
  close()
  return folds
}

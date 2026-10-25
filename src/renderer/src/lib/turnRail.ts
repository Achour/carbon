import type { ChatMessage, TurnBookmark } from '@shared/types'
import type { TurnFold } from './turnFold'

/**
 * One tick of the transcript's turn rail (`TurnRail`): a turn, seen from the
 * outside — what was asked, how it ended, and how much happened in between.
 *
 * Built from the loaded window only. A long chat holds its older messages in
 * the database until the reader scrolls to them, and the rail does not reach
 * past that: what it cannot draw as a tick it draws as an "earlier" mark, and a
 * bookmark back there carries its own text (`TurnBookmark`).
 */
export interface RailTurn {
  /** The user message that opened the turn. */
  id: string
  /** The prompt, flattened to one line and capped — or the action's label. */
  prompt: string
  /** The opening of the turn's answer, markdown stripped; empty when it ended on work. */
  answer: string
  /** Tool calls the turn made, every message of it included. */
  steps: number
  /** How long it ran, on the turn header's clock; 0 before anything replied. */
  ms: number
  /** Still running — the last turn of a busy chat, or one whose work outlived it. */
  live: boolean
  /** How much happened, in four ascending steps — the tick's length. */
  weight: 0 | 1 | 2 | 3
}

const PROMPT_MAX = 240
const ANSWER_MAX = 320
/** What a bookmark keeps of its prompt: enough to recognize, little to store. */
const BOOKMARK_MAX = 120

/**
 * Markdown read as plain text: enough to put an answer's first lines in a small
 * card without a stray `**` or a fence marker, not a renderer. Code blocks keep
 * their contents (often the point of the answer) and lose their fences.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The words a bookmark keeps for its turn: flattened, so a raw prompt and a rail prompt agree. */
export function bookmarkText(prompt: string): string {
  return cap(plainText(prompt), BOOKMARK_MAX)
}

/**
 * Buckets on a log scale, because the spread is enormous — a one-line answer
 * and a two-hour refactor are both turns — and a linear length would draw
 * every ordinary turn as the same stub beside one long bar.
 */
function weightOf(answerLength: number, steps: number): RailTurn['weight'] {
  const score = answerLength + steps * 120
  if (score < 300) return 0
  if (score < 1500) return 1
  if (score < 6000) return 2
  return 3
}

/**
 * The rail's turns, in order. `folds` is `foldTurns(messages)` — passed in
 * rather than recomputed, and so that this file has no runtime imports.
 * `busy` marks the last turn live: a turn that has not ended yet has no
 * `turn` row to say so.
 */
export function railTurns(
  messages: ChatMessage[],
  folds: ReadonlyMap<string, TurnFold>,
  busy: boolean
): RailTurn[] {
  const turns: RailTurn[] = []
  let current: { id: string; prompt: string; steps: number } | null = null

  const close = (isLast: boolean): void => {
    if (!current) return
    const fold = folds.get(current.id)
    const answer = fold ? plainText(fold.answer) : ''
    turns.push({
      id: current.id,
      prompt: current.prompt,
      answer: cap(answer, ANSWER_MAX),
      steps: current.steps,
      ms: fold?.replied ? Math.max(0, fold.endTs - fold.startTs) : 0,
      live: (isLast && busy) || !!fold?.running,
      weight: weightOf(answer.length, current.steps)
    })
  }

  for (const m of messages) {
    if (m.role === 'user') {
      close(false)
      const words = m.label ?? plainText(m.text)
      current = {
        id: m.id,
        prompt: cap(words || (m.attachments?.length ? 'Attachment' : 'Empty message'), PROMPT_MAX),
        steps: 0
      }
    } else if (m.role === 'assistant' && current) {
      for (const p of m.parts) if (p?.type === 'tool') current.steps++
    }
  }
  close(true)
  return turns
}

function sameTurn(a: RailTurn, b: RailTurn): boolean {
  return (
    a.id === b.id &&
    a.prompt === b.prompt &&
    a.answer === b.answer &&
    a.steps === b.steps &&
    a.ms === b.ms &&
    a.live === b.live &&
    a.weight === b.weight
  )
}

/**
 * Keep every unchanged turn at its previous identity, and the list itself when
 * nothing moved. The rail is fed from `messages`, which changes on every
 * streamed delta, and only the live turn's numbers move with it — so the ticks
 * (memoized) see a new object only where something they draw changed.
 */
export function reconcileTurns(prev: RailTurn[], next: RailTurn[]): RailTurn[] {
  const byId = new Map(prev.map((t) => [t.id, t]))
  let changed = prev.length !== next.length
  const out = next.map((t, i) => {
    const old = byId.get(t.id)
    if (old && sameTurn(old, t)) {
      if (prev[i] !== old) changed = true
      return old
    }
    changed = true
    return t
  })
  return changed ? out : prev
}

/**
 * Bookmarks whose turn is not in the loaded window and may still be further
 * back. With nothing left to load, an unmatched id is a turn that no longer
 * exists — an edit-and-resend rewound past it — and is dropped from the view.
 */
export function earlierBookmarks(
  bookmarks: readonly TurnBookmark[] | undefined,
  turns: readonly RailTurn[],
  hiddenBefore: number
): TurnBookmark[] {
  if (!bookmarks?.length || hiddenBefore <= 0) return []
  const loaded = new Set(turns.map((t) => t.id))
  return bookmarks.filter((b) => !loaded.has(b.id))
}

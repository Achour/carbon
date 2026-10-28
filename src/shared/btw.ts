import type { SlashCommand } from './types'

/**
 * `/btw` — a side question about the conversation that never becomes part of
 * it. It is answered from the chat's context while the agent keeps working:
 * nothing is queued, no turn starts, and neither the question nor the answer
 * is written to the transcript.
 *
 * Carbon's own, offered on every provider's `/` menu. Claude answers it
 * natively (the CLI's `side_question` control request, which forks the live
 * conversation without tools); the other providers answer on a one-shot over
 * the serialized transcript (`ChatManager.askBtw`). Pure and dependency-free
 * so `node --test` can run it (test/btw.test.ts).
 */
export const BTW_COMMAND: SlashCommand = {
  name: 'btw',
  description: 'Ask a quick side question without interrupting the agent',
  // Not optional: a command with no argument shape runs the moment it is
  // picked, which would send an empty question.
  argumentHint: '<question>'
}

/** The question in a `/btw …` message ('' for a bare `/btw`); null for anything else. */
export function parseBtw(text: string): string | null {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text)
  return m ? (m[1] ?? '').trim() : null
}

/** `list` with `/btw` at its head, once — a provider that grows its own keeps its row out. */
export function withBtw(list: SlashCommand[]): SlashCommand[] {
  return [BTW_COMMAND, ...list.filter((c) => c.name !== BTW_COMMAND.name)]
}

/** One answered side question, carried into the next so a follow-up has its context. */
export interface BtwExchange {
  question: string
  response: string
}

/**
 * One side question in a chat's open card, as both clients hold it. `answer`
 * and `error` both absent means it is still being answered. Never persisted:
 * a side question is kept out of the conversation on purpose, and out of its
 * history with it.
 */
export interface BtwEntry {
  id: string
  question: string
  answer?: string
  error?: string
}

/** The answered entries of a card, as the history the next question carries. */
export function btwHistory(entries: BtwEntry[]): BtwExchange[] {
  return entries.flatMap((e) => (e.answer ? [{ question: e.question, response: e.answer }] : []))
}

/** Transcript budget for the one-shot fallback — paid per question, unlike a handoff's once. */
export const BTW_TRANSCRIPT_CHARS = 60_000
/** Past this the question is given up; the user is waiting on it with the card open. */
export const BTW_TIMEOUT_MS = 90_000

/** System instruction for the one-shot fallback (providers with no native side question). */
export const BTW_SYSTEM =
  'You are answering a quick side question from the user about an ongoing conversation ' +
  'between them and an AI coding agent, while that agent keeps working. You have no tools: ' +
  'answer only from the transcript you are given and what you know. Do not take over the ' +
  'task, propose to run anything, or continue the agent\'s work. Be brief and direct — a few ' +
  'sentences, or a short list when that is clearer. If the transcript does not say, say so.'

/** The one-shot prompt: the transcript, earlier side questions, and the new one. */
export function buildBtwPrompt(
  transcript: string,
  question: string,
  history: BtwExchange[] = []
): string {
  const earlier = history.length
    ? '\n\nEarlier side questions:\n\n' +
      history.map((h) => `Q: ${h.question}\nA: ${h.response}`).join('\n\n')
    : ''
  const context = transcript ? `Transcript:\n\n${transcript}` : 'The conversation has no messages yet.'
  return `${context}${earlier}\n\nSide question: ${question}\n\nAnswer:`
}

import type { ChatMessage, SlashCommand } from './types'

/**
 * `/btw` — a side question about the conversation, answered from the chat's
 * context while the agent keeps working: nothing is queued and no turn
 * starts. The exchange is kept in the transcript where it was asked (a `btw`
 * event row) but is never sent to the agent, nor carried by a handoff.
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

/** Earlier side questions a follow-up carries: answered, since the turn's prompt, newest few. */
export const BTW_HISTORY_MAX = 5

/**
 * The side questions already answered in the current turn — everything after
 * the last user message — as the history the next one carries, so "and what
 * did you mean by that?" reads as a follow-up rather than a fresh question.
 */
export function btwHistory(messages: ChatMessage[]): BtwExchange[] {
  const out: BtwExchange[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < BTW_HISTORY_MAX; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    if (m.role === 'event' && m.kind === 'btw' && m.btw?.answer) {
      out.push({ question: m.btw.question, response: m.btw.answer })
    }
  }
  return out.reverse()
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

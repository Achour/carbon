import type { Attachment, ChatMessage } from '@shared/types'

/**
 * Chat-title helpers shared by both providers. `deriveTitle` is the instant
 * placeholder shown the moment the first message is sent; the rest feed the
 * per-provider one-shot model call that replaces that placeholder with a terse
 * AI-generated title after the first turn completes.
 *
 * Everything here is pure and imports only shared types, so `node --test` can
 * run it directly (see test/titles.test.ts).
 */

/** Instant placeholder from the first message: label > text > attachment names. */
export function deriveTitle(text: string, label?: string, attachments: Attachment[] = []): string {
  const raw = label || text || attachments.map((a) => a.name).join(', ')
  return raw.replace(/\s+/g, ' ').trim().slice(0, 64)
}

/** The first user message's intent — prompt text plus any attachment names. */
export function firstUserText(messages: ChatMessage[]): string {
  const m = messages.find((msg) => msg.role === 'user')
  if (!m || m.role !== 'user') return ''
  const parts = [m.text.trim(), ...(m.attachments?.map((a) => a.name) ?? [])].filter(Boolean)
  return parts.join(' ').trim()
}

/** Assistant reply text so far (thinking/tool parts excluded), capped for the prompt. */
export function assistantSummaryText(messages: ChatMessage[], cap = 2000): string {
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) texts.push(p.text.trim())
    }
  }
  return texts.join('\n').slice(0, cap)
}

/** Normalize a model's raw title: unwrap quotes, drop trailing punctuation, clamp. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[.。!?、,]+$/, '')
    .trim()
    .slice(0, 60)
}

/** System instruction for the one-shot title model. */
export const TITLE_SYSTEM =
  'You name a coding-assistant chat from the user\'s FIRST message. Reply with ONLY a ' +
  'terse 3-6 word title, Title Case, that captures what the USER wants. Base it on the ' +
  "user's message; use the assistant's reply only to disambiguate a vague request — " +
  'NEVER introduce a feature, file, or topic the user did not mention. If the message is ' +
  "only a greeting or small talk with no task (e.g. 'hi', 'hello', 'thanks'), reply " +
  "exactly 'Greeting'. No quotes, no trailing punctuation, no preamble."

/**
 * The one-shot prompt for the title model. Titles are generated in parallel with
 * the first turn (from the user's message alone), so `assistantText` is usually
 * empty; it's only appended as light context when present.
 */
export function buildTitlePrompt(userText: string, assistantText = ''): string {
  const u = userText.slice(0, 1500) || '(no message)'
  const a = assistantText.slice(0, 1500)
  const ctx = a
    ? `\n\nAssistant's reply (context only — do not pull in topics the user didn't raise):\n${a}`
    : ''
  return (
    'Title this coding session in 3-6 words, based on what the USER asked for.\n\n' +
    `User's first message:\n${u}${ctx}\n\n` +
    'Title:'
  )
}

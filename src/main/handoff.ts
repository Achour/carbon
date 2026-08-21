import type { ChatMessage } from '@shared/types'

/**
 * Cross-provider handoff text helpers. When a chat switches provider mid-
 * conversation (Claude ⇄ Codex), the new backend cannot resume the old one's
 * session — so the outgoing model writes a handoff brief from the transcript,
 * and the brief rides invisibly on the new provider's first turn. Everything
 * here is pure and imports only shared types, so `node --test` can run it
 * directly (see test/handoff.test.ts).
 */

/** Transcript budget for the brief-writing one-shot (a large-context call). */
export const HANDOFF_TRANSCRIPT_CHARS = 200_000
/**
 * Transcript budget when the brief could not be generated and the raw
 * transcript is injected into the new session's first turn instead. Much
 * smaller: this rides inside the new conversation's context for its lifetime.
 */
export const HANDOFF_FALLBACK_CHARS = 24_000
/** Ceiling on brief generation; past it the raw-transcript fallback rides instead. */
export const HANDOFF_TIMEOUT_MS = 120_000

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)} …[truncated]`

/** Truncate string leaves before stringifying — tool inputs can carry whole file bodies. */
const clipJsonStrings = (_key: string, value: unknown): unknown =>
  typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value

/** One transcript block per message; null when there is nothing worth showing. */
function blockFor(m: ChatMessage): string | null {
  if (m.role === 'user') {
    const names = m.attachments?.map((a) => a.name) ?? []
    const text = [m.text.trim(), names.length ? `(attached: ${names.join(', ')})` : '']
      .filter(Boolean)
      .join('\n')
    return text ? `## User\n${clip(text, 8000)}` : null
  }
  if (m.role === 'assistant') {
    const lines: string[] = []
    for (const p of m.parts) {
      // Thinking is omitted: it is not part of the visible conversation contract.
      if (p.type === 'text' && p.text.trim()) {
        lines.push(clip(p.text.trim(), 6000))
      } else if (p.type === 'tool') {
        const input =
          p.input === undefined ? '' : ` ${clip(JSON.stringify(p.input, clipJsonStrings), 400)}`
        // Slice before the whitespace collapse so a 100 KB output doesn't feed
        // the regex to keep 400 chars; 3× slack absorbs any shrinkage.
        const out = p.output?.trim()
        const result = out
          ? ` → ${clip(out.slice(0, 1200).replace(/\s+/g, ' '), 400)}`
          : ` → ${p.status}`
        lines.push(`[tool ${p.name}]${input}${result}`)
      }
    }
    return lines.length ? `## Assistant\n${lines.join('\n')}` : null
  }
  return m.text.trim() ? `[${m.kind}] ${clip(m.text.trim(), 500)}` : null
}

/**
 * Serialize a conversation for the handoff, newest messages favoured: the tail
 * is built newest-first until `cap` is spent — so the cost scales with the cap,
 * not the chat — and the first user message (the goal) is always kept, with an
 * omission marker for whatever fell between. `moreBefore` notes history that
 * was never hydrated (a windowed chat's unloaded prefix; the caller slices the
 * placeholders off before calling).
 */
export function serializeTranscript(
  messages: ChatMessage[],
  cap: number,
  moreBefore = false
): string {
  // The head: the first user message, clipped so it can't crowd out the tail.
  let headBlock: string | null = null
  let headIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue
    const block = blockFor(messages[i])
    if (block) {
      headBlock = clip(block, Math.floor(cap / 4))
      headIndex = i
    }
    break
  }

  // The tail, walked backwards until the budget is spent. `start` ends up as
  // the oldest message the tail covers.
  let budget = cap - (headBlock?.length ?? 0)
  const tailRev: string[] = []
  let start = messages.length
  for (let i = messages.length - 1; i > headIndex; i--) {
    const block = blockFor(messages[i])
    if (block === null) {
      start = i
      continue
    }
    if (block.length + 2 > budget) {
      // Even the newest block alone can blow the budget — keep it clipped
      // rather than handing over a transcript with no recent activity at all.
      if (tailRev.length === 0) {
        tailRev.push(clip(block, Math.max(budget, 2000)))
        start = i
      }
      break
    }
    budget -= block.length + 2
    tailRev.push(block)
    start = i
  }
  if (!headBlock && tailRev.length === 0) return ''

  const parts: string[] = []
  if (moreBefore) parts.push('[… earlier history not shown …]')
  if (headBlock) parts.push(headBlock)
  const omitted = start - headIndex - 1
  if (omitted > 0) parts.push(`[… ${omitted} earlier messages omitted …]`)
  parts.push(...tailRev.reverse())
  return parts.join('\n\n')
}

/** System instruction for the outgoing model's brief-writing one-shot. */
export const HANDOFF_BRIEF_SYSTEM =
  'You are an AI coding agent writing a handoff brief: your session is ending and a ' +
  'different AI coding agent will take over the conversation mid-stream with no access to ' +
  'the transcript. From the transcript you are given, write the brief that lets it continue ' +
  "seamlessly. Cover: (1) the user's goal and their most recent request; (2) decisions, " +
  'constraints and preferences established along the way; (3) work already done — files ' +
  'created or changed, commands run, and their outcomes; (4) the current state, including ' +
  'anything half-finished or broken; (5) what remains and the immediate next step. Be ' +
  'specific with file paths, names and commands. Plain text, under 600 words, no preamble.'

/** The one-shot prompt for the brief: the transcript plus who is handing off to whom. */
export function buildHandoffBriefPrompt(
  transcript: string,
  fromLabel: string,
  toLabel: string
): string {
  return (
    `The conversation below ran on ${fromLabel}; the user is switching it to ${toLabel}. ` +
    'Write the handoff brief for the incoming agent.\n\n' +
    `Transcript:\n\n${transcript}\n\nHandoff brief:`
  )
}

/**
 * Kickoff prompt when an approved plan is implemented by the other provider.
 * The plan rides verbatim — it is the highest-fidelity handoff artifact there
 * is; the generated brief only covers the conversation around it.
 */
export function buildPlanImplementPrompt(plan: string, fromLabel: string): string {
  return (
    `The plan below was written by ${fromLabel} and approved by the user in this ` +
    'conversation, which has been handed off to you for implementation. Implement it now.\n\n' +
    plan
  )
}

/**
 * The block prepended (invisibly) to the resent prompt when an edit-and-resend
 * could not truncate the provider's own conversation and had to start a fresh
 * one — Grok, or a chat whose kept turns predate the anchor we fork on.
 *
 * Deliberately not `buildHandoffContext`: nothing was handed over. It is the
 * same agent, in the same workspace, resuming a conversation whose tail the user
 * just rewrote — so the framing that matters is that the transcript below is its
 * OWN history and that the turns after it were withdrawn on purpose. Told
 * otherwise, the model spends the turn apologising for a switch that never
 * happened, or tries to reconcile the missing replies.
 */
export function buildReplayContext(transcript: string): string {
  return (
    '<conversation-replay>\n' +
    'This conversation is already in progress and the transcript below is your own ' +
    'history with the user in this workspace (it may be truncated). Your session was ' +
    'restarted for technical reasons, so continue seamlessly rather than greeting the ' +
    'user as if this were new.\n\n' +
    'Everything in that transcript still stands: treat instructions, facts, decisions and ' +
    'preferences recorded in it as though the user had just told you them, because they ' +
    'did. Only the turns AFTER it were withdrawn — the user edited their last message and ' +
    'resent it, so the replies that followed the original wording no longer apply. Do not ' +
    'try to recover them or ask what happened to them. Trust the workspace over this ' +
    'transcript: read files when current state matters.\n\n' +
    `${transcript}\n` +
    '</conversation-replay>\n\n' +
    "The user's edited message follows."
  )
}

/**
 * The block prepended (invisibly — the UI never shows it) to the user's first
 * message on the new provider. `raw` marks the fallback where the summary is
 * the serialized transcript itself rather than a written brief.
 */
export function buildHandoffContext(summary: string, fromLabel: string, raw = false): string {
  const source = raw
    ? 'Below is the transcript of that conversation so far (it may be truncated).'
    : 'Below is a handoff brief the previous agent wrote before leaving.'
  return (
    '<conversation-handoff>\n' +
    `You are taking over an ongoing conversation mid-stream from another AI coding agent (${fromLabel}). ` +
    'The user has been working with it in this same workspace and expects you to continue ' +
    'seamlessly — do not restart the task, re-plan from scratch, or greet the user as if the ' +
    `conversation were new. ${source} Trust the workspace over the notes: verify current ` +
    'state by reading files when it matters.\n\n' +
    `${summary}\n` +
    '</conversation-handoff>\n\n' +
    "The user's next message follows."
  )
}

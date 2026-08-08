/**
 * Token accounting for both providers, read from the transcripts the CLIs write
 * to disk.
 *
 * This is deliberately a *different* question from `usage.ts`, which asks the
 * providers "how much of my plan is left right now". This one asks "what have I
 * spent, on which models, over the last N days" — a history question no live API
 * answers, because neither provider bills a subscription per token. The only
 * durable record is the session logs, so that is what we read:
 * `~/.claude/projects/<slug>/<session>.jsonl` and
 * `~/.codex/sessions/<y>/<m>/<d>/rollout-<id>.jsonl`.
 *
 * Reading them covers Carbon's own turns too: the Agent SDK and the Codex SDK
 * both drive the real CLIs, so a chat in this app lands in the same files as one
 * in the terminal. That is what makes the number *the* number rather than "what
 * Carbon happened to see" — and it's why we don't also count the `TurnStats`
 * already on our own event messages, which would double every in-app turn.
 *
 * Everything here is pure: parsing takes a line, pricing takes a model. The
 * filesystem walk, caching and aggregation live in `usageStats.ts`, so this file
 * stays unit-testable with `node --test` (no bundler, `node:*` imports only).
 */

// ---------- Buckets ----------

/** One provider+model+day cell. Tokens and the money they cost, together. */
export interface UsageCell {
  provider: 'claude' | 'codex'
  model: string
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** Input tokens billed at the full rate (cache misses). */
  input: number
  /** Input tokens served from cache, billed at ~10% (Claude) / 10% (Codex). */
  cacheRead: number
  /** Input tokens written *into* the cache, billed at a premium. */
  cacheWrite: number
  output: number
  /** Reasoning tokens — a subset of `output`, reported only by Codex. */
  reasoning: number
  costUsd: number
  /** What `cacheRead` would have cost at the full input rate, minus what it did. */
  savingsUsd: number
  /** Assistant responses (Claude) / sampled turns (Codex) this cell covers. */
  responses: number
  /** Tokens we had no rate for — `costUsd` excludes them. */
  unpricedTokens: number
}

export function emptyCell(
  provider: UsageCell['provider'],
  model: string,
  day: string
): UsageCell {
  return {
    provider,
    model,
    day,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    savingsUsd: 0,
    responses: 0,
    unpricedTokens: 0
  }
}

/** `YYYY-MM-DD` in the *local* zone — the day the user remembers working. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------- Pricing ----------

/** Dollars per million tokens, by kind. */
export interface Rate {
  input: number
  output: number
  cacheRead: number
  /** Claude bills 5-minute and 1-hour cache writes differently. */
  cacheWrite5m: number
  cacheWrite1h: number
}

/**
 * Claude rates derive from one number: reads are 0.1×, a 5-minute cache write
 * 1.25×, a 1-hour write 2× the input rate. Expressing it that way keeps the
 * table to the two figures Anthropic actually publishes.
 */
function anthropic(input: number, output: number): Rate {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2
  }
}

/**
 * OpenAI publishes a cached-input rate directly (a flat 10% of input across the
 * GPT-5 family) and bills no cache-write premium, so writes cost the input rate.
 */
function openai(input: number, output: number, cachedInput = input * 0.1): Rate {
  return {
    input,
    output,
    cacheRead: cachedInput,
    cacheWrite5m: input,
    cacheWrite1h: input
  }
}

/**
 * Published list prices, newest first. Matching is longest-prefix, so a dated
 * snapshot (`claude-haiku-4-5-20251001`) and a context suffix (`…[1m]`) both land
 * on their family, and an unreleased sibling of a known family still prices at
 * the family rate instead of silently costing nothing.
 *
 * These are *API list prices*. Nobody paying a Max or Plus subscription is billed
 * them — which is the whole reason the UI calls the headline figure "raw token
 * cost" and says so out loud.
 */
const RATES: [prefix: string, rate: Rate][] = [
  // Anthropic
  ['claude-fable-5', anthropic(10, 50)],
  ['claude-mythos', anthropic(10, 50)],
  ['claude-opus-5', anthropic(5, 25)],
  ['claude-opus-4-8', anthropic(5, 25)],
  ['claude-opus-4-7', anthropic(5, 25)],
  ['claude-opus-4-6', anthropic(5, 25)],
  ['claude-opus-4-5', anthropic(5, 25)],
  ['claude-opus-4', anthropic(15, 75)],
  ['claude-opus-3', anthropic(15, 75)],
  ['claude-3-opus', anthropic(15, 75)],
  ['claude-sonnet-5', anthropic(3, 15)],
  ['claude-sonnet-4', anthropic(3, 15)],
  ['claude-3-7-sonnet', anthropic(3, 15)],
  ['claude-3-5-sonnet', anthropic(3, 15)],
  ['claude-haiku-4-5', anthropic(1, 5)],
  ['claude-3-5-haiku', anthropic(0.8, 4)],
  ['claude-3-haiku', anthropic(0.25, 1.25)],
  // OpenAI. The Codex-only slugs (sol/terra/luna, the review model) are billed as
  // the GPT-5 family they belong to; OpenAI doesn't publish them separately.
  ['gpt-5.4-mini', openai(0.25, 2)],
  ['gpt-5-mini', openai(0.25, 2)],
  ['gpt-5-nano', openai(0.05, 0.4)],
  ['gpt-5', openai(1.25, 10)],
  ['codex-', openai(1.25, 10)],
  ['o4-mini', openai(1.1, 4.4)],
  ['o3', openai(2, 8)]
]

/**
 * Fast mode is a different SKU, not a faster tier of the same one — Claude Opus 5
 * served fast bills at Fable rates. The logs record which one served the turn
 * (`usage.speed`), so honoring it is the difference between a right answer and one
 * that is quietly 2× low for anyone who leaves Fast on.
 */
const FAST_RATE = anthropic(10, 50)

/** The published rate for a model, or `null` when we have no figure for it. */
export function rateFor(model: string, speed?: string): Rate | null {
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, '')
  if (!id) return null
  if (speed === 'fast' && id.startsWith('claude-opus-')) return FAST_RATE
  let best: Rate | null = null
  let bestLen = -1
  for (const [prefix, rate] of RATES) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = rate
      bestLen = prefix.length
    }
  }
  return best
}

/** Add one priced sample to `cell`, or bank it as unpriced when we have no rate. */
export function addSample(
  cell: UsageCell,
  rate: Rate | null,
  s: {
    input: number
    cacheRead: number
    cacheWrite5m: number
    cacheWrite1h: number
    output: number
    reasoning?: number
  }
): void {
  const write = s.cacheWrite5m + s.cacheWrite1h
  cell.input += s.input
  cell.cacheRead += s.cacheRead
  cell.cacheWrite += write
  cell.output += s.output
  cell.reasoning += s.reasoning ?? 0
  cell.responses += 1
  if (!rate) {
    cell.unpricedTokens += s.input + s.cacheRead + write + s.output
    return
  }
  const m = 1e6
  cell.costUsd +=
    (s.input * rate.input +
      s.cacheRead * rate.cacheRead +
      s.cacheWrite5m * rate.cacheWrite5m +
      s.cacheWrite1h * rate.cacheWrite1h +
      s.output * rate.output) /
    m
  // What re-sending that context uncached would have cost, minus what it did.
  cell.savingsUsd += (s.cacheRead * (rate.input - rate.cacheRead)) / m
}

// ---------- Claude transcripts ----------

/**
 * Claude Code writes one JSONL per session under
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` — plus one per subagent in a
 * `<sessionId>/subagents/` folder beside it. Every assistant turn carries the
 * API's own `usage` block. Only lines mentioning `usage` are worth parsing — the
 * bulk of a transcript is tool results, and skipping them is what keeps a 2 GB
 * scan to a few seconds.
 */
export const CLAUDE_LINE_HINT = '"usage"'

export interface ClaudeSample {
  model: string
  ts: number
  /** `messageId:requestId` — the dedupe key, or null when either is missing. */
  key: string | null
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
  speed?: string
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * One assistant line → one billable sample, or null.
 *
 * The dedupe key matters: a single API response is written once per content
 * block, so a turn that produced text *and* a tool call appears twice with the
 * same `usage`. Counting both would inflate every number on the page. Anything
 * missing an id/requestId pair (older transcripts) is counted once and can't
 * dedupe — the alternative, dropping it, loses real spend.
 */
export function parseClaudeLine(line: string): ClaudeSample | null {
  if (!line.includes(CLAUDE_LINE_HINT)) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (o.type !== 'assistant') return null
  const msg = o.message as Record<string, unknown> | undefined
  const usage = msg?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const model = typeof msg?.model === 'string' ? msg.model : ''
  // The CLI's placeholder for turns it answered without a model call.
  if (!model || model === '<synthetic>') return null
  const ts = Date.parse(String(o.timestamp ?? ''))
  if (!Number.isFinite(ts)) return null

  const created = usage.cache_creation as Record<string, unknown> | undefined
  let w5 = num(created?.ephemeral_5m_input_tokens)
  let w1 = num(created?.ephemeral_1h_input_tokens)
  const writeTotal = num(usage.cache_creation_input_tokens)
  // Older transcripts report only the total. Charge it at the 5-minute rate:
  // it's the cheaper of the two, so an unknown split can't overstate the bill.
  if (w5 + w1 === 0) w5 = writeTotal
  else if (w5 + w1 !== writeTotal && writeTotal > 0) {
    // Trust the total when the breakdown disagrees, keeping the observed ratio.
    const scale = writeTotal / (w5 + w1)
    w5 = Math.round(w5 * scale)
    w1 = writeTotal - w5
  }

  const id = typeof msg?.id === 'string' ? msg.id : ''
  const req = typeof o.requestId === 'string' ? o.requestId : ''
  return {
    model,
    ts,
    key: id && req ? `${id}:${req}` : null,
    input: num(usage.input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    output: num(usage.output_tokens),
    speed: typeof usage.speed === 'string' ? usage.speed : undefined
  }
}

// ---------- Codex rollouts ----------

/**
 * Codex writes `~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl`. Usage
 * arrives as `token_count` events carrying both a running total and the delta for
 * the call that just finished; the model is *not* on those events, so it has to be
 * carried forward from the most recent `turn_context` / `thread_settings_applied`.
 * Hence a small per-file state machine rather than a pure line function.
 */
export const CODEX_LINE_HINTS = ['token_count', '"model"']

export interface CodexSample {
  model: string
  ts: number
  /** Uncached input (Codex's `input_tokens` is inclusive of the cached part). */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

/** Per-file cursor: remembers the model in force for the next `token_count`. */
export class CodexFileReader {
  private model = ''
  private samples: CodexSample[] = []

  /** Feed one line; returns nothing — collect with `take()` at end of file. */
  push(line: string): void {
    if (!CODEX_LINE_HINTS.some((h) => line.includes(h))) return
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const payload = o.payload as Record<string, unknown> | undefined
    if (!payload) return

    if (o.type === 'turn_context') {
      if (typeof payload.model === 'string') this.model = payload.model
      return
    }
    if (o.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      const s = payload.thread_settings as Record<string, unknown> | undefined
      if (typeof s?.model === 'string') this.model = s.model
      return
    }
    if (o.type !== 'event_msg' || payload.type !== 'token_count') return

    const info = payload.info as Record<string, unknown> | undefined
    const last = info?.last_token_usage as Record<string, unknown> | undefined
    if (!last) return
    const ts = Date.parse(String(o.timestamp ?? ''))
    if (!Number.isFinite(ts)) return

    const total = num(last.input_tokens)
    const cached = Math.min(num(last.cached_input_tokens), total)
    const output = num(last.output_tokens)
    const write = num(last.cache_write_input_tokens)
    if (total + output + write === 0) return
    this.samples.push({
      model: this.model || 'unknown',
      ts,
      input: total - cached,
      cacheRead: cached,
      cacheWrite: write,
      output,
      reasoning: num(last.reasoning_output_tokens)
    })
  }

  take(): CodexSample[] {
    const out = this.samples
    this.samples = []
    return out
  }
}

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderUsage, RateLimitWindow, UsageOverview } from '@shared/types'
import { CodexAppServerClient } from './codexAppServer'
import { withTimeout } from './session'
import { codexWindow, type CodexWindow } from './usageWindows'

/**
 * Account-level plan limits for both providers, for the sidebar Usage popover.
 *
 * Deliberately independent of `ChatManager`: "how much headroom is left on my
 * plan" is a property of the login, not of a chat, and has to be answerable
 * with no chat open. Both providers can serve it off a throwaway process — the
 * Agent SDK's usage control request and Codex's `account/*` App Server methods
 * are both answered without a turn, so neither read costs tokens.
 */

/**
 * The single throttle on real reads, so callers can ask freely: turn boundaries
 * and popover opens both go through here, and only a miss costs a process. Long
 * enough that continuous heavy use can't spawn CLI processes in a loop, short
 * enough that a window can't move much behind the chip's back.
 */
const TTL_MS = 120_000
/** A cold read spawns a CLI process; past this the popover shows what it has. */
const TIMEOUT_MS = 12_000

let cached: { at: number; value: UsageOverview } | null = null
let inflight: Promise<UsageOverview> | null = null

/** A prompt stream that never yields — these sessions only issue control requests. */
async function* idlePrompt(): AsyncGenerator<never> {
  await new Promise(() => {})
}

function unavailable(provider: ProviderUsage['provider'], note: string): ProviderUsage {
  return { provider, available: false, note, windows: [] }
}


// ---------- Claude ----------

/**
 * Reads plan limits off a throwaway agent process, like `warmModels`: the usage
 * control request is answered without a turn, so this must NOT wait for the
 * `init` message (the CLI only emits it once a turn begins). No setting sources
 * either — the answer is account-level, and skipping them keeps a project's
 * SessionStart hooks out of the path.
 */
async function readClaude(cwd: string): Promise<ProviderUsage> {
  const q = query({ prompt: idlePrompt(), options: { cwd } })
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
    if (!u.rate_limits_available || !u.rate_limits) {
      return {
        provider: 'claude',
        available: false,
        note: 'Plan limits don’t apply to this login.',
        plan: u.subscription_type,
        windows: []
      }
    }
    const rl = u.rate_limits
    const windows: RateLimitWindow[] = []
    const push = (
      label: string,
      w?: { utilization: number | null; resets_at: string | null } | null
    ): void => {
      if (w) windows.push({ label, utilization: w.utilization, resetsAt: w.resets_at })
    }
    push('5-hour', rl.five_hour)
    push('7-day', rl.seven_day)
    push('7-day (Opus)', rl.seven_day_opus)
    push('7-day (Sonnet)', rl.seven_day_sonnet)
    // Per-model weekly buckets the server sends for the current plan. Additive,
    // and the only place a model-scoped limit shows up on newer accounts — the
    // fixed seven_day_opus / seven_day_sonnet fields come back null there.
    for (const m of rl.model_scoped ?? []) {
      push(`${m.display_name} (weekly)`, { utilization: m.utilization, resets_at: m.resets_at })
    }
    return {
      provider: 'claude',
      available: windows.length > 0,
      note: windows.length > 0 ? undefined : 'No plan limit windows reported.',
      plan: u.subscription_type,
      windows
    }
  } catch (err) {
    console.error('claude usage failed:', err)
    return unavailable('claude', 'Couldn’t read Claude usage. Are you signed in?')
  } finally {
    try {
      q.close()
    } catch {
      // already closed
    }
  }
}

// ---------- Codex ----------

interface CodexAccountResponse {
  account?: { type?: string; email?: string; planType?: string } | null
}

interface CodexRateLimitsResponse {
  rateLimits?: CodexRateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null
  rateLimitResetCredits?: { availableCount?: number | null } | null
}

interface CodexRateLimitSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  planType?: string | null
}

/**
 * Reads plan limits over a short-lived `codex app-server`. The `account/*`
 * methods need no thread, so this never starts (or resumes) a conversation.
 */
async function readCodex(): Promise<ProviderUsage> {
  const client = new CodexAppServerClient()
  try {
    const [account, limits] = (await Promise.all([
      client.request('account/read', { refreshToken: false }),
      client.request('account/rateLimits/read', undefined)
    ])) as [CodexAccountResponse, CodexRateLimitsResponse]

    if (!account?.account) return unavailable('codex', 'Not signed in to Codex.')

    const rl = limits?.rateLimits
    const buckets = Object.entries(limits?.rateLimitsByLimitId ?? {})
    const snapshots: Array<[string, CodexRateLimitSnapshot]> = buckets.length
      ? buckets
      : rl
        ? [[rl.limitName || rl.limitId || '', rl]]
        : []
    const prefix = snapshots.length > 1
    const windows = snapshots.flatMap(([key, snapshot]) =>
      [codexWindow(snapshot.primary), codexWindow(snapshot.secondary)]
        .filter((w): w is RateLimitWindow => w !== null)
        .map((window) => ({
          ...window,
          label: prefix && key ? `${key} · ${window.label}` : window.label
        }))
    )

    return {
      provider: 'codex',
      available: windows.length > 0,
      note: windows.length > 0 ? undefined : 'No plan limit windows reported.',
      plan: rl?.planType ?? snapshots[0]?.[1].planType ?? account.account.planType ?? null,
      windows,
      resetCredits: limits?.rateLimitResetCredits?.availableCount ?? 0
    }
  } catch (err) {
    console.error('codex usage failed:', err)
    return unavailable('codex', 'Couldn’t read Codex usage. Are you signed in?')
  } finally {
    client.dispose()
  }
}

// ---------- Entry point ----------

/**
 * Both providers' plan limits. Cached for `TTL_MS` and deduped while in flight,
 * because a cold read spawns one CLI process per provider — cheap once, not
 * cheap on every popover open. `refresh` is the panel's explicit refresh.
 */
export function readUsageOverview(cwd: string, refresh = false): Promise<UsageOverview> {
  if (!refresh && cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value)
  if (inflight) return inflight
  const run = (async (): Promise<UsageOverview> => {
    // Independent so one provider being signed out never blanks the other.
    const [claude, codex] = await Promise.all([
      withTimeout(readClaude(cwd), TIMEOUT_MS, unavailable('claude', 'Timed out reading Claude usage.')),
      withTimeout(readCodex(), TIMEOUT_MS, unavailable('codex', 'Timed out reading Codex usage.'))
    ])
    const value: UsageOverview = { claude, codex }
    cached = { at: Date.now(), value }
    return value
  })()
  inflight = run
  void run.finally(() => {
    if (inflight === run) inflight = null
  })
  return run
}

import * as React from 'react'
import { cn } from '@/lib/utils'
import { resetsIn } from '@/lib/format'
import type { ProviderUsage, UsageOverview } from '@shared/types'

/** Amber from here up: still fine, but worth knowing before you start a big turn. */
export const USAGE_WARN = 70
/** Red from here up. */
export const USAGE_CRITICAL = 90

/** Tailwind fill for a utilization percentage, shared by the bar and the ring. */
export function usageColor(pct: number): string {
  if (pct >= USAGE_CRITICAL) return 'bg-destructive'
  if (pct >= USAGE_WARN) return 'bg-amber-500'
  return 'bg-primary'
}

/**
 * A 0–100 plan-utilization bar with a label and reset time. Shared by the
 * per-chat SessionPanel and the account-level UsagePanel so the two can't
 * disagree about what 85% looks like.
 */
export function UsageBar({
  label,
  utilization,
  resetsAt
}: {
  label: string
  utilization: number | null
  resetsAt?: string | null
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, utilization ?? 0))
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {utilization == null ? '—' : `${Math.round(pct)}%`}
          {Number.isFinite(reset) && (
            <span className="ml-1 opacity-70">· resets in {resetsIn(reset)}</span>
          )}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full', usageColor(pct))}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  )
}

/** The most-used window across both providers — what the trigger reports. */
export function peakUtilization(
  overview: UsageOverview | null
): { pct: number; provider: ProviderUsage['provider'] } | null {
  if (!overview) return null
  let peak: { pct: number; provider: ProviderUsage['provider'] } | null = null
  for (const p of [overview.claude, overview.codex]) {
    if (!p.available) continue
    for (const w of p.windows) {
      if (w.utilization == null) continue
      if (!peak || w.utilization > peak.pct) peak = { pct: w.utilization, provider: p.provider }
    }
  }
  return peak
}

/** Text tone for a utilization: the usage trigger's colour, on both screens. */
export function usageTone(pct: number | null): string {
  if (pct == null) return 'text-muted-foreground'
  if (pct >= USAGE_CRITICAL) return 'text-destructive'
  if (pct >= USAGE_WARN) return 'text-amber-500'
  return 'text-muted-foreground'
}

/**
 * The trigger's whole point: the number is readable without opening anything.
 * Checking your headroom shouldn't require a click — by the time you'd think to
 * look, you're usually already against the limit.
 */
export function UsageRing({ pct, className }: { pct: number | null; className?: string }): React.JSX.Element {
  const r = 5.5
  const circumference = 2 * Math.PI * r
  const filled = ((pct ?? 0) / 100) * circumference
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0 -rotate-90', className)} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity={0.2} />
      {pct != null && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      )}
    </svg>
  )
}

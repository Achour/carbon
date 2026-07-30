import * as React from 'react'
import { cn } from '@/lib/utils'
import { resetsIn } from '@/lib/format'

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

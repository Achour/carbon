import * as React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ProviderUsage, UsageOverview } from '@shared/types'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { UsageBar, USAGE_CRITICAL, USAGE_WARN } from '@/components/UsageBar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WithTooltip } from '@/components/ui/tooltip'

const PROVIDER_LABEL: Record<ProviderUsage['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode'
}

/**
 * Every provider the overview actually carries. OpenCode is absent unless its
 * CLI is installed, so this is a filter rather than a fixed pair.
 */
function providerUsages(overview: UsageOverview): ProviderUsage[] {
  return [overview.claude, overview.codex, overview.opencode].filter(
    (p): p is ProviderUsage => p != null
  )
}

/** The most-used window across the available providers — what the trigger reports. */
function peakUtilization(
  overview: UsageOverview | null
): { pct: number; provider: ProviderUsage['provider'] } | null {
  if (!overview) return null
  let peak: { pct: number; provider: ProviderUsage['provider'] } | null = null
  for (const p of providerUsages(overview)) {
    if (!p.available) continue
    for (const w of p.windows) {
      if (w.utilization == null) continue
      if (!peak || w.utilization > peak.pct) peak = { pct: w.utilization, provider: p.provider }
    }
  }
  return peak
}

function toneFor(pct: number | null): string {
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
function UsageRing({ pct }: { pct: number | null }): React.JSX.Element {
  const r = 5.5
  const circumference = 2 * Math.PI * r
  const filled = ((pct ?? 0) / 100) * circumference
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden>
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

function ProviderSection({ usage }: { usage: ProviderUsage }): React.JSX.Element {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {PROVIDER_LABEL[usage.provider]}
        </span>
        {usage.plan && (
          <span className="rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
            {usage.plan}
          </span>
        )}
      </div>
      {usage.available ? (
        <div className="space-y-2">
          {usage.windows.map((w) => (
            <UsageBar key={w.label} label={w.label} utilization={w.utilization} resetsAt={w.resetsAt} />
          ))}
          {/* Codex-only, and only worth a line when there's actually one to spend. */}
          {!!usage.resetCredits && usage.resetCredits > 0 && (
            <div className="text-[11px] text-muted-foreground/70">
              {usage.resetCredits} reset credit{usage.resetCredits === 1 ? '' : 's'} available
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] leading-relaxed text-muted-foreground/70">{usage.note}</div>
      )}
    </section>
  )
}

/**
 * Account-level plan limits for both providers, from the sidebar footer.
 *
 * Separate from SessionPanel, which answers a different question: that one is
 * "what is this chat's session doing" (cost, MCP servers, rules), this one is
 * "how much of my plan is left" — a property of the login, so it deliberately
 * works with no chat open and shows both providers side by side. Comparing them
 * is the point: it's what tells you which agent to start the next task on.
 */
export function UsagePanel(): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  // Store-held, not local: turn boundaries refresh this from the reducer, so the
  // chip stays honest during a long session without the panel being open.
  const overview = useApp((s) => s.usage)
  const refreshUsage = useApp((s) => s.refreshUsage)

  const load = React.useCallback(
    async (force = false): Promise<void> => {
      setBusy(true)
      try {
        await refreshUsage(force)
      } finally {
        setBusy(false)
      }
    },
    [refreshUsage]
  )

  // The ring has to mean something before the first click, so this reads once
  // unprompted — but on a delay. A cold read spawns a CLI process per provider,
  // and startup is deliberately lazy (the store opens the database and reads
  // nothing else); racing that for a number nobody has looked at yet is a bad
  // trade.
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 4000)
    return () => clearTimeout(timer)
  }, [load])
  // Opening reads unforced: main answers from cache when it's warm, so this is
  // free on a reopen and only spends a process once the numbers have aged out.
  // The ⟳ button is the escape hatch when you want it read right now.
  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const peak = peakUtilization(overview)
  const pct = peak?.pct ?? null
  const tone = toneFor(pct)
  const label =
    peak == null
      ? 'Usage'
      : `Usage · ${PROVIDER_LABEL[peak.provider]} ${Math.round(peak.pct)}%`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label={label}>
        <PopoverTrigger
          aria-label={label}
          className={cn(
            'no-drag flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 outline-none transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent',
            tone
          )}
        >
          <UsageRing pct={pct} />
          {peak && (
            // Naming the provider is not decoration: a bare "31%" doesn't say
            // 31% of what, and the answer flips between providers as one or the
            // other gets closer to its limit — which is exactly the thing worth
            // knowing at a glance.
            <span className="text-[11px] tabular-nums">
              {PROVIDER_LABEL[peak.provider]} {Math.round(peak.pct)}%
            </span>
          )}
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent side="top" align="start" className="w-72 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">Usage</span>
          <WithTooltip label="Refresh">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh usage"
              disabled={busy}
              onClick={() => void load(true)}
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            </Button>
          </WithTooltip>
        </div>
        <div className="space-y-4 p-3">
          {!overview ? (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading plan limits…
            </div>
          ) : (
            <>
              <ProviderSection usage={overview.claude} />
              <div className="border-t border-border pt-3">
                <ProviderSection usage={overview.codex} />
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

import * as React from 'react'
import { ChartColumn, ChevronRight, RefreshCw } from 'lucide-react'
import { PROVIDER_SHORT_LABELS, type ProviderUsage, type RateLimitWindow } from '@shared/types'
import { peakUtilization, usageColor, UsageRing, usageTone } from '@/components/UsageBar'
import { ProviderMark } from '@/components/ui/provider-mark'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { resetsIn } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import { Sheet } from './Sheet'
import { navigate } from './App'

/**
 * The plan's headroom, from the sidebar's footer: the desktop's ring and
 * "Claude 31%" as the trigger, the 5-hour and weekly bars in a sheet. Same
 * numbers as the desktop's Usage popover (`usage:overview`, cached in main),
 * drawn at a size a thumb and a phone held at arm's length can read.
 */
export function UsageButton(): React.JSX.Element {
  const usage = useRemote((s) => s.usage)
  const [open, setOpen] = React.useState(false)
  const peak = peakUtilization(usage)
  const pct = peak?.pct ?? null
  const label = peak ? `Usage · ${PROVIDER_SHORT_LABELS[peak.provider]} ${Math.round(peak.pct)}%` : 'Usage'
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 active:bg-sidebar-accent',
          usageTone(pct)
        )}
      >
        <UsageRing pct={pct} className="size-[18px]" />
        {peak && (
          <span className="text-[13px] tabular-nums">
            {PROVIDER_SHORT_LABELS[peak.provider]} {Math.round(peak.pct)}%
          </span>
        )}
      </button>
      <UsageSheet open={open} onClose={() => setOpen(false)} />
    </>
  )
}

function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const usage = useRemote((s) => s.usage)
  const refreshUsage = useRemote((s) => s.refreshUsage)
  const [busy, setBusy] = React.useState(false)

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

  // Unforced: main answers from its cache while it is warm, so reopening is free.
  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        <div className="-my-1 flex items-center justify-between">
          <span>Plan usage</span>
          <button
            type="button"
            aria-label="Refresh usage"
            disabled={busy}
            onClick={() => void load(true)}
            className="-mr-2 flex size-9 items-center justify-center rounded-full active:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
          </button>
        </div>
      }
    >
      <div className="px-3 pb-3">
        {!usage ? (
          <div className="flex items-center gap-2.5 py-6 text-[14px] text-muted-foreground">
            <DotSpinner className="size-4" />
            Reading plan limits…
          </div>
        ) : (
          <>
            <ProviderSection usage={usage.claude} />
            <div className="mt-2 border-t border-border">
              <ProviderSection usage={usage.codex} />
            </div>
          </>
        )}
        {/* Headroom is the plan's question; history is the Usage page's. */}
        <button
          type="button"
          onClick={() => {
            onClose()
            useRemote.getState().setDrawer(false)
            navigate('#/usage')
          }}
          className="mt-4 flex h-12 w-full items-center gap-3 rounded-xl bg-secondary px-3.5 text-left text-[15px] active:bg-accent"
        >
          <ChartColumn className="size-[18px] shrink-0 text-muted-foreground" />
          <span className="flex-1">Spend history</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </Sheet>
  )
}

function ProviderSection({ usage }: { usage: ProviderUsage }): React.JSX.Element {
  return (
    <section className="pt-4 pb-1">
      <div className="mb-3 flex items-center gap-2">
        <ProviderMark provider={usage.provider} className="size-4" />
        <span className="flex-1 text-[15px] font-medium">{PROVIDER_SHORT_LABELS[usage.provider]}</span>
        {usage.plan && (
          <span className="rounded-md bg-secondary px-2 py-0.5 text-[12px] text-muted-foreground">{usage.plan}</span>
        )}
      </div>
      {usage.available ? (
        <div className="space-y-4">
          {usage.windows.map((w) => (
            <WindowBar key={w.label} window={w} />
          ))}
          {/* Codex-only, and only worth a line when there's actually one to spend. */}
          {!!usage.resetCredits && usage.resetCredits > 0 && (
            <div className="text-[13px] text-muted-foreground">
              {usage.resetCredits} reset credit{usage.resetCredits === 1 ? '' : 's'} available
            </div>
          )}
        </div>
      ) : (
        <div className="text-[14px] leading-snug text-muted-foreground">{usage.note}</div>
      )}
    </section>
  )
}

/** `UsageBar`'s reading, at the phone's type size. */
function WindowBar({ window: w }: { window: RateLimitWindow }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, w.utilization ?? 0))
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14.5px]">{w.label}</span>
        <span className="text-[14.5px] tabular-nums">{w.utilization == null ? '—' : `${Math.round(pct)}%`}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
        <div className={cn('h-full rounded-full', usageColor(pct))} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      {Number.isFinite(reset) && (
        <div className="mt-1 text-[12.5px] text-muted-foreground">Resets in {resetsIn(reset)}</div>
      )}
    </div>
  )
}

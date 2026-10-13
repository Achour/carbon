import * as React from 'react'
import { contextUsageFor, useApp } from '@/store'
import { formatTokens } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The popover's body. A separate component so its subscription and its markup
 * belong to the popup, not to the composer: `PopoverContent`'s children are
 * built at the trigger's render time, and the composer re-renders on every
 * coalesced delta mid-turn. Nothing here runs until the popup is open.
 */
export function ContextDetail({
  used,
  window: win,
  name,
  chatId
}: {
  used: number
  window: number
  name: string
  chatId: string | null
}): React.JSX.Element {
  // Whichever surface draws this chat. Read from `contextUsage` unconditionally,
  // a side chat's popover showed the *main* chat's breakdown — the same numbers
  // under a different conversation, which is worse than showing none.
  const usage = useApp((s) => contextUsageFor(s, chatId))
  const pct = Math.min(1, used / win)
  const rows = usage?.overhead ?? []
  const shown = rows.slice(0, 5)
  const rest = rows.slice(5).reduce((n, row) => n + row.tokens, 0)
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">Context window</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(pct * 100)}% used
        </span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct > 0.9 ? 'bg-destructive' : pct > 0.7 ? 'bg-amber-500' : 'bg-primary'
          )}
          style={{ width: `${Math.max(2, pct * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{formatTokens(used)} used</span>
        <span>
          {formatTokens(Math.max(0, win - used))} free of {formatTokens(win)}
        </span>
      </div>
      {/* Being over has no other symptom until a turn stalls compacting, so it
          is said out loud while it is still just a number. */}
      {usage?.overLimit && (
        <p className="mt-2 rounded-md bg-secondary px-2 py-1.5 text-[11px] leading-relaxed text-amber-500">
          {formatTokens(usage.overLimit.tokensOver)} over{' '}
          {usage.overLimit.kind === 'hard_limit'
            ? 'the hard limit — the next request would be rejected.'
            : 'the compaction threshold — the next turn compacts first.'}
        </p>
      )}
      {shown.length > 0 && (
        <div className="mt-2.5 border-t border-border pt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Always loaded</div>
          {shown.map((row) => (
            <div
              key={`${row.detail}:${row.label}`}
              className="flex items-baseline justify-between gap-2 py-px text-[11px]"
            >
              <span className="truncate text-muted-foreground" title={row.label}>
                {row.label}
                <span className="ml-1 text-muted-foreground/60">{row.detail}</span>
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatTokens(row.tokens)}
              </span>
            </div>
          ))}
          {rest > 0 && (
            <div className="flex items-baseline justify-between gap-2 py-px text-[11px] text-muted-foreground/60">
              <span>+{rows.length - shown.length} more</span>
              <span className="tabular-nums">{formatTokens(rest)}</span>
            </div>
          )}
        </div>
      )}
      <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
        How much of the conversation {name} can hold at once. When it fills up, older messages are
        compacted automatically so the chat can continue.
      </p>
    </>
  )
}

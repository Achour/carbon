import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { formatAgentDuration } from '@shared/agentRuns'
import { cn } from '@/lib/utils'

/**
 * The row that opens every turn: `Working for 17s` while it runs, and
 * `Worked for 31s ›` once it lands — the control that folds the whole run down
 * to its answer.
 *
 * **It is a sibling of the turn's nodes, never their parent.** What it
 * discloses is the rest of the flat keyed array `ChatView` renders, so this is
 * a plain button and not a `Collapsible`: a base-ui trigger opens a panel it
 * owns, and there is nothing here for it to own — wrapping the turn's messages
 * in one would remount every settled row at the moment the turn ends, which is
 * exactly what `useHistoryNodes` exists to prevent.
 *
 * The rule under it is the header's own, not a divider between turns: it draws
 * the line the work hangs from, so a folded turn is a label, a rule and an
 * answer rather than a label floating over prose.
 */
export const TurnHeader = React.memo(function TurnHeader({
  userMessageId,
  startTs,
  endTs,
  live,
  collapsible,
  expanded,
  onToggle
}: {
  userMessageId: string
  /** The prompt's `ts` — one clock for both readings, see below. */
  startTs: number
  /** `ts` of the turn's last message; ignored while live. */
  endTs: number
  live: boolean
  /**
   * Whether the row is the fold's control. False for a turn that only talked
   * (folding would hide nothing) and for a live turn that has never folded;
   * true for a settled turn and for a live *continuation* of one that has
   * (`renderMessages` decides which — the label and the control are
   * independent, so a folded turn can tick "Working for" and still open).
   */
  collapsible: boolean
  expanded: boolean
  onToggle: (userMessageId: string) => void
}): React.JSX.Element {
  // Ticks in the component, off the prompt's timestamp, the way the tool and
  // agent clocks do. Routed through `RenderCtx` or the store instead, a value
  // that changes every second would re-render the whole transcript once a
  // second for the whole of a turn.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])

  // **One source, deliberately the same one in both states.** `TurnStats`
  // reports the provider's own `durationMs`, which is the more authoritative
  // number and the wrong one here: it would land a second or two off whatever
  // this row had just ticked up to, so the label would visibly jump the moment
  // the turn ended. Wall clock across the turn's own messages keeps the live
  // reading and the settled one on one clock — and it is the only reading a
  // turn that reported no stats at all has.
  const ms = Math.max(0, (live ? now : endTs) - startTs)
  const label = `${live ? 'Working' : 'Worked'} for ${formatAgentDuration(ms)}`

  // **No size of its own: the label reads at the transcript's own size.** It
  // sits in the same container as the prose it introduces, so inheriting is
  // the exact match rather than a number that has to be kept level with
  // `body`'s 14px by hand. It is a chrome *colour* on reading-size type — the
  // row is quiet, not small.
  return (
    <div className="flex flex-col gap-2">
      {!collapsible ? (
        // No affordance on a row that would answer a click with nothing: a
        // turn still doing its first run of work, or one with nothing to hide.
        <span className="text-muted-foreground">{label}</span>
      ) : (
        <button
          type="button"
          data-turn-header={userMessageId}
          onClick={() => onToggle(userMessageId)}
          aria-expanded={expanded}
          className={
            // `ToolCard`'s activity row, spelled out here because that constant
            // is private to it. The negative margin with the matching padding
            // is what lets the hover fill bleed past the text while the text
            // itself stays on the transcript's own left edge — so the label
            // does not move when the turn settles and this replaces the span.
            'group -mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40'
          }
        >
          {label}
          <ChevronRight
            className={cn(
              // Always drawn, unlike an activity row's — this chevron *is* the
              // affordance for the fold rather than a hint that a row opens —
              // but it brightens with the label so the two move together.
              'size-3.5 shrink-0 text-muted-foreground/50 transition-[color,transform] duration-200 group-hover:text-muted-foreground',
              expanded && 'rotate-90'
            )}
          />
        </button>
      )}
      <div className="h-px bg-border" />
    </div>
  )
})

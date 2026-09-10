/**
 * Coalescing a stream of parts into activity *runs*.
 *
 * A sequence of reads, searches and shell calls is one act of work, and drawn
 * a row apiece it buries the conversation it was serving. `ToolGroup` is the
 * row a run collapses to; this is the pass that decides where the runs are.
 *
 * It lives here rather than inside the transcript's `Blocks` because a
 * sub-agent's own stream is the same kind of stream and had no grouping at
 * all — so identical work read as one line when the main agent did it and as
 * eleven rows when a spawned agent did, inside a card that was already the
 * densest thing on screen. One pass, both callers.
 *
 * The two predicates are injected rather than imported: `isGroupableTool` and
 * the transcript's own skips live with the components that own them, and a
 * copy of either rule here is a copy that drifts.
 */
import type { AssistantPart, ToolPart } from '@shared/types'

/** Group a run of this many consecutive read/search tools into one row. */
export const GROUP_MIN = 2

/** A run of calls, or a part that stands on its own. */
export type PartRun =
  | { kind: 'group'; parts: ToolPart[]; key: string }
  | { kind: 'single'; part: AssistantPart; index: number }

export function groupToolRuns(
  parts: readonly (AssistantPart | null | undefined)[],
  {
    isGroupable,
    skip,
    from = 0
  }: {
    /** Whether this call is a step in a run rather than a block of its own. */
    isGroupable: (part: ToolPart) => boolean
    /**
     * Parts that draw nothing. They are dropped **without ending the run
     * around them**, which is the whole subtlety of this pass: Claude now
     * ships a withheld `thinking` block between every pair of tool calls, so a
     * loop that flushed on one would group nothing and every run would be a
     * single.
     */
    skip?: (part: AssistantPart) => boolean
    /** Ignore everything before this index — a folded turn's hidden prefix. */
    from?: number
  }
): PartRun[] {
  const items: PartRun[] = []
  let run: { part: ToolPart; index: number }[] = []
  const flush = (): void => {
    if (run.length >= GROUP_MIN) {
      items.push({ kind: 'group', parts: run.map((r) => r.part), key: `grp-${run[0].index}` })
    } else {
      for (const r of run) items.push({ kind: 'single', part: r.part, index: r.index })
    }
    run = []
  }
  for (let i = Math.max(0, from); i < parts.length; i++) {
    const part = parts[i]
    // Streamed arrays can be sparse; persisted ones turn holes into null.
    if (!part) continue
    if (skip?.(part)) continue
    if (part.type === 'tool' && isGroupable(part)) {
      run.push({ part, index: i })
    } else {
      flush()
      items.push({ kind: 'single', part, index: i })
    }
  }
  flush()
  return items
}

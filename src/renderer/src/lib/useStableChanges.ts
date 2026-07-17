import * as React from 'react'
import type { GitFileChange } from '@shared/types'

/**
 * During a live turn the store's `messages` array gets a fresh reference on every
 * streamed token, so `scopedChanges(...)` recomputes and (for last-turn scope)
 * returns a brand-new `.filter()` array each time — even when the edited-file set
 * is unchanged. That fresh reference would bust every downstream `useMemo` keyed
 * on `changes` once per token. Stabilize by content: hand back the previous array
 * whenever the change set hasn't actually changed.
 *
 * Fast path: the `uncommitted`/`branch` scopes return `scopedChanges`'s input
 * array (`git.changes` / `branchChanges.changes`) *by reference*, so when only
 * `messages` churned the input reference is unchanged and we short-circuit with no
 * work at all. Only `last-turn` scope (a fresh `.filter()` array per call) falls
 * through to a content signature — `GitFileChange` is a flat all-primitive shape,
 * so `JSON.stringify` is a complete, deterministic signature.
 */
export function useStableChanges(changes: GitFileChange[]): GitFileChange[] {
  const ref = React.useRef<{ input: GitFileChange[]; sig: string; value: GitFileChange[] } | null>(
    null
  )
  // Same input reference (the common stable-scope case) — no stringify needed.
  if (ref.current && ref.current.input === changes) return ref.current.value
  const sig = JSON.stringify(changes)
  if (!ref.current || ref.current.sig !== sig) {
    ref.current = { input: changes, sig, value: changes }
  } else {
    // Same content, fresh reference (last-turn re-filter): keep the stable value,
    // but remember this reference so the next identical render fast-paths.
    ref.current.input = changes
  }
  return ref.current.value
}

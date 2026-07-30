import type { RateLimitWindow } from '@shared/types'

/**
 * Pure normalization of Codex's rate-limit shape into `RateLimitWindow`, split
 * out of `usage.ts` so it can be unit-tested without spawning an App Server.
 *
 * Both conversions here fail silently rather than loudly if they're wrong — a
 * window mislabelled, or an epoch read in the wrong unit, still renders a
 * plausible-looking bar. That's exactly what's worth pinning.
 */

/** What Codex reports for a window instead of a name. */
export interface CodexWindow {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null
}

/**
 * Codex describes a window only as a duration in minutes, so the label is ours
 * to derive. Claude names its own ("5-hour", "7-day"), and the popover stacks
 * the two providers together — so these have to read like they came from the
 * same vocabulary.
 */
export function codexWindowLabel(mins: number | null | undefined): string {
  if (!mins || mins <= 0 || !Number.isFinite(mins)) return 'Usage'
  if (mins % 10080 === 0) {
    const weeks = mins / 10080
    return weeks === 1 ? 'Weekly' : `${weeks}-week`
  }
  if (mins % 1440 === 0) {
    const days = mins / 1440
    return days === 1 ? 'Daily' : `${days}-day`
  }
  if (mins % 60 === 0) {
    const hours = mins / 60
    return hours === 1 ? 'Hourly' : `${hours}-hour`
  }
  return `${mins}-minute`
}

/**
 * One Codex window as the renderer's shared bar wants it, or null when there's
 * nothing to show. A window with no `usedPercent` is dropped rather than drawn
 * at zero: "0% used" and "not reported" look identical on a bar, and only one
 * of them is good news.
 */
export function codexWindow(w?: CodexWindow | null): RateLimitWindow | null {
  if (!w || w.usedPercent == null) return null
  return {
    label: codexWindowLabel(w.windowDurationMins),
    utilization: w.usedPercent,
    // Codex sends epoch *seconds*; RateLimitWindow carries an ISO string, and
    // the renderer parses it back to epoch *milliseconds*. Missing this ×1000
    // renders "resets in 55 years" — wrong, but not obviously wrong.
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null
  }
}

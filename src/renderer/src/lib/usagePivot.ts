import type { UsageAmounts, UsageFact, UsageKind } from '@shared/types'

/**
 * Every view on the Usage page is a fold over one array of facts.
 *
 * Main reduces the logs to (day, provider, model, project) slices and stops
 * there; this file is what turns them into whatever the page is showing — a
 * headline, a stacked column per day, a table grouped by provider, project or
 * model — under whichever filters are set. Keeping it here, and pure, is what
 * lets a click on a column or a row re-cut the whole page instantly without a
 * second report or a round trip.
 *
 * Dependency-free so `node --test` runs it directly (`test/usagePivot.test.ts`).
 */

export type UsageMeasure = 'cost' | 'tokens'
export type UsageGroup = 'provider' | 'project' | 'model'

const KINDS: readonly UsageKind[] = ['input', 'cacheRead', 'cacheWrite', 'output']

export interface UsageSlice {
  tokens: UsageAmounts
  cost: UsageAmounts
  reasoning: number
  savedUsd: number
  responses: number
  unpriced: number
}

export function emptyAmounts(): UsageAmounts {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

export function emptySlice(): UsageSlice {
  return {
    tokens: emptyAmounts(),
    cost: emptyAmounts(),
    reasoning: 0,
    savedUsd: 0,
    responses: 0,
    unpriced: 0
  }
}

export function addFact(into: UsageSlice, f: UsageFact): void {
  for (const k of KINDS) {
    into.tokens[k] += f.tokens[k]
    into.cost[k] += f.cost[k]
  }
  into.reasoning += f.reasoning
  into.savedUsd += f.savedUsd
  into.responses += f.responses
  into.unpriced += f.unpriced
}

export function sumAmounts(a: UsageAmounts): number {
  return a.input + a.cacheRead + a.cacheWrite + a.output
}

/** A slice's amounts in the measure on screen. */
export function amountsOf(s: UsageSlice, measure: UsageMeasure): UsageAmounts {
  return measure === 'cost' ? s.cost : s.tokens
}

/** A slice's single figure in the measure on screen. */
export function valueOf(s: UsageSlice, measure: UsageMeasure): number {
  return sumAmounts(amountsOf(s, measure))
}

/**
 * The key a fact files under for a grouping. A model is keyed with its
 * provider, since two backends can report the same id and they are priced and
 * served apart.
 */
export function keyOf(f: UsageFact, by: UsageGroup): string {
  if (by === 'provider') return f.provider
  if (by === 'project') return String(f.project)
  return `${f.provider}\u0000${f.model}`
}

export interface UsageFilter {
  /** `YYYY-MM-DD`: only that day. */
  day?: string | null
  /** Only facts filing under this key of `by`. */
  focus?: { by: UsageGroup; key: string } | null
}

export function filterFacts(facts: readonly UsageFact[], filter: UsageFilter): UsageFact[] {
  const { day, focus } = filter
  if (!day && !focus) return facts as UsageFact[]
  return facts.filter(
    (f) => (!day || f.day === day) && (!focus || keyOf(f, focus.by) === focus.key)
  )
}

export function totalOf(facts: readonly UsageFact[]): UsageSlice {
  const t = emptySlice()
  for (const f of facts) addFact(t, f)
  return t
}

export interface UsageRow {
  key: string
  slice: UsageSlice
  /** The first fact seen for the key — carries the provider, model and project. */
  sample: UsageFact
}

/** Facts grouped by `by`, largest first in `measure`, ties broken the other way. */
export function groupFacts(
  facts: readonly UsageFact[],
  by: UsageGroup,
  measure: UsageMeasure
): UsageRow[] {
  const rows = new Map<string, UsageRow>()
  for (const f of facts) {
    const key = keyOf(f, by)
    let row = rows.get(key)
    if (!row) rows.set(key, (row = { key, slice: emptySlice(), sample: f }))
    addFact(row.slice, f)
  }
  const other: UsageMeasure = measure === 'cost' ? 'tokens' : 'cost'
  return [...rows.values()].sort(
    (a, b) =>
      valueOf(b.slice, measure) - valueOf(a.slice, measure) ||
      valueOf(b.slice, other) - valueOf(a.slice, other)
  )
}

/** The key the chart files everything past its named series under. */
export const OTHER = '\u0000other'

export interface DailyStack {
  /** Series keys, bottom of the stack first; `OTHER` last when present. */
  keys: string[]
  /** `values[series][day]`, in `measure`. */
  values: number[][]
}

/**
 * One stacked column per day: the `limit` largest series by name, the rest
 * folded into `OTHER`. Series are ranked over the whole window, not per day, so
 * a series keeps its place in the stack from one column to the next.
 */
export function dailyStack(
  facts: readonly UsageFact[],
  days: readonly string[],
  by: UsageGroup,
  measure: UsageMeasure,
  limit: number
): DailyStack {
  const ranked = groupFacts(facts, by, measure)
    .filter((r) => valueOf(r.slice, measure) > 0)
    .map((r) => r.key)
  const named = ranked.slice(0, limit)
  const hasOther = ranked.length > limit
  const keys = hasOther ? [...named, OTHER] : named
  const slot = new Map(keys.map((k, i) => [k, i]))
  const dayAt = new Map(days.map((d, i) => [d, i]))
  const values = keys.map(() => days.map(() => 0))
  for (const f of facts) {
    const d = dayAt.get(f.day)
    if (d === undefined) continue
    const s = slot.get(keyOf(f, by)) ?? (hasOther ? keys.length - 1 : undefined)
    if (s === undefined) continue
    values[s][d] +=
      measure === 'cost' ? sumAmounts(f.cost) : sumAmounts(f.tokens)
  }
  return { keys, values }
}

/** `+23%` / `−8%` against a previous figure, or null when there is nothing to compare. */
export function change(now: number, before: number): number | null {
  if (!(before > 0)) return null
  return ((now - before) / before) * 100
}

import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { RefreshCw, X } from 'lucide-react'
import { PROVIDER_LABELS, USAGE_KINDS, USAGE_RANGES } from '@shared/types'
import type { UsageFact, UsageKind, UsageProvider, UsageReport } from '@shared/types'
import { cn } from '@/lib/utils'
import { formatTokens, formatUsd, relativeTime } from '@/lib/format'
import { projectLabel } from '@/lib/projects'
import { projectHue } from '@/lib/projectIdentity'
import {
  OTHER,
  amountsOf,
  change,
  dailyStack,
  filterFacts,
  groupFacts,
  keyOf,
  sumAmounts,
  totalOf,
  valueOf,
  type UsageGroup,
  type UsageMeasure,
  type UsageRow
} from '@/lib/usagePivot'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { ProjectAvatar } from '@/components/ui/project-avatar'

/**
 * The Usage page: what was spent, where, over the last 7/30/90 days.
 *
 * Deliberately a page and not another popover. The sidebar's Usage chip answers
 * "can I start a big turn right now" in one number and belongs next to the
 * composer; this answers "where is the money going", which is a question you sit
 * down with.
 *
 * **One measure at a time, for the whole page.** Cost and tokens answer
 * different questions — what a habit is worth, and how much work it moved — and
 * a page that mixed them (a dollar headline over a token chart over a table with
 * a column of each) made every comparison a conversion. The switch beside the
 * range re-expresses *everything*: headline, composition, chart, every column.
 *
 * **Every number is a fold over one array of facts** (`lib/usagePivot.ts`), so
 * the page is explorable rather than fixed: a column of the chart filters the
 * page to that day, a row of the table filters it to that provider, project or
 * model, and both clear from the chips that name them.
 *
 * The cost is *list price*, not a bill. On a subscription nobody is charged per
 * token, so a number presented as "your spend" would be a lie; presented as what
 * the same tokens would cost on the API, it is the only comparable figure there
 * is — and it's the one that tells you whether a habit is expensive.
 */

// ---------- Vocabulary ----------

const PROVIDERS: { key: UsageProvider; color: string }[] = [
  // Identity hues, fixed — see `--chart-claude` in `index.css`.
  { key: 'claude', color: 'var(--chart-claude)' },
  { key: 'codex', color: 'var(--chart-codex)' },
  { key: 'grok', color: 'var(--chart-grok)' }
]
const PROVIDER_COLOR = Object.fromEntries(PROVIDERS.map((p) => [p.key, p.color])) as Record<
  UsageProvider,
  string
>

const KIND_LABEL: Record<UsageKind, string> = {
  input: 'Fresh input',
  cacheRead: 'Cache reads',
  cacheWrite: 'Cache writes',
  output: 'Output'
}

/**
 * Kinds are *composition*, not identity, so they take one ink at four
 * strengths rather than four more hues — the three provider hues are solved as
 * a set and a fourth through seventh would crowd them. Darker is dearer per
 * token: output, then writes, then fresh input, then reads.
 */
const KIND_COLOR: Record<UsageKind, string> = {
  output: 'color-mix(in oklch, var(--foreground) 88%, transparent)',
  cacheWrite: 'color-mix(in oklch, var(--foreground) 60%, transparent)',
  input: 'color-mix(in oklch, var(--foreground) 38%, transparent)',
  cacheRead: 'color-mix(in oklch, var(--foreground) 18%, transparent)'
}

/** What everything past the named series folds into, on the chart. */
const OTHER_COLOR = 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)'

/** Named series on the chart before the rest becomes "Other". */
const SERIES_LIMIT = 6
/** Lightness offsets for a provider's 1st, 2nd, 3rd… model on the chart. */
const MODEL_STEPS = [0, 0.16, -0.12, 0.26, -0.2, 0.08]
/** Table rows shown before "Show all". */
const ROW_LIMIT = 10

const GROUPS: { id: UsageGroup; label: string }[] = [
  { id: 'provider', label: 'Provider' },
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' }
]

function fmt(v: number, measure: UsageMeasure): string {
  return measure === 'cost' ? formatUsd(v) : formatTokens(v)
}

/** Compact money for axes and legends: `$1.2k`, `$85`, `$0.40`. */
function compactUsd(v: number): string {
  if (v >= 1000) return `$${Number((v / 1000).toFixed(v >= 10_000 ? 0 : 1))}k`
  if (v >= 100) return `$${Math.round(v)}`
  return `$${v.toFixed(v === 0 ? 0 : 2)}`
}

function compact(v: number, measure: UsageMeasure): string {
  return measure === 'cost' ? compactUsd(v) : formatTokens(v)
}

function pct(part: number, whole: number): string {
  if (!(whole > 0)) return '0%'
  const p = (part / whole) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  // 99.6% is not 100%: the rounding would claim every input token was cached.
  if (p >= 99.5 && p < 100) return `${Math.min(p, 99.9).toFixed(1)}%`
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`
}

/** `Jul 9` — parsed as local, not UTC. */
function shortDay(day: string, weekday = false): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric'
  })
}

/** `day` moved by `n` days, `YYYY-MM-DD` in and out, local. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(y, m - 1, d + n)
  const p = (v: number): string => String(v).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/**
 * The first day every provider still has logs for, or null when nothing is
 * pruned. Before it the page is reading a partial history — Codex's days and
 * not Claude Code's — and has to say so.
 */
function completeFrom(report: UsageReport): string | null {
  const days = Object.values(report.keptFrom).filter((d): d is string => !!d)
  return days.length ? days.sort().at(-1)! : null
}

function updatedLabel(scannedAt: number): string {
  const ago = relativeTime(scannedAt)
  return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`
}

// ---------- Series identity ----------

interface SeriesInfo {
  label: string
  color: string
  /** Shown in mono — a model id is a slug, not a name. */
  mono?: boolean
  /** A project's root, for its mark. */
  root?: string
}

/**
 * How a key of the current grouping is drawn. Providers wear their identity
 * hue, projects the hue their mark already wears in the sidebar, and models —
 * an open set with no colour of their own — the categorical palette by rank.
 */
function useSeriesInfo(
  report: UsageReport,
  by: UsageGroup,
  ranked: string[]
): (key: string, sample?: UsageFact) => SeriesInfo {
  const names = useApp((s) => s.projectNames)
  return React.useMemo(() => {
    const rank = new Map(ranked.map((k, i) => [k, i]))
    // Twelve project hues can collide among six named series; the second of a
    // pair steps lighter so the stack never shows one colour twice.
    const projectColor = new Map<string, string>()
    if (by === 'project') {
      const used = new Set<number>()
      for (const key of ranked.slice(0, SERIES_LIMIT)) {
        const hue = projectHue(report.projects[Number(key)] ?? '')
        const l = used.has(hue) ? 'calc(var(--project-ink-l) + 0.16)' : 'var(--project-ink-l)'
        used.add(hue)
        projectColor.set(key, `oklch(${l} var(--project-ink-c) ${hue})`)
      }
    }
    // A model wears its provider's hue, stepped in lightness by its rank among
    // that provider's models: the colours on this page are the labels, so a
    // Claude model must read as Claude in every grouping, never as Codex blue.
    const modelColor = new Map<string, string>()
    if (by === 'model') {
      const seen: Partial<Record<string, number>> = {}
      for (const key of ranked.slice(0, SERIES_LIMIT)) {
        const provider = key.slice(0, key.indexOf('\u0000')) as UsageProvider
        const k = (seen[provider] = (seen[provider] ?? -1) + 1)
        const step = MODEL_STEPS[k % MODEL_STEPS.length]
        modelColor.set(key, `oklch(from ${PROVIDER_COLOR[provider]} calc(l + ${step}) c h)`)
      }
    }
    return (key, sample) => {
      if (key === OTHER) return { label: 'Other', color: OTHER_COLOR }
      const named = (rank.get(key) ?? Infinity) < SERIES_LIMIT
      if (by === 'provider') {
        const p = key as UsageProvider
        return { label: PROVIDER_LABELS[p], color: PROVIDER_COLOR[p] }
      }
      if (by === 'project') {
        const root = report.projects[Number(key)] ?? ''
        return {
          label: root ? projectLabel(root, names) : 'Unknown folder',
          color: (named && projectColor.get(key)) || OTHER_COLOR,
          root
        }
      }
      const model = sample?.model ?? key.slice(key.indexOf('\u0000') + 1)
      return {
        label: model,
        color: (named && modelColor.get(key)) || OTHER_COLOR,
        mono: true
      }
    }
  }, [report, by, ranked, names])
}

// ---------- Primitives ----------

function Swatch({ color }: { color: string }): React.JSX.Element {
  return (
    <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div role="group" aria-label={ariaLabel} className="flex rounded-md bg-secondary p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-[11px] transition-colors',
            value === o.id
              ? 'bg-card font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A filter that is on, said in words, with its own way off. */
function Chip({ children, onClear }: { children: React.ReactNode; onClear: () => void }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 max-w-64 items-center gap-1.5 rounded-full border border-border bg-card pr-1 pl-2.5 text-[12px]">
      <span className="flex min-w-0 items-center gap-1.5 truncate">{children}</span>
      <button
        type="button"
        aria-label="Clear filter"
        onClick={onClear}
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return width
}

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]

/**
 * A ceiling for three ticks (0 · half · full) that is round enough to label and
 * tight enough to use the height. Derived from *half* the peak so the middle tick
 * is the round number — rounding the peak itself to 1/2/5 leaves a chart whose
 * data sits in the bottom half whenever the peak just clears a power of ten.
 */
function niceCeiling(peak: number): number {
  if (peak <= 0) return 1
  const half = peak / 2
  const mag = 10 ** Math.floor(Math.log10(half))
  const step = (STEPS.find((s) => half <= s * mag) ?? 10) * mag
  return step * 2
}

// ---------- Summary ----------

/**
 * The headline, said as one figure and the sentence under it, then what the
 * figure is made of. The composition is by *kind* in both measures because the
 * kinds are where the two diverge: cache reads are nearly every token and a
 * minority of the cost, and seeing that split is the one thing neither the
 * chart nor the table shows.
 */
function Summary({
  report,
  facts,
  measure,
  filtered,
  day
}: {
  report: UsageReport
  facts: UsageFact[]
  measure: UsageMeasure
  filtered: boolean
  day: string | null
}): React.JSX.Element {
  const slice = totalOf(facts)
  const amounts = amountsOf(slice, measure)
  const value = sumAmounts(amounts)
  const tokens = sumAmounts(slice.tokens)
  const span = day ? 1 : report.days.length
  const previous = measure === 'cost' ? report.previous.costUsd : report.previous.tokens
  // A previous window that reaches past a provider's pruned logs is missing that
  // provider's spend, and the change it implies is an artifact of the deletion.
  const kept = completeFrom(report)
  const comparable = !kept || addDays(report.from, -report.days.length) >= kept
  const delta = filtered || !comparable ? null : change(value, previous)
  const observedInput = slice.tokens.input + slice.tokens.cacheRead
  const sessions = day ? report.daySessions[report.days.indexOf(day)] ?? 0 : report.sessions

  const details: string[] = []
  if (!day) details.push(`${compact(value / span, measure)} a day`)
  if (!filtered || day) details.push(`${sessions.toLocaleString()} session${sessions === 1 ? '' : 's'}`)
  details.push(`${slice.responses.toLocaleString()} responses`)

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[40px] leading-none font-semibold tracking-tight tabular-nums">
          {measure === 'cost' ? formatUsd(value) : formatTokens(value)}
        </span>
        {measure === 'tokens' && <span className="text-[15px] text-muted-foreground">tokens</span>}
        {delta != null && (
          <WithTooltip
            label={`${fmt(previous, measure)} in the ${report.days.length} days before`}
          >
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                'bg-secondary text-muted-foreground'
              )}
            >
              {delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(Math.abs(delta) >= 10 ? 0 : 1)}% vs
              previous {report.days.length} days
            </span>
          </WithTooltip>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">
        {measure === 'cost'
          ? 'What these tokens would cost at API list rates, not what you were billed'
          : `${pct(slice.tokens.cacheRead, observedInput)} of input served from cache`}
        <span className="mx-1.5 opacity-50">·</span>
        {details.join(' · ')}
      </p>

      {/* Composition: one bar, four kinds. */}
      <div className="mt-5 flex h-2 gap-px overflow-hidden rounded-full bg-secondary">
        {USAGE_KINDS.map((k) =>
          amounts[k] > 0 ? (
            <div
              key={k}
              style={{ flexGrow: amounts[k], flexBasis: 0, background: KIND_COLOR[k], minWidth: 3 }}
            />
          ) : null
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {USAGE_KINDS.map((k) => (
          <div key={k} className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Swatch color={KIND_COLOR[k]} />
              {KIND_LABEL[k]}
            </div>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-[15px] font-medium tabular-nums">{fmt(amounts[k], measure)}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {pct(amounts[k], value)}
              </span>
            </div>
            <div className="truncate text-[11px] text-muted-foreground tabular-nums">
              {kindNote(k, slice, measure, tokens)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The one thing worth saying under each kind, in the other measure where it helps. */
function kindNote(
  k: UsageKind,
  slice: ReturnType<typeof totalOf>,
  measure: UsageMeasure,
  tokens: number
): string {
  if (measure === 'cost') {
    if (k === 'cacheRead' && slice.savedUsd > 0) return `saved ${compactUsd(slice.savedUsd)} vs uncached`
    return `${formatTokens(slice.tokens[k])} tokens`
  }
  if (k === 'output' && slice.reasoning > 0) return `incl. ${formatTokens(slice.reasoning)} reasoning`
  const cost = sumAmounts(slice.cost)
  return tokens > 0 ? `${pct(slice.cost[k], cost)} of cost` : ''
}

// ---------- Chart ----------

const CHART_H = 220
const PAD = { top: 10, right: 4, bottom: 22, left: 48 }

/**
 * One column per day, stacked by the current grouping.
 *
 * Stacked *columns*, where the page used to overlay *areas*. The objection to
 * stacking was right for lines — a stacked line draws a small series at the
 * total's height, so $200 of Claude and $15 of Codex read as the same — and
 * does not hold for columns: a segment's height is its own number and the
 * column's height is the day's, so both questions are answered at a glance.
 * Columns are also discrete, which is what makes a day *clickable*.
 */
function DailyColumns({
  days,
  stack,
  info,
  measure,
  day,
  onDay,
  keptFrom,
  prunedLabel
}: {
  days: string[]
  stack: { keys: string[]; values: number[][] }
  /** Days before this have only partial logs; drawn as a shaded band. */
  keptFrom: string | null
  /** Says whose logs are missing from the band. */
  prunedLabel: string
  info: (key: string) => SeriesInfo
  measure: UsageMeasure
  day: string | null
  onDay: (day: string | null) => void
}): React.JSX.Element {
  const box = React.useRef<HTMLDivElement>(null)
  const pruned = keptFrom ? days.filter((d) => d < keptFrom).length : 0
  const width = useWidth(box)
  const [hover, setHover] = React.useState<number | null>(null)

  const n = days.length
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = CHART_H - PAD.top - PAD.bottom
  const totals = days.map((_, d) => stack.values.reduce((sum, s) => sum + s[d], 0))
  const ceiling = niceCeiling(Math.max(0, ...totals) || (measure === 'cost' ? 1 : 1000))
  const band = n ? plotW / n : 0
  const barW = Math.max(2, Math.min(28, band * 0.68))
  const x = (d: number): number => PAD.left + d * band + (band - barW) / 2
  const h = (v: number): number => (v / ceiling) * plotH
  const baseY = PAD.top + plotH
  const ticks = [0, 0.5, 1].map((f) => f * ceiling)
  const selected = day ? days.indexOf(day) : -1

  const indexAt = (e: React.MouseEvent<SVGSVGElement>): number | null => {
    if (!band) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - rect.left - PAD.left) / band)
    return i >= 0 && i < n ? i : null
  }

  // Ends and a midpoint for a month or more; every day for a week.
  const labels =
    n <= 10
      ? days.map((_, i) => i)
      : [0, Math.floor((n - 1) / 2), n - 1]
  const active = hover ?? (selected >= 0 ? selected : null)

  return (
    <div ref={box} className="relative select-none">
      <svg
        width={width || 1}
        height={CHART_H}
        role="img"
        aria-label={`Daily ${measure} by ${stack.keys.length} series`}
        className="cursor-pointer"
        onMouseMove={(e) => setHover(indexAt(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const i = indexAt(e)
          if (i == null) return
          onDay(days[i] === day ? null : days[i])
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={baseY - h(t)}
              y2={baseY - h(t)}
              className="stroke-border"
              strokeDasharray={t === 0 ? undefined : '2 3'}
            />
            <text
              x={PAD.left - 8}
              y={baseY - h(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {compact(t, measure)}
            </text>
          </g>
        ))}

        {pruned > 0 && (
          <g pointerEvents="none">
            <rect
              x={PAD.left}
              y={PAD.top}
              width={pruned * band}
              height={plotH}
              className="fill-secondary"
              opacity={0.45}
            />
            {pruned * band > 120 && (
              <text
                x={PAD.left + (pruned * band) / 2}
                y={PAD.top + 14}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {prunedLabel}
              </text>
            )}
          </g>
        )}

        {hover != null && (
          <rect
            x={PAD.left + hover * band}
            y={PAD.top}
            width={band}
            height={plotH}
            className="fill-secondary"
            opacity={0.6}
          />
        )}

        {width > 0 &&
          days.map((d, i) => {
            let y = baseY
            const dim = selected >= 0 && i !== selected
            return (
              <g key={d} opacity={dim ? 0.3 : 1}>
                {stack.keys.map((key, s) => {
                  const v = stack.values[s][i]
                  if (v <= 0) return null
                  const segH = h(v)
                  y -= segH
                  return (
                    <rect
                      key={key}
                      x={x(i)}
                      y={y}
                      width={barW}
                      // A 1px seam of background between segments, so two
                      // neighbours never blur into one block.
                      height={Math.max(0, segH - (segH > 2 ? 1 : 0))}
                      rx={Math.min(2, barW / 4)}
                      fill={info(key).color}
                    />
                  )
                })}
              </g>
            )
          })}

        {labels.map((i) => (
          <text
            key={days[i]}
            x={
              n <= 10
                ? x(i) + barW / 2
                : i === 0
                  ? PAD.left
                  : i === n - 1
                    ? width - PAD.right
                    : x(i) + barW / 2
            }
            y={CHART_H - 5}
            textAnchor={n <= 10 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            className={cn(
              'text-[10px]',
              i === selected ? 'fill-foreground font-medium' : 'fill-muted-foreground'
            )}
          >
            {shortDay(days[i])}
          </text>
        ))}
      </svg>

      {active != null && hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-44 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] shadow-md"
          style={
            x(active) > width / 2
              ? { right: Math.max(width - x(active) + 10, 4) }
              : { left: Math.min(x(active) + barW + 10, width - 180) }
          }
        >
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="font-medium">{shortDay(days[active], true)}</span>
            <span className="tabular-nums font-medium">{fmt(totals[active], measure)}</span>
          </div>
          {stack.keys
            .map((key, s) => ({ key, v: stack.values[s][active] }))
            .filter((r) => r.v > 0)
            .reverse()
            .map(({ key, v }) => {
              const si = info(key)
              return (
                <div key={key} className="flex items-center gap-2 text-muted-foreground">
                  <Swatch color={si.color} />
                  <span className={cn('min-w-0 flex-1 truncate', si.mono && 'font-mono text-[10.5px]')}>
                    {si.label}
                  </span>
                  <span className="tabular-nums text-foreground">{fmt(v, measure)}</span>
                </div>
              )
            })}
          {totals[active] === 0 && <div className="text-muted-foreground">Nothing recorded</div>}
          <div className="mt-1.5 border-t border-border pt-1 text-muted-foreground">
            {days[active] === day ? 'Click to show every day' : 'Click to see this day'}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Table ----------

function RowLabel({ info, size = 'sm' }: { info: SeriesInfo; size?: 'xs' | 'sm' }): React.JSX.Element {
  const icons = useApp((s) => s.projectIcons)
  return (
    <span className="flex min-w-0 items-center gap-2">
      {info.root !== undefined && info.root ? (
        <ProjectAvatar root={info.root} name={info.label} icon={icons[info.root] ?? null} size={size} />
      ) : (
        <Swatch color={info.color} />
      )}
      <span className={cn('truncate', info.mono && 'font-mono text-[12px]')}>{info.label}</span>
    </span>
  )
}

/**
 * The window grouped by provider, project or model, one row each, its columns
 * the four kinds in the measure on screen. A row is a filter: clicking one
 * re-cuts the headline and the chart to it.
 */
function Breakdown({
  rows,
  by,
  measure,
  info,
  focus,
  onFocus
}: {
  rows: UsageRow[]
  by: UsageGroup
  measure: UsageMeasure
  info: (key: string, sample?: UsageFact) => SeriesInfo
  focus: string | null
  onFocus: (key: string | null) => void
}): React.JSX.Element {
  const [all, setAll] = React.useState(false)
  React.useEffect(() => setAll(false), [by])
  const total = rows.reduce((sum, r) => sum + valueOf(r.slice, measure), 0)
  const shown = all ? rows : rows.slice(0, ROW_LIMIT)
  const label = GROUPS.find((g) => g.id === by)!.label

  return (
    <section>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="pb-2 text-left font-normal">{label}</th>
            {USAGE_KINDS.map((k) => (
              <th key={k} className="hidden pb-2 pl-3 text-right font-normal whitespace-nowrap md:table-cell">
                {KIND_LABEL[k]}
              </th>
            ))}
            <th className="pb-2 pl-3 text-right font-normal">Total</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const si = info(r.key, r.sample)
            const amounts = amountsOf(r.slice, measure)
            const v = sumAmounts(amounts)
            const share = total > 0 ? (v / total) * 100 : 0
            const on = focus === r.key
            return (
              <tr
                key={r.key}
                onClick={() => onFocus(on ? null : r.key)}
                aria-selected={on}
                className={cn(
                  'group cursor-pointer border-t border-border/60 transition-colors',
                  on ? 'bg-secondary' : 'hover:bg-secondary/50',
                  focus && !on && 'text-muted-foreground'
                )}
              >
                <td className="py-2 pr-3 pl-2">
                  <RowLabel info={si} />
                  {/* Share of the window, as a bar under the name: the column
                      it replaces said the same thing slower. */}
                  <div className="mt-1.5 ml-6 h-[3px] rounded-full bg-secondary group-hover:bg-background">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(share, share > 0 ? 1 : 0)}%`,
                        background: si.color === OTHER_COLOR ? 'var(--muted-foreground)' : si.color
                      }}
                    />
                  </div>
                </td>
                {USAGE_KINDS.map((k) => (
                  <td
                    key={k}
                    className="hidden py-2 pl-3 text-right align-top text-muted-foreground tabular-nums md:table-cell"
                  >
                    {amounts[k] > 0 ? fmt(amounts[k], measure) : '—'}
                  </td>
                ))}
                <td className="py-2 pr-2 pl-3 text-right align-top tabular-nums">
                  <div className="font-medium">{fmt(v, measure)}</div>
                  <div className="text-[11px] text-muted-foreground">{pct(v, total)}</div>
                </td>
              </tr>
            )
          })}
          {!rows.length && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-muted-foreground">
                Nothing recorded in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > ROW_LIMIT && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-2 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  )
}

/**
 * Caveats, and only when there are any — an unpriced model makes the headline
 * quietly too low, but a permanent panel saying "100% priced" says nothing.
 */
function Caveats({ report, facts }: { report: UsageReport; facts: UsageFact[] }): React.JSX.Element | null {
  const slice = totalOf(facts)
  const all = sumAmounts(slice.tokens)
  const lines = [...report.notes]
  const claudeKept = report.keptFrom.claude
  if (claudeKept && report.from < claudeKept) {
    lines.push(
      `Claude Code deletes its session logs after ${daysBetween(claudeKept, report.to)} days (cleanupPeriodDays in ~/.claude/settings.json), so its usage before ${shortDay(claudeKept)} can’t be counted.`
    )
  }
  if (slice.unpriced > 0 && all > 0) {
    lines.unshift(
      `${pct(slice.unpriced, all)} of tokens ran on models with no published rate — costs above exclude them.`
    )
  }
  if (!lines.length) return null
  return (
    <div className="text-[11px] leading-relaxed text-warning">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
function daysBetween(a: string, b: string): number {
  const at = (d: string): number => {
    const [y, m, dd] = d.split('-').map(Number)
    return new Date(y, m - 1, dd).getTime()
  }
  return Math.round((at(b) - at(a)) / 86_400_000)
}

// ---------- Page ----------

export function UsageStats(): React.JSX.Element {
  const report = useApp((s) => s.usageReport)
  const loading = useApp((s) => s.usageReportLoading)
  const range = useApp((s) => s.usageDays)
  const load = useApp((s) => s.loadUsageReport)
  const closeUsage = useApp((s) => s.closeUsage)
  const loadProjectIcons = useApp((s) => s.loadProjectIcons)

  const [measure, setMeasure] = React.useState<UsageMeasure>('cost')
  const [by, setBy] = React.useState<UsageGroup>('provider')
  const [day, setDay] = React.useState<string | null>(null)
  const [focus, setFocus] = React.useState<string | null>(null)

  // A filter names a day or a row of *this* report; a new window drops both.
  React.useEffect(() => {
    setDay((d) => (d && report?.days.includes(d) ? d : null))
    setFocus(null)
  }, [report])

  React.useEffect(() => {
    if (report) void loadProjectIcons(report.projects.filter(Boolean))
  }, [report, loadProjectIcons])

  const filtered = day != null || focus != null
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Esc peels a filter before it closes the page.
      if (filtered) {
        setDay(null)
        setFocus(null)
      } else closeUsage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeUsage, filtered])

  const facts = report?.facts ?? []
  // The chart is never cut by the day — it is what you pick the day from.
  const chartFacts = React.useMemo(
    () => filterFacts(facts, { focus: focus ? { by, key: focus } : null }),
    [facts, focus, by]
  )
  const pageFacts = React.useMemo(() => filterFacts(chartFacts, { day }), [chartFacts, day])
  // The table is never cut by its own focus — it is what you pick the row from.
  const rows = React.useMemo(
    () => groupFacts(filterFacts(facts, { day }), by, measure),
    [facts, day, by, measure]
  )
  const ranked = React.useMemo(
    () => groupFacts(facts, by, measure).map((r) => r.key),
    [facts, by, measure]
  )
  const info = useSeriesInfo(report ?? EMPTY, by, ranked)
  const stack = React.useMemo(() => {
    if (!report) return { keys: [], values: [] }
    return dailyStack(chartFacts, report.days, by, measure, SERIES_LIMIT)
  }, [report, chartFacts, by, measure])

  const focusSample = focus ? facts.find((f) => keyOf(f, by) === focus) : undefined
  const empty = report && report.facts.length === 0

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="drag flex h-[38px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <span className="text-sm font-semibold">Usage</span>
        <WithTooltip label="Close usage  esc">
          <Button size="icon-sm" variant="ghost" className="no-drag" aria-label="Close usage" onClick={closeUsage}>
            <X />
          </Button>
        </WithTooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!report ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <DotSpinner className="size-4" />
            Reading session logs…
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-9 px-6 pt-6 pb-8">
            {/* What the page is about, and every control that changes it. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="text-[15px] font-semibold">
                  {shortDay(report.from)} – {shortDay(report.to)}
                </h1>
                {day && <Chip onClear={() => setDay(null)}>{shortDay(day, true)}</Chip>}
                {focus && (
                  <Chip onClear={() => setFocus(null)}>
                    <RowLabel info={info(focus, focusSample)} size="xs" />
                  </Chip>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Segmented
                  ariaLabel="Measure"
                  value={measure}
                  onChange={setMeasure}
                  options={[
                    { id: 'cost', label: 'Cost' },
                    { id: 'tokens', label: 'Tokens' }
                  ]}
                />
                <Segmented
                  ariaLabel="Window"
                  value={String(range)}
                  onChange={(v) => void load(Number(v))}
                  options={USAGE_RANGES.map((r) => ({ id: String(r.days), label: r.label }))}
                />
                <WithTooltip label="Re-read session logs">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh usage"
                    disabled={loading}
                    onClick={() => void load(range, true)}
                  >
                    <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                  </Button>
                </WithTooltip>
              </div>
            </div>

            <Summary report={report} facts={pageFacts} measure={measure} filtered={filtered} day={day} />

            <section>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold">
                  {measure === 'cost' ? 'Cost' : 'Tokens'} by day
                </h2>
                <Segmented
                  ariaLabel="Group by"
                  value={by}
                  onChange={(g) => {
                    setBy(g)
                    setFocus(null)
                  }}
                  options={GROUPS}
                />
              </div>
              <DailyColumns
                days={report.days}
                stack={stack}
                info={info}
                measure={measure}
                day={day}
                onDay={setDay}
                keptFrom={completeFrom(report)}
                prunedLabel={`${(Object.keys(report.keptFrom) as UsageProvider[])
                  .filter((p) => (report.keptFrom[p] ?? '') > report.from)
                  .map((p) => PROVIDER_LABELS[p])
                  .join(' and ')} logs deleted`}
              />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 pl-12">
                {[...stack.keys].reverse().map((key) => {
                  const si = info(key)
                  return (
                    <span key={key} className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Swatch color={si.color} />
                      <span className={cn('max-w-48 truncate', si.mono && 'font-mono text-[10.5px]')}>
                        {si.label}
                      </span>
                    </span>
                  )
                })}
              </div>
            </section>

            <Breakdown
              rows={rows}
              by={by}
              measure={measure}
              info={info}
              focus={focus}
              onFocus={setFocus}
            />

            <Caveats report={report} facts={pageFacts} />

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                Read from Claude Code, Codex and Grok session logs, including sessions run outside Carbon
              </span>
              <span>{updatedLabel(report.scannedAt)}</span>
            </div>

            {empty && (
              <p className="text-[12px] text-muted-foreground">
                No usage recorded in this window. Sessions appear here once Claude Code, Codex or Grok
                has run, from this app or the terminal.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const EMPTY: UsageReport = {
  from: '',
  to: '',
  days: [],
  facts: [],
  projects: [],
  daySessions: [],
  sessions: 0,
  previous: { costUsd: 0, tokens: 0 },
  keptFrom: {},
  scannedAt: 0,
  notes: []
}

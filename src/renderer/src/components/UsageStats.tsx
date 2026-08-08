import * as React from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { USAGE_RANGES } from '@shared/types'
import type { Provider, UsageDay, UsageReport, UsageTotals } from '@shared/types'
import { cn } from '@/lib/utils'
import { formatTokens, formatUsd, relativeTime } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * The Usage page: what was spent, on which models, over the last 7/30/90 days.
 *
 * Deliberately a page and not another popover. The sidebar's Usage chip answers
 * "can I start a big turn right now" in one number and belongs next to the
 * composer; this answers "where is the money going", which is a question you sit
 * down with — several dimensions (provider, model, day) that only mean anything
 * next to each other.
 *
 * The headline is *list price*, not a bill. On a subscription nobody is charged
 * per token, so a number presented as "your spend" would be a lie; presented as
 * what the same tokens would cost on the API, it is the only comparable figure
 * there is — and it's the one that tells you whether a habit is expensive.
 */

// ---------- Series ----------

const SERIES: { key: Provider; label: string; color: string }[] = [
  // Fixed order, never cycled: Claude is always warm, Codex always cool, so the
  // legend on one chart reads the same as the dots in the table below it.
  { key: 'claude', label: 'Claude Code', color: 'var(--chart-claude)' },
  { key: 'codex', label: 'Codex', color: 'var(--chart-codex)' }
]

type Measure = 'cost' | 'tokens'

function tokensOf(t: UsageTotals): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output
}

function valueOf(t: UsageTotals, measure: Measure): number {
  return measure === 'cost' ? t.costUsd : tokensOf(t)
}

function formatValue(v: number, measure: Measure): string {
  return measure === 'cost' ? formatUsd(v) : formatTokens(v)
}

function updatedLabel(scannedAt: number): string {
  const ago = relativeTime(scannedAt)
  return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`
}

/** `Jul 9` — the axis and tooltip form. Parsed as local, not UTC. */
function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---------- Primitives ----------

function Dot({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  )
}

function Card({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {children}
    </section>
  )
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </span>
  )
}

/** A two-option segmented switch — the page's only control shape besides the range. */
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
            'rounded-[5px] px-2 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase transition-colors',
            value === o.id
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Width of `ref`'s element, tracked so the chart can be drawn in real pixels. */
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

// ---------- Chart ----------

const CHART_H = 208
const PAD = { top: 12, right: 10, bottom: 20, left: 56 }

/**
 * Daily spend, Codex stacked on Claude.
 *
 * Stacked rather than overlaid because the two are one budget: the height of the
 * band *is* the day's total, which is the thing you scan for. Each band carries a
 * 2px line in its own color drawn over a wider surface-colored line, so where the
 * two fills meet there is a hairline of background between them instead of two
 * translucent washes bleeding into one muddy edge.
 */
function DailyChart({
  days,
  measure
}: {
  days: UsageDay[]
  measure: Measure
}): React.JSX.Element {
  const box = React.useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const [hover, setHover] = React.useState<number | null>(null)

  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = CHART_H - PAD.top - PAD.bottom
  // Each series from the baseline, not stacked on the one below it. Stacking
  // draws the smaller series at the *total's* height, so a day of $200 Claude
  // and $15 Codex puts the two lines almost on top of each other and reads as
  // "they cost about the same" — the exact opposite of the data. Overlaid, a
  // line's height is its own number and the comparison is the glance.
  const series = SERIES.map((s) => ({ ...s, values: days.map((d) => valueOf(d[s.key], measure)) }))
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0))
  const peak = Math.max(0, ...series.flatMap((s) => s.values))
  // A flat zero range would divide by zero; give it a nominal ceiling so the
  // empty chart draws a baseline rather than NaN paths.
  const ceiling = niceCeiling(peak || (measure === 'cost' ? 1 : 1000))

  const x = (i: number): number =>
    PAD.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW)
  const y = (v: number): number => PAD.top + plotH - (v / ceiling) * plotH

  // Larger series behind, so the smaller one is never buried under its fill.
  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)
  const drawOrder = [...series].sort((a, b) => sum(b.values) - sum(a.values))

  const line = (values: number[]): string =>
    values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  /** The line, closed down to the baseline at both ends. */
  const area = (values: number[]): string =>
    `${line(values)} L${x(values.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`

  const ticks = [0, 0.5, 1].map((f) => f * ceiling)
  const active = hover != null && hover >= 0 && hover < days.length ? hover : null

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!plotW || !days.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = (e.clientX - rect.left - PAD.left) / plotW
    setHover(Math.max(0, Math.min(days.length - 1, Math.round(t * (days.length - 1)))))
  }

  return (
    <div ref={box} className="relative">
      <svg
        width={width || 1}
        height={CHART_H}
        role="img"
        aria-label={`Daily ${measure === 'cost' ? 'cost' : 'tokens'} by provider`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {formatValue(t, measure)}
            </text>
          </g>
        ))}

        {width > 0 &&
          drawOrder.map((s) => (
            <g key={s.key}>
              <path d={area(s.values)} fill={s.color} fillOpacity={0.16} />
              {/* Surface-colored underlay: keeps the two lines legible where
                  they run close together or cross. */}
              <path
                d={line(s.values)}
                fill="none"
                className="stroke-card"
                strokeWidth={5}
                strokeLinejoin="round"
                strokeOpacity={0.7}
              />
              <path
                d={line(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}

        {active != null && (
          <g pointerEvents="none">
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(active)}
                cy={y(s.values[active])}
                r={3.5}
                fill={s.color}
                className="stroke-card"
                strokeWidth={2}
              />
            ))}
          </g>
        )}

        {/* Ends plus a midpoint: enough to place any peak in the month without
            a label under every column. */}
        {days.length > 0 &&
          [
            { i: 0, anchor: 'start' as const },
            ...(days.length > 8
              ? [{ i: Math.floor((days.length - 1) / 2), anchor: 'middle' as const }]
              : []),
            { i: days.length - 1, anchor: 'end' as const }
          ].map(({ i, anchor }) => (
            <text
              key={days[i].day}
              x={anchor === 'start' ? PAD.left : anchor === 'end' ? width - PAD.right : x(i)}
              y={CHART_H - 4}
              textAnchor={anchor}
              className="fill-muted-foreground text-[10px]"
            >
              {shortDay(days[i].day)}
            </text>
          ))}
      </svg>

      {active != null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] shadow-md"
          style={{
            // Flip sides near the right edge so the card never leaves the panel.
            left: x(active) > width / 2 ? undefined : Math.min(x(active) + 12, width - 150),
            right: x(active) > width / 2 ? Math.max(width - x(active) + 12, 8) : undefined
          }}
        >
          <div className="mb-1 font-medium">{shortDay(days[active].day)}</div>
          {SERIES.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-muted-foreground">
              <Dot color={s.color} />
              <span className="flex-1">{s.label}</span>
              <span className="tabular-nums text-foreground">
                {formatValue(valueOf(days[active][s.key], measure), measure)}
              </span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1">
            <span className="text-muted-foreground">Total</span>
            <span className="tabular-nums font-medium">
              {formatValue(totals[active], measure)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
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

// ---------- Sections ----------

function ProviderSplit({ report }: { report: UsageReport }): React.JSX.Element {
  const total = report.total.costUsd
  return (
    <div className="mt-6 space-y-4">
      {SERIES.map((s) => {
        const t = report[s.key]
        const share = total > 0 ? (t.costUsd / total) * 100 : 0
        return (
          <div key={s.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px]">
                <Dot color={s.color} />
                {s.label}
              </span>
              <span className="text-[13px] tabular-nums">{formatUsd(t.costUsd)}</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(share, share > 0 ? 1.5 : 0)}%`, background: s.color }}
              />
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
              {share.toFixed(1)}% of cost · {formatTokens(tokensOf(t))} tokens
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Stat({
  label,
  value,
  note
}: {
  label: string
  value: string
  note: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-[22px] leading-tight font-semibold tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{note}</div>
    </div>
  )
}

function StatRow({ report }: { report: UsageReport }): React.JSX.Element {
  const t = report.total
  const observedInput = t.input + t.cacheRead
  const cachedShare = observedInput > 0 ? (t.cacheRead / observedInput) * 100 : 0
  const days = Math.max(1, report.days.length)
  return (
    <Card className="grid grid-cols-2 gap-x-2 p-0 sm:grid-cols-3 lg:grid-cols-5 [&>*]:border-border [&>*:not(:last-child)]:border-r">
      <Stat
        label="Processed tokens"
        value={formatTokens(tokensOf(t))}
        note={`${formatTokens(tokensOf(t) / days)} daily average`}
      />
      <Stat
        label="Cached input"
        value={formatTokens(t.cacheRead)}
        note={`${cachedShare.toFixed(1)}% of observed input`}
      />
      <Stat
        label="Uncached input"
        value={formatTokens(t.input)}
        note={`${formatTokens(t.cacheWrite)} cache writes`}
      />
      <Stat
        label="Output"
        value={formatTokens(t.output)}
        note={
          t.reasoning > 0 ? `includes ${formatTokens(t.reasoning)} reasoning` : 'model replies'
        }
      />
      <Stat
        label="Responses"
        value={t.responses.toLocaleString()}
        note={`${report.sessions.toLocaleString()} session${report.sessions === 1 ? '' : 's'}`}
      />
    </Card>
  )
}

interface Row {
  id: string
  label: string
  color?: string
  costUsd: number
  tokens: number
}

function Breakdown({ report }: { report: UsageReport }): React.JSX.Element {
  const [by, setBy] = React.useState<'model' | 'day'>('model')

  const rows: Row[] =
    by === 'model'
      ? report.models.map((m) => ({
          id: `${m.provider} ${m.model}`,
          label: m.model,
          color: SERIES.find((s) => s.key === m.provider)?.color,
          costUsd: m.costUsd,
          tokens: tokensOf(m)
        }))
      : report.days
          .map((d) => ({
            id: d.day,
            label: shortDay(d.day),
            costUsd: d.claude.costUsd + d.codex.costUsd,
            tokens: tokensOf(d.claude) + tokensOf(d.codex)
          }))
          .filter((d) => d.costUsd > 0 || d.tokens > 0)
          .reverse()

  const total = rows.reduce((sum, r) => sum + r.costUsd, 0)

  return (
    <Card className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Breakdown</h2>
        <Segmented
          ariaLabel="Break usage down by"
          value={by}
          onChange={setBy}
          options={[
            { id: 'model', label: 'Model' },
            { id: 'day', label: 'Day' }
          ]}
        />
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-card">
            <tr className="text-[11px] text-muted-foreground">
              <th className="pb-2 text-left font-normal">{by === 'model' ? 'Model' : 'Day'}</th>
              <th className="pb-2 text-right font-normal">Cost</th>
              <th className="pb-2 text-right font-normal">Share</th>
              <th className="pb-2 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = total > 0 ? (r.costUsd / total) * 100 : 0
              return (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="py-2 pr-3">
                    <span className="flex min-w-0 items-center gap-2">
                      {r.color && <Dot color={r.color} />}
                      <span className="truncate font-mono text-[12px]">{r.label}</span>
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatUsd(r.costUsd)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {share.toFixed(1)}%
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">
                    {formatTokens(r.tokens)}
                  </td>
                </tr>
              )
            })}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  Nothing recorded in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * Caveats, and only when there are any.
 *
 * The page used to carry a permanent "cost quality" panel reporting the priced
 * share — which reads `100.0% / 0.0%` on every normal corpus, so it spent a third
 * of a row saying nothing. The disclosure still has to exist, because a model slug
 * with no published rate makes the headline quietly too low, but it belongs where
 * an exception belongs: absent until there is one.
 */
function Caveats({ report }: { report: UsageReport }): React.JSX.Element | null {
  const all = tokensOf(report.total)
  const unpriced = report.total.unpricedTokens
  const lines = [...report.notes]
  if (unpriced > 0 && all > 0) {
    lines.unshift(
      `${((unpriced / all) * 100).toFixed(1)}% of tokens ran on models with no published rate — the total above excludes them.`
    )
  }
  if (!lines.length) return null
  return (
    <div className="px-1 text-[11px] leading-relaxed text-warning">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

// ---------- Page ----------

export function UsageStats(): React.JSX.Element {
  const report = useApp((s) => s.usageReport)
  const loading = useApp((s) => s.usageReportLoading)
  const days = useApp((s) => s.usageDays)
  const load = useApp((s) => s.loadUsageReport)
  const closeUsage = useApp((s) => s.closeUsage)
  const [measure, setMeasure] = React.useState<Measure>('cost')

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeUsage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeUsage])

  const empty = report && report.total.responses === 0

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* The window strip carries the page's identity and nothing else — the
          range picker changes what the *content* says, so it belongs with the
          content, not with the traffic lights. */}
      <header className="drag flex h-[38px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <span className="text-sm font-semibold">Usage</span>
        <WithTooltip label="Close usage  esc">
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag"
            aria-label="Close usage"
            onClick={closeUsage}
          >
            <X />
          </Button>
        </WithTooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!report ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading session logs…
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-4 p-6">
            {/* The window the whole page is about, and the controls that change
                it — one row, above everything the range applies to. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-[15px] font-semibold">
                {shortDay(report.from)} to {shortDay(report.to)}
              </h1>
              <div className="flex items-center gap-1.5">
                <div className="flex rounded-md bg-secondary p-0.5">
                  {USAGE_RANGES.map((r) => (
                    <button
                      key={r.days}
                      type="button"
                      aria-pressed={days === r.days}
                      onClick={() => void load(r.days)}
                      className={cn(
                        'rounded-[5px] px-2.5 py-1 text-[11px] transition-colors',
                        days === r.days
                          ? 'bg-card font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <WithTooltip label="Re-read session logs">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh usage"
                    disabled={loading}
                    onClick={() => void load(days, true)}
                  >
                    <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                  </Button>
                </WithTooltip>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <Card className="flex flex-col">
                <Label>Raw token cost</Label>
                <div className="mt-1 text-[34px] leading-tight font-semibold tabular-nums">
                  {formatUsd(report.total.costUsd)}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  What these tokens would cost at API list rates — not what you were billed.
                </p>
                <ProviderSplit report={report} />
              </Card>

              <Card className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[15px] font-semibold">
                    Daily {measure === 'cost' ? 'cost' : 'tokens'}
                  </h2>
                  <div className="flex items-center gap-3">
                    {/* Legend, always present: identity is never color alone. */}
                    <div className="flex items-center gap-3">
                      {SERIES.map((s) => (
                        <span
                          key={s.key}
                          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                        >
                          <Dot color={s.color} />
                          {s.label}
                        </span>
                      ))}
                    </div>
                    <Segmented
                      ariaLabel="Chart measure"
                      value={measure}
                      onChange={setMeasure}
                      options={[
                        { id: 'tokens', label: 'Tokens' },
                        { id: 'cost', label: 'Cost' }
                      ]}
                    />
                  </div>
                </div>
                <DailyChart days={report.days} measure={measure} />
              </Card>
            </div>

            <StatRow report={report} />

            <Breakdown report={report} />

            <Caveats report={report} />

            <div className="flex items-center justify-between px-1 pb-2 text-[11px] text-muted-foreground">
              <span>
                Read from Claude Code and Codex session logs, including turns run outside Carbon
              </span>
              <span>{updatedLabel(report.scannedAt)}</span>
            </div>

            {empty && (
              <p className="px-1 pb-4 text-[12px] text-muted-foreground">
                No usage recorded in this window. Sessions appear here once Claude Code or Codex
                has run — from this app or the terminal.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

import * as React from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts'
import type { ChartSpec } from '@shared/chartSpec'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart'
import { cn } from '@/lib/utils'

/**
 * A chart an agent drew with `chart_render`, drawn with the app's own chart
 * components — the heavy half of `InlineVisual`, split out so Recharts is not in
 * the entry chunk (see `lib/preloadHeavy.ts`).
 *
 * The marks follow the dataviz rules rather than the library's defaults: bars
 * at most 24px with a 4px rounded data end and a square baseline, 2px lines,
 * area fills as a ~10% wash, a solid hairline grid on the value axis only, a
 * legend only when there is more than one series, a tooltip on every form, and
 * a table view — mandatory rather than optional, since three light-mode palette
 * slots sit under 3:1 against the surface. Nothing animates: a turn folding and
 * unfolding remounts the chart, and an entrance replayed on a remount is the
 * thing this transcript treats as a bug.
 */

/** The category column, internally — the model's own key never reaches a selector. */
const CAT = 'cat'
/**
 * A pie slice's slot (`s1…s8`). Legend and tooltip name an item by looking its
 * `nameKey` value up in the config — and a pie's config is keyed by slot, so
 * naming slices by their category put every label through a lookup that
 * missed, and the legend drew colour swatches with nothing beside them.
 */
const SLICE = 'slice'

/**
 * Series keys are model-chosen and land in `ChartStyle`'s injected `<style>`
 * as `--color-<key>`, so they are mapped to fixed internal names first: a key
 * with a quote or a brace in it would otherwise be CSS the agent wrote.
 */
const slot = (i: number): string => `s${i + 1}`

/** The x axis is padded so the first and last markers sit inside the plot
 *  rather than half-clipped at its edges. */
const EDGE = { left: 8, right: 8 }

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** A category label cut to fit an axis; the tooltip and table carry it whole. */
function clip(value: unknown, max: number): string {
  const s = String(value ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export default function ChartCard({ spec }: { spec: ChartSpec }): React.JSX.Element {
  const [table, setTable] = React.useState(false)
  const pie = spec.kind === 'pie'

  // Rows keyed by the internal names, and a config naming each slot. A pie's
  // identity is per *slice*, so its slots follow the rows instead.
  const rows = React.useMemo(
    () =>
      spec.data.map((row, r) => {
        const out: Record<string, string | number> = { [CAT]: row[spec.x], [SLICE]: slot(r) }
        spec.series.forEach((s, i) => (out[slot(i)] = row[s.key]))
        return out
      }),
    [spec]
  )
  const config = React.useMemo<ChartConfig>(() => {
    const entries = pie
      ? spec.data.map((row, i) => [slot(i), { label: String(row[spec.x]), color: `var(--chart-${i + 1})` }])
      : spec.series.map((s, i) => [slot(i), { label: s.label, color: `var(--chart-${i + 1})` }])
    return Object.fromEntries(entries)
  }, [spec, pie])

  const legend = pie || spec.series.length > 1
  const height = pie ? 260 : spec.horizontal ? Math.min(480, Math.max(160, rows.length * 30 + 48)) : 240
  const longest = Math.max(...rows.map((r) => String(r[CAT]).length))

  return (
    <div data-chart-render className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-snug">{spec.title}</div>
          {spec.description && (
            <div className="text-xs text-muted-foreground">{spec.description}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
          className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {table ? 'Chart' : 'Table'}
        </button>
      </div>

      {spec.stats.length > 0 && (
        <div
          className="grid gap-x-4 gap-y-2 px-4 pt-3"
          style={{ gridTemplateColumns: `repeat(${spec.stats.length}, minmax(0, 1fr))` }}
        >
          {spec.stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <div className="truncate text-lg font-semibold leading-tight">{stat.value}</div>
              <div className="truncate text-xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="px-2 pt-3 pb-2">
        {table ? (
          <ChartTable spec={spec} />
        ) : (
          <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
            {pie ? (
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey={SLICE} hideLabel />} />
                <Pie
                  data={rows}
                  dataKey={slot(0)}
                  nameKey={SLICE}
                  innerRadius={56}
                  outerRadius={92}
                  // The 2px surface gap between slices, in the card's colour.
                  stroke="var(--card)"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {rows.map((row, i) => (
                    <Cell key={i} fill={`var(--color-${slot(i)})`} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey={SLICE} className="flex-wrap gap-x-3 gap-y-1" />} />
              </PieChart>
            ) : spec.kind === 'bar' ? (
              <BarChart
                data={rows}
                layout={spec.horizontal ? 'vertical' : 'horizontal'}
                margin={{ left: 4, right: 12, top: 4 }}
              >
                <CartesianGrid vertical={spec.horizontal} horizontal={!spec.horizontal} />
                {spec.horizontal ? (
                  <>
                    <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => compact.format(v)} />
                    <YAxis
                      type="category"
                      dataKey={CAT}
                      tickLine={false}
                      axisLine={false}
                      width={Math.min(160, Math.max(48, longest * 7))}
                      tickFormatter={(v) => clip(v, 22)}
                    />
                  </>
                ) : (
                  <>
                    <XAxis dataKey={CAT} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => clip(v, 12)} />
                    <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact.format(v)} />
                  </>
                )}
                <ChartTooltip cursor content={<ChartTooltipContent />} />
                {legend && <ChartLegend content={<ChartLegendContent />} />}
                {spec.series.map((_, i) => {
                  const top = !spec.stacked || i === spec.series.length - 1
                  return (
                    <Bar
                      key={i}
                      dataKey={slot(i)}
                      fill={`var(--color-${slot(i)})`}
                      stackId={spec.stacked ? 'a' : undefined}
                      maxBarSize={24}
                      // Rounded at the data end only; a stack rounds its last
                      // segment, so the baseline and the joins stay square.
                      radius={top ? (spec.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
                      stroke={spec.stacked ? 'var(--card)' : undefined}
                      strokeWidth={spec.stacked ? 2 : 0}
                      isAnimationActive={false}
                    />
                  )
                })}
              </BarChart>
            ) : spec.kind === 'line' ? (
              <LineChart data={rows} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey={CAT} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} padding={EDGE} tickFormatter={(v) => clip(v, 12)} />
                <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact.format(v)} />
                <ChartTooltip cursor content={<ChartTooltipContent indicator="line" />} />
                {legend && <ChartLegend content={<ChartLegendContent />} />}
                {spec.series.map((_, i) => (
                  <Line
                    key={i}
                    dataKey={slot(i)}
                    type="monotone"
                    stroke={`var(--color-${slot(i)})`}
                    strokeWidth={2}
                    // Markers only while there are few enough points to read
                    // as points; past that they are noise on the line.
                    // Filled with the series colour inside a 2px ring of the
                    // card: left to the default fill, the marker took the
                    // card's colour too and punched a hole in the line at
                    // every point.
                    dot={
                      rows.length <= 12
                        ? { r: 4, fill: `var(--color-${slot(i)})`, strokeWidth: 2, stroke: 'var(--card)' }
                        : false
                    }
                    activeDot={{ r: 5, fill: `var(--color-${slot(i)})`, strokeWidth: 2, stroke: 'var(--card)' }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            ) : (
              <AreaChart data={rows} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey={CAT} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} padding={EDGE} tickFormatter={(v) => clip(v, 12)} />
                <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact.format(v)} />
                <ChartTooltip cursor content={<ChartTooltipContent indicator="line" />} />
                {legend && <ChartLegend content={<ChartLegendContent />} />}
                {spec.series.map((_, i) => (
                  <Area
                    key={i}
                    dataKey={slot(i)}
                    type="monotone"
                    stackId={spec.stacked ? 'a' : undefined}
                    stroke={`var(--color-${slot(i)})`}
                    strokeWidth={2}
                    fill={`var(--color-${slot(i)})`}
                    // A wash, never a block: stacked bands need a little more
                    // to stay distinguishable from one another.
                    fillOpacity={spec.stacked ? 0.25 : 0.1}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            )}
          </ChartContainer>
        )}
      </div>

      {spec.footer && <div className="px-4 pb-3.5 text-xs text-muted-foreground">{spec.footer}</div>}
    </div>
  )
}

/**
 * The same numbers as a table — the way to read a value without hovering, and
 * the relief the palette's light-mode contrast warning requires.
 */
function ChartTable({ spec }: { spec: ChartSpec }): React.JSX.Element {
  return (
    <div className="max-h-[320px] overflow-auto px-2">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 text-left font-normal">{spec.x}</th>
            {spec.series.map((s) => (
              <th key={s.key} className="py-1 pl-3 text-right font-normal">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.data.map((row, i) => (
            <tr key={i} className={cn('border-t border-border/60')}>
              <td className="py-1 pr-3">{String(row[spec.x])}</td>
              {spec.series.map((s) => (
                <td key={s.key} className="py-1 pl-3 text-right tabular-nums">
                  {full.format(Number(row[s.key]))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

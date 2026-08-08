export function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function shortenPath(path: string, home?: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`
  return path
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Compact "time until reset" for a future epoch-ms timestamp. */
export function resetsIn(ts: number): string {
  const diff = ts - Date.now()
  if (!Number.isFinite(diff) || diff <= 0) return 'soon'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${Math.max(1, min)}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function dateGroup(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const dayDiff = Math.round((today.getTime() - startOfDay.getTime()) / 86_400_000)
  if (dayDiff <= 0) return 'Today'
  if (dayDiff === 1) return 'Yesterday'
  if (dayDiff < 7) return 'Previous 7 days'
  if (dayDiff < 30) return 'Previous 30 days'
  return 'Older'
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/**
 * Cost with thousands separators, for the Usage page where a figure can run to
 * five digits and `formatCost`'s bare `12500.95` becomes unreadable.
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/**
 * Token counts at a glance: `8.60B`, `130M`, `50.9K`. Three significant figures
 * up to 100, then whole units — enough to compare two rows without the width of
 * a full digit group.
 */
export function formatTokens(n: number): string {
  const unit = (value: number, suffix: string): string =>
    `${value >= 100 ? Math.round(value) : Number(value.toFixed(value >= 10 ? 1 : 2))}${suffix}`
  if (n >= 1e9) return unit(n / 1e9, 'B')
  if (n >= 1e6) return unit(n / 1e6, 'M')
  if (n >= 1e3) return unit(n / 1e3, 'K')
  return String(Math.round(n))
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

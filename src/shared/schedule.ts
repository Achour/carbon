/**
 * **When a scheduled task runs.** One module for both sides of the IPC line:
 * main fires from `nextRun`, and the Scheduled page shows "next run" from the
 * same function, so the time on the page is the time it fires.
 *
 * A schedule is a five-field cron expression in the machine's local time, or a
 * single moment. The page never asks anyone to write cron: its presets
 * (`SchedulePreset`) compile to an expression and read back from one, and an
 * expression no preset spells is shown as itself. The agent's `schedule_*`
 * tools take cron directly, which models write fluently.
 *
 * Dependency-free on purpose — no imports at all — so `node --test` runs it
 * straight off the `.ts`, and the renderer bundles it without dragging main in.
 */

export type Schedule = { kind: 'cron'; cron: string } | { kind: 'once'; at: number }

interface Field {
  /** Allowed values, ascending. */
  values: number[]
  /** Written as `*` or `*\/n` — cron's day-of-month/day-of-week rule keys on it. */
  star: boolean
}

export interface ParsedCron {
  minute: Field
  hour: Field
  dom: Field
  month: Field
  dow: Field
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const SPECS: { name: string; min: number; max: number; names?: string[]; base?: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  // 7 is Sunday too, as in every cron; folded to 0 below.
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 }
]

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
}

export function parseCron(expr: string): { ok: true; cron: ParsedCron } | { ok: false; error: string } {
  const text = (MACROS[expr.trim().toLowerCase()] ?? expr).trim()
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `A cron expression has five fields (minute hour day-of-month month day-of-week); "${expr}" has ${parts.length}.`
    }
  }
  const fields: Field[] = []
  for (let i = 0; i < 5; i++) {
    const field = parseField(parts[i], SPECS[i])
    if (typeof field === 'string') return { ok: false, error: field }
    fields.push(field)
  }
  const dow = fields[4]
  dow.values = [...new Set(dow.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)
  return {
    ok: true,
    cron: { minute: fields[0], hour: fields[1], dom: fields[2], month: fields[3], dow }
  }
}

function parseField(raw: string, spec: (typeof SPECS)[number]): Field | string {
  const values = new Set<number>()
  const value = (token: string): number | null => {
    const lower = token.toLowerCase()
    const named = spec.names?.indexOf(lower) ?? -1
    if (named >= 0) return named + (spec.base ?? 0)
    if (!/^\d+$/.test(token)) return null
    return Number(token)
  }
  for (const item of raw.split(',')) {
    const [range, stepText, extra] = item.split('/')
    if (extra !== undefined || !range) return `Bad ${spec.name} "${raw}".`
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return `Bad step in ${spec.name} "${raw}".`
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else {
      const [a, b, more] = range.split('-')
      if (more !== undefined) return `Bad ${spec.name} "${raw}".`
      const from = value(a)
      const to = b === undefined ? (stepText === undefined ? from : spec.max) : value(b)
      if (from === null || to === null) return `Bad ${spec.name} "${raw}".`
      lo = from
      hi = to
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      return `${spec.name[0].toUpperCase()}${spec.name.slice(1)} "${raw}" is outside ${spec.min}–${spec.max}.`
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { values: [...values].sort((a, b) => a - b), star: raw.startsWith('*') }
}

/**
 * Cron's rule for the two day fields, as Vixie cron spells it: when both are
 * restricted a day matching *either* runs (`0 9 1 * 1` is the 1st and every
 * Monday); when either is written with a star — `*` or a stepped `*\/2` — both
 * sets must match. The star test is on the *spelling*, so a stepped star still
 * narrows: `0 9 *\/2 * *` is odd days, not every day.
 */
function dayMatches(cron: ParsedCron, date: Date): boolean {
  const dom = cron.dom.values.includes(date.getDate())
  const dow = cron.dow.values.includes(date.getDay())
  if (cron.dom.star || cron.dow.star) return dom && dow
  return dom || dow
}

/** How far ahead to look before calling an expression unsatisfiable (Feb 30). */
const HORIZON_DAYS = 366 * 5

/**
 * The first minute strictly after `after` that the expression names, in local
 * time — or null if none comes within five years.
 *
 * Daylight-saving time is handled by building each candidate as a local date:
 * in the autumn the repeated hour resolves to its first occurrence, and once
 * that has fired it is no longer *after*, so a run never happens twice; in the
 * spring a time inside the skipped hour lands just past it (02:30 runs at
 * 03:30) rather than being dropped for the day.
 */
export function nextCronRun(cron: ParsedCron, after: number): number | null {
  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const y = day.getFullYear()
    const m = day.getMonth()
    const d = day.getDate()
    if (cron.month.values.includes(m + 1) && dayMatches(cron, day)) {
      // No skipping hours by comparing against `start`'s: on the spring
      // change, one minute after 01:59 *is* 03:00, and an hour shortcut
      // would drop 02:30 before it could normalize to 03:30. The timestamp
      // comparison below is the only filter.
      // The earliest of the day's candidates, not the first in field order:
      // a time in a skipped stretch normalizes *forward* (Lord Howe's
      // half-hour change turns 02:15 into 02:45), past a later field value
      // that was valid all along.
      let best: number | null = null
      for (const h of cron.hour.values) {
        for (const min of cron.minute.values) {
          const t = new Date(y, m, d, h, min)
          if (t.getDate() !== d) continue
          const ms = t.getTime()
          if (ms > after && (best === null || ms < best)) best = ms
        }
      }
      if (best !== null) return best
    }
    day = new Date(y, m, d + 1)
  }
  return null
}

/**
 * When a schedule next fires after `after`. A one-off fires once: its moment
 * if that is still ahead, otherwise never again. (A one-off whose moment
 * passed while the app was closed is not lost — the scheduler stores the due
 * time and fires anything overdue; this answers what comes *next*.)
 */
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null
  const parsed = parseCron(schedule.cron)
  return parsed.ok ? nextCronRun(parsed.cron, after) : null
}

export function validateSchedule(schedule: Schedule): string | null {
  if (schedule.kind === 'once') {
    return Number.isFinite(schedule.at) && schedule.at > 0 ? null : 'A one-off run needs a date and time.'
  }
  const parsed = parseCron(schedule.cron)
  if (!parsed.ok) return parsed.error
  return nextCronRun(parsed.cron, Date.now()) === null ? `"${schedule.cron}" never runs.` : null
}

// ---------- Presets ----------

/**
 * What the page offers instead of a cron field. Each compiles to exactly one
 * expression and `presetOf` reads it back, so editing a task reopens the
 * preset it was made with; anything else is `custom` and shown as written.
 */
export type SchedulePreset =
  | { kind: 'minutes'; every: number }
  | { kind: 'hours'; every: number; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'once'; at: number }
  | { kind: 'custom'; cron: string }

export function presetSchedule(preset: SchedulePreset): Schedule {
  switch (preset.kind) {
    case 'minutes':
      return { kind: 'cron', cron: preset.every === 1 ? '* * * * *' : `*/${preset.every} * * * *` }
    case 'hours':
      return {
        kind: 'cron',
        cron: preset.every === 1 ? `${preset.minute} * * * *` : `${preset.minute} */${preset.every} * * *`
      }
    case 'daily':
      return { kind: 'cron', cron: `${preset.minute} ${preset.hour} * * *` }
    case 'weekdays':
      return { kind: 'cron', cron: `${preset.minute} ${preset.hour} * * 1-5` }
    case 'weekly':
      return { kind: 'cron', cron: `${preset.minute} ${preset.hour} * * ${preset.day}` }
    case 'once':
      return { kind: 'once', at: preset.at }
    case 'custom':
      return { kind: 'cron', cron: preset.cron.trim() }
  }
}

export function presetOf(schedule: Schedule): SchedulePreset {
  if (schedule.kind === 'once') return { kind: 'once', at: schedule.at }
  const cron = schedule.cron.trim().replace(/\s+/g, ' ')
  const num = '(\\d{1,2})'
  let m = /^\* \* \* \* \*$/.exec(cron)
  if (m) return { kind: 'minutes', every: 1 }
  m = new RegExp(`^\\*/${num} \\* \\* \\* \\*$`).exec(cron)
  if (m && +m[1] >= 1 && +m[1] <= 59) return { kind: 'minutes', every: +m[1] }
  m = new RegExp(`^${num} \\* \\* \\* \\*$`).exec(cron)
  if (m && +m[1] <= 59) return { kind: 'hours', every: 1, minute: +m[1] }
  m = new RegExp(`^${num} \\*/${num} \\* \\* \\*$`).exec(cron)
  if (m && +m[1] <= 59 && +m[2] >= 1 && +m[2] <= 23) return { kind: 'hours', every: +m[2], minute: +m[1] }
  m = new RegExp(`^${num} ${num} \\* \\* (\\*|1-5|[0-7])$`).exec(cron)
  if (m && +m[1] <= 59 && +m[2] <= 23) {
    const time = { hour: +m[2], minute: +m[1] }
    if (m[3] === '*') return { kind: 'daily', ...time }
    if (m[3] === '1-5') return { kind: 'weekdays', ...time }
    return { kind: 'weekly', day: +m[3] % 7, ...time }
  }
  return { kind: 'custom', cron: schedule.cron }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** `9:05`, in the user's own clock convention. */
export function clockTime(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** "Weekdays at 9:00", "Every 15 minutes", "Once, Oct 15, 9:00 AM" — the page's one line for a schedule. */
export function describeSchedule(schedule: Schedule): string {
  const preset = presetOf(schedule)
  switch (preset.kind) {
    case 'minutes':
      return preset.every === 1 ? 'Every minute' : `Every ${preset.every} minutes`
    case 'hours': {
      const past = preset.minute ? ` at :${String(preset.minute).padStart(2, '0')}` : ''
      return preset.every === 1 ? `Every hour${past}` : `Every ${preset.every} hours${past}`
    }
    case 'daily':
      return `Every day at ${clockTime(preset.hour, preset.minute)}`
    case 'weekdays':
      return `Weekdays at ${clockTime(preset.hour, preset.minute)}`
    case 'weekly':
      return `Every ${DAY_NAMES[preset.day]} at ${clockTime(preset.hour, preset.minute)}`
    case 'once':
      return `Once, ${formatMoment(preset.at)}`
    case 'custom':
      return `Cron ${preset.cron}`
  }
}

/** "Thu, Oct 15, 9:00 AM" — a moment, with the year only when it is not this one. */
export function formatMoment(at: number, now = Date.now()): string {
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * A local date-time as the agent writes it — `2026-10-15T09:00`, with or
 * without seconds, a space for the `T`, or a trailing zone — as epoch ms. A
 * bare one is *local* time, which is what the user meant by "at 9".
 */
export function parseLocalDateTime(raw: string): number | null {
  const text = raw.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (m) {
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime()
    return Number.isFinite(t) ? t : null
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const t = Date.parse(text)
    return Number.isFinite(t) ? t : null
  }
  return null
}

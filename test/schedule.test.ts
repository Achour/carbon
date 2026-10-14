import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  nextCronRun,
  nextRun,
  parseCron,
  parseLocalDateTime,
  presetOf,
  presetSchedule,
  validateSchedule,
  type SchedulePreset
} from '../src/shared/schedule.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const next = (cron: string, after: number): number | null => {
  const parsed = parseCron(cron)
  assert.ok(parsed.ok, cron)
  return nextCronRun(parsed.cron, after)
}

test('parseCron rejects malformed expressions with a reason', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *']) {
    const parsed = parseCron(bad)
    assert.equal(parsed.ok, false, bad)
  }
  assert.ok(parseCron('@daily').ok)
  assert.ok(parseCron('0 9 * * mon-fri').ok)
  assert.ok(parseCron('0 9 * jan,jul sun').ok)
})

test('daily and weekday expressions land on the next matching minute', () => {
  // Wed 2026-10-14 08:00 → 09:00 the same day.
  assert.equal(next('0 9 * * *', at(2026, 10, 14, 8)), at(2026, 10, 14, 9))
  // Exactly at 09:00 → strictly after, so tomorrow.
  assert.equal(next('0 9 * * *', at(2026, 10, 14, 9)), at(2026, 10, 15, 9))
  // Fri 2026-10-16 10:00 → weekdays skip the weekend to Monday.
  assert.equal(next('0 9 * * 1-5', at(2026, 10, 16, 10)), at(2026, 10, 19, 9))
  // Sunday as 7.
  assert.equal(next('30 8 * * 7', at(2026, 10, 14)), at(2026, 10, 18, 8, 30))
})

test('intervals step within the hour and roll over', () => {
  assert.equal(next('*/15 * * * *', at(2026, 10, 14, 8, 1)), at(2026, 10, 14, 8, 15))
  assert.equal(next('*/15 * * * *', at(2026, 10, 14, 8, 45)), at(2026, 10, 14, 9, 0))
  assert.equal(next('0 */6 * * *', at(2026, 10, 14, 13)), at(2026, 10, 14, 18))
  // Seconds into a minute do not make that minute "after".
  assert.equal(next('* * * * *', at(2026, 10, 14, 8, 0) + 30_000), at(2026, 10, 14, 8, 1))
})

test('both day fields restricted means either one matches', () => {
  // The 1st or any Monday: from Tue 2026-10-27 that is Sun 11-01, then Mon 11-02.
  assert.equal(next('0 9 1 * 1', at(2026, 10, 27)), at(2026, 11, 1, 9))
  assert.equal(next('0 9 1 * 1', at(2026, 11, 1, 10)), at(2026, 11, 2, 9))
})

test('an impossible date is null, not a hang', () => {
  assert.equal(next('0 9 30 2 *', at(2026, 1, 1)), null)
})

test('one-off schedules fire once', () => {
  const t = at(2026, 10, 15, 9)
  assert.equal(nextRun({ kind: 'once', at: t }, t - 1), t)
  assert.equal(nextRun({ kind: 'once', at: t }, t), null)
})

test('presets round-trip through their cron expression', () => {
  const presets: SchedulePreset[] = [
    { kind: 'minutes', every: 1 },
    { kind: 'minutes', every: 15 },
    { kind: 'hours', every: 1, minute: 0 },
    { kind: 'hours', every: 4, minute: 30 },
    { kind: 'daily', hour: 9, minute: 5 },
    { kind: 'weekdays', hour: 17, minute: 0 },
    { kind: 'weekly', day: 1, hour: 9, minute: 0 },
    { kind: 'weekly', day: 0, hour: 9, minute: 0 },
    { kind: 'once', at: at(2026, 12, 1, 9) }
  ]
  for (const preset of presets) assert.deepEqual(presetOf(presetSchedule(preset)), preset)
  assert.deepEqual(presetOf({ kind: 'cron', cron: '0 9 1 * *' }), { kind: 'custom', cron: '0 9 1 * *' })
})

test('validateSchedule names what is wrong', () => {
  assert.equal(validateSchedule({ kind: 'cron', cron: '0 9 * * 1-5' }), null)
  assert.match(validateSchedule({ kind: 'cron', cron: '0 9 * *' }) ?? '', /five fields/)
  assert.match(validateSchedule({ kind: 'cron', cron: '0 9 31 2 *' }) ?? '', /never runs/)
})

test('parseLocalDateTime reads a bare date-time as local time', () => {
  assert.equal(parseLocalDateTime('2026-10-15T09:00'), at(2026, 10, 15, 9))
  assert.equal(parseLocalDateTime('2026-10-15 9:30'), at(2026, 10, 15, 9, 30))
  assert.equal(parseLocalDateTime('2026-10-15T09:00:00Z'), Date.UTC(2026, 9, 15, 9))
  assert.equal(parseLocalDateTime('tomorrow at 9'), null)
})

test('daylight saving: no double run in the repeated hour, no lost run in the skipped one', () => {
  // Only meaningful in a zone with DST; the assertions hold trivially elsewhere.
  const first = next('30 1 * * *', at(2026, 11, 1, 0))
  assert.ok(first)
  const second = next('30 1 * * *', first!)
  assert.ok(second && second - first! >= 23 * 3600_000)
  const spring = next('30 2 * * *', at(2026, 3, 8, 0))
  assert.ok(spring && spring > at(2026, 3, 8, 0) && spring < at(2026, 3, 9, 0))
})

test('a stepped star in a day field still narrows the days', () => {
  // Wed 2026-10-14 is even: */2 day-of-month is the odd days.
  assert.equal(next('0 9 */2 * *', at(2026, 10, 14)), at(2026, 10, 15, 9))
  // */2 day-of-week is Sun, Tue, Thu, Sat: from Wed, Thursday.
  assert.equal(next('0 9 * * */2', at(2026, 10, 14, 10)), at(2026, 10, 15, 9))
})

test('spring DST: a time in the skipped hour runs just past it, even from the minute before', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    const after = Date.parse('2026-03-08T01:59:00-05:00')
    assert.equal(next('30 2 * * *', after), Date.parse('2026-03-08T03:30:00-04:00'))
    // Autumn: 01:30 happens twice on 2026-11-01; it runs once.
    const first = next('30 1 * * *', Date.parse('2026-11-01T00:00:00-04:00'))!
    assert.equal(first, Date.parse('2026-11-01T01:30:00-04:00'))
    assert.equal(next('30 1 * * *', first), Date.parse('2026-11-02T01:30:00-05:00'))
    // Lord Howe moves half an hour: 02:00 → 02:30 on 2026-10-04. 02:15
    // normalizes to 02:45, and must not win over the valid 02:30.
    process.env.TZ = 'Australia/Lord_Howe'
    const lh = Date.parse('2026-10-04T01:59:00+10:30')
    assert.equal(next('15,30 2 * * *', lh), Date.parse('2026-10-04T02:30:00+11:00'))
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})

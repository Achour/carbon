import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codexLimitDisplayName,
  codexWindow,
  codexWindowLabel
} from '../src/main/usageWindows.ts'

test('Codex limit buckets use public model names instead of internal codenames', () => {
  assert.equal(
    codexLimitDisplayName(
      'codex_bengalfox',
      'GPT-5.3-Codex-Spark',
      'codex_bengalfox'
    ),
    '5.3 Codex Spark'
  )
  // Older App Servers did not always include limitName.
  assert.equal(codexLimitDisplayName('codex_bengalfox'), '5.3 Codex Spark')
  assert.equal(codexLimitDisplayName('codex'), 'Codex')
  // Current and future public GPT model slugs get the picker's compact style.
  assert.equal(codexLimitDisplayName('unused', 'GPT-5.6-Sol'), '5.6 Sol')
  // Never expose an unknown internal project name to the user.
  assert.equal(codexLimitDisplayName('codex_futurefox'), 'Codex model')
})

test('a Codex window duration is labelled in the same vocabulary Claude uses', () => {
  // The two real ones: Codex's plan windows come back as these.
  assert.equal(codexWindowLabel(10080), 'Weekly')
  assert.equal(codexWindowLabel(300), '5-hour')
  // Plural forms read as a count, singular ones as a cadence.
  assert.equal(codexWindowLabel(20160), '2-week')
  assert.equal(codexWindowLabel(1440), 'Daily')
  assert.equal(codexWindowLabel(4320), '3-day')
  assert.equal(codexWindowLabel(60), 'Hourly')
  // Nothing divides evenly — fall back rather than rounding into a lie.
  assert.equal(codexWindowLabel(90), '90-minute')
})

test('a missing or nonsensical duration degrades to a neutral label', () => {
  // The bar still renders; it just doesn't claim a window it wasn't told about.
  assert.equal(codexWindowLabel(undefined), 'Usage')
  assert.equal(codexWindowLabel(null), 'Usage')
  assert.equal(codexWindowLabel(0), 'Usage')
  assert.equal(codexWindowLabel(-60), 'Usage')
  assert.equal(codexWindowLabel(Number.NaN), 'Usage')
})

test('resetsAt converts epoch seconds to an ISO string', () => {
  // The ×1000 this pins: Codex sends seconds, RateLimitWindow carries ISO, and
  // the renderer parses it back to ms. Dropping it renders "resets in 55 years".
  const w = codexWindow({ usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785951322 })
  assert.equal(w?.resetsAt, '2026-08-05T17:35:22.000Z')
  assert.equal(w?.label, 'Weekly')
  assert.equal(w?.utilization, 28)
  // Sanity-check the unit from the other direction: seconds land this decade.
  assert.equal(new Date(w!.resetsAt!).getUTCFullYear(), 2026)
})

test('a window with no reported usage is dropped, not drawn at zero', () => {
  // "0% used" and "not reported" are indistinguishable on a bar, and only one
  // of them means the user has a full plan left.
  assert.equal(codexWindow({ windowDurationMins: 10080 }), null)
  assert.equal(codexWindow({ usedPercent: null, resetsAt: 1785951322 }), null)
  assert.equal(codexWindow(null), null)
  assert.equal(codexWindow(undefined), null)
  // Genuine zero usage is not the same thing, and does render.
  assert.equal(codexWindow({ usedPercent: 0, windowDurationMins: 10080 })?.utilization, 0)
})

test('a window with no reset time still renders', () => {
  // Codex omits resetsAt on some plans; the percentage is the useful part.
  const w = codexWindow({ usedPercent: 40, windowDurationMins: 300 })
  assert.equal(w?.resetsAt, null)
  assert.equal(w?.label, '5-hour')
})

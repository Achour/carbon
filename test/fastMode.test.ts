import assert from 'node:assert/strict'
import test from 'node:test'
import { fastModeNote } from '../src/shared/types.ts'

test('a served Fast turn, and an unreported one, say nothing', () => {
  assert.equal(fastModeNote({ state: 'on' }), null)
  // No status at all: a chat with no live session, or a Codex chat, which the
  // provider never reports on. "Don't know" must not read as "degraded".
  assert.equal(fastModeNote(undefined), null)
  // Still being resolved — not evidence of anything yet.
  assert.equal(fastModeNote({ state: 'off', reason: 'pending' }), null)
})

test('a refused Fast turn explains itself', () => {
  assert.equal(
    fastModeNote({ state: 'off', reason: 'extra_usage_disabled' }),
    'Extra usage is turned off for your account'
  )
  assert.equal(fastModeNote({ state: 'cooldown' }), 'Paused until your rate limit resets')
  // Cooldown outranks any reason riding along with it: the rate limit is what
  // the user needs to hear about, and it clears on its own.
  assert.equal(
    fastModeNote({ state: 'cooldown', reason: 'extra_usage_disabled' }),
    'Paused until your rate limit resets'
  )
})

test('an unknown reason code still admits Fast is not running', () => {
  assert.equal(
    fastModeNote({ state: 'off', reason: 'some_future_reason' }),
    'Unavailable — running at standard speed'
  )
  assert.equal(fastModeNote({ state: 'off' }), 'Unavailable — running at standard speed')
})

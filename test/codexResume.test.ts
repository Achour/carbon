import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMissingCodexThreadError } from '../src/main/codexResume.ts'

test('recognizes the Codex SDK missing-rollout resume failure', () => {
  assert.equal(
    isMissingCodexThreadError(
      new Error(
        'Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)'
      )
    ),
    true
  )
})

test('does not treat unrelated Codex failures as missing threads', () => {
  assert.equal(isMissingCodexThreadError(new Error('Authentication failed')), false)
  assert.equal(isMissingCodexThreadError(new Error('Network unavailable')), false)
  assert.equal(isMissingCodexThreadError(new Error('Unknown model')), false)
})

test('accepts a string error from a non-Error throw', () => {
  assert.equal(isMissingCodexThreadError('No rollout found for thread id abc'), true)
})

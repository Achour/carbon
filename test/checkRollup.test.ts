import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeChecks } from '../src/main/github.ts'

// `summarizeChecks` folds a `gh pr view --json statusCheckRollup` array into
// pass/fail/pending counts. Entries come in two shapes: CheckRun (status +
// conclusion) and StatusContext (state). The classification of the many GitHub
// enum values is the fiddly part worth pinning.

test('no checks configured collapses to undefined', () => {
  assert.equal(summarizeChecks(undefined), undefined)
  assert.equal(summarizeChecks(null), undefined)
  assert.equal(summarizeChecks([]), undefined)
  assert.equal(summarizeChecks('nope'), undefined)
})

test('completed check runs are classified by conclusion', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'NEUTRAL' }, // counts as pass
    { status: 'COMPLETED', conclusion: 'SKIPPED' }, // counts as pass
    { status: 'COMPLETED', conclusion: 'FAILURE' },
    { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }
  ]
  assert.deepEqual(summarizeChecks(rollup), { passed: 3, failed: 3, pending: 0, total: 6 })
})

test('incomplete check runs are pending regardless of conclusion', () => {
  const rollup = [
    { status: 'QUEUED', conclusion: '' },
    { status: 'IN_PROGRESS', conclusion: '' },
    // A stale conclusion on a not-yet-complete run must not count as a pass.
    { status: 'IN_PROGRESS', conclusion: 'SUCCESS' }
  ]
  assert.deepEqual(summarizeChecks(rollup), { passed: 0, failed: 0, pending: 3, total: 3 })
})

test('StatusContext entries are classified by state', () => {
  const rollup = [
    { state: 'SUCCESS' },
    { state: 'PENDING' },
    { state: 'EXPECTED' }, // pending
    { state: 'FAILURE' },
    { state: 'ERROR' } // fail
  ]
  assert.deepEqual(summarizeChecks(rollup), { passed: 1, failed: 2, pending: 2, total: 5 })
})

test('mixed CheckRun + StatusContext rollup', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { state: 'FAILURE' },
    { status: 'IN_PROGRESS' },
    { state: 'SUCCESS' }
  ]
  assert.deepEqual(summarizeChecks(rollup), { passed: 2, failed: 1, pending: 1, total: 4 })
})

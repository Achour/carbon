import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeMethods, mergeRows, parseReviewers, rollupState } from '../src/main/pulls.ts'

const row = (repo: string, number: number, updatedAt: string) => ({
  number,
  title: `${repo} ${number}`,
  updatedAt,
  state: 'OPEN',
  repository: { nameWithOwner: repo },
  author: { login: 'me' }
})

test('a PR in both searches is one row carrying both roles', () => {
  const rows = mergeRows(
    [row('o/a', 1, '2026-01-02'), row('o/b', 2, '2026-01-01')],
    [row('o/a', 1, '2026-01-02'), row('o/c', 3, '2026-01-03')]
  )
  assert.deepEqual(
    rows.map((r) => [r.repo, r.number, r.roles]),
    [
      ['o/c', 3, ['reviewing']],
      ['o/a', 1, ['authored', 'reviewing']],
      ['o/b', 2, ['authored']]
    ]
  )
})

test('search nodes that are not pull requests are dropped', () => {
  assert.deepEqual(mergeRows([{}, { number: 4 }], []), [])
})

test('rollup states fold to three', () => {
  assert.equal(rollupState('SUCCESS'), 'SUCCESS')
  assert.equal(rollupState('ERROR'), 'FAILURE')
  assert.equal(rollupState('EXPECTED'), 'PENDING')
  assert.equal(rollupState(undefined), '')
})

test('a re-requested reviewer reads as requested, not as their old verdict', () => {
  const reviewers = parseReviewers({
    latestReviews: {
      nodes: [
        { state: 'APPROVED', author: { login: 'ann' } },
        { state: 'CHANGES_REQUESTED', author: { login: 'bob' } }
      ]
    },
    reviewRequests: {
      nodes: [{ requestedReviewer: { login: 'bob' } }, { requestedReviewer: { name: 'core' } }]
    }
  })
  assert.deepEqual(
    reviewers.map((r) => [r.login, r.state]),
    [
      ['ann', 'APPROVED'],
      ['bob', 'REQUESTED'],
      ['core', 'REQUESTED']
    ]
  )
})

test("merge methods lead with the viewer's default and omit disallowed ones", () => {
  assert.deepEqual(
    mergeMethods({ squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH' }),
    ['squash', 'merge']
  )
})

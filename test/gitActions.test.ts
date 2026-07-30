import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGitActions } from '../src/renderer/src/lib/gitActions.ts'
import type { GitHubState, GitStatus, PrInfo } from '../src/shared/types.ts'

// Minimal builders — every field the resolver reads, defaulted to a clean repo
// on a feature branch with a GitHub remote in sync.
function gitStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'feature',
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    hasRemote: true,
    changes: [],
    additions: 0,
    deletions: 0,
    ...over
  }
}
function dirty(over: Partial<GitStatus> = {}): GitStatus {
  return gitStatus({ changes: [{ path: 'a.ts', status: 'M', staged: false }], ...over })
}
function github(over: Partial<GitHubState> = {}): GitHubState {
  return { installed: true, authed: true, repo: 'me/repo', defaultBranch: 'main', ...over }
}
function pr(over: Partial<PrInfo> = {}): PrInfo {
  return { number: 1, url: 'u', title: 't', state: 'OPEN', isDraft: false, reviewDecision: '', ...over }
}

const ids = (s: ReturnType<typeof resolveGitActions>): (string | null)[] => [
  s.primary?.id ?? null,
  ...s.rungs.map((r) => r.id)
]

test('not a repo → no actions', () => {
  assert.deepEqual(resolveGitActions(gitStatus({ isRepo: false }), null), { primary: null, rungs: [] })
  assert.deepEqual(resolveGitActions(null, null), { primary: null, rungs: [] })
})

test('dirty on default branch → branch off first, PR rung included', () => {
  const s = resolveGitActions(dirty({ branch: 'main' }), github())
  assert.deepEqual(ids(s), ['branch-commit', 'branch-commit-push-pr', 'commit-push', 'commit'])
})

test('default-branch detection falls back to main/master when gh unknown', () => {
  // No github info, but branch is `master` → still treated as protected default.
  const s = resolveGitActions(dirty({ branch: 'master' }), null)
  assert.equal(s.primary?.id, 'branch-commit')
})

test('dirty on feature branch with a GitHub repo → commit & push, PR rung', () => {
  const s = resolveGitActions(dirty({ branch: 'feature' }), github())
  assert.deepEqual(ids(s), ['commit-push', 'commit-push-pr', 'commit', 'push'])
})

test('dirty on feature branch, PR already open → no PR rung', () => {
  const s = resolveGitActions(dirty({ branch: 'feature' }), github({ pr: pr() }))
  assert.deepEqual(ids(s), ['commit-push', 'commit', 'push'])
})

test('no remote at all + gh authed → publish to GitHub', () => {
  const s = resolveGitActions(dirty({ hasRemote: false, hasUpstream: false, branch: 'main' }), github({ repo: undefined, defaultBranch: undefined }))
  assert.deepEqual(ids(s), ['publish-github', 'commit'])
})

test('no remote + gh NOT authed → only a local commit', () => {
  const s = resolveGitActions(dirty({ hasRemote: false, hasUpstream: false }), { installed: true, authed: false })
  assert.deepEqual(ids(s), ['commit'])
})

test('clean but ahead → push, with a create-pr rung when pushed and no PR', () => {
  const s = resolveGitActions(gitStatus({ ahead: 2 }), github())
  assert.deepEqual(ids(s), ['push', 'create-pr'])
})

test('clean feature branch with no upstream → push (publish it)', () => {
  const s = resolveGitActions(gitStatus({ branch: 'feature', hasUpstream: false, ahead: 0 }), github())
  assert.equal(s.primary?.id, 'push')
})

test('clean, pushed, in sync, no PR → create PR', () => {
  const s = resolveGitActions(gitStatus({ branch: 'feature', ahead: 0 }), github())
  assert.deepEqual(ids(s), ['create-pr'])
})

test('clean, in sync, PR already open → nothing (card shows it)', () => {
  const s = resolveGitActions(gitStatus({ branch: 'feature', ahead: 0 }), github({ pr: pr() }))
  assert.deepEqual(s, { primary: null, rungs: [] })
})

test('clean & ahead on the DEFAULT branch → push, but no create-pr rung', () => {
  const s = resolveGitActions(gitStatus({ branch: 'main', ahead: 1 }), github())
  assert.deepEqual(ids(s), ['push'])
})

test('clean & in sync on the default branch → nothing to do', () => {
  const s = resolveGitActions(gitStatus({ branch: 'main', ahead: 0 }), github())
  assert.deepEqual(s, { primary: null, rungs: [] })
})

test('clean & behind the remote → pull', () => {
  const s = resolveGitActions(gitStatus({ branch: 'main', ahead: 0, behind: 3 }), github())
  assert.deepEqual(ids(s), ['pull'])
})

test('clean & diverged (ahead + behind) → pull, with a push rung', () => {
  const s = resolveGitActions(gitStatus({ branch: 'feature', ahead: 2, behind: 1 }), github())
  assert.deepEqual(ids(s), ['pull', 'push'])
})

test('PR merged → sync & delete branch', () => {
  const s = resolveGitActions(gitStatus({ branch: 'feature', ahead: 0 }), github({ pr: pr({ state: 'MERGED' }) }))
  assert.equal(s.primary?.id, 'sync-cleanup')
})

test('PR merged in a worktree → no sync-cleanup, which git would refuse there', () => {
  // `sync-cleanup` switches to the default branch; inside a worktree git says
  // "already used by worktree at …". Cleanup there means removing the worktree,
  // which lives in the chat's ⋯ menu, so the ladder offers nothing.
  const merged = github({ pr: pr({ state: 'MERGED' }) })
  const s = resolveGitActions(gitStatus({ branch: 'feature' }), merged, { worktree: true })
  assert.equal(s.primary, null)
  assert.deepEqual(s.rungs, [])

  // Uncommitted work is still committable from a worktree.
  const d = resolveGitActions(dirty({ branch: 'feature' }), merged, { worktree: true })
  assert.equal(d.primary?.id, 'commit-push')

  // Every other state is unaffected by the flag.
  assert.equal(
    resolveGitActions(dirty({ branch: 'feature' }), github(), { worktree: true }).primary?.id,
    resolveGitActions(dirty({ branch: 'feature' }), github()).primary?.id
  )
})

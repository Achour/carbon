import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  createWorktree,
  finishWorktree,
  handOffWorktree,
  defaultBranchName,
  isManagedWorktree,
  listWorktrees,
  mergeWorktree,
  parseWorktreeList,
  removeWorktree,
  resolveWorktree,
  sanitizeBranch,
  setupCommandFor,
  worktreePathFor,
  worktreeStatus
} from '../src/main/worktree.ts'
import { git, initRepo } from './gitRepo.ts'

const execFileP = promisify(execFile)

// Keep worktrees the tests create out of the developer's real ~/.karbun.
const TEST_ROOT = join(tmpdir(), 'karbun-worktrees-test')
process.env.KARBUN_WORKTREES_DIR = TEST_ROOT

test('sanitizeBranch coerces user input into a valid ref name', () => {
  assert.equal(sanitizeBranch('Fix the login bug'), 'fix-the-login-bug')
  assert.equal(sanitizeBranch('feat/OAuth Support'), 'feat/oauth-support')
  // Illegal chars are dropped, so the surrounding words close up.
  assert.equal(sanitizeBranch('  ...weird^:name?  '), 'weirdname')
  // git rejects '..' in a ref, so runs of dots collapse to one.
  assert.equal(sanitizeBranch('v1..2..3'), 'v1.2.3')
  // Shell metacharacters never survive into a name we hand to git.
  assert.equal(sanitizeBranch('rm -rf $(pwd)'), 'rm-rf-pwd')
  // Nothing usable survives — caller falls back to a generated name.
  assert.equal(sanitizeBranch('~^:?*'), '')
  assert.equal(sanitizeBranch(''), '')
  // Never leaves a trailing separator, which git rejects.
  assert.ok(!sanitizeBranch('a'.repeat(80) + '/').endsWith('/'))
})

test('defaultBranchName is deterministic under injected clock and rng', () => {
  const name = defaultBranchName(new Date(2026, 6, 19), () => 0)
  assert.equal(name, 'karbun/jul19-aaaa')
  assert.equal(sanitizeBranch(name), name, 'generated names must survive sanitizing')
})

test('worktreePathFor disambiguates same-named projects in different parents', () => {
  const a = worktreePathFor('/root', '/home/me/a/api', 'karbun/x')
  const b = worktreePathFor('/root', '/home/me/b/api', 'karbun/x')
  assert.notEqual(a, b)
  // Branch slashes flatten into one directory level.
  assert.ok(a.endsWith('/karbun-x'))
})

test('isManagedWorktree only accepts paths inside the app-owned root', () => {
  assert.ok(isManagedWorktree('/root/proj-1234/br', '/root'))
  assert.ok(!isManagedWorktree('/elsewhere/proj/br', '/root'))
  // Prefix-only matches must not pass.
  assert.ok(!isManagedWorktree('/rootless/proj', '/root'))
})

test('setupCommandFor prefers .karbun, falls back to .codex, and quotes paths', () => {
  const seen: string[] = []
  const none = setupCommandFor('/repo', '/wt', (p) => {
    seen.push(p)
    return false
  })
  assert.equal(none, null)
  assert.deepEqual(seen, ['/repo/.karbun/setup.sh', '/repo/.codex/setup.sh'])

  const codex = setupCommandFor('/repo', '/wt', (p) => p.includes('.codex'))
  assert.ok(codex?.includes('/wt/.codex/setup.sh'))
  assert.ok(codex?.includes('CODEX_WORKDIR='), 'Codex scripts expect CODEX_WORKDIR')

  const karbun = setupCommandFor('/repo', '/wt', () => true)
  assert.ok(karbun?.includes('.karbun/setup.sh'), '.karbun wins over .codex')

  // A path with a quote must not break out of the command.
  const nasty = setupCommandFor("/re'po", '/wt', () => true)
  assert.ok(nasty?.includes(`'\\''`))
})

test('parseWorktreeList marks the main checkout and skips detached trees', () => {
  const out = [
    'worktree /repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /wt/feature',
    'HEAD bbb',
    'branch refs/heads/karbun/jul19-abcd',
    '',
    // A detached worktree has no branch to label it with.
    'worktree /wt/detached',
    'HEAD ccc',
    'detached',
    ''
  ].join('\n')

  const refs = parseWorktreeList(out)
  assert.deepEqual(refs, [
    { path: '/repo', branch: 'main', isMain: true },
    { path: '/wt/feature', branch: 'karbun/jul19-abcd', isMain: false }
  ])
  assert.deepEqual(parseWorktreeList(''), [], 'empty output yields no refs')
})

test('parseWorktreeList flags a worktree whose directory is gone', () => {
  const out = [
    'worktree /repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /wt/gone',
    'HEAD bbb',
    'branch refs/heads/karbun/jul19-abcd',
    // git appends the reason, so the marker is a prefix rather than a whole line.
    'prunable gitdir file points to non-existent location',
    ''
  ].join('\n')

  assert.deepEqual(parseWorktreeList(out), [
    { path: '/repo', branch: 'main', isMain: true },
    { path: '/wt/gone', branch: 'karbun/jul19-abcd', isMain: false, prunable: true }
  ])
})

test('listWorktrees drops a worktree whose directory was deleted behind our back', async () => {
  const repo = await initRepo('karbun-worktree-stale-')
  try {
    const created = await createWorktree(repo, 'vanishing')
    assert.ok(
      (await listWorktrees(repo)).some((w) => w.branch === 'vanishing'),
      'the worktree lists while it exists'
    )

    // What a disk cleanup (or `rm -rf ~/.karbun`) leaves behind: git keeps
    // reporting the worktree until something prunes the metadata.
    await rm(created.path, { recursive: true, force: true })
    const raw = parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain']))
    assert.equal(
      raw.find((w) => w.branch === 'vanishing')?.prunable,
      true,
      'git still reports it, marked prunable'
    )

    assert.deepEqual(
      (await listWorktrees(repo)).map((w) => w.branch),
      ['main'],
      'a worktree that is gone is never offered'
    )
    // It was ours, under KARBUN_WORKTREES_DIR, so the stale record is cleared too.
    assert.deepEqual(
      parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain'])).map((w) => w.branch),
      ['main'],
      'the stale metadata is pruned'
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('listWorktrees leaves a stale worktree it did not create alone', async () => {
  const repo = await initRepo('karbun-worktree-foreign-')
  const outside = await mkdtemp(join(tmpdir(), 'karbun-worktree-outside-'))
  try {
    // Someone else's worktree, outside the app-owned root — the shape of one
    // living on a disk that is currently unplugged.
    const foreign = join(outside, 'theirs')
    await git(repo, ['worktree', 'add', '-b', 'theirs', foreign])
    await rm(foreign, { recursive: true, force: true })

    assert.deepEqual(
      (await listWorktrees(repo)).map((w) => w.branch),
      ['main'],
      'still not offered — it cannot be opened either way'
    )
    assert.deepEqual(
      parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain'])).map((w) => w.branch),
      ['main', 'theirs'],
      'but the record survives, so plugging the disk back in restores it'
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('listWorktrees reports the main checkout alongside its worktrees', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'karbun-worktree-list-'))
  let made: string | null = null
  try {
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Carbon Test'])
    await git(repo, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])

    assert.deepEqual(
      (await listWorktrees(repo)).map((w) => [w.branch, w.isMain]),
      [['main', true]],
      'a plain checkout lists only itself'
    )

    const created = await createWorktree(repo, 'side-quest')
    made = created.path
    // Listing from inside the worktree must see the whole set, main first.
    const fromWorktree = await listWorktrees(created.path)
    assert.deepEqual(
      fromWorktree.map((w) => [w.branch, w.isMain]),
      [
        ['main', true],
        ['side-quest', false]
      ]
    )
    // Branched but not yet committed to, so it holds nothing main lacks — the
    // same state a worktree is in once its PR merges, and what marks it done.
    assert.equal(fromWorktree.find((w) => w.branch === 'side-quest')?.merged, true)
    assert.equal(fromWorktree[0].merged, undefined, 'the main checkout is never "finished"')
  } finally {
    if (made) await removeWorktree(repo, made, 'side-quest', true)
    await rm(repo, { recursive: true, force: true })
  }
})

test('createWorktree / status / remove round-trip against real git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'karbun-worktree-test-'))
  let created: Awaited<ReturnType<typeof createWorktree>> | null = null
  try {
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Carbon Test'])
    await git(repo, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])

    created = await createWorktree(repo, 'Fix Login')
    assert.equal(created.branch, 'fix-login')
    assert.ok(existsSync(join(created.path, 'a.txt')), 'tracked files are checked out')

    // The worktree is a linked worktree pointing back at the main checkout.
    const resolved = await resolveWorktree(created.path)
    assert.equal(resolved?.branch, 'fix-login')
    assert.equal(resolved?.repoRoot, created.repoRoot)
    // A plain checkout is not a worktree.
    assert.equal(await resolveWorktree(repo), null)

    const clean = await worktreeStatus(created.path, created.branch)
    assert.equal(clean.dirtyFiles, 0)
    assert.equal(clean.unmergedCommits, 0)

    await writeFile(join(created.path, 'b.txt'), 'work\n')
    const dirty = await worktreeStatus(created.path, created.branch)
    assert.equal(dirty.dirtyFiles, 1, 'untracked files count as dirty')

    // Unforced removal must refuse to destroy uncommitted work.
    const refused = await removeWorktree(repo, created.path, created.branch, false)
    assert.equal(refused.ok, false)
    assert.ok(existsSync(created.path), 'worktree survives a refused removal')

    const forced = await removeWorktree(repo, created.path, created.branch, true)
    assert.equal(forced.ok, true)
    assert.ok(!existsSync(created.path))
    created = null
  } finally {
    if (created) await rm(created.path, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test('handOffWorktree checks the branch out locally and drops the worktree', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'karbun-worktree-handoff-'))
  let made: string | null = null
  try {
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Carbon Test'])
    await git(repo, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])

    const created = await createWorktree(repo, 'feature-x')
    made = created.path
    // A commit made in the worktree must survive the hand-off.
    await writeFile(join(created.path, 'b.txt'), 'work\n')
    await git(created.path, ['add', '.'])
    await git(created.path, ['commit', '-qm', 'work in worktree'])

    // Uncommitted work blocks the hand-off rather than being destroyed.
    await writeFile(join(created.path, 'scratch.txt'), 'unsaved\n')
    const refused = await handOffWorktree(created.path, created)
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /uncommitted/i)
    assert.ok(existsSync(created.path), 'the worktree survives a refused hand-off')

    await rm(join(created.path, 'scratch.txt'))
    const res = await handOffWorktree(created.path, created)
    assert.equal(res.ok, true)
    // repoRoot, not `repo`: macOS resolves /var → /private/var via show-toplevel.
    assert.equal(res.cwd, created.repoRoot)
    assert.ok(!existsSync(created.path), 'the worktree directory is gone')

    // The main checkout is now on the branch, carrying its commit.
    const { stdout: branch } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo
    })
    assert.equal(branch.trim(), 'feature-x')
    assert.ok(existsSync(join(repo, 'b.txt')), 'work done in the worktree came along')
    made = null
  } finally {
    if (made) await rm(made, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test('mergeWorktree lands the branch in the main checkout and cleans up', async () => {
  const repo = await initRepo('karbun-worktree-merge-')
  let made: string | null = null
  try {
    const created = await createWorktree(repo, 'feature-y')
    made = created.path

    // Nothing committed yet — there is no merge to make.
    const empty = await mergeWorktree(created.path, created)
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /already in main/i)

    await writeFile(join(created.path, 'b.txt'), 'work\n')
    await git(created.path, ['add', '.'])
    await git(created.path, ['commit', '-qm', 'work in worktree'])

    const status = await worktreeStatus(created.path, created.branch)
    assert.equal(status.unmergedCommits, 1)

    // Uncommitted work blocks the merge — it would be left behind by removal.
    await writeFile(join(created.path, 'scratch.txt'), 'unsaved\n')
    const dirty = await mergeWorktree(created.path, created)
    assert.equal(dirty.ok, false)
    assert.match(dirty.error ?? '', /uncommitted/i)
    await rm(join(created.path, 'scratch.txt'))

    // A dirty main checkout blocks it too: an aborted merge needs a clean tree.
    await writeFile(join(repo, 'local.txt'), 'in progress\n')
    const dirtyRoot = await mergeWorktree(created.path, created)
    assert.equal(dirtyRoot.ok, false)
    assert.match(dirtyRoot.error ?? '', /main checkout has 1 uncommitted/i)
    await rm(join(repo, 'local.txt'))

    const res = await mergeWorktree(created.path, created)
    assert.equal(res.ok, true)
    assert.equal(res.cwd, created.repoRoot)
    assert.ok(!existsSync(created.path), 'the worktree directory is gone')
    assert.ok(existsSync(join(repo, 'b.txt')), 'the branch work landed in main')

    // Branch and worktree are both gone; main stayed checked out throughout.
    const { stdout: branch } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo
    })
    assert.equal(branch.trim(), 'main')
    const { stdout: heads } = await execFileP('git', ['branch', '--format=%(refname:short)'], {
      cwd: repo
    })
    assert.deepEqual(heads.trim().split('\n'), ['main'])
    made = null
  } finally {
    if (made) await rm(made, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test('mergeWorktree undoes a conflicting merge and leaves both trees intact', async () => {
  const repo = await initRepo('karbun-worktree-conflict-')
  let made: string | null = null
  try {
    const created = await createWorktree(repo, 'feature-z')
    made = created.path

    // Both sides change the same line — a guaranteed conflict.
    await writeFile(join(created.path, 'a.txt'), 'from the worktree\n')
    await git(created.path, ['commit', '-qam', 'worktree edit'])
    await writeFile(join(repo, 'a.txt'), 'from main\n')
    await git(repo, ['commit', '-qam', 'main edit'])

    // The worktree still holds its one unlanded commit.
    const status = await worktreeStatus(created.path, created.branch)
    assert.equal(status.unmergedCommits, 1)

    const res = await mergeWorktree(created.path, created)
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /undone/i)

    // The main checkout is not left mid-merge, and keeps its own version.
    assert.ok(!existsSync(join(repo, '.git', 'MERGE_HEAD')), 'the merge was aborted')
    const { stdout: content } = await execFileP('git', ['show', 'HEAD:a.txt'], { cwd: repo })
    assert.equal(content, 'from main\n')
    assert.ok(existsSync(created.path), 'the worktree survives a failed merge')

    // The worktree branch is still listed as unmerged, so it reads as live.
    const refs = await listWorktrees(repo)
    assert.equal(refs.find((r) => r.branch === 'feature-z')?.merged, false)
  } finally {
    if (made) await rm(made, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test('finishWorktree retires a landed worktree and reports a leftover branch', async () => {
  const repo = await initRepo('karbun-worktree-finish-')
  let made: string | null = null
  try {
    const created = await createWorktree(repo, 'landed')
    made = created.path

    // Uncommitted work blocks removal rather than going down with the folder.
    await writeFile(join(created.path, 'scratch.txt'), 'unsaved\n')
    const refused = await finishWorktree(created.path, created)
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /uncommitted/i)
    assert.equal(refused.cwd, undefined, 'a refusal never moves the chat')
    assert.ok(existsSync(created.path))
    await rm(join(created.path, 'scratch.txt'))

    // A commit git can't see in main stands in for a squash-merged PR: the
    // worktree still goes, the branch survives, and the chat still moves.
    await writeFile(join(created.path, 'b.txt'), 'work\n')
    await git(created.path, ['add', '.'])
    await git(created.path, ['commit', '-qm', 'unmerged work'])

    const leftover = await finishWorktree(created.path, created)
    assert.equal(leftover.ok, false)
    assert.equal(leftover.cwd, created.repoRoot, 'the chat moves even so')
    assert.match(leftover.error ?? '', /squash-merged/i)
    assert.ok(!existsSync(created.path), 'the worktree directory is gone')
    const heads = await execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: repo })
    assert.ok(heads.stdout.includes('landed'), 'the unmerged branch survives')
    made = null

    // The clean case: a branch with nothing of its own leaves nothing behind.
    const second = await createWorktree(repo, 'done')
    made = second.path
    const res = await finishWorktree(second.path, second)
    assert.equal(res.ok, true)
    assert.equal(res.cwd, second.repoRoot)
    assert.ok(!existsSync(second.path))
    const after = await execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: repo })
    assert.ok(!after.stdout.includes('done'), 'the merged branch is deleted')
    made = null
  } finally {
    if (made) await rm(made, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test('createWorktree recovers from a branch-name collision', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'karbun-worktree-collide-'))
  const made: string[] = []
  try {
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Carbon Test'])
    await git(repo, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])

    const first = await createWorktree(repo, 'same-name')
    made.push(first.path)
    const second = await createWorktree(repo, 'same-name')
    made.push(second.path)

    assert.notEqual(second.branch, first.branch, 'collision falls back to a generated name')
    assert.ok(existsSync(second.path))
  } finally {
    for (const p of made) await rm(p, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

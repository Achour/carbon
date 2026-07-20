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
  handOffWorktree,
  defaultBranchName,
  isManagedWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  resolveWorktree,
  sanitizeBranch,
  setupCommandFor,
  worktreePathFor,
  worktreeStatus
} from '../src/main/worktree.ts'

const execFileP = promisify(execFile)

// Keep worktrees the tests create out of the developer's real ~/.karbun.
const TEST_ROOT = join(tmpdir(), 'karbun-worktrees-test')
process.env.KARBUN_WORKTREES_DIR = TEST_ROOT

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP('git', args, { cwd })
}

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

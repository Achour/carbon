import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDefaultBranch, gitMergeIntoDefault, gitStatus } from '../src/main/git.ts'
import { branchOf, git, initRepo } from './gitRepo.ts'

/** A repo on `main` with one commit, plus a feature branch checked out. */
async function repoOnFeature(label: string): Promise<string> {
  const repo = await initRepo(`karbun-merge-${label}-`)
  await git(repo, ['switch', '-qc', 'feature'])
  return repo
}

test('detectDefaultBranch finds main, master, or neither', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'karbun-default-branch-'))
  try {
    await git(repo, ['init', '-q', '-b', 'trunk'])
    await git(repo, ['config', 'user.name', 'Carbon Test'])
    await git(repo, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(repo, 'a.txt'), 'x\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])
    // Only `trunk` exists, and it is not a name we recognize.
    assert.equal(await detectDefaultBranch(repo), null)

    await git(repo, ['branch', 'master'])
    assert.equal(await detectDefaultBranch(repo), 'master')
    // main wins over master when a repo somehow has both.
    await git(repo, ['branch', 'main'])
    assert.equal(await detectDefaultBranch(repo), 'main')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('gitMergeIntoDefault lands the branch, deletes it, and ends on main', async () => {
  const repo = await repoOnFeature('ok')
  try {
    await writeFile(join(repo, 'b.txt'), 'feature work\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'feature work'])

    const res = await gitMergeIntoDefault(repo)
    assert.equal(res.ok, true)
    assert.match(res.output ?? '', /merged feature into main/i)

    assert.equal(await branchOf(repo), 'main')
    assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'feature work\n')
    const heads = await git(repo, ['branch', '--format=%(refname:short)'])
    assert.deepEqual(heads.trim().split('\n'), ['main'], 'the merged branch is gone')

    // Nothing left to do from main.
    const again = await gitMergeIntoDefault(repo)
    assert.equal(again.ok, false)
    assert.match(again.error ?? '', /already on main/i)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('gitStatus reports how far the branch has drifted behind the default', async () => {
  const repo = await repoOnFeature('lag')
  try {
    // Freshly branched: current, and the marker stays hidden.
    assert.equal((await gitStatus(repo)).behindDefault, 0)

    await git(repo, ['switch', '-q', 'main'])
    await writeFile(join(repo, 'c.txt'), 'moved on\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'main moves ahead'])
    // On the default branch itself the counts don't apply, but the branch's
    // name is still reported — labels read it wherever the chat is.
    const onMain = await gitStatus(repo)
    assert.equal(onMain.behindDefault, undefined)
    assert.equal(onMain.defaultBranch, 'main')

    await git(repo, ['switch', '-q', 'feature'])
    const stale = await gitStatus(repo)
    assert.equal(stale.behindDefault, 1)
    assert.equal(stale.aheadDefault, 0)
    assert.equal(stale.defaultBranch, 'main')
    // `behind` is a different number — no upstream here, so it stays 0.
    assert.equal(stale.behind, 0)

    // Merging main in clears it, which is what the marker asks you to do.
    await git(repo, ['merge', '--no-edit', 'main'])
    assert.equal((await gitStatus(repo)).behindDefault, 0)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('gitMergeIntoDefault refuses to merge over uncommitted work', async () => {
  const repo = await repoOnFeature('dirty')
  try {
    await writeFile(join(repo, 'b.txt'), 'committed\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'feature work'])
    await writeFile(join(repo, 'scratch.txt'), 'still editing\n')

    const res = await gitMergeIntoDefault(repo)
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /1 uncommitted file/i)
    // Refusing must not have moved the branch out from under the user.
    assert.equal(await branchOf(repo), 'feature')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('gitMergeIntoDefault puts the directory back when the merge conflicts', async () => {
  const repo = await repoOnFeature('conflict')
  try {
    // Both branches rewrite the same line.
    await writeFile(join(repo, 'a.txt'), 'from feature\n')
    await git(repo, ['commit', '-qam', 'feature edit'])
    await git(repo, ['switch', '-q', 'main'])
    await writeFile(join(repo, 'a.txt'), 'from main\n')
    await git(repo, ['commit', '-qam', 'main edit'])
    await git(repo, ['switch', '-q', 'feature'])

    const res = await gitMergeIntoDefault(repo)
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /still on feature/i)

    // Back exactly where we started: same branch, same content, no merge state.
    assert.equal(await branchOf(repo), 'feature')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'from feature\n')
    const status = await git(repo, ['status', '--porcelain'])
    assert.equal(status.trim(), '', 'the working tree is clean')
    const heads = await git(repo, ['branch', '--format=%(refname:short)'])
    assert.deepEqual(heads.trim().split('\n').sort(), ['feature', 'main'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

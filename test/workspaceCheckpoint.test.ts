import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  captureWorkspaceTree,
  rewindWorkspaceCheckpoint
} from '../src/main/workspaceCheckpoint.ts'

const execFileP = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP('git', args, { cwd })
}

test('Codex workspace checkpoint previews, detects drift, and restores one turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'karbun-checkpoint-test-'))
  try {
    await git(cwd, ['init', '-q'])
    await git(cwd, ['config', 'user.name', 'Carbon Test'])
    await git(cwd, ['config', 'user.email', 'karbun@example.test'])
    await writeFile(join(cwd, 'existing.txt'), 'before\n')
    await git(cwd, ['add', 'existing.txt'])
    await git(cwd, ['commit', '-qm', 'initial'])

    const before = await captureWorkspaceTree(cwd)
    assert.ok(before)
    await writeFile(join(cwd, 'existing.txt'), 'after\nsecond\n')
    await writeFile(join(cwd, 'created.txt'), 'new\n')
    const after = await captureWorkspaceTree(cwd)
    assert.ok(after)
    const checkpoint = { before, after }

    const preview = await rewindWorkspaceCheckpoint(cwd, checkpoint, true)
    assert.equal(preview.canRewind, true)
    assert.deepEqual(preview.filesChanged?.sort(), ['created.txt', 'existing.txt'])
    assert.equal(preview.insertions, 3)
    assert.equal(preview.deletions, 1)

    await writeFile(join(cwd, 'existing.txt'), 'newer user edit\n')
    const drifted = await rewindWorkspaceCheckpoint(cwd, checkpoint, true)
    assert.equal(drifted.canRewind, false)
    assert.match(drifted.error ?? '', /changed after this turn/i)

    await writeFile(join(cwd, 'existing.txt'), 'after\nsecond\n')
    const undone = await rewindWorkspaceCheckpoint(cwd, checkpoint, false)
    assert.equal(undone.canRewind, true)
    assert.equal(await readFile(join(cwd, 'existing.txt'), 'utf8'), 'before\n')
    await assert.rejects(stat(join(cwd, 'created.txt')), { code: 'ENOENT' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

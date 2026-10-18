import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { foldWorktreePath } from '../src/main/usageProjects.ts'

const roots = ['/Users/me/code/app', '/Users/me/work/app', '/Users/me/code/site']
const hash = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 8)

test("Claude Code's nested worktrees belong to the repo above them", () => {
  assert.equal(foldWorktreePath('/Users/me/code/site/.claude/worktrees/fix-nav', roots), '/Users/me/code/site')
})

test("Carbon's hashed worktree dir names exactly one of two same-named repos", () => {
  const cwd = `/Users/me/.karbun/worktrees/app-${hash('/Users/me/work/app')}/feature-x`
  assert.equal(foldWorktreePath(cwd, roots), '/Users/me/work/app')
})

test('a bare repo name after `worktrees` matches when it is unambiguous', () => {
  assert.equal(foldWorktreePath('/Users/me/.tool/worktrees/site/branch', roots), '/Users/me/code/site')
  // Two repos called `app`: refuse to guess.
  assert.equal(foldWorktreePath('/Users/me/.tool/worktrees/app/branch', roots), '/Users/me/.tool/worktrees/app/branch')
})

test('anything else stays its own folder', () => {
  assert.equal(foldWorktreePath('/tmp/scratch', roots), '/tmp/scratch')
})

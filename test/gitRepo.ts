import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Run git in `cwd`, returning stdout. Shared by the git-facing test files. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd })
  return stdout
}

/** A throwaway repo on `main` with one seed commit (`a.txt`). Caller removes it. */
export async function initRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'Carbon Test'])
  await git(repo, ['config', 'user.email', 'karbun@example.test'])
  await writeFile(join(repo, 'a.txt'), 'base\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-qm', 'init'])
  return repo
}

/** The branch currently checked out in `repo`. */
export async function branchOf(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

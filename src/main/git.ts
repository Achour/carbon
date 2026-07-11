import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitDiffTarget, GitFileChange, GitResult, GitStatus } from '@shared/types'

const execFileP = promisify(execFile)

// GIT_TERMINAL_PROMPT=0 makes remote ops fail fast instead of hanging on a
// credential prompt; GIT_OPTIONAL_LOCKS=0 keeps status reads from fighting
// over the index while an agent is running git in the same repo.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  })
  return stdout
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
  if (e.killed) return 'Git timed out — check your network or credentials.'
  const msg = (e.stderr || e.stdout || e.message || 'git failed').trim()
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg
}

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: '',
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  hasRemote: false,
  changes: []
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let out: string
  try {
    out = await git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch'])
  } catch {
    return EMPTY_STATUS
  }

  const status: GitStatus = { ...EMPTY_STATUS, isRepo: true }
  const changes: GitFileChange[] = []

  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.upstream ')) {
      status.hasUpstream = true
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        status.ahead = Number(m[1])
        status.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const path = parts.slice(8).join(' ')
      if (xy[0] !== '.') changes.push({ path, status: xy[0], staged: true })
      if (xy[1] !== '.') changes.push({ path, status: xy[1], staged: false })
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const [path, origPath] = parts.slice(9).join(' ').split('\t')
      if (xy[0] !== '.') changes.push({ path, origPath, status: xy[0], staged: true })
      if (xy[1] !== '.') changes.push({ path, origPath, status: xy[1], staged: false })
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      changes.push({ path: parts.slice(10).join(' '), status: 'U', staged: false })
    } else if (line.startsWith('? ')) {
      changes.push({ path: line.slice(2), status: '?', staged: false })
    }
  }

  status.changes = changes
  try {
    status.hasRemote = (await git(cwd, ['remote'])).trim().length > 0
  } catch {
    // leave hasRemote false
  }
  return status
}

export async function gitDiff(cwd: string, target: GitDiffTarget): Promise<string> {
  try {
    if (target.untracked) {
      // --no-index exits 1 whenever the files differ; the diff is still on stdout.
      try {
        return await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', target.path])
      } catch (err) {
        const e = err as { stdout?: string }
        if (typeof e.stdout === 'string' && e.stdout.length > 0) return e.stdout
        throw err
      }
    }
    const args = target.staged
      ? ['diff', '--no-color', '--cached', '--', target.path]
      : ['diff', '--no-color', '--', target.path]
    return await git(cwd, args)
  } catch (err) {
    return `error: ${errText(err)}`
  }
}

export async function gitStage(cwd: string, paths: string[]): Promise<GitResult> {
  try {
    await git(cwd, ['add', '--', ...paths])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<GitResult> {
  try {
    await git(cwd, ['reset', '-q', 'HEAD', '--', ...paths])
    return { ok: true }
  } catch {
    // Before the first commit HEAD doesn't exist; fall back to rm --cached.
    try {
      await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
  }
}

export async function gitCommit(cwd: string, message: string): Promise<GitResult> {
  try {
    const out = await git(cwd, ['commit', '-m', message])
    return { ok: true, output: out.trim() }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

export async function gitPush(cwd: string): Promise<GitResult> {
  try {
    const out = await git(cwd, ['push'], 60_000)
    return { ok: true, output: out.trim() }
  } catch (err) {
    const text = errText(err)
    if (/no upstream|set-upstream|no configured push destination/i.test(text)) {
      try {
        const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        const out = await git(cwd, ['push', '-u', 'origin', branch], 60_000)
        return { ok: true, output: out.trim() }
      } catch (err2) {
        return { ok: false, error: errText(err2) }
      }
    }
    return { ok: false, error: text }
  }
}

export async function gitInit(cwd: string): Promise<GitResult> {
  try {
    await git(cwd, ['init'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  changes: [],
  additions: 0,
  deletions: 0
}

// Safety rails for counting untracked additions by hand: skip huge files and
// bail after enough of them that the header badge is already "big".
const MAX_UNTRACKED_FILES = 300
const MAX_COUNT_BYTES = 4 * 1024 * 1024

interface LineDelta {
  additions: number
  deletions: number
}

/**
 * Resolves the numstat path field to the file's current path. Numstat renders
 * renames as `old => new` or `pre{old => new}post`; the change's path is always
 * the new one, so collapse to that.
 */
function resolveNumstatPath(raw: string): string {
  if (!raw.includes(' => ')) return raw
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw)
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/')
  const arrow = raw.split(' => ')
  return arrow[arrow.length - 1]
}

/** Parses `git diff --numstat` output into per-file add/remove counts. */
function numstatMap(out: string): Map<string, LineDelta> {
  const map = new Map<string, LineDelta>()
  for (const line of out.split('\n')) {
    if (!line) continue
    const [a, d, ...rest] = line.split('\t')
    // Binary files report "-" for both columns; Number('-') is NaN → 0.
    const additions = Number(a) || 0
    const deletions = Number(d) || 0
    map.set(resolveNumstatPath(rest.join('\t')), { additions, deletions })
  }
  return map
}

function sumDeltas(map: Map<string, LineDelta>): LineDelta {
  let additions = 0
  let deletions = 0
  for (const d of map.values()) {
    additions += d.additions
    deletions += d.deletions
  }
  return { additions, deletions }
}

/**
 * Untracked files never appear in `git diff --numstat`, so count their lines
 * directly — every line is an addition. Binaries (a NUL byte early on, git's
 * own heuristic) and oversized files are skipped.
 */
async function untrackedLineCounts(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const rel of paths.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const buf = await readFile(join(cwd, rel))
      if (buf.length === 0 || buf.length > MAX_COUNT_BYTES) continue
      if (buf.subarray(0, 8000).includes(0)) continue
      let lines = 0
      let idx = -1
      while ((idx = buf.indexOf(10, idx + 1)) !== -1) lines++
      // A final line with no trailing newline still counts.
      if (buf[buf.length - 1] !== 10) lines++
      counts.set(rel, lines)
    } catch {
      // unreadable (perms, symlink, vanished) — skip
    }
  }
  return counts
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let out: string
  try {
    // --untracked-files=all lists new files individually instead of collapsing a
    // new directory to a single "web/" entry (which renders as a blank tree row
    // and has no meaningful diff). .gitignore is still respected.
    out = await git(cwd, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ])
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
      const path = line.slice(2)
      // A trailing slash means git still reported a whole (empty) untracked dir;
      // it has no file to diff and would render nameless, so skip it.
      if (!path.endsWith('/')) changes.push({ path, status: '?', staged: false })
    }
  }

  status.changes = changes
  try {
    status.hasRemote = (await git(cwd, ['remote'])).trim().length > 0
  } catch {
    // leave hasRemote false
  }

  // Line counts for the header badge and the per-file tree markers. Working-tree
  // and staged numstats cover disjoint ranges (index→worktree and HEAD→index),
  // so summing them is the full change vs HEAD without double-counting; untracked
  // files are counted by hand since numstat never lists them.
  try {
    // core.quotepath=false matches the porcelain status parse above, so numstat
    // reports non-ASCII paths unquoted and the per-file lookups below hit.
    const [work, staged] = await Promise.all([
      git(cwd, ['-c', 'core.quotepath=false', 'diff', '--numstat']),
      git(cwd, ['-c', 'core.quotepath=false', 'diff', '--numstat', '--cached'])
    ])
    const workMap = numstatMap(work)
    const stagedMap = numstatMap(staged)
    const untracked = await untrackedLineCounts(
      cwd,
      changes.filter((c) => c.status === '?').map((c) => c.path)
    )

    // Tag each change row with its own add/remove counts.
    for (const c of changes) {
      if (c.status === '?') {
        const n = untracked.get(c.path)
        if (n !== undefined) {
          c.additions = n
          c.deletions = 0
        }
      } else {
        const d = (c.staged ? stagedMap : workMap).get(c.path)
        if (d) {
          c.additions = d.additions
          c.deletions = d.deletions
        }
      }
    }

    const w = sumDeltas(workMap)
    const s = sumDeltas(stagedMap)
    let untrackedAdds = 0
    for (const n of untracked.values()) untrackedAdds += n
    status.additions = w.additions + s.additions + untrackedAdds
    status.deletions = w.deletions + s.deletions
  } catch {
    // leave additions/deletions at 0
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

/**
 * Updates remote-tracking refs so `gitStatus` can report a truthful ahead/behind.
 * Without this, `# branch.ab` is measured against a stale `origin/*` and a repo
 * whose remote moved still looks "in sync". Best-effort: a no-remote repo or an
 * offline box fails quietly.
 */
export async function gitFetch(cwd: string): Promise<GitResult> {
  try {
    await git(cwd, ['fetch', '--prune'], 45_000)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

export async function gitPull(cwd: string): Promise<GitResult> {
  try {
    // Plain pull: fast-forwards when only behind, merges when diverged. A merge
    // conflict leaves the tree in a conflicted state and surfaces as an error;
    // the changed files then show up in the next status read.
    const out = await git(cwd, ['pull'], 60_000)
    return { ok: true, output: out.trim() }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  BranchChanges,
  GitDiffTarget,
  GitFileChange,
  GitResult,
  GitStatus
} from '@shared/types'

const execFileP = promisify(execFile)

// GIT_TERMINAL_PROMPT=0 makes remote ops fail fast instead of hanging on a
// credential prompt; GIT_OPTIONAL_LOCKS=0 keeps status reads from fighting
// over the index while an agent is running git in the same repo.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

export async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  })
  return stdout
}

export function errText(err: unknown): string {
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

const DEFAULT_BRANCHES = ['main', 'master']

/**
 * The repo's default branch, or null when it has neither `main` nor `master`.
 * One `for-each-ref` instead of a `rev-parse --verify` per candidate: it lists
 * only the refs that exist and exits 0 when none do.
 */
export async function detectDefaultBranch(cwd: string): Promise<string | null> {
  const heads = await git(cwd, [
    'for-each-ref',
    '--format=%(refname:short)',
    ...DEFAULT_BRANCHES.map((b) => `refs/heads/${b}`)
  ]).catch(() => '')
  // for-each-ref sorts by refname, so precedence comes from DEFAULT_BRANCHES.
  const present = heads.split('\n').map((l) => l.trim())
  return DEFAULT_BRANCHES.find((b) => present.includes(b)) ?? null
}

/**
 * Where `branch` stands relative to the repo's default branch: `behind` is the
 * staleness that has no other symptom until it surfaces as a conflicted merge,
 * `ahead` is the work not yet landed. Null only when the repo has no
 * main/master; the counts are null on the default branch itself, where the
 * question doesn't apply. This is the single implementation of that question —
 * `gitStatus`, `worktreeStatus` and the merge guards all read it from here, so
 * the chip, the dialog and the operation can never disagree.
 * (`GitStatus.behind` is a different number: vs the branch's own upstream.)
 */
export async function branchVsDefault(
  cwd: string,
  branch: string
): Promise<{ defaultBranch: string; behind: number | null; ahead: number | null } | null> {
  const def = await detectDefaultBranch(cwd)
  if (!def) return null
  if (!branch || branch === def) return { defaultBranch: def, behind: null, ahead: null }
  // "<left>\t<right>" — left is what the default has and we don't.
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${def}...${branch}`])
    .then((out) => out.trim().split(/\s+/).map(Number))
    .catch(() => null)
  const valid = counts?.length === 2 && counts.every(Number.isFinite)
  return {
    defaultBranch: def,
    behind: valid ? counts![0] : null,
    ahead: valid ? counts![1] : null
  }
}

/** The branch checked out in `cwd` ('HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

/**
 * The `.git` directory governing `cwd`, walking up to the repo root — or null
 * outside a repo. In a worktree `.git` is a *file* holding `gitdir: <path>`,
 * which is exactly where that worktree's own HEAD lives, so following it is
 * what makes a worktree report its own branch rather than the main checkout's.
 */
async function gitDirOf(cwd: string): Promise<string | null> {
  let dir = cwd
  // Bounded: a path deeper than this is pathological, and an unbounded loop
  // here would run once per sidebar row.
  for (let i = 0; i < 64; i++) {
    const dotGit = join(dir, '.git')
    try {
      const st = await stat(dotGit)
      if (st.isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))
      return pointer ? resolve(dir, pointer[1].trim()) : null
    } catch {
      // No `.git` here — keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * The branch checked out in `cwd`, or null when it isn't in a repo. Detached
 * HEAD reports the short sha, which is at least the thing you're sitting on —
 * `currentBranch`'s literal 'HEAD' would read as a branch named HEAD.
 *
 * This reads `.git/HEAD` instead of spawning git because the caller is the
 * sidebar asking about *every* chat: a dozen `rev-parse` processes to render a
 * list is a cost the answer doesn't justify, and HEAD is a file git rewrites on
 * every checkout anyway.
 */
export async function branchAt(cwd: string): Promise<string | null> {
  const gitDir = await gitDirOf(cwd)
  if (!gitDir) return null
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : head.slice(0, 7) || null
  } catch {
    return null
  }
}

/** `branchAt` for a whole set of folders — one map, unknown folders included as null. */
export async function branchesAt(cwds: string[]): Promise<Record<string, string | null>> {
  const unique = [...new Set(cwds)]
  const branches = await Promise.all(unique.map((cwd) => branchAt(cwd).catch(() => null)))
  return Object.fromEntries(unique.map((cwd, i) => [cwd, branches[i]]))
}

/**
 * Files with uncommitted changes (staged + unstaged + untracked). An unreadable
 * tree reads as clean — the git command being guarded then refuses itself.
 */
export async function dirtyFileCount(cwd: string): Promise<number> {
  const out = await git(cwd, ['status', '--porcelain']).catch(() => '')
  return out.split('\n').filter((l) => l.trim().length > 0).length
}

/** The one spelling of the dirty-tree refusal every guarded operation shows. */
export function uncommitted(n: number, subject: string, suffix: string): string {
  return `${subject} ${n} uncommitted file${n === 1 ? '' : 's'}. ${suffix}`
}

/**
 * Merge `branch` into the checked-out branch, aborting on conflict so the tree
 * is never left half-merged. Returns git's message on failure, null on success.
 */
export async function mergeOrAbort(cwd: string, branch: string): Promise<string | null> {
  try {
    await git(cwd, ['merge', '--no-edit', branch], 30_000)
    return null
  } catch (err) {
    await git(cwd, ['merge', '--abort'], 30_000).catch(() => {})
    return errText(err)
  }
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
    // git fails identically for a folder that isn't a repo and one that isn't
    // there, and the second is what a worktree deleted outside the app leaves
    // behind — reported as "not a git repo", it sends you looking in the wrong
    // place. Only this path pays for the stat, and it is already the slow one.
    const gone = await stat(cwd)
      .then((s) => !s.isDirectory())
      .catch(() => true)
    return gone ? { ...EMPTY_STATUS, missing: true } : EMPTY_STATUS
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
  // Started here and awaited at the end so it overlaps the numstat reads below
  // rather than adding its own round trip to every status refresh.
  const standing = branchVsDefault(cwd, status.branch)
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

  const vs = await standing
  if (vs) {
    status.defaultBranch = vs.defaultBranch
    if (vs.behind !== null) status.behindDefault = vs.behind
    if (vs.ahead !== null) status.aheadDefault = vs.ahead
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
    // Branch scope: diff the whole branch delta for this file (base → working tree).
    const args = target.base
      ? ['diff', '--no-color', target.base, '--', target.path]
      : target.staged
        ? ['diff', '--no-color', '--cached', '--', target.path]
        : ['diff', '--no-color', '--', target.path]
    return await git(cwd, args)
  } catch (err) {
    return `error: ${errText(err)}`
  }
}

/**
 * Branch-scope change set: every file that differs between the current branch's
 * merge-base with its base branch and the working tree — i.e. everything you've
 * done on this branch, committed and uncommitted. Untracked files are folded in
 * (they're branch work too); `committed` marks rows already in a branch commit.
 * Best-effort: returns an empty set if no base branch can be resolved.
 */
export async function gitBranchChanges(
  cwd: string,
  baseBranch?: string
): Promise<BranchChanges> {
  const empty: BranchChanges = { base: null, baseBranch: null, changes: [] }
  // Resolve the merge-base against the (given or conventional) base branch.
  const candidates = baseBranch ? [baseBranch] : ['main', 'master']
  let base: string | null = null
  let resolvedBase: string | null = null
  for (const b of candidates) {
    for (const ref of [b, `origin/${b}`]) {
      try {
        const mb = (await git(cwd, ['merge-base', 'HEAD', ref])).trim()
        if (mb) {
          base = mb
          resolvedBase = b
          break
        }
      } catch {
        // ref doesn't exist locally — try the next
      }
    }
    if (base) break
  }
  if (!base) return empty

  try {
    const [nameStatus, numstat, committedNames, untracked] = await Promise.all([
      git(cwd, ['-c', 'core.quotepath=false', 'diff', '--name-status', base]),
      git(cwd, ['-c', 'core.quotepath=false', 'diff', '--numstat', base]),
      git(cwd, ['-c', 'core.quotepath=false', 'diff', '--name-only', base, 'HEAD']),
      git(cwd, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'])
    ])
    const deltas = numstatMap(numstat)
    const committed = new Set(committedNames.split('\n').filter(Boolean))
    const changes: GitFileChange[] = []

    for (const line of nameStatus.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const status = parts[0][0] // "R100" → "R"
      const path = parts[parts.length - 1]
      const origPath = status === 'R' && parts.length > 2 ? parts[1] : undefined
      const d = deltas.get(path)
      changes.push({
        path,
        origPath,
        status,
        staged: false,
        committed: committed.has(path),
        additions: d?.additions,
        deletions: d?.deletions
      })
    }

    const untrackedPaths = untracked.split('\n').filter(Boolean)
    const counts = await untrackedLineCounts(cwd, untrackedPaths)
    for (const p of untrackedPaths) {
      changes.push({ path: p, status: '?', staged: false, additions: counts.get(p) ?? 0, deletions: 0 })
    }

    return { base, baseBranch: resolvedBase, changes }
  } catch {
    return { base, baseBranch: resolvedBase, changes: [] }
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

/**
 * Give a repo whose HEAD is unborn a commit to stand on, and report whether one
 * was needed. A folder that was only just `git init`ed has none, and that is
 * not a cosmetic gap: `git worktree add … HEAD` refuses outright with
 * "fatal: invalid reference: HEAD", so New worktree — the first thing a new
 * project is likely to reach for — dies on the very repo the app just created.
 * `branchVsDefault` is equally stuck, since an unborn `main` is not a ref that
 * `for-each-ref` can find.
 *
 * Written with plumbing rather than `git commit --allow-empty`, which would
 * sweep whatever is already staged into a commit the user never asked for and
 * label it "Initial commit". `commit-tree` against the empty tree touches
 * neither the index nor the working tree: everything stays exactly as staged or
 * untracked as it was, and only the missing base appears. The empty tree is
 * hashed rather than hard-coded because a SHA-256 repository names it
 * differently.
 *
 * `update-ref` follows the HEAD symref, so the base lands on the branch the
 * repo already believes it is on — `main` becomes a real branch, which is both
 * what a worktree can branch from and what "Merge into main" can later merge
 * into. `git worktree add --orphan` would sidestep the failure and leave two
 * histories that can never meet.
 */
export async function ensureRootCommit(cwd: string): Promise<boolean> {
  // Exits non-zero (and prints nothing) only on an unborn HEAD — the caller is
  // already known to be inside a repo.
  const born = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    (out) => !!out.trim(),
    () => false
  )
  if (born) return false
  const tree = (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  const commit = (await git(cwd, ['commit-tree', tree, '-m', 'Initial commit'])).trim()
  // '' as the expected old value: refuse rather than clobber if something else
  // committed to the branch between the check above and here.
  await git(cwd, ['update-ref', 'HEAD', commit, ''])
  return true
}

/**
 * The tip commit holds no files — nothing has really been committed yet. Not a
 * commit *count*: `ensureRootCommit` writes a base commit into every repo the
 * app initializes, so "one commit" and "nothing committed" are the same repo,
 * and the tree is the only thing that tells them apart. An unborn HEAD has no
 * tree at all, which is as empty as it gets.
 */
export async function hasEmptyTree(cwd: string): Promise<boolean> {
  try {
    const [empty, tree] = await Promise.all([
      git(cwd, ['hash-object', '-t', 'tree', '/dev/null']),
      git(cwd, ['rev-parse', 'HEAD^{tree}'])
    ])
    return empty.trim() === tree.trim()
  } catch {
    return true
  }
}

export async function gitInit(cwd: string): Promise<GitResult> {
  try {
    await git(cwd, ['init'])
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  // Best-effort, and deliberately not part of the result: the repo genuinely
  // was initialized, so reporting a failure here would send someone looking for
  // a repo that is already there. The only realistic way this fails is an
  // unconfigured `user.email`, and `createWorktree` says so at the point it
  // actually matters.
  await ensureRootCommit(cwd).catch(() => {})
  return { ok: true }
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

/**
 * Land the checked-out branch into the default branch, in place: switch, merge,
 * delete the branch. This is the ordinary end of a feature branch, and it ends
 * *on* the default branch — which is only safe because the source-control
 * ladder's first rung from there is "Create Branch & Commit", so the next piece
 * of work branches off again instead of piling onto main.
 *
 * Unlike the worktree merge, this rewrites the directory the chat is sitting
 * in, so the caller only offers it on an idle chat. A dirty tree is refused
 * outright: `switch` would either carry the changes onto the default branch or
 * refuse halfway, and neither is something to hand a beginner. A conflicting
 * merge is aborted and the original branch checked out again, so a refusal
 * always leaves the working directory exactly as it was found.
 */
export async function gitMergeIntoDefault(cwd: string): Promise<GitResult> {
  let branch: string, def: string | null, dirty: number
  try {
    // Pure reads with no dependency between them; the guards keep their order.
    ;[branch, def, dirty] = await Promise.all([
      currentBranch(cwd),
      detectDefaultBranch(cwd),
      dirtyFileCount(cwd)
    ])
  } catch (err) {
    return { ok: false, error: errText(err) }
  }

  if (!def) return { ok: false, error: 'No main or master branch to merge into.' }
  if (branch === def) return { ok: false, error: `Already on ${def}.` }
  if (branch === 'HEAD') return { ok: false, error: 'Not on a branch (detached HEAD).' }
  if (dirty > 0) {
    return {
      ok: false,
      error: uncommitted(dirty, 'You have', 'Commit them first — only committed work can be merged.')
    }
  }

  try {
    await git(cwd, ['switch', def], 30_000)
  } catch (err) {
    return { ok: false, error: errText(err) }
  }

  const conflict = await mergeOrAbort(cwd, branch)
  if (conflict) {
    // Put the directory back the way it was: the merge is undone, undo the switch.
    await git(cwd, ['switch', branch], 30_000).catch(() => {})
    return {
      ok: false,
      error: `${conflict}\n\nNothing changed — you're still on ${branch}. Ask the agent to merge ${def} into this branch and resolve the conflicts first.`
    }
  }

  try {
    // Unforced: git only agrees to this because it just merged the branch.
    await git(cwd, ['branch', '-d', branch], 30_000)
  } catch (err) {
    // The merge is what mattered; a surviving branch is harmless.
    return { ok: true, output: `Merged into ${def}. The ${branch} branch is still there: ${errText(err)}` }
  }
  return { ok: true, output: `Merged ${branch} into ${def} and deleted the branch.` }
}

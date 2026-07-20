import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { OpResult, WorktreeInfo, WorktreeRef, WorktreeStatus } from '@shared/types'
// The .ts extension keeps `node --test` able to load this module directly (see
// codex.ts for the same pattern); git.ts value-imports only node: builtins.
import { errText, git } from './git.ts'

/** Worktree commands checkout whole trees, so they get longer than git.ts's default. */
const TIMEOUT = 30_000

// ---------- Pure helpers ----------

/**
 * Coerce a user-supplied name into something `git branch` accepts: no spaces,
 * no ref-illegal characters, no leading/trailing punctuation. Returns '' when
 * nothing usable survives, so callers can fall back to a generated name.
 */
export function sanitizeBranch(name: string): string {
  return name
    .toLowerCase()
    // Also collapses leading/trailing whitespace into dashes the final trim strips.
    .replace(/[\s_]+/g, '-')
    // Anything git refuses in a ref name, plus the shell-hostile set.
    .replace(/[~^:?*[\]\\@{}!'"`$()<>|;&#]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    // Trimmed after the slice — slicing can itself expose a trailing separator.
    .replace(/^[-./]+|[-./]+$/g, '')
}

const B36 = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Auto branch name, e.g. `karbun/jul19-k3xq`. Deterministic under injection. */
export function defaultBranchName(now: Date = new Date(), rand: () => number = Math.random): string {
  const stamp = `${MONTHS[now.getMonth()]}${now.getDate()}`
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += B36[Math.floor(rand() * B36.length)] ?? '0'
  return `karbun/${stamp}-${suffix}`
}

/**
 * Deterministic on-disk location for a worktree. The repo hash keeps two
 * same-named projects (`~/a/api` and `~/b/api`) from colliding.
 */
export function worktreePathFor(root: string, repoRoot: string, branch: string): string {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  return join(root, `${basename(repoRoot)}-${hash}`, branch.replace(/\//g, '-'))
}

/**
 * Where worktrees live. Deliberately outside the repo (never dirties git
 * status, needs no .gitignore entry) and outside Electron's userData, whose
 * "Application Support" path contains a space that breaks many build scripts.
 * KARBUN_WORKTREES_DIR overrides it, which keeps tests out of the real $HOME.
 */
function worktreesRoot(): string {
  return process.env.KARBUN_WORKTREES_DIR || join(homedir(), '.karbun', 'worktrees')
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Relative paths of the setup scripts we honour, in precedence order. */
const SETUP_SCRIPTS = ['.karbun/setup.sh', '.codex/setup.sh']

/**
 * Build the `$SHELL -lc` command that provisions a fresh worktree, or null when
 * the project ships no setup script. We honour Codex's `.codex/setup.sh` too
 * (and export CODEX_WORKDIR) so existing Codex users get dependency setup for
 * free. `exists` is injectable to keep this testable without a real tree.
 */
export function setupCommandFor(
  repoRoot: string,
  worktreePath: string,
  exists: (p: string) => boolean = existsSync
): string | null {
  const rel = SETUP_SCRIPTS.find((r) => exists(join(repoRoot, r)))
  if (!rel) return null
  const env = [
    `KARBUN_ROOT=${shellQuote(repoRoot)}`,
    `KARBUN_WORKTREE=${shellQuote(worktreePath)}`,
    `CODEX_WORKDIR=${shellQuote(worktreePath)}`
  ].join(' ')
  // Run the copy that came with the worktree checkout, not the main repo's, so
  // a branch that changes its own setup script is honoured.
  return `cd ${shellQuote(worktreePath)} && ${env} sh ${shellQuote(join(worktreePath, rel))}`
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the repo's
 * main checkout. A detached worktree reports no branch and is skipped — there's
 * nothing meaningful to label it with in the picker.
 */
export function parseWorktreeList(stdout: string): WorktreeRef[] {
  const refs: WorktreeRef[] = []
  let path = ''
  let branch = ''
  const flush = (): void => {
    if (path && branch) refs.push({ path, branch, isMain: refs.length === 0 })
    path = ''
    branch = ''
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      // A new record starts; emit the one being accumulated.
      flush()
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()
  return refs
}

/** Every worktree of the repo `cwd` belongs to, main checkout first. */
export async function listWorktrees(cwd: string): Promise<WorktreeRef[]> {
  try {
    return parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']))
  } catch {
    return []
  }
}

/** True when `path` is inside the directory the app owns. Guards destructive ops. */
export function isManagedWorktree(path: string, root: string = worktreesRoot()): boolean {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base)
}

// ---------- Effectful API ----------

export interface WorktreeCreated extends WorktreeInfo {
  path: string
}

/**
 * Create a worktree of `repoRoot` on a new branch, checked out from HEAD.
 * Retries once on a branch-name collision before giving up.
 */
export async function createWorktree(repoRoot: string, branch?: string): Promise<WorktreeCreated> {
  const root = (await git(repoRoot, ['rev-parse', '--show-toplevel'], TIMEOUT)).trim()

  const add = async (name: string): Promise<WorktreeCreated> => {
    const path = worktreePathFor(worktreesRoot(), root, name)
    await mkdir(dirname(path), { recursive: true })
    await git(root, ['worktree', 'add', '-b', name, path, 'HEAD'], TIMEOUT)
    return { path, branch: name, repoRoot: root }
  }

  try {
    return await add(sanitizeBranch(branch ?? '') || defaultBranchName())
  } catch (err) {
    const msg = errText(err)
    // Branch or directory already taken — one retry under a fresh generated name.
    if (!/already exists|already used by worktree|not an empty directory/i.test(msg)) {
      throw new Error(msg)
    }
    try {
      return await add(defaultBranchName())
    } catch (retryErr) {
      throw new Error(errText(retryErr))
    }
  }
}

/**
 * Describe an existing linked worktree so a chat can attach to it. Returns null
 * when `path` is a plain checkout or not a repo at all.
 */
export async function resolveWorktree(path: string): Promise<WorktreeInfo | null> {
  try {
    // One spawn for all three: rev-parse prints a line per query, in order.
    const [dir, common, branch] = (
      await git(path, [
        'rev-parse',
        '--absolute-git-dir',
        '--path-format=absolute',
        '--git-common-dir',
        '--abbrev-ref',
        'HEAD'
      ])
    )
      .split('\n')
      .map((l) => l.trim())
    // In a linked worktree the per-worktree gitdir differs from the shared one;
    // in a normal checkout they're identical.
    if (!common || dir === common) return null
    return { repoRoot: dirname(common), branch }
  } catch {
    return null
  }
}

const DEFAULT_BRANCHES = ['main', 'master']

/**
 * Dirty-file and unmerged-commit counts, used to gate destructive removal.
 * The delete dialog blocks on this, so the independent reads go concurrently
 * and the default branch is probed with one `for-each-ref` instead of a
 * `rev-parse --verify` per candidate.
 */
export async function worktreeStatus(path: string, branch: string): Promise<WorktreeStatus> {
  const [status, heads] = await Promise.all([
    // Unreadable tree — report clean and let the git commands themselves refuse.
    git(path, ['status', '--porcelain']).catch(() => ''),
    // for-each-ref lists only the refs that exist, and exits 0 when none do.
    git(path, [
      'for-each-ref',
      '--format=%(refname:short)',
      ...DEFAULT_BRANCHES.map((b) => `refs/heads/${b}`)
    ]).catch(() => '')
  ])

  const dirtyFiles = status.split('\n').filter((l) => l.trim().length > 0).length
  // for-each-ref sorts by refname, so precedence comes from DEFAULT_BRANCHES.
  const present = heads.split('\n').map((l) => l.trim())
  const def = DEFAULT_BRANCHES.find((b) => present.includes(b))

  const unmergedCommits = def
    ? await git(path, ['rev-list', '--count', branch, '--not', def])
        .then((out) => Number(out.trim()) || 0)
        .catch(() => null)
    : null

  return { dirtyFiles, unmergedCommits }
}

/** Outcome of a hand-off; `cwd` is where the chat should continue. */
export interface HandoffResult {
  ok: boolean
  error?: string
  /** Set once the chat has somewhere to live, even if the checkout then failed. */
  cwd?: string
}

/**
 * Hand a worktree chat back to the main checkout: drop the worktree and check
 * its branch out in `repoRoot`, so work continues in the ordinary clone.
 *
 * Order is forced — git refuses to check out a branch that another worktree
 * holds, so the worktree must go first. That makes the dirty check up front
 * load-bearing: removal would take uncommitted work with it, and unlike a
 * delete there's no "you're destroying this" dialog behind it. The branch is
 * deliberately NOT deleted; checking it out is the whole point.
 */
export async function handOffWorktree(
  worktreePath: string,
  { repoRoot, branch }: WorktreeInfo
): Promise<HandoffResult> {
  if (!isManagedWorktree(worktreePath)) {
    return { ok: false, error: 'This worktree was not created here — remove it yourself first.' }
  }
  const { dirtyFiles } = await worktreeStatus(worktreePath, branch)
  if (dirtyFiles > 0) {
    return {
      ok: false,
      error: `The worktree has ${dirtyFiles} uncommitted file${dirtyFiles === 1 ? '' : 's'}. Commit or discard them before handing off.`
    }
  }

  try {
    await git(repoRoot, ['worktree', 'remove', worktreePath], TIMEOUT)
  } catch (err) {
    // Nothing moved — the chat stays where it is.
    return { ok: false, error: errText(err) }
  }
  try {
    await rmdir(dirname(worktreePath))
  } catch {
    // Other worktrees of this repo remain.
  }

  try {
    await git(repoRoot, ['switch', branch], TIMEOUT)
  } catch (err) {
    // The worktree is already gone, so the chat MUST move or it points at a
    // deleted directory. Report the failed checkout but hand back the root.
    return { ok: false, error: errText(err), cwd: repoRoot }
  }
  return { ok: true, cwd: repoRoot }
}

/**
 * Remove a worktree and its branch. Unforced, git itself refuses to drop a
 * dirty tree or an unmerged branch — that refusal is the safety policy, and its
 * message is handed back for the confirm dialog. Never touches a path outside
 * the app-managed root, so chats attached to a user's own worktree are safe.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  force: boolean
): Promise<OpResult> {
  if (!isManagedWorktree(path)) {
    return { ok: false, error: 'Refusing to remove a worktree the app did not create.' }
  }
  try {
    await git(repoRoot, force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path])
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  try {
    await git(repoRoot, ['branch', force ? '-D' : '-d', branch])
  } catch (err) {
    // The tree is already gone; a surviving branch is recoverable, not fatal.
    return { ok: false, error: errText(err) }
  }
  try {
    // Drop the per-repo parent once its last worktree is gone, so the root
    // doesn't accumulate empty directories. Fails harmlessly when non-empty.
    await rmdir(dirname(path))
  } catch {
    // Other worktrees of this repo remain.
  }
  return { ok: true }
}

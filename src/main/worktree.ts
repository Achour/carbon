import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { OpResult, WorktreeInfo, WorktreeRef, WorktreeStatus } from '@shared/types'
// The .ts extension keeps `node --test` able to load this module directly (see
// codex.ts for the same pattern); git.ts value-imports only node: builtins.
import {
  branchVsDefault,
  currentBranch,
  detectDefaultBranch,
  dirtyFileCount,
  errText,
  git,
  mergeOrAbort,
  uncommitted
} from './git.ts'

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

/**
 * Every worktree of the repo `cwd` belongs to, main checkout first, each tagged
 * with whether its branch is already merged into the default branch — that's
 * what marks a worktree as finished so the picker can offer to clean it up.
 * Merged-ness costs one `branch --merged` for the whole list, not one per
 * worktree, and stays undefined when the repo has no recognizable default.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeRef[]> {
  // The picker blocks on this at open, so the independent reads go together.
  const [refs, def] = await Promise.all([
    git(cwd, ['worktree', 'list', '--porcelain']).then(parseWorktreeList).catch(() => null),
    detectDefaultBranch(cwd)
  ])
  if (!refs) return []
  if (!def) return refs
  const merged = await git(cwd, ['branch', '--merged', def, '--format=%(refname:short)'])
    .then((out) => new Set(out.split('\n').map((l) => l.trim()).filter(Boolean)))
    .catch(() => null)
  if (!merged) return refs
  return refs.map((r) => (r.isMain ? r : { ...r, merged: merged.has(r.branch) }))
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

/**
 * Dirty-file and unmerged-commit counts, used to gate destructive removal.
 * The delete dialog blocks on this, so the independent reads go concurrently.
 */
export async function worktreeStatus(path: string, branch: string): Promise<WorktreeStatus> {
  const [dirtyFiles, vs] = await Promise.all([dirtyFileCount(path), branchVsDefault(path, branch)])
  return { dirtyFiles, unmergedCommits: vs?.ahead ?? null }
}

/** `git worktree remove` plus dropping the per-repo parent dir once empty. */
async function removeWorktreeDir(repoRoot: string, path: string, force: boolean): Promise<void> {
  await git(
    repoRoot,
    force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path],
    TIMEOUT
  )
  // Fails harmlessly while other worktrees of this repo remain.
  await rmdir(dirname(path)).catch(() => {})
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
  const dirty = await dirtyFileCount(worktreePath)
  if (dirty > 0) {
    return {
      ok: false,
      error: uncommitted(dirty, 'The worktree has', 'Commit or discard them before handing off.')
    }
  }

  try {
    await removeWorktreeDir(repoRoot, worktreePath, false)
  } catch (err) {
    // Nothing moved — the chat stays where it is.
    return { ok: false, error: errText(err) }
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
 * Retire a worktree whose work has landed elsewhere — the ending of the pull
 * request path, where the merge happened on the remote and nothing is left to
 * do locally but clean up. The chat moves to `repoRoot`.
 *
 * The branch deletion is allowed to fail without failing the whole operation:
 * a squash-merged PR leaves local commits that git can't see in the default
 * branch, so `branch -d` refuses even though the work is safely merged. The
 * worktree is still gone by then, so the chat must move regardless — reporting
 * a leftover branch is honest, stranding the chat in a deleted directory isn't.
 */
export async function finishWorktree(
  worktreePath: string,
  { repoRoot, branch }: WorktreeInfo
): Promise<HandoffResult> {
  if (!isManagedWorktree(worktreePath)) {
    return { ok: false, error: 'This worktree was not created here — remove it yourself.' }
  }
  const dirty = await dirtyFileCount(worktreePath)
  if (dirty > 0) {
    return {
      ok: false,
      error: uncommitted(dirty, 'The worktree has', 'Removing it would take them with it.')
    }
  }

  const res = await removeWorktree(repoRoot, worktreePath, branch, false)
  if (res.ok) return { ok: true, cwd: repoRoot }
  // Nothing moved — the chat stays where it is.
  if (!res.removed) return { ok: false, error: res.error }
  return {
    ok: false,
    cwd: repoRoot,
    error: `The worktree is gone and this chat moved to the main checkout, but the ${branch} branch is still here:\n\n${res.error}\n\nA squash-merged pull request looks unmerged to git. Delete it with \`git branch -D ${branch}\` once you're sure.`
  }
}

/**
 * Land a worktree's branch: merge it into the default branch in the main
 * checkout, then drop the worktree and the now-merged branch. This is the
 * ending for work that never goes through a pull request, and the only one the
 * app performs itself rather than delegating — the merge has to happen in
 * `repoRoot`, which is outside the agent's cwd (and outside Codex's sandbox).
 *
 * Every guard here exists to keep a beginner's main checkout unharmed: we only
 * merge into a clean main checkout that already has the default branch out, and
 * a conflicting merge is aborted rather than left half-applied for someone to
 * discover. Removal reuses the unforced path, which is safe by construction
 * here — git only deletes a branch it agrees is merged.
 */
export async function mergeWorktree(
  worktreePath: string,
  { repoRoot, branch }: WorktreeInfo
): Promise<HandoffResult> {
  if (!isManagedWorktree(worktreePath)) {
    return { ok: false, error: 'This worktree was not created here — merge it yourself.' }
  }

  // Pure reads with no dependency between them; the guards keep their order.
  const [dirty, vs, onBranch, rootDirty] = await Promise.all([
    dirtyFileCount(worktreePath),
    branchVsDefault(worktreePath, branch),
    currentBranch(repoRoot).catch(() => ''),
    dirtyFileCount(repoRoot)
  ])

  if (dirty > 0) {
    return {
      ok: false,
      error: uncommitted(dirty, 'The worktree has', 'Commit them first — a merge only moves committed work.')
    }
  }
  const def = vs?.defaultBranch
  if (!def) {
    return { ok: false, error: 'No main or master branch to merge into.' }
  }
  if (vs.ahead === 0) {
    return { ok: false, error: `Nothing to merge — ${branch} is already in ${def}.` }
  }
  if (onBranch !== def) {
    return {
      ok: false,
      error: `Your main checkout is on ${onBranch || 'another branch'}, not ${def}. Switch it to ${def} and try again.`
    }
  }
  if (rootDirty > 0) {
    return {
      ok: false,
      error: uncommitted(rootDirty, 'Your main checkout has', 'Commit or stash them so the merge can be undone cleanly if it conflicts.')
    }
  }

  const conflict = await mergeOrAbort(repoRoot, branch)
  if (conflict) {
    return {
      ok: false,
      error: `${conflict}\n\nThe merge was undone. Try "Update from main" in the worktree first — the agent can resolve the conflicts there.`
    }
  }

  const removed = await removeWorktree(repoRoot, worktreePath, branch, false)
  if (removed.ok) return { ok: true, cwd: repoRoot }
  // The merge landed either way, so the work is safe. The chat moves only when
  // the directory is actually gone (a leftover branch), never on a failed remove.
  if (!removed.removed) {
    return { ok: false, error: `Merged into ${def}, but the worktree is still there: ${removed.error}` }
  }
  return {
    ok: false,
    cwd: repoRoot,
    error: `Merged into ${def}, but the ${branch} branch is still here: ${removed.error}`
  }
}

/**
 * Remove a worktree and its branch. Unforced, git itself refuses to drop a
 * dirty tree or an unmerged branch — that refusal is the safety policy, and its
 * message is handed back for the confirm dialog. Never touches a path outside
 * the app-managed root, so chats attached to a user's own worktree are safe.
 * `removed` distinguishes a failed removal (nothing happened) from a surviving
 * branch (the directory is gone — a chat living there has to move).
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  force: boolean
): Promise<OpResult & { removed?: boolean }> {
  if (!isManagedWorktree(path)) {
    return { ok: false, error: 'Refusing to remove a worktree the app did not create.' }
  }
  try {
    await removeWorktreeDir(repoRoot, path, force)
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  try {
    await git(repoRoot, ['branch', force ? '-D' : '-d', branch], TIMEOUT)
  } catch (err) {
    // The tree is already gone; a surviving branch is recoverable, not fatal.
    return { ok: false, removed: true, error: errText(err) }
  }
  return { ok: true, removed: true }
}

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { OpResult, WorktreeInfo, WorktreeRef, WorktreeStatus } from '@shared/types'
// Naming lives in @shared because the picker previews the name this creates —
// two implementations would show one branch and make another.
import { defaultBranchName, sanitizeBranch } from '../shared/branchName.ts'
// The .ts extension keeps `node --test` able to load this module directly (see
// codex.ts for the same pattern); git.ts value-imports only node: builtins.
import {
  branchVsDefault,
  currentBranch,
  detectDefaultBranch,
  dirtyFileCount,
  ensureRootCommit,
  errText,
  git,
  mergeOrAbort,
  uncommitted
} from './git.ts'

/** Worktree commands checkout whole trees, so they get longer than git.ts's default. */
const TIMEOUT = 30_000

// ---------- Pure helpers ----------

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
 * A parsed `worktree list` record. `prunable` stays main-local rather than
 * joining `WorktreeRef` in the shared contract: `listWorktrees` drops those
 * refs, so the flag never crosses IPC and no renderer can read it.
 */
export interface ParsedWorktree extends WorktreeRef {
  /** git reports the worktree's directory as gone. */
  prunable?: boolean
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the repo's
 * main checkout. A detached worktree reports no branch and is skipped — there's
 * nothing meaningful to label it with in the picker.
 */
export function parseWorktreeList(stdout: string): ParsedWorktree[] {
  const refs: ParsedWorktree[] = []
  let path = ''
  let branch = ''
  let prunable = false
  const flush = (): void => {
    if (path && branch) {
      const ref: ParsedWorktree = { path, branch, isMain: refs.length === 0 }
      // Set only when true: absent is the normal case, and the field reads as a
      // marker rather than a state every record carries.
      if (prunable) ref.prunable = true
      refs.push(ref)
    }
    path = ''
    branch = ''
    prunable = false
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      // A new record starts; emit the one being accumulated.
      flush()
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line.startsWith('prunable')) {
      // git appends the reason ("gitdir file points to non-existent location"),
      // which is why this is a prefix test and not an equality one.
      prunable = true
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
 *
 * Worktrees whose directory is gone are dropped rather than listed: git keeps
 * reporting one until something prunes it, and offering it would start a chat
 * in a directory that isn't there. Deleting a worktree outside the app is the
 * only way to reach that state, and nothing else notices it.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeRef[]> {
  // The picker blocks on this at open, so the independent reads go together.
  const [all, def] = await Promise.all([
    git(cwd, ['worktree', 'list', '--porcelain']).then(parseWorktreeList).catch(() => null),
    detectDefaultBranch(cwd)
  ])
  if (!all) return []

  // Clearing the metadata behind a vanished worktree is only ours to do when
  // every stale entry is one we made. `~/.karbun/worktrees` lives under $HOME
  // and is always mounted, so missing there means gone for good; someone else's
  // worktree on an unplugged disk is merely absent, and pruning it would
  // destroy the record they need to plug the disk back in. `prune` takes no
  // path filter, so it is all of them or none. Either way the stale refs are
  // filtered out — the fix the picker actually needs doesn't depend on it.
  const stale = all.filter((w) => w.prunable)
  if (stale.length > 0 && stale.every((w) => isManagedWorktree(w.path))) {
    await git(cwd, ['worktree', 'prune'], TIMEOUT).catch(() => {})
  }
  const refs = all.filter((w) => !w.prunable)

  if (!def) return refs
  const merged = await git(cwd, ['branch', '--merged', def, '--format=%(refname:short)'])
    .then((out) => new Set(out.split('\n').map((l) => l.trim()).filter(Boolean)))
    .catch(() => null)
  if (!merged) return refs
  return refs.map((r) => (r.isMain ? r : { ...r, merged: merged.has(r.branch) }))
}

/**
 * True when `path` is inside the directory the app owns. Guards destructive ops.
 *
 * Compared on **realpaths**, because git reports one: `git worktree list` echoes
 * back the resolved path, not the path `worktree add` was handed, so a single
 * symlink anywhere above the root makes every literal comparison false. The root
 * is the side that moves — `$TMPDIR` on a mac is `/var/folders/…`, a symlink to
 * `/private/var/folders/…` — and the failure is silent: stale metadata simply
 * stops being pruned, and the guard stops recognising worktrees the app made.
 *
 * Resolution can fail on either side and must not throw: the caller's whole
 * reason for asking is often that `path` was deleted behind the app's back, and
 * the root may not exist until the first worktree is created. Both fall back to
 * the literal string, and the unresolved root is still checked, so a path that
 * was already relative to it matches whether or not it can be resolved.
 */
export function isManagedWorktree(path: string, root: string = worktreesRoot()): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const under = (dir: string): boolean =>
    path.startsWith(dir.endsWith('/') ? dir : `${dir}/`) ||
    real(path).startsWith(dir.endsWith('/') ? dir : `${dir}/`)
  return under(root) || under(real(root))
}

// ---------- Effectful API ----------

export interface WorktreeCreated extends WorktreeInfo {
  path: string
}

/** Branch name or directory already taken — the one error a retry can answer. */
const COLLISION = /already exists|already used by worktree|not an empty directory/i

/**
 * Add a worktree of `root` at this branch's deterministic location. `fresh`
 * picks the git command: `-b` creates the branch off HEAD, its absence checks
 * out one that already exists.
 */
async function addWorktree(
  root: string,
  branch: string,
  fresh: boolean
): Promise<WorktreeCreated> {
  const path = worktreePathFor(worktreesRoot(), root, branch)
  const args = fresh
    ? ['worktree', 'add', '-b', branch, path, 'HEAD']
    : ['worktree', 'add', path, branch]
  try {
    await mkdir(dirname(path), { recursive: true })
    await git(root, args, TIMEOUT)
  } catch (err) {
    // Normalized once, here, so every caller's failure is git's own stderr and
    // none of them has to re-wrap it on the way out.
    throw new Error(errText(err))
  }
  return { path, branch, repoRoot: root }
}

/**
 * The main checkout's root, plus the base commit a worktree needs to exist.
 *
 * Read off the *common* git dir rather than `--show-toplevel`: inside a linked
 * worktree the toplevel is that worktree, and a worktree made from there was
 * rooted in it — nested under a directory named after the worktree, recorded
 * in recents as a project of its own, and stranded the moment its "root" was
 * handed off or removed, since every exit then ran git in a directory that no
 * longer existed. The common dir is the one place that is the same from every
 * worktree of a repo, which is exactly what `resolveWorktree` already relies on.
 */
async function worktreeBase(repoRoot: string): Promise<string> {
  const common = (
    await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], TIMEOUT)
  ).trim()
  const root = dirname(common)
  try {
    await ensureRootCommit(root)
  } catch (err) {
    // Reached only when git cannot write a commit at all — in practice an
    // unconfigured identity, whose own message names the fix.
    throw new Error(`This project has no commits yet, and one could not be made:\n${errText(err)}`)
  }
  return root
}

/**
 * Create a worktree of `repoRoot` on a new branch, checked out from HEAD.
 *
 * A worktree branches from a commit, so a repo that has none gets one first
 * (`ensureRootCommit`) rather than the raw "invalid reference: HEAD" a freshly
 * initialized project used to hit here.
 *
 * The collision retry is deliberately limited to *generated* names, which
 * collide only by chance and mean nothing to anyone. Retrying a name the user
 * typed would answer "create `fix-login`" with a worktree on
 * `karbun/aug24-k3xq` and no indication anything went sideways — a rename is a
 * worse answer than the error it hides.
 */
export async function createWorktree(repoRoot: string, branch?: string): Promise<WorktreeCreated> {
  const root = await worktreeBase(repoRoot)
  const named = sanitizeBranch(branch ?? '')
  try {
    return await addWorktree(root, named || defaultBranchName(), true)
  } catch (err) {
    if (named || !COLLISION.test((err as Error).message)) throw err
    return addWorktree(root, defaultBranchName(), true)
  }
}

/**
 * Check an existing branch out into a worktree of its own — the picker's
 * "start on a branch that's already here".
 *
 * No retry and no fallback name: the branch is the whole point of the request,
 * so git's refusal (another worktree holds it, the directory is occupied) is
 * the answer. `worktreeBase` still runs, since a repo can have a branch ref and
 * an unborn HEAD in the checkout the request came from.
 */
export async function checkoutWorktree(
  repoRoot: string,
  branch: string
): Promise<WorktreeCreated> {
  return addWorktree(await worktreeBase(repoRoot), branch, false)
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
  if (vs.ahead === null) {
    // rev-list failed, so nothing is known about what the merge would bring in.
    return { ok: false, error: `Couldn't compare ${branch} with ${def}. Is ${branch} still a branch?` }
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

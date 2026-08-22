import type { GitHubState, GitStatus } from '@shared/types'

/**
 * The git/GitHub "next step" ladder behind the source-control split button.
 * Each id is one rung; `resolveGitActions` reads the repo state and picks the
 * primary (single-click) rung plus the fuller ladder shown in the dropdown.
 * All rungs are agent-delegated except `push` (mechanical). Pure & dependency-
 * free so it can be unit-tested with `node --test`.
 */
export type GitActionId =
  | 'branch-commit'
  | 'branch-commit-push-pr'
  | 'commit-push'
  | 'commit-push-pr'
  | 'commit'
  | 'push'
  | 'pull'
  | 'create-pr'
  | 'publish-github'
  | 'sync-cleanup'
  | 'update-from-main'

export interface GitAction {
  id: GitActionId
  label: string
}

const LABELS: Record<GitActionId, string> = {
  'branch-commit': 'Create Branch & Commit',
  'branch-commit-push-pr': 'Create Branch, Commit, Push & Open PR',
  'commit-push': 'Commit & Push',
  'commit-push-pr': 'Commit, Push & Open PR',
  commit: 'Commit',
  push: 'Push',
  pull: 'Pull',
  'create-pr': 'Create Pull Request',
  'publish-github': 'Publish repository',
  'sync-cleanup': 'Sync & delete branch',
  'update-from-main': 'Update from main'
}

export function gitAction(id: GitActionId): GitAction {
  return { id, label: LABELS[id] }
}

const DEFAULT_BRANCH_NAMES = new Set(['main', 'master'])

/** True when `branch` is the repo's protected default we shouldn't commit onto. */
export function isDefaultBranch(branch: string, defaultBranch?: string): boolean {
  if (defaultBranch) return branch === defaultBranch
  return DEFAULT_BRANCH_NAMES.has(branch)
}

export interface GitActionSet {
  /** The primary (single-click) action, or null when there's nothing to do. */
  primary: GitAction | null
  /** Escalation ladder for the dropdown (never repeats `primary`). */
  rungs: GitAction[]
}

function set(primary: GitActionId | null, rungs: GitActionId[]): GitActionSet {
  return { primary: primary ? gitAction(primary) : null, rungs: rungs.map(gitAction) }
}

/**
 * Maps the current git + GitHub state to the source-control button's primary
 * action and dropdown ladder. `github` may be null (still loading / gh absent),
 * in which case only local actions are offered and it upgrades once gh reports.
 * `opts.worktree` marks a chat running in a linked worktree, where one rung is
 * physically impossible — see `sync-cleanup` below.
 */
export function resolveGitActions(
  git: GitStatus | null,
  github: GitHubState | null,
  opts: { worktree?: boolean } = {}
): GitActionSet {
  if (!git || !git.isRepo) return set(null, [])

  const dirty = git.changes.length > 0
  const canPr = !!github?.repo // gh recognizes this as a GitHub repo
  const onDefault = isDefaultBranch(git.branch, github?.defaultBranch)
  const hasPr = !!github?.pr

  // No remote at all → publish the whole project to GitHub.
  //
  // Offered whether or not gh is installed and logged in, unlike every other
  // GitHub rung: this one opens a dialog, and that dialog's first step is where
  // a missing binary or login is explained. Hiding it until gh was ready left
  // the state with no affordance at all — a project with nowhere to push looked
  // exactly like one with nothing to do, and nothing on screen said why.
  if (!git.hasRemote) return set('publish-github', dirty ? ['commit'] : [])

  // The branch's PR has merged → close the loop. `sync-cleanup` switches to the
  // default branch, which git refuses inside a worktree ("already used by
  // worktree at …") because the main checkout holds it. There the cleanup is
  // removing the worktree itself, which is an environment action in the chat's
  // ⋯ menu rather than a rung here.
  if (github?.pr?.state === 'MERGED') {
    if (opts.worktree) return set(dirty ? 'commit-push' : null, [])
    return set('sync-cleanup', dirty ? ['commit-push'] : [])
  }

  if (dirty) {
    if (onDefault) {
      // Never commit straight onto the default branch: branch off first.
      return set('branch-commit', canPr ? ['branch-commit-push-pr', 'commit-push', 'commit'] : ['commit-push', 'commit'])
    }
    // On a feature branch: commit and publish it.
    if (canPr && !hasPr) return set('commit-push', ['commit-push-pr', 'commit', 'push'])
    return set('commit-push', ['commit', 'push'])
  }

  // Clean working tree.
  if (git.behind > 0) {
    // The remote has commits we don't (only known after a fetch) → pull first.
    // If we're also ahead, offer push as the follow-up rung.
    return set('pull', git.ahead > 0 ? ['push'] : [])
  }
  // A PR only makes sense off the default branch.
  const prRung = canPr && !hasPr && !onDefault
  if (git.ahead > 0) {
    // Committed but not pushed.
    return set('push', prRung && git.hasUpstream ? ['create-pr'] : [])
  }
  if (!git.hasUpstream && !onDefault) {
    // A feature branch with commits but no upstream (ahead is unknown without
    // one) → publishing it is the sensible next step.
    return set('push', [])
  }
  if (git.hasUpstream && prRung) {
    // Pushed and in sync, but no PR yet.
    return set('create-pr', [])
  }
  // Clean, in sync, and either a PR is open (the card shows it) or nothing to do.
  return set(null, [])
}

// ---- Agent prompts (one per delegated rung) ----

/**
 * Builds the chat prompt handed to the agent for a delegated action. `push` is
 * executed directly (no prompt) so it isn't handled here.
 */
export function gitActionPrompt(id: GitActionId, opts: { commitScope: string }): string {
  const commit = `${opts.commitScope} with a clear one-line commit message.`
  const noExtras =
    'Do not run tests, review diffs, or change any code beyond what is described here.'
  const branch =
    'Create and check out a new branch off the current one, named concisely from the change (e.g. `claude/<short-slug>`).'
  const openPr =
    "Then open a GitHub pull request with `gh pr create` targeting the repository's default branch, with a clear title and a concise body summarizing the change. Print the PR URL."

  switch (id) {
    case 'commit':
      return `${commit} ${noExtras}`
    case 'branch-commit':
      return `${branch} Then ${commit} ${noExtras} Report the branch name and the commit.`
    case 'commit-push':
      return `${commit} Then push the branch, setting the upstream if it isn't published yet (\`git push -u origin HEAD\`). ${noExtras}`
    case 'commit-push-pr':
      return `${commit} Push the branch (set the upstream if needed). ${openPr} ${noExtras}`
    case 'branch-commit-push-pr':
      return `${branch} Then ${commit} Push it with upstream (\`git push -u origin HEAD\`). ${openPr} ${noExtras}`
    case 'create-pr':
      return `Open a GitHub pull request for the current branch with \`gh pr create\`, targeting the repository's default branch, with a clear title and a concise body summarizing the changes. Push the branch first if it isn't published yet. ${noExtras} Print the PR URL.`
    case 'sync-cleanup':
      return `The pull request for this branch has been merged. Switch to the repository's default branch, pull the latest, and delete the now-merged local branch. ${noExtras} Report what you did.`
    case 'update-from-main':
      // Delegated rather than executed directly precisely because of conflicts:
      // the whole value of updating early is having someone resolve them here,
      // in a scratch branch, instead of at merge time.
      return `Bring this branch up to date with the repository's default branch (main or master). Fetch first, then merge the default branch into this one — the remote-tracking copy (\`origin/<default>\`) if there is a remote, the local branch otherwise. If the merge conflicts, resolve each conflict carefully, preserving the intent of both sides, and complete the merge. Do not make any other changes and do not commit unrelated work. Report what came in and how you resolved anything that conflicted.`
    case 'push':
    case 'pull':
    case 'publish-github':
      // Executed by the app, not via the agent. Publishing used to be delegated
      // — the agent was told to invent a repository name, pick a visibility and
      // run `gh repo create` — which is three decisions that are the user's to
      // make, taken silently. It opens the publish dialog now.
      return ''
  }
}

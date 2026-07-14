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
  'publish-github': 'Publish to GitHub',
  'sync-cleanup': 'Sync & delete branch'
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
 */
export function resolveGitActions(
  git: GitStatus | null,
  github: GitHubState | null
): GitActionSet {
  if (!git || !git.isRepo) return set(null, [])

  const dirty = git.changes.length > 0
  const canPr = !!github?.repo // gh recognizes this as a GitHub repo
  const onDefault = isDefaultBranch(git.branch, github?.defaultBranch)
  const hasPr = !!github?.pr

  // No remote at all → publish the whole project to GitHub (needs gh login).
  if (!git.hasRemote) {
    if (github?.authed) return set('publish-github', dirty ? ['commit'] : [])
    // gh unusable here: only a local commit is possible.
    return set(dirty ? 'commit' : null, [])
  }

  // The branch's PR has merged → close the loop.
  if (github?.pr?.state === 'MERGED') {
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
    case 'publish-github':
      return `Publish this project to GitHub. If there are no commits yet, stage all files and make an initial commit with a clear message. Then create a new PRIVATE GitHub repository from this directory and push to it (\`gh repo create <folder-name> --source . --private --push\`). ${noExtras} Print the repository URL.`
    case 'sync-cleanup':
      return `The pull request for this branch has been merged. Switch to the repository's default branch, pull the latest, and delete the now-merged local branch. ${noExtras} Report what you did.`
    case 'push':
    case 'pull':
      // Executed directly by the store, not via the agent.
      return ''
  }
}

import { homedir } from 'node:os'
import type {
  GitResult,
  PullCheck,
  PullCheckoutResult,
  PullCheckState,
  PullDetail,
  PullEdit,
  PullListResult,
  PullMergeMethod,
  PullReviewer,
  PullRole,
  PullSummary,
  WorktreeTarget
} from '@shared/types'
// The .ts extensions keep `node --test` able to load this module directly: the
// parsers below are pinned by test/pulls.test.ts.
import { classify, errText, gh, summarizeChecks } from './github.ts'
import { git } from './git.ts'
import { parseRemoteUrl } from './projects.ts'
import { listWorktrees } from './worktree.ts'

/**
 * The Pull requests page. Everything goes through `gh`, like the rest of the
 * GitHub layer: it already holds the user's login, and it answers for every
 * repository at once — which is the point of this page, since the PRs worth
 * seeing are rarely all in the project that happens to be open.
 *
 * The list is GraphQL rather than `gh search prs` because search's JSON has no
 * diff size and no check state, and the rows draw both; one query per role
 * answers the whole list in two round trips instead of one per PR.
 */

// gh runs from the home directory for everything that is not about a checkout:
// `-R` / the GraphQL variables name the repository, and a cwd inside some other
// repo would only let gh guess at a default it never needs.
const HOME = homedir()

const ROW_FIELDS = `
  number title url updatedAt state isDraft additions deletions
  headRefName baseRefName reviewDecision
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`

const LIST_QUERY = `query {
  authored: search(query: "is:pr is:open archived:false author:@me sort:updated-desc", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${ROW_FIELDS} } }
  }
  reviewing: search(query: "is:pr is:open archived:false review-requested:@me sort:updated-desc", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${ROW_FIELDS} } }
  }
  viewer { login }
}`

interface RawRow {
  number?: number
  title?: string
  url?: string
  updatedAt?: string
  state?: string
  isDraft?: boolean
  additions?: number
  deletions?: number
  headRefName?: string
  baseRefName?: string
  reviewDecision?: string | null
  repository?: { nameWithOwner?: string } | null
  author?: { login?: string; avatarUrl?: string } | null
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] } | null
}

const DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])

/** GitHub's rollup `state` (EXPECTED, ERROR, …) folded to the three a row draws. */
export function rollupState(state: string | undefined): PullCheckState {
  const s = (state ?? '').toUpperCase()
  if (!s) return ''
  if (s === 'SUCCESS') return 'SUCCESS'
  if (s === 'FAILURE' || s === 'ERROR') return 'FAILURE'
  return 'PENDING'
}

/** One search node to a row; null for anything that is not a PR we can name. */
export function parseRow(raw: RawRow, role: PullRole): PullSummary | null {
  const repo = raw.repository?.nameWithOwner
  if (!repo || typeof raw.number !== 'number') return null
  const state = (raw.state ?? '').toUpperCase()
  const decision = (raw.reviewDecision ?? '').toUpperCase()
  return {
    repo,
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? `https://github.com/${repo}/pull/${raw.number}`,
    updatedAt: raw.updatedAt ?? '',
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    isDraft: !!raw.isDraft,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    headRef: raw.headRefName ?? '',
    baseRef: raw.baseRefName ?? '',
    // A deleted account comes back as a null author — GitHub's own "ghost".
    author: raw.author?.login ?? 'ghost',
    authorAvatar: raw.author?.avatarUrl,
    checks: rollupState(raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    reviewDecision: DECISIONS.has(decision) ? (decision as PullSummary['reviewDecision']) : '',
    roles: [role]
  }
}

/**
 * Both searches into one list. A PR you authored *and* were asked to review
 * (a teammate re-requested you on your own PR, or a bot did) is one row with
 * both roles, never two rows.
 */
export function mergeRows(authored: RawRow[], reviewing: RawRow[]): PullSummary[] {
  const byKey = new Map<string, PullSummary>()
  const add = (nodes: RawRow[], role: PullRole): void => {
    for (const node of nodes) {
      const row = parseRow(node, role)
      if (!row) continue
      const key = `${row.repo}#${row.number}`
      const seen = byKey.get(key)
      if (seen) {
        if (!seen.roles.includes(role)) seen.roles.push(role)
      } else byKey.set(key, row)
    }
  }
  add(authored, 'authored')
  add(reviewing, 'reviewing')
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string }).code === 'ENOENT'
}

export async function listPulls(): Promise<PullListResult> {
  let out: string
  try {
    out = await gh(HOME, ['api', 'graphql', '-f', `query=${LIST_QUERY}`], 30_000)
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: false, reason: 'missing', error: 'The GitHub CLI (gh) is not installed.' }
    }
    const text = errText(err)
    // gh's own wording for both "never logged in" and "token revoked".
    if (/gh auth login|not logged in|authentication|401/i.test(text)) {
      return { ok: false, reason: 'auth', error: text }
    }
    return { ok: false, reason: 'error', error: text }
  }
  try {
    const j = JSON.parse(out) as {
      data?: {
        authored?: { nodes?: RawRow[] }
        reviewing?: { nodes?: RawRow[] }
        viewer?: { login?: string }
      }
    }
    return {
      ok: true,
      login: j.data?.viewer?.login ?? '',
      pulls: mergeRows(j.data?.authored?.nodes ?? [], j.data?.reviewing?.nodes ?? [])
    }
  } catch {
    return { ok: false, reason: 'error', error: 'GitHub answered with something that is not JSON.' }
  }
}

// ---- Detail ----

const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    pullRequest(number: $number) {
      ${ROW_FIELDS}
      body createdAt changedFiles isCrossRepository mergeable mergeStateStatus viewerCanUpdate
      comments { totalCount }
      reviewThreads { totalCount }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { name } ... on Bot { login avatarUrl } } }
      }
      latestReviews(first: 30) { nodes { state author { login avatarUrl } } }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`

interface RawContext {
  __typename?: string
  name?: string
  status?: string
  conclusion?: string
  detailsUrl?: string
  context?: string
  state?: string
  targetUrl?: string
}

interface RawDetail extends RawRow {
  body?: string
  createdAt?: string
  changedFiles?: number
  isCrossRepository?: boolean
  mergeable?: string
  mergeStateStatus?: string
  viewerCanUpdate?: boolean
  comments?: { totalCount?: number }
  reviewThreads?: { totalCount?: number }
  reviewRequests?: {
    nodes?: { requestedReviewer?: { login?: string; name?: string; avatarUrl?: string } | null }[]
  }
  latestReviews?: {
    nodes?: { state?: string; author?: { login?: string; avatarUrl?: string } | null }[]
  }
  checks?: {
    nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: RawContext[] } } | null } }[]
  }
}

interface RawRepo {
  mergeCommitAllowed?: boolean
  squashMergeAllowed?: boolean
  rebaseMergeAllowed?: boolean
  viewerDefaultMergeMethod?: string
  pullRequest?: RawDetail | null
}

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])

/**
 * Reviewers as one list: whoever has reviewed, with their latest verdict, then
 * whoever is still asked. Someone re-requested after reviewing shows as
 * requested — that is the state the PR is actually waiting on.
 */
export function parseReviewers(raw: RawDetail): PullReviewer[] {
  const out = new Map<string, PullReviewer>()
  for (const r of raw.latestReviews?.nodes ?? []) {
    const login = r.author?.login
    const state = (r.state ?? '').toUpperCase()
    if (!login || !REVIEW_STATES.has(state)) continue
    out.set(login, { login, avatar: r.author?.avatarUrl, state: state as PullReviewer['state'] })
  }
  for (const n of raw.reviewRequests?.nodes ?? []) {
    const who = n.requestedReviewer
    const login = who?.login ?? who?.name
    if (!login) continue
    out.set(login, { login, avatar: who?.avatarUrl, state: 'REQUESTED' })
  }
  return [...out.values()]
}

export function parseChecks(contexts: RawContext[]): PullCheck[] {
  return contexts.map((c) => ({
    name: c.name ?? c.context ?? 'check',
    state: classify({ status: c.status, conclusion: c.conclusion, state: c.state }),
    url: c.detailsUrl ?? c.targetUrl ?? undefined
  }))
}

/** Allowed methods, the viewer's default first so the Merge button leads with it. */
export function mergeMethods(repo: RawRepo): PullMergeMethod[] {
  const allowed: PullMergeMethod[] = []
  if (repo.mergeCommitAllowed !== false) allowed.push('merge')
  if (repo.squashMergeAllowed !== false) allowed.push('squash')
  if (repo.rebaseMergeAllowed !== false) allowed.push('rebase')
  const preferred = (repo.viewerDefaultMergeMethod ?? '').toLowerCase() as PullMergeMethod
  const i = allowed.indexOf(preferred)
  if (i > 0) allowed.unshift(...allowed.splice(i, 1))
  return allowed
}

function splitRepo(repo: string): { owner: string; name: string } | null {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo)
  return m ? { owner: m[1], name: m[2] } : null
}

export async function pullDetail(
  repo: string,
  number: number
): Promise<PullDetail | { error: string }> {
  const parts = splitRepo(repo)
  if (!parts) return { error: `Not a repository: ${repo}` }
  let out: string
  try {
    out = await gh(
      HOME,
      [
        'api',
        'graphql',
        '-F',
        `owner=${parts.owner}`,
        '-F',
        `name=${parts.name}`,
        '-F',
        `number=${number}`,
        '-f',
        `query=${DETAIL_QUERY}`
      ],
      30_000
    )
  } catch (err) {
    return { error: errText(err) }
  }
  let repoNode: RawRepo | undefined
  try {
    repoNode = (JSON.parse(out) as { data?: { repository?: RawRepo } }).data?.repository
  } catch {
    return { error: 'GitHub answered with something that is not JSON.' }
  }
  const pr = repoNode?.pullRequest
  const row = pr ? parseRow(pr, 'authored') : null
  if (!repoNode || !pr || !row) return { error: `${repo}#${number} was not found.` }
  const contexts = pr.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const mergeable = (pr.mergeable ?? '').toUpperCase()
  return {
    ...row,
    // Roles are the list's business; the detail is fetched per PR and knows
    // nothing about why it is being looked at.
    roles: [],
    body: pr.body ?? '',
    createdAt: pr.createdAt ?? '',
    changedFiles: pr.changedFiles ?? 0,
    isCrossRepository: !!pr.isCrossRepository,
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    mergeState: (pr.mergeStateStatus ?? '').toUpperCase(),
    reviewers: parseReviewers(pr),
    comments: (pr.comments?.totalCount ?? 0) + (pr.reviewThreads?.totalCount ?? 0),
    checkRuns: parseChecks(contexts),
    checkSummary: summarizeChecks(contexts),
    mergeMethods: mergeMethods(repoNode),
    canUpdate: !!pr.viewerCanUpdate
  }
}

export async function pullDiff(repo: string, number: number): Promise<GitResult> {
  try {
    // A large PR's diff runs to megabytes — the default 10 MB buffer is the
    // ceiling this is allowed to hit, and a minute is generous for a download.
    return { ok: true, output: await gh(HOME, ['pr', 'diff', String(number), '-R', repo], 60_000) }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

/**
 * Merge on GitHub. Deliberately without `--delete-branch`: gh would also try to
 * delete the *local* branch and check out the base in whatever checkout it
 * finds, and a worktree chat may be sitting on that branch right now.
 */
export async function pullMerge(
  repo: string,
  number: number,
  method: PullMergeMethod
): Promise<GitResult> {
  try {
    await gh(HOME, ['pr', 'merge', String(number), '-R', repo, `--${method}`], 60_000)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

export async function pullEdit(repo: string, number: number, edit: PullEdit): Promise<GitResult> {
  const id = String(number)
  try {
    if (edit.ready === true) await gh(HOME, ['pr', 'ready', id, '-R', repo])
    else if (edit.ready === false) await gh(HOME, ['pr', 'ready', id, '-R', repo, '--undo'])
    const args: string[] = []
    if (edit.title !== undefined) args.push('--title', edit.title)
    if (edit.body !== undefined) args.push('--body', edit.body)
    if (edit.addReviewer) args.push('--add-reviewer', edit.addReviewer)
    if (args.length) await gh(HOME, ['pr', 'edit', id, '-R', repo, ...args], 30_000)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

// ---- Local checkouts ----

/** `owner/repo`, lowercased — GitHub names are case-insensitive, remotes are not. */
function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase()
}

/**
 * Which local projects hold which GitHub repositories, keyed `owner/repo`
 * (lowercase). Every remote counts, not only `origin`: a fork's checkout has
 * the PR's repository as `upstream`, and that is exactly the checkout a chat
 * about the PR belongs in. A repo held by several projects keeps the first.
 */
export async function pullProjects(roots: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const found = await Promise.all(
    [...new Set(roots)].map(async (root) => {
      const text = await git(root, ['remote', '-v'], 5_000).catch(() => '')
      const keys = new Set<string>()
      for (const line of text.split('\n')) {
        const url = line.split(/\s+/)[1]
        const remote = url ? parseRemoteUrl(url) : null
        if (remote && remote.host.includes('github')) keys.add(repoKey(remote.owner, remote.repo))
      }
      return { root, keys }
    })
  )
  for (const { root, keys } of found) for (const k of keys) out[k] ??= root
  return out
}

/** The name of the remote in `root` that points at `repo`, if any. */
async function remoteFor(root: string, repo: string): Promise<string | null> {
  const text = await git(root, ['remote', '-v'], 5_000).catch(() => '')
  const want = repo.toLowerCase()
  for (const line of text.split('\n')) {
    const [name, url] = line.split(/\s+/)
    const remote = url ? parseRemoteUrl(url) : null
    if (name && remote && repoKey(remote.owner, remote.repo) === want) return name
  }
  return null
}

/**
 * Make the PR's head branch available in `root` and answer with where a chat
 * about it should run.
 *
 * If the branch is already checked out — the main checkout or a worktree — the
 * chat goes there, since git refuses a second checkout of one branch and the
 * work in progress is in that tree anyway. Otherwise the head is fetched
 * through `refs/pull/N/head`, which exists on the base repository for every PR,
 * fork or not, and the chat gets a worktree of its own on that branch. An
 * existing local branch is fast-forwarded only when that is all it takes; a
 * branch with local commits the PR does not have is left exactly as it is.
 */
export async function pullCheckout(
  root: string,
  repo: string,
  number: number,
  headRef: string
): Promise<PullCheckoutResult> {
  if (!headRef) return { ok: false, error: 'The pull request names no branch.' }
  const remote = await remoteFor(root, repo)
  if (!remote) return { ok: false, error: `${root} has no remote for ${repo}.` }

  const trees = await listWorktrees(root).catch(() => [])
  const holder = trees.find((w) => w.branch === headRef)
  if (holder) {
    const target: WorktreeTarget = holder.isMain
      ? { kind: 'local' }
      : { kind: 'existing', path: holder.path, branch: headRef, repoRoot: root }
    return { ok: true, root, target }
  }

  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${headRef}`])
    .then(() => true)
    .catch(() => false)
  try {
    if (!exists) {
      await git(root, ['fetch', remote, `pull/${number}/head:${headRef}`], 120_000)
    } else {
      // Fetch into FETCH_HEAD and fast-forward only when the local branch is an
      // ancestor of it. A refusal here is not an error — the branch just has
      // its own history, and the chat should see that history.
      await git(root, ['fetch', remote, `pull/${number}/head`], 120_000)
      const behind = await git(root, ['merge-base', '--is-ancestor', headRef, 'FETCH_HEAD'])
        .then(() => true)
        .catch(() => false)
      if (behind) await git(root, ['branch', '-f', headRef, 'FETCH_HEAD'])
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  return { ok: true, root, target: { kind: 'branch', branch: headRef } }
}

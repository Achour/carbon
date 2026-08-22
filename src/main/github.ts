import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  GitHubState,
  GitResult,
  PrChecks,
  PrInfo,
  PublishInfo,
  PublishOpts,
  PublishResult
} from '@shared/types'
// The .ts extension keeps `node --test` able to load this module directly (see
// worktree.ts for the same pattern); git.ts value-imports only node: builtins.
import {
  currentBranch,
  ensureRootCommit,
  errText as gitErrText,
  git,
  hasEmptyTree
} from './git.ts'

const execFileP = promisify(execFile)

// GH_PROMPT_DISABLED stops gh from ever blocking on an interactive prompt (it
// errors fast instead); NO_COLOR / update-notifier keep stdout clean and quick.
const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1'
}

async function gh(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await execFileP('gh', args, {
    cwd,
    env: GH_ENV,
    timeout,
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string }).code === 'ENOENT'
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
  if (e.killed) return 'GitHub CLI timed out — check your network or gh login.'
  const msg = (e.stderr || e.stdout || e.message || 'gh failed').trim()
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg
}

// ---- statusCheckRollup summarization (pure; kept dependency-free for tests) ----

interface RollupEntry {
  // CheckRun: status is QUEUED | IN_PROGRESS | COMPLETED; conclusion is the result.
  status?: string
  conclusion?: string
  // StatusContext: single `state` field.
  state?: string
}

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE'
])

/** Classifies a single rollup entry into pass / fail / pending. */
function classify(entry: RollupEntry): 'pass' | 'fail' | 'pending' {
  // A check run that hasn't completed is pending regardless of conclusion.
  if (entry.status && entry.status !== 'COMPLETED') return 'pending'
  const v = (entry.conclusion || entry.state || '').toUpperCase()
  if (PASS.has(v)) return 'pass'
  if (FAIL.has(v)) return 'fail'
  return 'pending' // PENDING, EXPECTED, '' (queued check runs) all land here
}

/**
 * Rolls a `gh pr view --json statusCheckRollup` array up into pass/fail/pending
 * counts. Returns undefined when the PR has no checks configured.
 */
export function summarizeChecks(rollup: unknown): PrChecks | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined
  let passed = 0
  let failed = 0
  let pending = 0
  for (const entry of rollup as RollupEntry[]) {
    const c = classify(entry)
    if (c === 'pass') passed++
    else if (c === 'fail') failed++
    else pending++
  }
  return { passed, failed, pending, total: rollup.length }
}

interface RawPr {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  reviewDecision?: string
  statusCheckRollup?: unknown
}

const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])

function parsePr(raw: RawPr): PrInfo {
  const decision = (raw.reviewDecision || '').toUpperCase()
  const state = (raw.state || '').toUpperCase()
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    isDraft: !!raw.isDraft,
    reviewDecision: REVIEW_DECISIONS.has(decision)
      ? (decision as PrInfo['reviewDecision'])
      : '',
    checks: summarizeChecks(raw.statusCheckRollup)
  }
}

const PR_FIELDS = 'number,state,url,title,isDraft,reviewDecision,statusCheckRollup'

async function ghAuthed(cwd: string): Promise<boolean> {
  try {
    // `auth token` reads the stored token from config/keyring with NO network
    // round-trip (unlike `auth status`, which validates online and can flake).
    await gh(cwd, ['auth', 'token'], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort GitHub state for a working directory. Never throws: any failure
 * (no gh binary, not logged in, no GitHub remote, offline) collapses to the
 * flags we could determine, with `repo`/`pr` left undefined.
 */
export async function ghState(cwd: string): Promise<GitHubState> {
  // 1. Is gh installed at all?
  try {
    await gh(cwd, ['--version'], 5_000)
  } catch (err) {
    if (isEnoent(err)) return { installed: false, authed: false }
    // A non-ENOENT failure on --version means gh is unusable here; treat as absent.
    return { installed: false, authed: false }
  }

  // 2. Does the cwd map to a GitHub repo? `repo view` also implies auth succeeded.
  let repo: string | undefined
  let defaultBranch: string | undefined
  try {
    const out = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
    const j = JSON.parse(out) as {
      nameWithOwner?: string
      defaultBranchRef?: { name?: string } | null
    }
    repo = j.nameWithOwner
    defaultBranch = j.defaultBranchRef?.name
  } catch {
    // No GitHub remote here, or not authed — distinguish for the caller's hint.
    return { installed: true, authed: await ghAuthed(cwd) }
  }

  // 3. Is there a PR for the current branch?
  let pr: PrInfo | undefined
  try {
    const out = await gh(cwd, ['pr', 'view', '--json', PR_FIELDS])
    pr = parsePr(JSON.parse(out) as RawPr)
  } catch {
    // "no pull requests found" for this branch — leave pr undefined.
  }

  return { installed: true, authed: true, repo, defaultBranch, pr }
}

/**
 * What the publish dialog opens on. Every read is independent and every one of
 * them is allowed to fail alone: an account with no org access still publishes
 * under its login, and a repo whose commits can't be counted is still a repo
 * worth publishing. Losing the whole dialog to any one of them would be the
 * worst possible trade.
 *
 * The two `user` reads are separate because gh has no single endpoint for
 * "everywhere I can create"; the org list is kept only if the login came back,
 * so an unauthenticated answer names no owners rather than half of them.
 * `empty` compares the tip's tree to the empty one
 * rather than counting commits, because after `git init` here there is always
 * exactly one commit — the base `ensureRootCommit` writes — and "one commit" and
 * "nothing committed yet" are the same repo.
 */
export async function ghPublishInfo(cwd: string): Promise<PublishInfo> {
  // All five together, including the org list the login decides to keep: run
  // sequentially it is two gh round-trips deep, which the dialog waits on with
  // its owner field empty.
  const [login, orgs, branch, commits, empty] = await Promise.all([
    gh(cwd, ['api', 'user', '--jq', '.login'], 10_000)
      .then((out) => out.trim())
      .catch(() => ''),
    gh(cwd, ['api', 'user/orgs', '--jq', '.[].login'], 15_000)
      .then((out) => out.split('\n').map((l) => l.trim()).filter(Boolean))
      .catch(() => []),
    currentBranch(cwd).catch(() => ''),
    git(cwd, ['rev-list', '--count', 'HEAD'])
      .then((out) => Number(out.trim()) || 0)
      .catch(() => 0),
    hasEmptyTree(cwd)
  ])
  return { login, orgs: login ? orgs : [], branch, commits, empty }
}

/** First github.com URL in gh's output — it also prints progress lines. */
function repoUrlIn(out: string): string {
  return /https:\/\/github\.com\/[^\s]+/.exec(out)?.[0]?.replace(/[.,]$/, '') ?? ''
}

/**
 * Create the GitHub repository this project should live in, add it as `origin`,
 * and push. The steps are ordered by what is recoverable: everything local
 * happens before the remote exists, so a refusal here leaves nothing to undo,
 * and the push is last because it is the only step whose failure leaves a real
 * repository behind — which is why that one message says so instead of reading
 * like the whole thing failed.
 *
 * `commitAll` is the caller's answer to the one thing a publish cannot decide
 * for itself. Publishing pushes *commits*, so a project whose files have never
 * been committed publishes an empty repository — technically correct and
 * useless. The dialog asks, defaulting to yes exactly when there is nothing but
 * the base commit to push, and this stays a parameter rather than a guess so
 * someone mid-way through staging never has their staging decided for them.
 *
 * The push runs under gh's own credential helper, injected for that one command
 * (`-c credential.helper=` clears the inherited list first, so the answer comes
 * from the account that just created the repo rather than from whichever helper
 * the machine happens to try first). `gh auth login` normally installs that
 * helper globally; someone who skipped that step would otherwise create a
 * repository and immediately fail to push to it, and writing to their global
 * git config to fix that is not ours to do.
 */
export async function publishRepo(cwd: string, opts: PublishOpts): Promise<PublishResult> {
  const name = opts.name.trim()
  const owner = opts.owner.trim()
  if (!name) return { ok: false, error: 'Give the repository a name.' }

  try {
    // A push needs a commit, and a folder that was only just initialized has
    // none — `git push` on an unborn HEAD fails the same way `worktree add` does.
    await ensureRootCommit(cwd)
    if (opts.commitAll) {
      await git(cwd, ['add', '-A'], 60_000)
      // --allow-empty: the tree may have been committed by something else
      // between the dialog opening and Publish, and failing the publish over
      // having nothing left to commit would be a refusal about nothing.
      await git(cwd, ['commit', '--allow-empty', '-m', 'Initial commit'], 60_000)
    }
  } catch (err) {
    return { ok: false, error: gitErrText(err) }
  }

  const args = [
    'repo',
    'create',
    owner ? `${owner}/${name}` : name,
    opts.private ? '--private' : '--public',
    '--source',
    cwd,
    '--remote',
    'origin'
  ]
  const description = opts.description?.trim()
  if (description) args.push('--description', description)

  let url = ''
  try {
    url = repoUrlIn(await gh(cwd, args, 60_000))
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  if (!url) url = `https://github.com/${owner ? `${owner}/` : ''}${name}`

  try {
    const branch = await currentBranch(cwd)
    await git(
      cwd,
      ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-u', 'origin', branch],
      120_000
    )
  } catch (err) {
    return {
      ok: false,
      error: `${url} was created and added as \`origin\`, but the push failed:\n\n${gitErrText(err)}`
    }
  }
  return { ok: true, url }
}

/** Opens the current branch's PR in the system browser. */
export async function openPrWeb(cwd: string): Promise<GitResult> {
  try {
    await gh(cwd, ['pr', 'view', '--web'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

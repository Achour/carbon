import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHubState, GitResult, PrChecks, PrInfo } from '@shared/types'

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

/** Opens the current branch's PR in the system browser. */
export async function openPrWeb(cwd: string): Promise<GitResult> {
  try {
    await gh(cwd, ['pr', 'view', '--web'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

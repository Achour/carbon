export type Provider = 'claude' | 'codex'

export type ServiceTier = 'standard' | 'fast'

export const SERVICE_TIER_OPTIONS: {
  id: ServiceTier
  label: string
  description: string
}[] = [
  { id: 'standard', label: 'Standard', description: 'Standard speed and usage' },
  { id: 'fast', label: 'Fast', description: 'Faster responses with increased usage' }
]

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export type EffortId = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type ClaudeEffortId = Exclude<EffortId, 'minimal' | 'ultra'>
export type CodexEffortId = Exclude<EffortId, 'minimal'>

export const EFFORT_OPTIONS: { id: EffortId | ''; label: string; description: string }[] = [
  { id: '', label: 'Default', description: 'Uses your provider config' },
  { id: 'minimal', label: 'Minimal', description: 'Lowest reasoning, where supported' },
  { id: 'low', label: 'Low', description: 'Fastest, minimal thinking' },
  { id: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { id: 'high', label: 'High', description: 'Deep reasoning' },
  { id: 'xhigh', label: 'X-High', description: 'Deeper than high' },
  { id: 'max', label: 'Max', description: 'Maximum effort, select models' },
  { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic delegation' }
]

/** Prevent a provider-specific effort from leaking across a model/provider switch. */
export function effortForProvider(
  effort: EffortId | undefined,
  provider: 'claude'
): ClaudeEffortId | undefined
export function effortForProvider(
  effort: EffortId | undefined,
  provider: 'codex'
): CodexEffortId | undefined
export function effortForProvider(
  effort: EffortId | undefined,
  provider: Provider
): EffortId | undefined
export function effortForProvider(effort: EffortId | undefined, provider: Provider): EffortId | undefined {
  if (provider === 'codex' && effort === 'minimal') return undefined
  if (provider === 'claude' && (effort === 'minimal' || effort === 'ultra')) return undefined
  return effort
}

export type ChatStatus = 'idle' | 'starting' | 'streaming' | 'waiting-permission'

export interface PersistedPlanReview {
  requestId: string
  plan: string
  userMessageId: string
}

/** A chat running in an isolated git worktree the app created (or attached to). */
export interface WorktreeInfo {
  /** Main checkout root the worktree belongs to. The sidebar groups by this. */
  repoRoot: string
  /** Branch checked out in the worktree. */
  branch: string
}

/**
 * Where a chat runs: the main checkout, a fresh worktree, or one that already
 * exists. Doubles as the picker's UI selection and the `chats:create` payload —
 * `local` simply means "no worktree". Main re-derives `repoRoot` authoritatively
 * from the path, so the extra fields on `existing` are only for the renderer.
 */
export type WorktreeTarget =
  | { kind: 'local' }
  | { kind: 'new' }
  | { kind: 'existing'; path: string; branch: string; repoRoot: string }

/** Pre-removal safety report for a worktree. */
export interface WorktreeStatus {
  /** Files with uncommitted changes (staged + unstaged + untracked). */
  dirtyFiles: number
  /** Commits on the branch not reachable from the default branch; null when unknown. */
  unmergedCommits: number | null
}

/** What to do with the worktree when its chat is deleted. */
export type WorktreeDisposition = 'keep' | 'remove' | 'force'

/** One entry from `git worktree list` — the main checkout or a linked worktree. */
export interface WorktreeRef {
  path: string
  branch: string
  /** True for the repo's main checkout ("Local" in the picker). */
  isMain: boolean
}


export interface ChatMeta {
  id: string
  title: string
  /** True once the user renamed the chat; suppresses the auto-generated title. */
  titleManual?: boolean
  cwd: string
  provider: Provider
  /** Model override; undefined means the user's default model. */
  model?: string
  /** Reasoning effort; undefined means the default (high). */
  effort?: EffortId
  /** Provider processing tier; older chats without this field use Standard. */
  serviceTier?: ServiceTier
  permissionMode: PermissionModeId
  /** Mode the chat was in before switching to plan; restored on plan approval. */
  modeBeforePlan?: PermissionModeId
  /** Codex plan awaiting approval; persisted so review survives an app restart. */
  pendingPlanReview?: PersistedPlanReview
  /** Provider-side session id, used to resume conversations. */
  sessionId?: string
  /** Tokens currently in the model's context (from the last API call). */
  contextTokens?: number
  /** Context window size of the model in use. */
  contextWindow?: number
  /** Present when `cwd` is a git worktree the app manages or attached to. */
  worktree?: WorktreeInfo
  createdAt: number
  updatedAt: number
}

export interface ChatData extends ChatMeta {
  messages: ChatMessage[]
}

/**
 * The project a chat belongs to. A worktree chat lives in its own directory but
 * groups under the project it branched from — the single definition of that
 * rule, so sidebar grouping, search labels and project removal can't drift.
 */
export function projectRoot(chat: Pick<ChatMeta, 'cwd' | 'worktree'>): string {
  return chat.worktree?.repoRoot ?? chat.cwd
}

// ---------- Messages ----------

export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
}

export interface ToolPart {
  type: 'tool'
  toolUseId: string
  name: string
  input?: unknown
  status: ToolStatus
  output?: string
  /** Image blocks a tool returned (e.g. preview_screenshot) — base64, no prefix. */
  outputImages?: { mediaType: string; data: string }[]
  denied?: boolean
  /** Sub-agent activity for Task/Agent tools: the spawned agent's own stream. */
  children?: AssistantPart[]
}

export type AssistantPart = TextPart | ThinkingPart | ToolPart

/** A UI element picked from a live page in the browser-preview panel. */
export interface ElementRef {
  /** Page URL the element was picked from. */
  url: string
  /** Lowercase tag name, e.g. "button". */
  tag: string
  /** CSS selector locating the element on the page. */
  selector: string
  /** Trimmed visible text, if any. */
  label?: string
  /** Truncated outerHTML of the element. */
  html?: string
  /** Source file:line resolved from the React fiber (dev builds only). */
  source?: { file: string; line?: number; column?: number }
}

export interface Attachment {
  id: string
  kind: 'image' | 'file' | 'element'
  name: string
  /** Images (and element screenshots): IANA media type + raw base64 (no data: prefix). */
  mediaType?: string
  data?: string
  /** Files: absolute path on disk, passed to Claude as a reference to read. */
  path?: string
  /** Elements: the picked element's location, markup, and source mapping. */
  element?: ElementRef
}

export interface UserMessage {
  id: string
  role: 'user'
  text: string
  ts: number
  attachments?: Attachment[]
  /**
   * Display label for an app-initiated action message (e.g. a "Commit" from the
   * source-control button). When set, the UI shows a compact chip instead of the
   * verbose prompt `text` — the prompt still goes to the agent, just not the eye.
   */
  label?: string
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  parts: AssistantPart[]
  ts: number
  /** Exact per-turn worktree delta when the provider adapter can snapshot it. */
  fileChanges?: TurnFileChange[]
}

export interface TurnFileChange {
  path: string
  additions: number
  deletions: number
}

export interface TurnStats {
  costUsd: number
  durationMs: number
  numTurns: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

export interface EventMessage {
  id: string
  role: 'event'
  kind: 'error' | 'info' | 'compact' | 'turn'
  text: string
  ts: number
  stats?: TurnStats
}

export type ChatMessage = UserMessage | AssistantMessage | EventMessage

// ---------- Permissions ----------

export interface PermissionRequestPayload {
  id: string
  chatId: string
  toolUseId: string
  toolName: string
  input: unknown
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  /** True when the provider offered "always allow" permission suggestions. */
  hasSuggestions: boolean
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      always?: boolean
      updatedInput?: Record<string, unknown>
      /**
       * Plan approvals only: switch the chat to this model before implementation
       * starts, so a plan written by one model can be built by another. Must stay
       * within the chat's provider (sessions aren't portable across backends).
       * Undefined keeps the model the plan was written with.
       */
      model?: string
      /**
       * Plan approvals only: reasoning effort for the implementation turn.
       * An empty string uses the provider default; undefined keeps the effort
       * used while writing the plan.
       */
      effort?: EffortId | ''
    }
  | { behavior: 'deny'; message?: string }

/** Result of a file-checkpoint rewind (`rewindFiles`). */
export interface RewindResult {
  canRewind: boolean
  error?: string
  /** Repo-relative paths that would change / did change. */
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/** A single persisted permission rule from a settings file. */
export interface PermissionRule {
  /** e.g. "Bash(git push:*)" or "Read". */
  value: string
  behavior: 'allow' | 'deny' | 'ask'
  /** Which settings file it lives in. */
  source: 'user' | 'project' | 'local'
}

export interface UserQuestion {
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

// ---------- Events streamed from main to renderer ----------

/**
 * A background task the SDK is running for a chat (a backgrounded shell command,
 * sub-agent, monitor, or workflow). The SDK reports the full live set on every
 * change (REPLACE semantics); it is per-process, so it resets when a session's
 * CLI process (re)starts.
 */
export interface BackgroundJob {
  id: string
  /** Friendly type: 'shell' | 'subagent' | 'monitor' | 'workflow' | … */
  type: string
  description: string
  /** Defaults to true. False when the provider exposes status but no per-job stop API. */
  stoppable?: boolean
}

/** Generic ok/error result for main-process operations that can fail. */
export type OpResult = { ok: true } | { ok: false; error: string }

// ---------- Session introspection (MCP, models, agents, usage) ----------

/** A tool exposed by an MCP server, from `mcpServerStatus()`. */
export interface McpToolInfo {
  name: string
  description?: string
  readOnly?: boolean
}

/** Live status of one configured MCP server for a session. */
export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  /** Config scope: project | user | local | claudeai | managed. */
  scope?: string
  /** Present when status is 'failed'. */
  error?: string
  tools?: McpToolInfo[]
}

/** A subagent available in the session, from `supportedAgents()`. */
export interface AgentInfo {
  name: string
  description: string
  /** Model alias the agent uses, or undefined when it inherits the parent's. */
  model?: string
}

/** Authenticated account, from `accountInfo()`. */
export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  /** Backend the CLI is authenticated against (firstParty, bedrock, vertex, …). */
  apiProvider?: string
}

/** One plan rate-limit utilization window (5-hour, 7-day, per-model). */
export interface RateLimitWindow {
  /** Human label, e.g. "5-hour", "7-day", "7-day (Opus)". */
  label: string
  /** Percent of the window used, 0–100, or null when unknown. */
  utilization: number | null
  /** ISO 8601 timestamp when the window resets, or null. */
  resetsAt?: string | null
}

/** Structured `/usage` data: session cost + plan rate-limit windows. */
export interface UsageInfo {
  costUsd: number
  linesAdded: number
  linesRemoved: number
  subscriptionType?: string | null
  /** False for API-key / Bedrock / Vertex sessions where plan limits don't apply. */
  rateLimitsAvailable: boolean
  windows: RateLimitWindow[]
}

/**
 * Live rate-limit signal pushed from a `rate_limit_event` mid-session. Surfaced
 * as a warning when approaching or hitting a claude.ai plan limit.
 */
export interface RateLimitState {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** Which window: five_hour | seven_day | seven_day_opus | … */
  rateLimitType?: string
  /** Percent used, 0–100. */
  utilization?: number
  /** Epoch ms when the limiting window resets. */
  resetsAt?: number
}

export type ChatEvent =
  | { type: 'message'; chatId: string; message: ChatMessage }
  | { type: 'part-delta'; chatId: string; messageId: string; partIndex: number; delta: string }
  | { type: 'part'; chatId: string; messageId: string; partIndex: number; part: AssistantPart }
  | { type: 'tool-update'; chatId: string; messageId: string; toolUseId: string; patch: Partial<ToolPart> }
  | { type: 'meta'; chatId: string; patch: Partial<ChatMeta> }
  | { type: 'status'; chatId: string; status: ChatStatus }
  // Another Carbon instance holds this chat's write lock (userData is shared
  // between the dev and packaged builds), so edits here will not be saved.
  | { type: 'chat-locked'; chatId: string }
  | { type: 'permission-request'; chatId: string; request: PermissionRequestPayload }
  | { type: 'permission-resolved'; chatId: string; requestId: string }
  | { type: 'commands'; chatId: string; cwd: string; commands: SlashCommand[] }
  | { type: 'background-jobs'; chatId: string; jobs: BackgroundJob[] }
  | { type: 'rate-limit'; chatId: string; state: RateLimitState }
  // Transient (not persisted): the AI title is being generated for this chat, so
  // the sidebar can shimmer the placeholder until the real title arrives.
  | { type: 'title-pending'; chatId: string; pending: boolean }

// ---------- Settings ----------

export interface AppDefaults {
  model?: string
  effort?: EffortId
  serviceTier?: ServiceTier
  permissionMode: PermissionModeId
  recentDirs: string[]
  /**
   * Last effort chosen *per model*, keyed by model id (`''` for a provider's
   * Default row). Selecting a model restores its remembered effort, so switching
   * back and forth doesn't force the user to re-pick effort each time. `effort`
   * above stays the global fallback for a model with no remembered value yet.
   */
  modelEfforts?: Record<string, EffortId | ''>
}

/** A live change to a chat's inference options. */
export interface ChatOptionsPatch {
  model?: string
  effort?: EffortId | ''
  serviceTier?: ServiceTier
  permissionMode?: PermissionModeId
  /**
   * Whether the change also becomes the default for future chats. Defaults to
   * true, since a change is normally something the user picked. The composer
   * passes `false` when it is *correcting* a value the user never chose — Fast
   * on a model that doesn't support it, or an effort that doesn't exist on the
   * provider just switched to — so an automatic normalization in one chat can't
   * quietly overwrite a real preference everywhere else.
   */
  remember?: boolean
}

export interface ModelOption {
  id: string
  label: string
  description?: string
  provider: Provider
  disabled?: boolean
  /**
   * Canonical wire model id this option resolves to (for example an SDK alias,
   * or the configured model behind a provider's Default row). Lets the picker
   * show the real model while preserving the provider-default selection.
   */
  resolvedModel?: string
  /** Context window in tokens, when known — feeds the composer's context ring. */
  contextWindow?: number
  /** Reasoning levels advertised by this exact model, when known. */
  supportedEfforts?: EffortId[]
  /** Whether this model advertises provider Fast mode; undefined means unknown. */
  supportsFastMode?: boolean
}

const canonicalModelName = (model?: string): string =>
  (model ?? '').replace(/\[1m\]$/i, '')

/**
 * Resolve a stored model id to the picker row that covers it. Older chats can
 * carry a resolved wire id while the live SDK list exposes an alias.
 */
export function canonicalModelId(model: string, options: ModelOption[]): string {
  if (options.some((option) => option.id === model)) return model
  const match = options.find(
    (option) =>
      option.id !== '' &&
      (canonicalModelName(option.id) === canonicalModelName(model) ||
        canonicalModelName(option.resolvedModel) === canonicalModelName(model))
  )
  return match ? match.id : model
}

/**
 * Read a per-model effort through the same alias/wire-id equivalence used by
 * the model picker. A direct entry wins when both old and canonical keys exist.
 */
export function rememberedEffortForModel(
  modelEfforts: AppDefaults['modelEfforts'],
  model: string,
  options: ModelOption[]
): EffortId | '' | undefined {
  const direct = modelEfforts?.[model]
  if (direct !== undefined) return direct
  const target = canonicalModelId(model, options)
  for (const [storedModel, storedEffort] of Object.entries(modelEfforts ?? {})) {
    if (canonicalModelId(storedModel, options) === target) return storedEffort
  }
  return undefined
}

/** Sentinel model id: use Codex without pinning a model (defer to ~/.codex config). */
export const CODEX_DEFAULT_MODEL = 'codex-default'

export const MODEL_OPTIONS: ModelOption[] = [
  { id: '', label: 'Default', description: 'Your Claude Code default', provider: 'claude' },
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent', provider: 'claude' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Powerful all-rounder', provider: 'claude' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Fast and capable', provider: 'claude' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest', provider: 'claude' },
  { id: 'codex-default', label: 'Codex (default)', description: 'Model from your Codex config', provider: 'codex' },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'OpenAI Codex',
    provider: 'codex',
    contextWindow: 272_000,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'OpenAI Codex',
    provider: 'codex',
    contextWindow: 272_000,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'OpenAI Codex',
    provider: 'codex',
    contextWindow: 272_000,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
  }
]

/**
 * Which provider a model id belongs to. Codex model ids are all listed in
 * MODEL_OPTIONS; anything else (including the '' default and the SDK's dynamic
 * Claude aliases, which aren't in this static list) is Claude. Used to set a new
 * chat's provider from its picked model, and to detect a provider switch.
 */
export function providerForModel(id: string): Provider {
  return MODEL_OPTIONS.find((m) => m.id === id)?.provider ?? 'claude'
}

/**
 * Human name for a resolved wire id: 'claude-opus-4-8[1m]' → 'Opus 4.8'.
 * Undefined when the id isn't in a shape we recognize, so callers can fall back.
 */
export function claudeModelName(resolvedModel?: string): string | undefined {
  if (!resolvedModel) return undefined
  const clean = resolvedModel.replace(/\[[^\]]+\]$/i, '').replace(/^claude-/i, '')
  const match = /^(opus|fable|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(clean)
  if (!match) return undefined
  const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
  return `${family} ${version}`
}

/** Human label for either provider's resolved wire model id. */
export function resolvedModelName(resolvedModel?: string): string | undefined {
  if (!resolvedModel) return undefined
  const claudeName = claudeModelName(resolvedModel)
  if (claudeName) return claudeName
  // Preserve the existing Claude fallback for legacy ids the helper does not
  // recognize; the SDK's displayName is more useful than a raw wire id.
  if (/^claude-/i.test(resolvedModel)) return undefined
  return (
    MODEL_OPTIONS.find(
      (option) => option.id === resolvedModel && option.id !== CODEX_DEFAULT_MODEL
    )?.label ??
    resolvedModel
  )
}

/**
 * Expand an SDK alias label ("Opus") using its resolved wire id. The "Default"
 * row keeps its own name — which model it points at is shown alongside it
 * instead, since that row's whole purpose is *not* naming a specific model.
 */
export function claudeModelLabel(displayName: string, resolvedModel?: string): string {
  if (/^default\b/i.test(displayName)) return displayName
  return claudeModelName(resolvedModel) ?? displayName
}

/** Context size advertised through the SDK's model id/description metadata. */
export function claudeModelContextWindow(
  description: string,
  resolvedModel?: string
): number | undefined {
  return /\[1m\]$/i.test(resolvedModel ?? '') || /\b1m\s+context\b/i.test(description)
    ? 1_000_000
    : undefined
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

export const PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'default', label: 'Ask to approve', description: 'Prompts before sensitive actions' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approves edits in the project' },
  { id: 'plan', label: 'Plan mode', description: 'Read-only, plans before acting' },
  { id: 'auto', label: 'Auto', description: 'A classifier approves safe actions for you' },
  { id: 'bypassPermissions', label: 'Full access', description: 'Never asks — use with care' }
]

// ---------- Files ----------

export interface FileEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
}

export type FileContent =
  | { kind: 'text'; content: string; language?: string; truncated: boolean }
  | { kind: 'image'; dataUri: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string }

// ---------- Git ----------

export interface GitFileChange {
  /** Repo-relative path. */
  path: string
  /** Former path when the change is a rename. */
  origPath?: string
  /** One-letter status: M, A, D, R, C, T, U (conflict) or ? (untracked). */
  status: string
  staged: boolean
  /** Added lines for this file (undefined when unknown, e.g. binary). */
  additions?: number
  /** Removed lines for this file (undefined when unknown, e.g. binary). */
  deletions?: number
  /** Branch scope: this delta is (partly) already committed vs the branch base. */
  committed?: boolean
}

/** Branch-scope change set: everything on the current branch vs its base. */
export interface BranchChanges {
  /** merge-base sha with the base branch, or null if it couldn't be resolved. */
  base: string | null
  /** Short name of the base branch compared against (e.g. "main"). */
  baseBranch: string | null
  /** Files differing from `base` (committed on the branch and/or uncommitted). */
  changes: GitFileChange[]
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  hasRemote: boolean
  changes: GitFileChange[]
  /** Total added / removed lines across staged, unstaged and untracked changes. */
  additions: number
  deletions: number
}

export type GitResult = { ok: true; output?: string } | { ok: false; error: string }

export interface GitDiffTarget {
  path: string
  staged: boolean
  untracked?: boolean
  /** Branch scope: diff the working tree against this base sha instead of the index. */
  base?: string
}

// ---------- GitHub (gh CLI) ----------

/** Aggregate CI/status-check outcome for a PR, rolled up from `statusCheckRollup`. */
export interface PrChecks {
  passed: number
  failed: number
  /** Queued / in-progress / expected checks. */
  pending: number
  total: number
}

/** The pull request for the current branch, as reported by `gh pr view`. */
export interface PrInfo {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  /** '' when no review has been requested/left yet. */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  /** Undefined when the PR has no checks configured. */
  checks?: PrChecks
}

/**
 * GitHub layer for a working directory, derived from the `gh` CLI. Everything is
 * best-effort: a missing binary, no login, no GitHub remote, or an offline box
 * all degrade to `installed`/`authed` flags with no `repo`/`pr`.
 */
export interface GitHubState {
  /** `gh` binary is on PATH. */
  installed: boolean
  /** `gh` has a logged-in account. */
  authed: boolean
  /** owner/repo, when the cwd maps to a GitHub repository gh recognizes. */
  repo?: string
  /** The repo's default branch (e.g. "main"); used to steer commits off it. */
  defaultBranch?: string
  /** PR for the current branch, if one exists. */
  pr?: PrInfo
}

// ---------- Terminal ----------

export interface TerminalCreateOpts {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Run this command via `$SHELL -lc` instead of an interactive login shell. */
  command?: string
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }

// ---------- Browser preview / dev server ----------

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface PreviewState {
  cwd: string
  status: PreviewStatus
  /** The command being run, e.g. "npm run dev". */
  command?: string
  /** Detected local URL once the dev server prints it. */
  url?: string
  /** Short summary when status is 'error' (spawn failure or early exit). */
  error?: string
}

/** main → renderer dev-server lifecycle updates. */
export type PreviewEvent = { type: 'state'; state: PreviewState }

/** main → renderer request to act on a live preview (agent read-back / navigation). */
export interface PreviewCommand {
  id: string
  cwd: string
  kind: 'screenshot' | 'navigate'
  /** navigate: target URL. screenshot: URL to open one at if none exists yet. */
  url?: string
}

export interface PreviewCommandResult {
  id: string
  ok: boolean
  /** screenshot: base64 PNG, no data: prefix. */
  data?: string
  error?: string
}

// ---------- Slash commands ----------

/** A slash command available in a session (custom command, skill, or built-in). */
export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string
  description: string
  /** Hint for arguments, e.g. "<file>". */
  argumentHint?: string
  aliases?: string[]
}

// ---------- Preload API ----------

export interface DockIconPalette {
  background: string
  surface: string
  code: string
  foreground: string
  primary: string
}

export interface Api {
  listChats(): Promise<ChatMeta[]>
  getChat(id: string): Promise<ChatData | null>
  createChat(opts: {
    cwd: string
    provider?: Provider
    model?: string
    effort?: EffortId
    serviceTier?: ServiceTier
    permissionMode?: PermissionModeId
    /** Where the chat runs; omitted or `local` means `cwd` itself. */
    worktree?: WorktreeTarget
  }): Promise<ChatMeta>
  /** `worktree` decides the fate of a worktree chat's directory; default 'keep'. */
  deleteChat(id: string, worktree?: WorktreeDisposition): Promise<OpResult>
  /** Dirty/unmerged report for a worktree chat; null when the chat has no worktree. */
  worktreeStatus(chatId: string): Promise<WorktreeStatus | null>
  /** Shell command that provisions a fresh worktree (deps, .env), or null. */
  worktreeSetupCommand(chatId: string): Promise<string | null>
  /** Every worktree of the repo `cwd` belongs to, main checkout first. */
  listWorktrees(cwd: string): Promise<WorktreeRef[]>
  /**
   * Move a worktree chat back to the main checkout: drop the worktree and check
   * its branch out there. Refuses while the worktree has uncommitted work.
   */
  worktreeHandoff(chatId: string): Promise<OpResult>
  renameChat(id: string, title: string): Promise<void>
  send(chatId: string, text: string, attachments?: Attachment[], label?: string): Promise<void>
  /** Absolute path of a dragged/picked File (empty string for in-memory files). */
  pathForFile(file: File): string
  interrupt(chatId: string): Promise<void>
  /** Stop a single background task by its id. */
  stopBackgroundJob(chatId: string, taskId: string): Promise<void>
  respondPermission(chatId: string, requestId: string, decision: PermissionDecision): Promise<void>
  setChatOptions(chatId: string, patch: ChatOptionsPatch): Promise<void>
  // ---- Checkpoint / rewind ----
  /** Revert the working tree to its state at a user message. dryRun previews only. */
  rewindFiles(chatId: string, userMessageId: string, dryRun: boolean): Promise<RewindResult>
  // ---- Session introspection ----
  /** Whether the chat has a running CLI session (introspection needs one). */
  sessionLive(chatId: string): Promise<boolean>
  /** Live MCP server status for a chat; empty when no session is running. */
  mcpStatus(chatId: string): Promise<McpServerInfo[]>
  mcpReconnect(chatId: string, name: string): Promise<OpResult>
  mcpToggle(chatId: string, name: string, enabled: boolean): Promise<OpResult>
  /** Models the session reports; empty if unavailable (renderer falls back to the static list). */
  /** `cwd` lets the new-chat screen, which has no chat yet, still get the list. */
  listModels(chatId: string, cwd?: string): Promise<ModelOption[]>
  /** User-level Codex model from $CODEX_HOME/config.toml; separate from Claude's model list. */
  codexConfigModel(): Promise<string | null>
  listAgents(chatId: string): Promise<AgentInfo[]>
  accountInfo(chatId: string): Promise<AccountInfo | null>
  usageInfo(chatId: string): Promise<UsageInfo | null>
  // ---- Persisted permission rules ----
  getPermissionRules(cwd: string): Promise<PermissionRule[]>
  /** Remove a rule from a project settings file (local or project scope only). */
  removePermissionRule(cwd: string, rule: PermissionRule): Promise<OpResult>
  pickDirectory(): Promise<string | null>
  listDir(dir: string): Promise<FileEntry[]>
  readFile(path: string): Promise<FileContent>
  statPath(path: string): Promise<'file' | 'dir' | null>
  searchFiles(cwd: string, query: string): Promise<{ rel: string; path: string }[]>
  gitStatus(cwd: string): Promise<GitStatus>
  gitDiff(cwd: string, target: GitDiffTarget): Promise<string>
  gitStage(cwd: string, paths: string[]): Promise<GitResult>
  gitUnstage(cwd: string, paths: string[]): Promise<GitResult>
  gitCommit(cwd: string, message: string): Promise<GitResult>
  gitPush(cwd: string): Promise<GitResult>
  gitPull(cwd: string): Promise<GitResult>
  /** Update remote-tracking refs so ahead/behind reflects the real remote. */
  gitFetch(cwd: string): Promise<GitResult>
  /** Branch-scope changes: everything on the current branch vs its base branch. */
  gitBranchChanges(cwd: string, baseBranch?: string): Promise<BranchChanges>
  gitInit(cwd: string): Promise<GitResult>
  /** GitHub state (PR + checks) for the cwd's current branch; best-effort. */
  githubState(cwd: string): Promise<GitHubState>
  /** Open the current branch's PR in the browser (`gh pr view --web`). */
  githubOpenPr(cwd: string): Promise<GitResult>
  getDefaults(): Promise<AppDefaults>
  forgetDir(dir: string): Promise<void>
  /** Show a file or folder in the OS file manager, selected in its parent. */
  revealPath(path: string): Promise<void>
  /** Bring the app window to the foreground (notification clicks). */
  focusWindow(): Promise<void>
  /**
   * Align native macOS chrome and vibrancy with the app's appearance.
   * `resolvedDark` supplies the current material tone while System mode stays
   * attached to OS appearance changes. No-op off macOS.
   */
  setWindowAppearance(
    mode: 'dark' | 'light' | 'system',
    resolvedDark: boolean
  ): Promise<void>
  /** Update the macOS Dock icon to mirror the active app theme. */
  setDockIcon(palette: DockIconPalette): Promise<void>
  /**
   * Reveal native macOS window vibrancy to match the translucency preference.
   * `true` uses a translucent backing; `false` restores an opaque backing that
   * covers the constructor-created material. No-op off macOS.
   */
  setWindowTranslucent(on: boolean): Promise<void>
  /** Host platform (e.g. 'darwin'); gates macOS-only appearance options. */
  readonly platform: string
  // ---- Terminal ----
  terminalCreate(opts: TerminalCreateOpts): Promise<void>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalKill(id: string): Promise<void>
  /** Provider-specific slash commands available for a project folder. */
  getCommands(cwd: string, provider?: Provider): Promise<SlashCommand[]>
  // ---- Browser preview / dev server ----
  /** Detected dev command for a project, or null if none found. */
  previewDetect(cwd: string): Promise<string | null>
  previewState(cwd: string): Promise<PreviewState>
  /** Starts the dev server (auto-detected command unless one is given). */
  previewStart(cwd: string, command?: string): Promise<PreviewState>
  previewStop(cwd: string): Promise<PreviewState>
  /** Buffered dev-server output (ANSI-stripped). */
  previewLogs(cwd: string): Promise<string>
  /** Renderer forwards guest console lines so agent read-back can surface them. */
  previewReportConsole(cwd: string, line: string): void
  /** Renderer's reply to a PreviewCommand (screenshot/navigate). */
  previewCommandResult(result: PreviewCommandResult): void
  /**
   * Fallback screenshot: crop the app window's capture to a pane rect (in CSS
   * px). Used when a <webview>'s own capturePage() fails. Base64 PNG, or null.
   */
  previewCaptureWindow(rect: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<string | null>
  onChatEvent(cb: (ev: ChatEvent) => void): () => void
  onNewChat(cb: () => void): () => void
  /** A notification was clicked — bring this chat to the foreground. */
  onOpenChat(cb: (id: string) => void): () => void
  onTerminalEvent(cb: (ev: TerminalEvent) => void): () => void
  onPreviewEvent(cb: (ev: PreviewEvent) => void): () => void
  onPreviewCommand(cb: (cmd: PreviewCommand) => void): () => void
}

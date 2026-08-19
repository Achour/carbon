export const PROVIDERS = ['claude', 'codex', 'grok'] as const

export type Provider = (typeof PROVIDERS)[number]

/**
 * The provider a stored name refers to, or null when this build has no backend
 * of that name.
 *
 * `Provider` is a compile-time union, and every `Record<Provider, …>` in the app
 * is a total function *over that union* — outside it they return undefined, and
 * the caller dereferences it (`PATHS[provider].map`) rather than falling back.
 * That is the right shape for a fixed set, but a chat's `provider` is not one:
 * it is a string read off disk, and the database is deliberately shared between
 * builds (`userData` is pinned to `ai-gui`, dev and packaged alike), so a branch
 * that adds a fourth provider writes rows every other build must still be able
 * to open. Coerce such a value once, at the read, rather than teaching every
 * lookup to survive it — a fallback inside the lookups would draw one backend's
 * mark for another's chat, and silently mislabelling a row is worse than
 * declining to place it.
 */
export function knownProvider(value: unknown): Provider | null {
  return PROVIDERS.includes(value as Provider) ? (value as Provider) : null
}

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
/**
 * Grok advertises its reasoning levels per model on the ACP handshake
 * (`_meta.reasoningEfforts`), and every model so far offers a subset of these
 * four. `max`/`ultra`/`minimal` have no Grok equivalent, so they are dropped
 * rather than approximated — sending an unknown effort is silently ignored by
 * the CLI, which would leave the composer claiming a level that isn't running.
 */
export type GrokEffortId = Extract<EffortId, 'low' | 'medium' | 'high' | 'xhigh'>

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
  provider: 'grok'
): GrokEffortId | undefined
export function effortForProvider(
  effort: EffortId | undefined,
  provider: Provider
): EffortId | undefined
export function effortForProvider(effort: EffortId | undefined, provider: Provider): EffortId | undefined {
  if (effort === undefined) return undefined
  return PROVIDER_EFFORTS[provider].includes(effort) ? effort : undefined
}

/**
 * Every provider's reasoning levels, widest model first — the single answer to
 * "which efforts does this backend have".
 *
 * One table rather than a rule per provider because three call sites need the
 * same fact in three shapes: `effortForProvider` filters a stored value against
 * it, the composer builds a menu from it, and the plan review's "Build with"
 * picker falls back to it when a model advertises none of its own. Those had
 * drifted into a filter, a two-way ternary and a `Record` respectively, which is
 * how a Grok chat came to be offered Claude's menu — including `max`, which
 * `effortForProvider` then silently dropped on the way to the CLI.
 *
 * A *model* may support fewer (`ModelOption.supportedEfforts`); this is the
 * provider-wide union and the correct fallback when the model says nothing.
 */
export const PROVIDER_EFFORTS: Record<Provider, EffortId[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  grok: ['low', 'medium', 'high', 'xhigh']
}

/** Grok's reasoning levels. Kept as a named export for the ACP spawn flag. */
export const GROK_EFFORTS = PROVIDER_EFFORTS.grok as GrokEffortId[]

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
  /**
   * Branch is already merged into the default branch — the worktree is done and
   * safe to remove. Undefined when unknown (no default branch, or the main
   * checkout, which is never "finished").
   */
  merged?: boolean
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
  /**
   * A cross-provider model pick that hasn't been sent yet. Switching backends
   * has real side effects (session teardown, a handoff brief), so it applies
   * on the next send rather than on click — a misclick is undone by simply
   * picking again, with the original session never touched. `''` targets the
   * Claude default row; undefined means no switch is pending. The composer
   * shows this model (and its provider's controls) while it waits.
   */
  pendingModel?: string
  /** Provider for a dynamic `pendingModel` that is not in the static catalog. */
  pendingProvider?: Provider
  /**
   * Transient: shown in a locked composer while the handoff context for a
   * just-sent provider switch is being generated. Set as the switch applies,
   * cleared when the turn is handed to the new backend. The renderer only
   * shows it while the chat is busy, so a value left behind by a crash is
   * invisible.
   */
  switchingNote?: string
  /** Tokens currently in the model's context (from the last API call). */
  contextTokens?: number
  /**
   * Semantics marker for persisted context usage. Older Codex builds stored a
   * cumulative turn total in `contextTokens`; values written from App Server's
   * last model call carry version 1 so that legacy values can be cleared once.
   * Claude does not need the marker because its field has always meant live
   * context occupancy.
   */
  contextTokensVersion?: 1
  /** Context window size of the model in use. */
  contextWindow?: number
  /** Present when `cwd` is a git worktree the app manages or attached to. */
  worktree?: WorktreeInfo
  /**
   * When the user pinned the chat; absent means unpinned. A timestamp rather
   * than a flag so the sidebar's Pinned section has a stable order (oldest pin
   * first) instead of reshuffling every time a pinned chat is used.
   */
  pinnedAt?: number
  createdAt: number
  updatedAt: number
}

export interface ChatData extends ChatMeta {
  messages: ChatMessage[]
}

/**
 * What the renderer receives when it opens a chat: the most recent messages
 * only, plus how many older ones were left in the database. Opening the largest
 * real chat used to ship all 1201 messages — 36.9 MB across IPC, parsed twice
 * and mounted as 1201 React rows — for a view showing the last screenful.
 *
 * `hiddenBefore` is also the cursor: pass it to `loadOlderMessages` to get the
 * next window back, and use the `from` it returns as the new value.
 */
export interface ChatView {
  chat: ChatData
  hiddenBefore: number
}

/** One window of older messages, and the index the window starts at. */
export interface OlderMessages {
  from: number
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

/**
 * What is *permanently* in the context window, from `context_usage` on each
 * assistant message (Claude Code 2.1.235+) — the part a user can act on.
 *
 * The headline numbers are deliberately NOT here: they ride `contextTokens` /
 * `contextWindow` on `ChatMeta`, which every provider already feeds and which
 * persists, so the reading survives a chat switch and a restart. This carries
 * only what cannot persist — a breakdown that is stale the moment the session
 * ends, and large enough that `metaOf`'s wholesale re-serialize would write it
 * on every save.
 *
 * Already flattened, summed and sorted by the main process: the renderer showed
 * one row per MCP *server*, while the CLI reports one entry per *tool* — a few
 * hundred of them — so aggregating before IPC rather than after is what keeps
 * this off the wire.
 */
export interface ContextUsage {
  /**
   * Set once the conversation no longer fits. `compaction_window` means the
   * next turn triggers an auto-compact; `hard_limit` means the request itself
   * would be rejected.
   */
  overLimit?: { tokensOver: number; kind: 'hard_limit' | 'compaction_window' }
  /** Largest first, zero-token entries dropped. */
  overhead: { label: string; detail: 'MCP' | 'memory' | 'skill' | 'agent'; tokens: number }[]
}

export interface TurnStats {
  costUsd: number
  durationMs: number
  numTurns: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

/** Structured from → to of a provider switch, for the transcript's handoff card. */
export interface ModelSwitchInfo {
  /** Display names only ('Opus 5'); provider names ride separately. */
  fromModel: string
  fromProvider: Provider
  toModel: string
  toProvider: Provider
}

export interface EventMessage {
  id: string
  role: 'event'
  kind: 'error' | 'info' | 'compact' | 'turn' | 'switch'
  /** Always set — the prose fallback when a renderer lacks the structured card. */
  text: string
  ts: number
  stats?: TurnStats
  /** kind 'switch' only. */
  switch?: ModelSwitchInfo
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
       * starts, so a plan written by one model can be built by another. A model
       * from the *other* provider works too — the manager tears down the review,
       * switches backends, and hands the plan across (see
       * ChatManager.approvePlanCrossProvider). Undefined keeps the model the
       * plan was written with.
       */
      model?: string
      /** Provider of `model`, needed for runtime-discovered model ids. */
      provider?: Provider
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
  /** Provider-stable id used by Codex App Server's request_user_input response. */
  id?: string
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
  /** Optional elicitation fields may be submitted without a value. Defaults true. */
  required?: boolean
  /** Defaults to true for Claude's existing AskUserQuestion behavior. */
  allowOther?: boolean
  /** Request that a free-form answer be visually concealed. */
  isSecret?: boolean
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
export type OpResult = { ok: true; url?: string } | { ok: false; error: string }

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
 * One provider's *account-level* plan limits, for the sidebar Usage popover.
 *
 * Deliberately not `UsageInfo`: that one is per-session (its cost and line
 * counts only mean anything for a specific chat), while this answers "how much
 * headroom is left on my plan" — which is a property of the account and has to
 * be readable with no chat open at all.
 */
export interface ProviderUsage {
  provider: Provider
  /** False when signed out, unreachable, or on a backend without plan limits. */
  available: boolean
  /** Why it's unavailable, in the user's words. Only set when `available`. */
  note?: string
  /** Plan name the provider reports ('max', 'plus', …). */
  plan?: string | null
  windows: RateLimitWindow[]
  /**
   * Codex "rate limit reset" credits the account can spend to clear a window.
   * Omitted for Claude, which has no equivalent.
   */
  resetCredits?: number
}

/** Both providers' plan limits, read side by side. */
export interface UsageOverview {
  claude: ProviderUsage
  codex: ProviderUsage
}

// ---------- Usage history (the Usage page) ----------

/** Windows the Usage page offers, shortest first — the order they're read in. */
export const USAGE_RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' }
] as const

/** The window the page opens on: a month is the span a habit shows up over. */
export const USAGE_DEFAULT_DAYS = 30

/** Token counts and their list-price cost, for one slice of the report. */
export interface UsageTotals {
  /** Input tokens billed at the full rate (cache misses). */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** Reasoning tokens — a *subset* of `output`; Codex reports them, Claude doesn't. */
  reasoning: number
  costUsd: number
  /** What `cacheRead` would have cost uncached, minus what it did cost. */
  savingsUsd: number
  /** Assistant responses (Claude) / sampled turns (Codex). */
  responses: number
  /** Tokens with no published rate; excluded from `costUsd`. */
  unpricedTokens: number
}

/** One row of the per-model breakdown. */
export interface UsageModelRow extends UsageTotals {
  provider: Provider
  model: string
}

/** One point on the daily chart. `YYYY-MM-DD`, local. */
export interface UsageDay {
  day: string
  claude: UsageTotals
  codex: UsageTotals
  grok: UsageTotals
}

/**
 * Token spend over a window, read from the CLIs' own session logs.
 *
 * Distinct from `UsageOverview`, which is "how much plan headroom is left right
 * now". This is history: what was spent, on which models, on which days —
 * including turns run outside Carbon, because both SDKs drive the same CLIs and
 * write to the same logs.
 */
export interface UsageReport {
  /** Inclusive local-day bounds, `YYYY-MM-DD`. */
  from: string
  to: string
  days: UsageDay[]
  /** Sorted by cost, descending. */
  models: UsageModelRow[]
  claude: UsageTotals
  codex: UsageTotals
  grok: UsageTotals
  total: UsageTotals
  /** Distinct session files that contributed to the window. */
  sessions: number
  /** When the scan ran (epoch ms). */
  scannedAt: number
  /** Sources that couldn't be read at all, in the user's words. */
  notes: string[]
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

/**
 * Whether the provider is actually serving Fast. `cooldown` is Fast paused
 * after a rate limit — it comes back on its own.
 */
export type FastModeState = 'off' | 'cooldown' | 'on'

/**
 * What the provider reports back about Fast for a live session. Choosing Fast
 * is a *request*: the account may not allow the extra usage Fast bills to, the
 * model may not offer it, a rate limit may have paused it. Without reading this
 * back the composer would keep advertising Fast while every turn ran Standard.
 */
export interface FastModeStatus {
  state: FastModeState
  /** Provider reason code when Fast can't serve; render it via `fastModeNote`. */
  reason?: string
}

/**
 * Why Fast isn't being served, in the user's words — null when it is being
 * served, and also null while the provider is still working it out, since a
 * pending check is not evidence of anything.
 */
export function fastModeNote(status?: FastModeStatus): string | null {
  if (!status || status.state === 'on') return null
  if (status.state === 'cooldown') return 'Paused until your rate limit resets'
  switch (status.reason) {
    case 'pending':
      return null
    case 'extra_usage_disabled':
      return 'Extra usage is turned off for your account'
    case 'free':
      return 'Not included in your plan'
    case 'preference':
      return 'Turned off in your provider settings'
    case 'model_not_allowed':
      return 'Not available for this model'
    case 'not_first_party':
      return 'Not available on this API provider'
    case 'disabled_by_env':
      return 'Disabled by an environment variable'
    case 'network_error':
      return "Couldn't reach the provider to check"
    default:
      return 'Unavailable — running at standard speed'
  }
}

export type ChatEvent =
  | { type: 'message'; chatId: string; message: ChatMessage }
  | { type: 'part-delta'; chatId: string; messageId: string; partIndex: number; delta: string }
  | { type: 'part'; chatId: string; messageId: string; partIndex: number; part: AssistantPart }
  | { type: 'tool-update'; chatId: string; messageId: string; toolUseId: string; patch: Partial<ToolPart> }
  | { type: 'meta'; chatId: string; patch: Partial<ChatMeta> }
  // Transient, per assistant message: the CLI's own context accounting. Not
  // folded into `meta` because ChatMeta is persisted wholesale and this is not.
  | { type: 'context-usage'; chatId: string; usage: ContextUsage }
  | { type: 'status'; chatId: string; status: ChatStatus }
  // Another Carbon instance holds this chat's write lock (userData is shared
  // between the dev and packaged builds), so edits here will not be saved.
  | { type: 'chat-locked'; chatId: string }
  | { type: 'permission-request'; chatId: string; request: PermissionRequestPayload }
  | { type: 'permission-resolved'; chatId: string; requestId: string }
  // `provider` is part of the identity, not decoration: two providers can have a
  // live session in the same folder, and the renderer keys its cache on
  // `${cwd}::${provider}`. Without it a Grok push either lands in Claude's slot
  // or is discarded for not matching it.
  | { type: 'commands'; chatId: string; cwd: string; provider: Provider; commands: SlashCommand[] }
  | { type: 'background-jobs'; chatId: string; jobs: BackgroundJob[] }
  | { type: 'rate-limit'; chatId: string; state: RateLimitState }
  // Transient (not persisted): whether the provider is honouring this chat's
  // Fast selection. Only Claude reports it; the Codex SDK exposes no equivalent.
  | { type: 'fast-mode'; chatId: string; status: FastModeStatus }
  // Transient (not persisted): the AI title is being generated for this chat, so
  // the sidebar can shimmer the placeholder until the real title arrives.
  | { type: 'title-pending'; chatId: string; pending: boolean }

// ---------- Settings ----------

export interface AppDefaults {
  model?: string
  /** Provider of the remembered model; older settings infer it from the catalog. */
  modelProvider?: Provider
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
  /** Provider of `model`, needed for runtime-discovered model ids. */
  modelProvider?: Provider
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

/** Sentinel model id: use Grok without pinning a model (defer to ~/.grok/config.toml). */
export const GROK_DEFAULT_MODEL = 'grok-default'

export const MODEL_OPTIONS: ModelOption[] = [
  { id: '', label: 'Default', description: 'Your Claude Code default', provider: 'claude' },
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent', provider: 'claude' },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Powerful all-rounder', provider: 'claude' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Previous Opus', provider: 'claude' },
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
  },
  { id: 'grok-default', label: 'Grok (default)', description: 'Model from your Grok config', provider: 'grok' },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    description: 'xAI Grok Build',
    provider: 'grok',
    contextWindow: 500_000,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    description: 'xAI Grok Build',
    provider: 'grok',
    contextWindow: 500_000,
    supportedEfforts: ['low', 'medium', 'high']
  }
]

/**
 * Which provider a model id *demonstrably* belongs to, or undefined when the id
 * is one neither catalog nor its shape can place. Callers with a live catalog
 * pass it so runtime-discovered ids route correctly; the static catalog is the
 * fallback for startup, older settings and known aliases.
 *
 * The shape rules below matter because a wire id is not always a catalog id: the
 * SDK reports Claude's long-context models as `claude-opus-5[1m]`, which no
 * static row carries. Answering "unknown" for those let a stale provider stand
 * beside a model that could never run on it — a Claude id sent to Codex, which
 * the API rejects outright. Anything genuinely unplaceable still returns
 * undefined so an explicitly recorded provider keeps the last word.
 */
export function knownProviderForModel(
  id: string,
  options: ModelOption[] = MODEL_OPTIONS
): Provider | undefined {
  const listed = options.find((m) => m.id === id) ?? MODEL_OPTIONS.find((m) => m.id === id)
  if (listed) return listed.provider
  if (/^claude[-.]/i.test(id)) return 'claude'
  if (/^(gpt|codex|o\d)[-.]/i.test(id)) return 'codex'
  // Grok's wire ids are the catalog ids (`grok-4.6`), but the CLI also reports
  // build-suffixed variants on usage rows (`grok-4.6-build`) and older docs use
  // the bare `grok-build` alias, none of which any static row carries.
  if (/^grok[-.]/i.test(id)) return 'grok'
  return undefined
}

/**
 * Which provider a model id belongs to, defaulting to Claude for ids nothing can
 * place. Prefer `knownProviderForModel` where an explicit provider is on hand —
 * that answer should only be overridden by a certainty, not by this default.
 */
export function providerForModel(id: string, options: ModelOption[] = MODEL_OPTIONS): Provider {
  return knownProviderForModel(id, options) ?? 'claude'
}

/**
 * The provider a remembered (model, provider) pair should actually run on. The
 * model's own catalog entry wins over the recorded provider, which is only
 * consulted for ids nothing can place — a runtime-discovered id, or settings
 * written before the field existed.
 *
 * The precedence is the point. The two are stored separately and can drift
 * apart, and the two outcomes are not symmetric: a stale provider beside a
 * known model is an API rejection ("The 'claude-fable-5' model is not supported
 * when using Codex"), where preferring the model's own provider can at worst
 * re-state what the pair already agreed on.
 */
export function providerForRememberedModel(
  model: string | undefined,
  recorded: Provider | undefined,
  options: ModelOption[] = MODEL_OPTIONS
): Provider {
  // The recorded half is a bare string out of settings.json, which a build with
  // a provider this one does not have may have written. It is consulted only
  // for models nothing can place, so a provider *this* build cannot place
  // answers for nothing at all and must not be passed on as one.
  const known = knownProvider(recorded)
  // "No model" pins nothing: both providers have a default of their own, and
  // Claude's Default row *is* the empty id — reading it as evidence of Claude
  // would drag every unpinned Codex chat across to the wrong backend.
  if (!model) return known ?? 'claude'
  return knownProviderForModel(model, options) ?? known ?? 'claude'
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
  codex: 'Codex',
  grok: 'Grok'
}

/**
 * The name to use in prose and on chips — "Claude", not "Claude Code". Six
 * places used to spell this as `provider === 'codex' ? 'Codex' : 'Claude'`,
 * which is a two-provider idiom that silently mislabels a third as Claude
 * rather than failing to compile.
 */
export const PROVIDER_SHORT_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok'
}

/**
 * Just the model's display name ('Opus 5'), or the provider's name when the
 * model is the provider-default row. `options` (the live picker list, when the
 * caller has it) resolves dynamic SDK alias ids like `opus[1m]` that
 * `resolvedModelName` alone can't name.
 */
export function modelDisplayName(
  model: string | undefined,
  provider: Provider,
  options?: ModelOption[]
): string {
  if (!model || model === CODEX_DEFAULT_MODEL) return PROVIDER_LABELS[provider]
  return options?.find((option) => option.id === model)?.label ?? resolvedModelName(model) ?? model
}

/**
 * Human "model (provider)" label for cross-provider copy — the handoff's
 * composer notes, prose fallbacks and brief prompts.
 */
export function modelLabel(
  model: string | undefined,
  provider: Provider,
  options?: ModelOption[]
): string {
  const name = PROVIDER_LABELS[provider]
  const display = modelDisplayName(model, provider, options)
  return display === name ? name : `${display} (${name})`
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
  /**
   * Commits the repo's *default* branch has that this one doesn't — how stale
   * the branch is. Distinct from `behind`, which is measured against the
   * branch's own upstream. Absent on the default branch itself and in repos
   * with no main/master, where the question doesn't apply.
   */
  behindDefault?: number
  /** The reverse: commits here that the default branch doesn't have yet. */
  aheadDefault?: number
  /**
   * The repo's default branch ('main' / 'master'); set whenever one exists,
   * including while it's the branch checked out.
   */
  defaultBranch?: string
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
  /**
   * Chat that opened this terminal. Only used to reap the pty when that chat is
   * deleted — tabs themselves stay global, visible from every chat.
   */
  chatId?: string
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  /**
   * Foreground process under the shell changed. `command` is null when the bare
   * shell is in front (nothing running); otherwise it names what is running, so
   * a long-lived `npm run dev` is visible without opening the tab.
   */
  | { type: 'busy'; id: string; command: string | null }

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

/**
 * A published release newer than the running build. Carbon ships unsigned, so
 * updates are *announced*, not installed: the user downloads the new build.
 */
export interface UpdateInfo {
  /** Semver without the tag's `v` prefix. */
  version: string
  /** Installer for this platform/arch, or null when no asset matched it. */
  downloadUrl: string | null
  /** The release page — always offered, and the fallback when no asset matched. */
  releaseUrl: string
  /** Release notes (markdown), possibly empty. */
  notes: string
  publishedAt: string
}

export interface Api {
  listChats(): Promise<ChatMeta[]>
  getChat(id: string): Promise<ChatView | null>
  /**
   * The window of messages immediately before `before`. Returns an empty list
   * once the beginning of the chat is reached.
   */
  loadOlderMessages(id: string, before: number): Promise<OlderMessages | null>
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
  /**
   * Land a worktree chat's branch: merge it into the default branch in the main
   * checkout, then remove the worktree. Refuses unless both trees are clean and
   * the main checkout is on the default branch; a conflicting merge is aborted.
   */
  worktreeMerge(chatId: string): Promise<OpResult>
  /**
   * Retire a worktree whose work landed elsewhere (the PR path): remove it and
   * move the chat to the main checkout. Refuses while it has uncommitted work.
   */
  worktreeFinish(chatId: string): Promise<OpResult>
  /** Remove a worktree by path (the picker's cleanup); unforced, like deletion. */
  worktreeRemove(path: string): Promise<OpResult>
  renameChat(id: string, title: string): Promise<void>
  /** Pin/unpin a chat to the sidebar's Pinned section. */
  setChatPinned(id: string, pinned: boolean): Promise<void>
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
  /** Account-level plan limits for both providers; needs no chat. */
  usageOverview(refresh?: boolean): Promise<UsageOverview>
  /** Token spend over the last `days`, read from both CLIs' session logs. */
  usageReport(days: number, refresh?: boolean): Promise<UsageReport>
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
  /**
   * Land the checked-out branch into the default branch in place: switch, merge,
   * delete it. Refuses on a dirty tree and undoes a conflicting merge, so a
   * failure always leaves the working directory as it was.
   */
  gitMergeIntoDefault(cwd: string): Promise<GitResult>
  /** Update remote-tracking refs so ahead/behind reflects the real remote. */
  gitFetch(cwd: string): Promise<GitResult>
  /** Branch-scope changes: everything on the current branch vs its base branch. */
  gitBranchChanges(cwd: string, baseBranch?: string): Promise<BranchChanges>
  /**
   * The branch checked out in each folder (null outside a repo), for the
   * sidebar's detailed rows. A set rather than one folder at a time because the
   * caller always asks about every visible chat at once.
   */
  gitBranches(cwds: string[]): Promise<Record<string, string | null>>
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
  /** Open an http(s) URL in the user's default browser. */
  openExternal(url: string): Promise<void>
  /**
   * The newest published release when it is newer than this build, else null.
   * Never rejects — offline and up-to-date are the same answer to the UI.
   */
  checkForUpdate(): Promise<UpdateInfo | null>
  /** The running build's version, for the settings/about line. */
  readonly appVersion: string
  /**
   * True when the Homebrew cask installed this build — the one install route
   * that updates in place, so the update UI offers `brew upgrade` instead of a
   * download. False is the safe answer and the one every ambiguous case gets.
   */
  readonly installedViaHomebrew: boolean
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
  /** The user's home directory, so paths can be shown as `~/…`. */
  readonly home: string
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

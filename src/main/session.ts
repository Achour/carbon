import type {
  AccountInfo,
  ChatData,
  CodexGoal,
  CodexGoalStatus,
  CodexReviewTarget,
  AgentInfo,
  Attachment,
  ChatEvent,
  McpServerInfo,
  ModelOption,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  RewindResult,
  ServiceTier,
  UsageInfo
} from '@shared/types'

/** Sink for every main → renderer event, over the single `chat:event` channel. */
export type Emit = (ev: ChatEvent) => void

/**
 * The prompt a provider sees for one send: hidden context (the cross-provider
 * handoff) first, then the user's text. The displayed/persisted message keeps
 * the user's own words — only the outbound prompt is composed here.
 */
export function composePrompt(text: string, hiddenContext?: string): string {
  return [hiddenContext, text].filter(Boolean).join('\n\n')
}

/** Resolve to `fallback` after `ms`. The work is not cancelled, just ignored. */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ])
}

/**
 * The provider-agnostic surface `ChatManager` drives. Both `ClaudeSession`
 * (Agent SDK) and `CodexSession` (Codex SDK) implement it, so everything the
 * manager and IPC layer touch is identical regardless of which agent runs the
 * chat. Introspection methods a provider doesn't support return empty/no-op
 * values (e.g. Codex has no live MCP status or file checkpoints).
 */
export interface AgentSession {
  /** True once the underlying session is gone; the manager drops dead sessions. */
  readonly dead: boolean
  /** True when the wrapper has no running turn, prompt, permission, or background job. */
  readonly idle: boolean
  /**
   * `hiddenContext` is prepended to the prompt the provider sees but never to
   * the displayed/persisted user message — the cross-provider handoff rides
   * it. A promise is allowed (the handoff brief resolving): the user message
   * echoes immediately and the turn starts once the context lands; sessions
   * keep an internal send queue so later sends can't overtake it.
   */
  send(
    text: string,
    attachments?: Attachment[],
    label?: string,
    hiddenContext?: string | Promise<string | undefined>
  ): void
  /**
   * The plan text behind a pending review request, or null if `requestId`
   * isn't one. Lets the manager catch a plan approved into the *other*
   * provider before the approval reaches this session (see ChatManager).
   */
  pendingPlan?(requestId: string): string | null
  interrupt(): Promise<void>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  /** Optional live speed switch; providers with client-level config recreate instead. */
  setServiceTier?(serviceTier: ServiceTier): Promise<void>
  stopBackgroundJob(taskId: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): void
  rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult>
  mcpStatus(): Promise<McpServerInfo[]>
  mcpReconnect(name: string): Promise<OpResult>
  mcpToggle(name: string, enabled: boolean): Promise<OpResult>
  listModels(): Promise<ModelOption[]>
  listAgents(): Promise<AgentInfo[]>
  accountInfo(): Promise<AccountInfo | null>
  usageInfo(): Promise<UsageInfo | null>
  /** Native Codex App Server goal controls; absent on other providers. */
  codexGoalGet?(): Promise<CodexGoal | null>
  codexGoalSet?(params: {
    objective?: string
    status?: CodexGoalStatus
    tokenBudget?: number | null
  }): Promise<CodexGoal>
  codexGoalClear?(): Promise<boolean>
  /** Queue a native App Server review turn for the already-persisted command message. */
  codexReview?(userMessageId: string, target: CodexReviewTarget): void
  /**
   * Fork this provider's conversation so it ends immediately before the user
   * message at `index`, returning the id the chat should resume from.
   *
   * Genuinely optional, and implemented only by Codex: see `ConversationFork`
   * for why the other two answer without a session at all.
   */
  forkBefore?(index: number): Promise<string | undefined>
  dispose(): void
}

/**
 * How one provider rewinds its own conversation — the backing half of
 * edit-and-resend, and the seam that keeps `ChatManager` from learning what a
 * fork means to each backend.
 *
 * Every implementation produces a *new* conversation rather than mutating the
 * live one, so a failure part-way through leaves the original intact and the
 * chat carries on where it was. `undefined` means this provider cannot truncate
 * and the caller must replay the kept turns into a fresh session instead.
 *
 * `needsSession` is what keeps an edit cheap. Only Codex's fork rides a running
 * CLI, because its turn ids live behind the app-server connection. Claude's is
 * a module function over the transcript file on disk and Grok's reads nothing
 * at all — so constructing a session to ask them would spawn a CLI (~700ms,
 * ~490MB) purely to throw it away a moment later, and could evict another
 * chat's warm one on the way out.
 */
export interface ConversationFork {
  needsSession: boolean
  fork(chat: ChatData, index: number, session: AgentSession | null): Promise<string | undefined>
}

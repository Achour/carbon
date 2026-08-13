import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  effortForProvider,
  GROK_DEFAULT_MODEL,
  type AccountInfo,
  type AgentInfo,
  type AssistantMessage,
  type AssistantPart,
  type Attachment,
  type ChatData,
  type ChatMeta,
  type ChatStatus,
  type McpServerInfo,
  type ModelOption,
  type OpResult,
  type PermissionDecision,
  type PermissionModeId,
  type PersistedPlanReview,
  type RewindResult,
  type SlashCommand,
  type ToolPart,
  type UsageInfo
} from '@shared/types'
import type { Store } from './store'
import { composePrompt, withTimeout, type AgentSession, type Emit } from './session.ts'
import { DeltaCoalescer } from './deltaCoalescer.ts'
import {
  GrokAcpClient,
  GROK_OAUTH_REFERRER,
  grokEffortFlag,
  grokInstalled,
  grokPermissionMode,
  resolveGrokBinary,
  isExitPlanTool,
  toolName,
  toolNameIfNamed,
  toolOutput,
  toolStatus,
  type GrokCommand,
  type GrokModelState,
  type GrokPermissionRequest,
  type GrokPromptResult,
  type GrokSessionUpdate,
  type GrokToolCall
} from './grokAcp.ts'
import { deriveTitle } from './titles.ts'

/**
 * Grok Build as an `AgentSession`, on top of the ACP client in `grokAcp.ts`.
 *
 * The division is the same one `codex.ts` keeps against `codexAppServer.ts`:
 * everything protocol-shaped lives below, and this file only turns those events
 * into `ChatEvent`s. That is what lets the manager, the IPC layer and the whole
 * renderer stay unaware there is a third backend at all.
 *
 * `costUsdTicks` is xAI's own billing figure at 1e-10 USD per tick — Carbon
 * reports it verbatim rather than pricing the tokens itself, because unlike the
 * Usage page (which must re-price historical cells as rates move) a turn's cost
 * is a fact the provider already settled.
 */
const USD_PER_TICK = 1e-10

/** Grok's default context window; overridden per model from the ACP handshake. */
const DEFAULT_CONTEXT_WINDOW = 500_000

/** Handshake-only probe: no turn runs, so this only has to outlast a spawn. */
const MODEL_PROBE_TIMEOUT_MS = 15_000

/** A handoff brief the user is waiting on — bounded so a send can't hang. */
const ONE_SHOT_TIMEOUT_MS = 60_000

interface PendingTurn {
  text: string
  attachments: Attachment[]
  userMessageId: string
}

interface PendingPermission {
  resolve: (optionId: string | null) => void
  request: GrokPermissionRequest
}

export class GrokSession implements AgentSession {
  private chat: ChatData
  private emit: Emit
  private store: Store
  private onDead: () => void
  private onCommands: (commands: SlashCommand[]) => void

  private client: GrokAcpClient | null = null
  private sessionId: string | null
  /** Serializes starts so two quick sends cannot spawn two agents. */
  private starting: Promise<GrokAcpClient> | null = null
  private sendChain: Promise<void> = Promise.resolve()
  private queued = new Set<PendingTurn>()

  private current: AssistantMessage | null = null
  /** Open tool calls by ACP id, so an update patches the part it opened. */
  private toolLoc = new Map<string, { message: AssistantMessage; index: number }>()
  /** Tool-call ids belonging to a plan exit, which render as a panel, not a card. */
  private planToolIds = new Set<string>()
  /** Slot the streaming text/thinking is currently appending to, by kind. */
  private streamSlot: { kind: 'text' | 'thinking'; index: number } | null = null

  private permissions = new Map<string, PendingPermission>()
  /**
   * Persisted like Codex's, and for the same reason: Grok's plan arrives as the
   * *last* thing in a turn rather than as a gate inside one, so there is no
   * live request holding it open and nothing to lose by an app restart.
   */
  private planReview: PersistedPlanReview | null
  /** The user message the current turn answers — the implementation turn reuses it. */
  private activeUserMessageId: string | null = null
  private running = false
  private interrupted = false
  private disposed = false
  private deadFlag = false
  private lastEmittedStatus: ChatStatus | null = null
  private turnStart = 0
  private models: GrokModelState | null = null
  private commands: GrokCommand[] = []
  /**
   * The permission baseline and effort are process-level in Grok (a `session/new`
   * `_meta` flag and a spawn flag). Changing either cannot be applied to a live
   * agent, so it is recorded here and the next send respawns — the same contract
   * `ClaudeSession` has for effort.
   */
  private optionsKey: string

  private readonly deltas = new DeltaCoalescer(
    (event) => this.emit(event),
    () => this.chat.id,
    () => this.store.saveChatSoon(this.chat.id),
    () => this.disposed
  )

  constructor(
    chat: ChatData,
    emit: Emit,
    store: Store,
    onDead: () => void,
    onCommands: (commands: SlashCommand[]) => void = () => {}
  ) {
    this.chat = chat
    this.emit = emit
    this.store = store
    this.onDead = onDead
    this.onCommands = onCommands
    this.sessionId = chat.sessionId ?? null
    this.planReview = chat.pendingPlanReview ?? null
    this.optionsKey = this.currentOptionsKey()
  }

  get dead(): boolean {
    return this.deadFlag
  }

  get idle(): boolean {
    return !this.running && this.queued.size === 0 && this.permissions.size === 0 && !this.planReview
  }

  // ---------- Lifecycle ----------

  private currentOptionsKey(): string {
    const mode = grokPermissionMode(this.chat.permissionMode)
    return [
      this.chat.cwd,
      mode.alwaysApprove ? 'yolo' : mode.autoMode ? 'auto' : 'ask',
      grokEffortFlag(effortForProvider(this.chat.effort, 'grok')) ?? ''
    ].join('|')
  }

  /** The model to launch with; the Default row defers to ~/.grok/config.toml. */
  private launchModel(): string | undefined {
    const model = this.chat.model
    if (!model || model === GROK_DEFAULT_MODEL) return undefined
    return model
  }

  private async ensureClient(): Promise<GrokAcpClient> {
    const wanted = this.currentOptionsKey()
    if (this.client?.alive && wanted !== this.optionsKey) {
      // Effort or the permission baseline moved. Neither has a live setter, so
      // the agent is replaced; the conversation survives because `sessionId`
      // resumes it through `session/load` below.
      this.client.dispose()
      this.client = null
    }
    this.optionsKey = wanted
    if (this.client?.alive) return this.client
    if (this.starting) return this.starting
    this.starting = this.startClient().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startClient(): Promise<GrokAcpClient> {
    const mode = grokPermissionMode(this.chat.permissionMode)
    const client = new GrokAcpClient({
      cwd: this.chat.cwd,
      model: this.launchModel(),
      effort: grokEffortFlag(effortForProvider(this.chat.effort, 'grok')),
      alwaysApprove: mode.alwaysApprove,
      autoMode: mode.autoMode,
      callbacks: {
        onUpdate: (update) => this.handleUpdate(update),
        onPermission: (request) => this.handlePermission(request),
        onModels: (state) => this.handleModels(state),
        onCommands: (commands) => this.handleCommands(commands),
        onExit: (error) => this.handleExit(error)
      }
    })
    this.client = client
    const initial = await client.start()
    if (initial) this.handleModels(initial)

    if (this.sessionId) {
      try {
        const loaded = await client.loadSession(this.sessionId)
        if (loaded.models) this.handleModels(loaded.models)
        await this.applyLiveMode(client)
        return client
      } catch {
        // The session was pruned from ~/.grok/sessions, or belongs to another
        // cwd. Falling back to a fresh one loses history but keeps the chat
        // usable, which beats failing every send from here on.
        this.sessionId = null
      }
    }
    const created = await client.newSession()
    this.sessionId = created.sessionId
    this.chat.sessionId = created.sessionId
    this.store.saveChat(this.chat.id)
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { sessionId: created.sessionId } })
    if (created.models) this.handleModels(created.models)
    await this.applyLiveMode(client)
    return client
  }

  /** Plan mode is the one permission axis that moves without a respawn. */
  private async applyLiveMode(client: GrokAcpClient): Promise<void> {
    if (!this.sessionId) return
    try {
      await client.setMode(this.sessionId, this.chat.permissionMode === 'plan' ? 'plan' : 'default')
    } catch {
      // Mode is advisory; a refusal must not block the turn.
    }
  }

  private handleExit(error: Error | null): void {
    this.client = null
    this.running = false
    this.rejectAllPermissions()
    if (this.disposed) return
    if (error) {
      this.pushError(error.message)
      this.setStatus('idle')
    }
    this.deadFlag = true
    this.onDead()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queued.clear()
    this.rejectAllPermissions()
    this.client?.dispose()
    this.client = null
    this.deadFlag = true
  }

  // ---------- Emitting helpers ----------

  private setStatus(status: ChatStatus): void {
    if (status === this.lastEmittedStatus) return
    this.lastEmittedStatus = status
    this.emit({ type: 'status', chatId: this.chat.id, status })
  }

  private pushMessage(message: ChatData['messages'][number]): void {
    this.deltas.flush()
    this.chat.messages.push(message)
    this.chat.updatedAt = Date.now()
    this.emit({ type: 'message', chatId: this.chat.id, message })
    this.store.saveChatSoon(this.chat.id)
  }

  private pushError(text: string): void {
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'error', text, ts: Date.now() })
  }

  private ensureCurrent(): AssistantMessage {
    if (!this.current) {
      this.current = { id: randomUUID(), role: 'assistant', parts: [], ts: Date.now() }
      this.chat.messages.push(this.current)
      this.chat.updatedAt = Date.now()
      this.emit({ type: 'message', chatId: this.chat.id, message: this.current })
    }
    return this.current
  }

  private emitPart(message: AssistantMessage, index: number): void {
    this.deltas.drop(message.id, index)
    this.emit({
      type: 'part',
      chatId: this.chat.id,
      messageId: message.id,
      partIndex: index,
      part: message.parts[index]
    })
    this.store.saveChatSoon(this.chat.id)
  }

  // ---------- Sending ----------

  send(
    text: string,
    attachments: Attachment[] = [],
    label?: string,
    hiddenContext?: string | Promise<string | undefined>
  ): void {
    if (this.disposed) return
    if (!this.chat.title) {
      this.chat.title = deriveTitle(text, label, attachments)
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { title: this.chat.title } })
    }
    const userMessageId = randomUUID()
    this.pushMessage({
      id: userMessageId,
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {}),
      ...(label ? { label } : {})
    })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
    this.setStatus(this.sessionId ? 'streaming' : 'starting')

    const turn: PendingTurn = { text, attachments, userMessageId }
    this.queued.add(turn)
    this.sendChain = this.sendChain.then(async () => {
      let context: string | undefined
      try {
        context = (await hiddenContext) || undefined
      } catch {
        context = undefined
      }
      // Swept while the handoff brief was resolving (interrupt or dispose).
      if (!this.queued.delete(turn)) return
      await this.runTurn({ ...turn, text: composePrompt(turn.text, context) })
    })
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    if (this.disposed) return
    this.running = true
    this.interrupted = false
    this.activeUserMessageId = turn.userMessageId
    this.turnStart = Date.now()
    this.setStatus('streaming')
    let result: GrokPromptResult | null = null
    try {
      const client = await this.ensureClient()
      if (!this.sessionId) throw new Error('Grok session could not be created.')
      // Re-assert the plan flag on every turn rather than only at session
      // start. Plan mode is the one permission axis that moves without a
      // respawn, so `ensureClient` can hand back a live agent whose flag is
      // stale — which is exactly what happens on plan approval: the chat's mode
      // is restored to `default`, but the *session* is still refusing every
      // edit outside plan.md, so the implementation turn the approval just
      // queued fails every write it attempts.
      await this.applyLiveMode(client)
      result = await client.prompt(this.sessionId, this.promptBlocks(turn))
    } catch (error) {
      if (!this.disposed && !this.interrupted) {
        this.pushError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.running = false
      this.finishTurn(result)
    }
  }

  /**
   * Grok 1.0.3 declares `promptCapabilities.image: false`, so an attached image
   * cannot ride the prompt as a content block the way it does for the other two.
   * The path goes in the text instead — the agent has filesystem tools and reads
   * it itself, which is what the CLI's own `@file` mention does.
   */
  private promptBlocks(turn: PendingTurn): { type: string; text: string }[] {
    const paths = turn.attachments
      .map((attachment) => attachment.path)
      .filter((path): path is string => !!path)
    const text = paths.length ? `${turn.text}\n\nAttached files:\n${paths.join('\n')}` : turn.text
    return [{ type: 'text', text }]
  }

  private finishTurn(result: GrokPromptResult | null): void {
    this.deltas.flush()
    this.current = null
    this.streamSlot = null
    this.toolLoc.clear()
    // Tool-call ids never span turns, so both maps reset here rather than
    // accumulating every call of a long conversation.
    this.planToolIds.clear()
    if (result) this.recordTurn(result)
    this.setStatus(this.permissions.size ? 'waiting-permission' : 'idle')
    this.store.saveChat(this.chat.id)
  }

  private recordTurn(result: GrokPromptResult): void {
    const tokens = result.turnTokens ?? {}
    if (tokens.total != null) {
      this.chat.contextTokens = tokens.total
      this.chat.contextWindow = this.contextWindow()
      this.emit({
        type: 'meta',
        chatId: this.chat.id,
        patch: { contextTokens: tokens.total, contextWindow: this.chat.contextWindow }
      })
    }
    const usage = result.usage
    if (!usage) return
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'turn',
      text: '',
      ts: Date.now(),
      stats: {
        costUsd: (usage.costUsdTicks ?? 0) * USD_PER_TICK,
        durationMs: Date.now() - this.turnStart,
        numTurns: usage.modelCalls ?? 1,
        model: result.modelId ?? this.chat.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      }
    })
  }

  private contextWindow(): number {
    const current = this.models?.availableModels?.find(
      (model) => model.modelId === (this.models?.currentModelId ?? this.chat.model)
    )
    return current?._meta?.totalContextTokens ?? DEFAULT_CONTEXT_WINDOW
  }

  // ---------- Stream normalization ----------

  private handleUpdate(update: GrokSessionUpdate): void {
    if (this.disposed) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendStream('text', textOf((update as { content?: { text?: string } }).content))
        return
      case 'agent_thought_chunk':
        this.appendStream('thinking', textOf((update as { content?: { text?: string } }).content))
        return
      case 'tool_call':
      case 'tool_call_update':
        this.applyToolCall(update as GrokToolCall)
        return
      case 'session_info_update':
        this.applyTitle((update as { title?: string }).title)
        return
      case 'current_mode_update':
        return
      case 'turn_completed':
        // The authoritative usage also arrives on the prompt reply, which is
        // where it is recorded; this copy would double-count the turn card.
        return
      default:
        return
    }
  }

  /**
   * Append streamed text to the open part of that kind, opening a new one when
   * the kind changes. Grok interleaves reasoning and prose within a turn, and a
   * single accumulating part per kind is what keeps a "thinking → answer →
   * thinking" sequence rendering as three blocks rather than two merged ones.
   */
  private appendStream(kind: 'text' | 'thinking', delta: string): void {
    if (!delta) return
    const message = this.ensureCurrent()
    if (this.streamSlot?.kind !== kind) {
      const part: AssistantPart = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', text: '' }
      message.parts.push(part)
      this.streamSlot = { kind, index: message.parts.length - 1 }
      this.emitPart(message, this.streamSlot.index)
    }
    const slot = message.parts[this.streamSlot.index]
    if (slot && (slot.type === 'text' || slot.type === 'thinking')) slot.text += delta
    this.deltas.queue(message.id, this.streamSlot.index, delta)
  }

  private applyToolCall(call: GrokToolCall): void {
    if (!call.toolCallId) return
    // A plan hand-off is a tool call on the wire and a review panel here, so it
    // draws no card. The id is remembered because only the *first* payload for
    // the call identifies it: the closing update carries `_meta: null`, which
    // `isExitPlanTool` cannot recognize, and without the id it would fall
    // through and open a stray unnamed card in the error state — one per plan.
    if (isExitPlanTool(call)) this.planToolIds.add(call.toolCallId)
    if (this.planToolIds.has(call.toolCallId)) {
      // A failed exit is the agent being told it may not leave plan mode yet;
      // there is no plan to review in that case.
      if (call.status !== 'failed') this.offerPlanForReview()
      return
    }
    const existing = this.toolLoc.get(call.toolCallId)
    if (!existing) {
      const message = this.ensureCurrent()
      const part: ToolPart = {
        type: 'tool',
        toolUseId: call.toolCallId,
        name: toolName(call),
        input: call.rawInput,
        status: toolStatus(call.status)
      }
      message.parts.push(part)
      const index = message.parts.length - 1
      this.toolLoc.set(call.toolCallId, { message, index })
      // A tool ends the current text run: the next chunk starts a fresh part
      // below it rather than appending above where the card now sits.
      this.streamSlot = null
      this.emitPart(message, index)
      return
    }
    const part = existing.message.parts[existing.index]
    if (!part || part.type !== 'tool') return
    const patch: Partial<ToolPart> = {}
    if (call.status) patch.status = toolStatus(call.status)
    if (call.rawInput !== undefined) patch.input = call.rawInput
    // `tool_call_update` re-titles the call once it knows what it is doing
    // ("Read" becomes "Read `/tmp/app/math.js`"); the later title is the better
    // one. A status-only update names nothing and must leave the card alone.
    const name = toolNameIfNamed(call)
    if (name && name !== part.name) patch.name = name
    const output = toolOutput(call)
    if (output !== undefined) patch.output = output
    if (patch.status === 'error' && !patch.output && part.output === undefined) {
      patch.output = output ?? 'Tool failed.'
    }
    Object.assign(part, patch)
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId: existing.message.id,
      toolUseId: call.toolCallId,
      patch
    })
    this.store.saveChatSoon(this.chat.id)
  }

  private applyTitle(title: string | undefined): void {
    const clean = title?.trim()
    if (!clean || this.chat.titleManual) return
    if (this.chat.title === clean) return
    this.chat.title = clean
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { title: clean } })
    this.store.saveChatSoon(this.chat.id)
  }

  private handleModels(state: GrokModelState): void {
    this.models = { ...this.models, ...state }
  }

  private handleCommands(commands: GrokCommand[]): void {
    this.commands = commands
    this.onCommands(
      commands.map((command) => ({
        name: command.name,
        description: command.description ?? '',
        argumentHint: command.input?.hint
      }))
    )
    this.emit({
      type: 'commands',
      chatId: this.chat.id,
      cwd: this.chat.cwd,
      commands: this.commands.map((command) => ({
        name: command.name,
        description: command.description ?? '',
        argumentHint: command.input?.hint
      }))
    })
  }

  // ---------- Permissions ----------

  private handlePermission(request: GrokPermissionRequest): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (this.disposed) {
        resolve(null)
        return
      }
      const requestId = randomUUID()
      this.permissions.set(requestId, { resolve, request })
      const tool = request.toolCall
      this.emit({
        type: 'permission-request',
        chatId: this.chat.id,
        request: {
          id: requestId,
          chatId: this.chat.id,
          toolUseId: tool.toolCallId ?? `grok-${requestId}`,
          toolName: toolName(tool),
          input: tool.rawInput,
          title: tool.title,
          displayName: tool._meta?.['x.ai/tool']?.label,
          hasSuggestions: request.options.some((option) => option.kind?.startsWith('allow_always'))
        }
      })
      this.setStatus('waiting-permission')
    })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.permissions.get(requestId)
    if (pending) {
      this.permissions.delete(requestId)
      const options = pending.request.options
      const wanted =
        decision.behavior === 'allow'
          ? decision.always
            ? ['allow_always', 'allow_once']
            : ['allow_once', 'allow_always']
          : ['reject_once', 'reject_always']
      const option =
        wanted.map((kind) => options.find((entry) => entry.kind === kind)).find(Boolean) ??
        (decision.behavior === 'allow' ? options[0] : options[options.length - 1])
      pending.resolve(option?.optionId ?? null)
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
      this.setStatus(
        this.running ? 'streaming' : this.permissions.size ? 'waiting-permission' : 'idle'
      )
      return
    }
    if (this.planReview?.requestId === requestId) this.resolvePlanReview(decision)
  }

  pendingPlan(requestId: string): string | null {
    return this.planReview?.requestId === requestId ? this.planReview.plan : null
  }

  private rejectAllPermissions(): void {
    for (const [requestId, pending] of this.permissions) {
      pending.resolve(null)
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    }
    this.permissions.clear()
  }

  /**
   * Grok writes its plan to `plan.md` in the session directory and its
   * `exit_plan_mode` call carries an empty input, so the file *is* the plan —
   * there is nothing on the wire to read it from. The directory name is the
   * percent-encoded cwd, which is how the CLI itself keys sessions per folder.
   */
  private readPlanFile(): string {
    if (!this.sessionId) return ''
    const home = process.env.GROK_HOME ?? join(homedir(), '.grok')
    const path = join(home, 'sessions', encodeURIComponent(this.chat.cwd), this.sessionId, 'plan.md')
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {
      // An empty plan still opens the review — the CLI does the same, so the
      // user can approve and start building rather than being stuck.
      return ''
    }
  }

  /**
   * Grok never gates `exit_plan_mode`: the tool simply succeeds and the turn
   * ends, in every permission mode including plain ask — verified against 1.0.3.
   * So the review is *synthesized* from the tool call rather than bridged from a
   * pending request, and approving it has to start a new turn, because there is
   * no suspended one to release. That makes it Codex's shape, not Claude's.
   */
  private offerPlanForReview(): void {
    if (this.planReview) return
    const requestId = randomUUID()
    const review: PersistedPlanReview = {
      requestId,
      plan: this.readPlanFile(),
      userMessageId: this.activeUserMessageId ?? randomUUID()
    }
    this.planReview = review
    this.chat.pendingPlanReview = review
    this.store.saveChat(this.chat.id)
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { pendingPlanReview: review } })
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: requestId,
        chatId: this.chat.id,
        toolUseId: `grok-plan-${requestId}`,
        toolName: 'ExitPlanMode',
        input: { plan: review.plan },
        title: 'Review plan',
        displayName: 'Grok plan',
        description: 'Approve this plan to implement it, or request a revision.',
        hasSuggestions: false
      }
    })
    this.setStatus('waiting-permission')
  }

  private clearPlanReview(): void {
    const review = this.planReview ?? this.chat.pendingPlanReview
    if (!review) return
    this.planReview = null
    this.chat.pendingPlanReview = undefined
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { pendingPlanReview: undefined } })
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId: review.requestId })
    this.store.saveChat(this.chat.id)
  }

  /**
   * Approve or reject a plan. Approval restores the permission mode planning
   * replaced, applies any "Build with" model/effort, and sends the plan back as
   * the next turn — the plan text itself is the instruction, so nothing about
   * the conversation has to be re-derived.
   */
  private resolvePlanReview(decision: PermissionDecision): void {
    const review = this.planReview
    if (!review) return
    this.clearPlanReview()
    if (decision.behavior !== 'allow') {
      this.setStatus('idle')
      return
    }
    const prior = this.chat.modeBeforePlan
    const restore = prior && prior !== 'plan' ? prior : 'default'
    this.chat.modeBeforePlan = undefined
    this.chat.permissionMode = restore
    const patch: Partial<ChatMeta> = { permissionMode: restore, modeBeforePlan: undefined }
    if (decision.model !== undefined) {
      const next = decision.model || undefined
      if (next !== this.chat.model) {
        this.chat.model = next
        patch.model = next
      }
    }
    if (decision.effort !== undefined) {
      this.chat.effort = effortForProvider(decision.effort || undefined, 'grok')
      patch.effort = this.chat.effort
    }
    this.emit({ type: 'meta', chatId: this.chat.id, patch })
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'info',
      text: 'Plan approved. Grok is implementing it.',
      ts: Date.now()
    })
    const turn: PendingTurn = {
      text: `The user approved the following plan. Implement it completely now.\n\n<approved_plan>\n${review.plan}\n</approved_plan>`,
      attachments: [],
      userMessageId: review.userMessageId
    }
    this.queued.add(turn)
    this.setStatus('streaming')
    this.sendChain = this.sendChain.then(async () => {
      if (!this.queued.delete(turn)) return
      await this.runTurn(turn)
    })
  }

  // ---------- Controls ----------

  async interrupt(): Promise<void> {
    this.interrupted = true
    this.queued.clear()
    if (this.sessionId) this.client?.cancel(this.sessionId)
    this.rejectAllPermissions()
    this.running = false
    this.deltas.flush()
    this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    this.chat.model = model
    const target = this.launchModel()
    if (!target || !this.client?.alive || !this.sessionId) return
    try {
      await this.client.setModel(this.sessionId, target)
    } catch {
      // A refused switch leaves the running agent on its current model; the
      // next respawn picks the new one up from the launch flag regardless.
    }
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.chat.permissionMode = mode
    if (this.client?.alive) await this.applyLiveMode(this.client)
    // The yolo/auto baseline is fixed at session creation; `ensureClient` sees
    // the changed key on the next send and respawns.
  }

  async stopBackgroundJob(): Promise<void> {
    // Grok runs background terminals inside its own process and exposes no
    // per-job stop over ACP; `BackgroundJob.stoppable` is false for this chat.
  }

  async rewindFiles(): Promise<RewindResult> {
    return { canRewind: false, error: 'Grok does not support file checkpoints.' }
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return []
  }

  async mcpReconnect(): Promise<OpResult> {
    return { ok: false, error: 'Grok manages MCP servers in its own config.' }
  }

  async mcpToggle(): Promise<OpResult> {
    return { ok: false, error: 'Grok manages MCP servers in its own config.' }
  }

  /**
   * The live catalog, which is the only complete one: xAI ships models without
   * a Carbon release, and the handshake names every id the account can reach.
   */
  async listModels(): Promise<ModelOption[]> {
    return grokModelOptions(this.models)
  }

  async listAgents(): Promise<AgentInfo[]> {
    return []
  }

  async accountInfo(): Promise<AccountInfo | null> {
    return null
  }

  async usageInfo(): Promise<UsageInfo | null> {
    return null
  }
}

// ---------- Catalog and one-shots ----------

/** The live catalog as picker rows, with the Default row ahead of the models. */
export function grokModelOptions(state: GrokModelState | null): ModelOption[] {
  const models = state?.availableModels ?? []
  if (!models.length) return []
  return [
    {
      id: GROK_DEFAULT_MODEL,
      label: 'Grok (default)',
      description: 'Model from your Grok config',
      provider: 'grok'
    },
    ...models.map((model): ModelOption => {
      const efforts = model._meta?.reasoningEfforts
        ?.map((effort) => effortForProvider(effort.id as never, 'grok'))
        .filter((effort): effort is NonNullable<typeof effort> => !!effort)
      return {
        id: model.modelId,
        label: model.name?.trim() || model.modelId,
        description: model.description?.trim() || 'xAI Grok Build',
        provider: 'grok',
        ...(model._meta?.totalContextTokens
          ? { contextWindow: model._meta.totalContextTokens }
          : {}),
        ...(efforts?.length ? { supportedEfforts: efforts } : {})
      }
    })
  ]
}

/**
 * The account's models without a chat, for the picker and the new-chat screen.
 *
 * This costs no tokens: the catalog rides the ACP handshake, so the agent is
 * spawned, `initialize` is answered, and the process is killed before a session
 * even exists. That is why it is preferred over `grok -p`, which would run a
 * real turn to learn the same list.
 */
export async function fetchGrokModels(cwd: string): Promise<ModelOption[]> {
  if (!grokInstalled()) return []
  let client: GrokAcpClient | null = null
  try {
    client = new GrokAcpClient({
      cwd,
      callbacks: {
        onUpdate: () => {},
        onPermission: async () => null,
        onModels: () => {},
        onCommands: () => {},
        onExit: () => {}
      }
    })
    const state = await withTimeout(client.start(), MODEL_PROBE_TIMEOUT_MS, undefined)
    return grokModelOptions(state ?? null)
  } catch {
    return []
  } finally {
    client?.dispose()
  }
}

/**
 * One-shot generation for the cross-provider handoff brief and titles, on the
 * headless transport rather than ACP — `-p` is a single request/response with no
 * session to create, resume or tear down, which is exactly the shape a
 * throwaway needs. `--always-approve` cannot escalate anything here because the
 * prompt asks for prose and the turn ends at the first reply.
 */
export async function generateGrokText(
  cwd: string,
  model: string | undefined,
  prompt: string
): Promise<string | null> {
  if (!grokInstalled()) return null
  const args = ['-p', prompt, '--output-format', 'json', '--always-approve']
  if (model && model !== GROK_DEFAULT_MODEL) args.push('--model', model)
  return new Promise<string | null>((resolve) => {
    const child = spawn(resolveGrokBinary(), args, {
      cwd,
      env: { ...process.env, GROK_OAUTH2_REFERRER: GROK_OAUTH_REFERRER, GROK_NO_AUTO_UPDATE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    const done = (value: string | null): void => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, ONE_SHOT_TIMEOUT_MS)
    child.once('error', () => done(null))
    child.once('exit', () => {
      try {
        const text = (JSON.parse(out) as { text?: string }).text?.trim()
        done(text || null)
      } catch {
        done(null)
      }
    })
  })
}

// ---------- Pure helpers ----------

function textOf(content: { text?: string } | undefined): string {
  return content?.text ?? ''
}

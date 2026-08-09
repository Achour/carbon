import { randomUUID } from 'node:crypto'
import type {
  AssistantMessage,
  AssistantPart,
  Attachment,
  ChatData,
  ChatStatus,
  EffortId,
  McpServerInfo,
  ModelOption,
  OpencodeAgentInfo,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  PersistedPlanReview,
  RewindResult,
  ToolPart,
  AgentInfo,
  AccountInfo,
  UsageInfo,
  TurnStats
} from '@shared/types'
import type { Store } from './store'
import { composePrompt, type AgentSession, type Emit } from './session.ts'
import { DeltaCoalescer } from './deltaCoalescer.ts'
import { buildTitlePrompt, cleanTitle, deriveTitle, firstUserText, TITLE_SYSTEM } from './titles.ts'
import {
  captureWorkspaceTree,
  rewindWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceTree
} from './workspaceCheckpoint.ts'
import {
  addStepUsage,
  emptyUsage,
  extractPlan,
  partToAssistantPart,
  permissionDiff,
  permissionToolName,
  todosToToolPart,
  type OpencodePart,
  type OpencodePermissionAsked,
  type TurnUsage
} from './opencodeEvents.ts'
import { agentForChat, decisionToReply, primaryAgents } from './opencodeMode.ts'
import { buildApprovedPlanPrompt, buildPlanFeedbackPrompt } from './opencodePlan.ts'
import { mapProviderList, parseOpencodeModelId } from './opencodeModels.ts'
import { missingBinaryError, probeOpencode } from './opencodeBinary.ts'
import {
  opencodeClient,
  type OpencodeClientLike,
  type OpencodeEvent,
  type OpencodePromptBody
} from './opencodeServer.ts'

/**
 * OpenCode as an `AgentSession`.
 *
 * The third backend, and the only one the user installs themselves. Structurally
 * it is closest to `CodexSession` — a warm client, a serialized send chain, a
 * synthesized plan review — with two differences that come from the server:
 *
 * - **Text arrives as true incremental deltas** (`message.part.delta`), so this
 *   takes ClaudeSession's straightforward coalescing path rather than Codex's
 *   suffix-diffing of re-sent whole parts.
 * - **A turn's completion is the prompt POST resolving.** That endpoint is
 *   synchronous; `session.idle` corroborates it but is not relied on alone,
 *   because an idle can also arrive between the steps of a single turn.
 */

/** A turn snapshotted at send time, so later option changes can't rewrite it. */
interface PendingTurn {
  text: string
  attachments: Attachment[]
  userMessageId: string
  permissionMode: PermissionModeId
  /** Resolved primary agent — plan mode overrides the chat's stored pick. */
  agent: string
  model: string | undefined
  effort: EffortId | undefined
}

interface PendingPermission {
  id: string
  toolName: string
}

const TURN_STATS_MIN_TOKENS = 1

export class OpencodeSession implements AgentSession {
  private chat: ChatData
  private emit: Emit
  private store: Store
  private client: OpencodeClientLike
  private unsubscribe: (() => void) | null = null

  private sessionId: string | null
  private pending: PendingTurn[] = []
  private sendChain: Promise<void> = Promise.resolve()
  /** Turns still in the chain, so interrupt/dispose can drop them synchronously. */
  private chainQueued = new Set<PendingTurn>()
  private running = false
  private interrupted = false
  private current: AssistantMessage | null = null
  /** OpenCode part id → where it lives in the current assistant message. */
  private partLoc = new Map<string, { message: AssistantMessage; index: number }>()
  /**
   * OpenCode message id → role.
   *
   * The server echoes the user's own prompt back as a text part, so without this
   * every message would appear twice — once as the user typed it and again as
   * assistant prose. Populated from `message.updated`, which the server always
   * sends for a message before any of its parts.
   */
  private messageRoles = new Map<string, string>()
  /** The single checklist card for this turn. */
  private todoLoc: { message: AssistantMessage; index: number; toolUseId: string } | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private planReview: PersistedPlanReview | null
  private checkpoints = new Map<string, WorkspaceCheckpoint>()
  private turnUsage: TurnUsage = emptyUsage()
  private turnStart = 0
  /** Which model the server actually served this turn with. */
  private turnModel: string | undefined
  /** Workspace tree captured at turn start; paired with an 'after' at turn end. */
  private turnBefore: WorkspaceTree | null = null
  private lastEmittedStatus: ChatStatus | null = null
  /** Resolves the in-flight turn when the server says it is over. */
  private turnDone: (() => void) | null = null

  private readonly deltas = new DeltaCoalescer(
    (ev) => this.emit(ev),
    () => this.chat.id,
    () => this.store.saveChatSoon(this.chat.id),
    () => this.disposed
  )

  dead = false
  private disposed = false
  private titledOnce = false
  private titlePending = false
  private readonly titledResumed: boolean

  get idle(): boolean {
    return (
      !this.running &&
      this.pending.length === 0 &&
      this.chainQueued.size === 0 &&
      this.pendingPermissions.size === 0 &&
      // A chat parked on a plan review must never be LRU-evicted: the review is
      // the only thing holding the conversation open.
      !this.planReview
    )
  }

  constructor(
    chat: ChatData,
    emit: Emit,
    store: Store,
    _onDead: () => void,
    client?: OpencodeClientLike
  ) {
    this.chat = chat
    this.emit = emit
    this.store = store
    // Thrown here rather than at send time so ChatManager.deliver's catch turns
    // it into the chat's error message — the one place the user finds out why.
    if (!client && knownMissing) throw missingBinaryError()
    this.client = client ?? opencodeClient(chat.cwd)
    this.sessionId = chat.sessionId ?? null
    this.planReview = chat.pendingPlanReview ?? null
    this.titledResumed = !!chat.sessionId
  }

  // ---------- emit helpers ----------

  private setStatus(status: ChatStatus): void {
    if (this.disposed || this.lastEmittedStatus === status) return
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

  private pushEvent(kind: 'error' | 'info', text: string): void {
    this.pushMessage({ id: randomUUID(), role: 'event', kind, text, ts: Date.now() })
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
    // Authoritative: drop any buffered delta for this slot so the renderer isn't
    // handed an append on top of text it is about to be given in full.
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

  // ---------- sending ----------

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
    const messageId = randomUUID()
    this.pushMessage({
      id: messageId,
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {}),
      ...(label ? { label } : {})
    })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
    // Lock the composer now: the turn may still be waiting on its handoff
    // context, and drain() wouldn't flip the status until that resolves.
    this.setStatus(this.sessionId ? 'streaming' : 'starting')

    const turn: PendingTurn = {
      text,
      attachments,
      userMessageId: messageId,
      permissionMode: this.chat.permissionMode,
      agent: agentForChat(this.chat.opencodeAgent, this.chat.permissionMode),
      model: this.chat.model,
      effort: this.chat.effort
    }
    this.chainQueued.add(turn)
    this.sendChain = this.sendChain.then(async () => {
      let ctx: string | undefined
      try {
        ctx = (await hiddenContext) || undefined
      } catch {
        ctx = undefined
      }
      // Swept while waiting (interrupt/dispose): dropped, never queued.
      if (!this.chainQueued.delete(turn)) return
      if (ctx) turn.text = composePrompt(turn.text, ctx)
      this.pending.push(turn)
      void this.drain()
    })
  }

  /** Queue a turn the app itself composed (plan approval, plan revision). */
  private enqueueInternal(text: string, userMessageId: string, mode?: PermissionModeId): void {
    this.pending.push({
      text,
      attachments: [],
      userMessageId,
      permissionMode: mode ?? this.chat.permissionMode,
      agent: agentForChat(this.chat.opencodeAgent, mode ?? this.chat.permissionMode),
      model: this.chat.model,
      effort: this.chat.effort
    })
    void this.drain()
  }

  private async ensureSession(agent: string): Promise<string> {
    if (this.sessionId) return this.sessionId
    const created = await this.client.createSession({
      ...(this.chat.title ? { title: this.chat.title } : {}),
      agent
    })
    this.sessionId = created.id
    this.chat.sessionId = created.id
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { sessionId: created.id } })
    this.store.saveChat(this.chat.id)
    return created.id
  }

  private attach(sessionID: string): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.client.subscribe(sessionID, (event) => this.handleEvent(event))
  }

  private promptBody(turn: PendingTurn): OpencodePromptBody {
    const ref = parseOpencodeModelId(turn.model)
    return {
      ...(ref ? { model: ref } : {}),
      // Per turn, so switching agent takes effect without a new session.
      agent: turn.agent,
      // '' means "the model's own default", which is the absence of a variant.
      ...(turn.effort ? { variant: turn.effort } : {}),
      parts: [
        { type: 'text', text: turn.text },
        // Images ride as data URLs; OpenCode stores the part and hands the model
        // whatever its provider supports.
        ...turn.attachments
          .filter((a) => a.kind === 'image' && a.data)
          .map((a) => ({
            type: 'file',
            mime: a.mediaType ?? 'image/png',
            filename: a.name,
            url: `data:${a.mediaType ?? 'image/png'};base64,${a.data}`
          }))
      ]
    }
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (this.pending.length && !this.disposed) {
        const turn = this.pending.shift() as PendingTurn
        await this.runTurn(turn)
      }
    } finally {
      this.running = false
      if (!this.disposed && !this.pending.length) {
        this.setStatus(this.pendingPermissions.size || this.planReview ? 'waiting-permission' : 'idle')
      }
    }
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    this.interrupted = false
    this.current = null
    this.partLoc.clear()
    this.messageRoles.clear()
    this.todoLoc = null
    this.turnUsage = emptyUsage()
    this.turnStart = Date.now()
    this.turnModel = undefined
    // Captured before the turn and paired with an 'after' when it ends, so a
    // rewind can restore exactly what this turn changed. Deliberately the same
    // provider-agnostic git-tree mechanism Codex uses rather than OpenCode's own
    // revert API, whose semantics we have not verified.
    this.turnBefore = await captureWorkspaceTree(this.chat.cwd).catch(() => null)

    let sessionID: string
    try {
      sessionID = await this.ensureSession(turn.agent)
    } catch (err) {
      this.pushEvent('error', err instanceof Error ? err.message : String(err))
      return
    }
    this.attach(sessionID)
    this.setStatus('streaming')

    const done = new Promise<void>((resolve) => {
      this.turnDone = resolve
    })
    try {
      // The prompt POST resolves when the turn is over; race it against the
      // idle/error events so whichever lands first ends the turn exactly once.
      await Promise.race([this.client.prompt(sessionID, this.promptBody(turn)), done])
    } catch (err) {
      if (!this.interrupted) {
        this.pushEvent('error', err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.turnDone = null
      this.deltas.flush()
      await this.finishTurn(turn.userMessageId)
      void this.maybeGenerateTitle()
      this.offerPlanForReview(turn)
    }
  }

  private async finishTurn(userMessageId: string): Promise<void> {
    const before = this.turnBefore
    this.turnBefore = null
    if (before) {
      const after = await captureWorkspaceTree(this.chat.cwd).catch(() => null)
      // Same root only: a turn that relocated the chat has no comparable pair.
      if (after && after.root === before.root) {
        this.checkpoints.set(userMessageId, { before, after })
      }
    }
    const usage = this.turnUsage
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    if (tokens < TURN_STATS_MIN_TOKENS || this.disposed) return
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'turn',
      text: '',
      ts: Date.now(),
      stats: {
        costUsd: usage.costUsd,
        durationMs: Date.now() - this.turnStart,
        numTurns: 1,
        // Cache reads are folded into input: TurnStats has no cache fields, and
        // dropping them would under-report a cached turn by an order of magnitude.
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
        ...(this.turnModel ? { model: this.turnModel } : {})
      }
    })
  }

  // ---------- events ----------

  private handleEvent(event: OpencodeEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'message.updated':
        // Which model actually served the turn, for the turn-stats row. Only
        // recorded — the chat's own model is the user's pick and is not rewritten
        // from what the server happened to resolve.
        if (event.messageID && event.role) this.messageRoles.set(event.messageID, event.role)
        if (event.role === 'assistant' && event.modelID) {
          this.turnModel = event.providerID ? `${event.providerID}/${event.modelID}` : event.modelID
        }
        break
      case 'message.part.updated':
        this.applyPart(event.part)
        break
      case 'message.part.delta':
        this.applyDelta(event.partID, event.delta)
        break
      case 'message.part.removed':
        this.removePart(event.partID)
        break
      case 'todo.updated':
        this.applyTodos(event.todos)
        break
      case 'permission.asked':
        void this.handlePermission(event.request)
        break
      case 'permission.replied':
        // Also fires for a reply made from the user's own TUI against this
        // session — resolve our card rather than leaving it stranded.
        this.resolvePermission(event.permissionID, false)
        break
      case 'session.error':
        this.pushEvent('error', event.message)
        this.endTurn()
        break
      case 'session.idle':
        this.endTurn()
        break
      case 'resync':
        void this.resync()
        break
      case 'server-lost':
        this.failActiveTurn(event.message)
        break
      default:
        break
    }
  }

  private endTurn(): void {
    const resolve = this.turnDone
    this.turnDone = null
    resolve?.()
  }

  private applyPart(raw: OpencodePart): void {
    if (!raw.id) return
    // The user's own prompt comes back as a text part on their message; Carbon
    // has already shown it, and rendering it again would double every turn.
    if (raw.messageID && this.messageRoles.get(raw.messageID) === 'user') return
    this.turnUsage = addStepUsage(this.turnUsage, raw)
    const mapped = partToAssistantPart(raw)
    if (!mapped) return

    const existing = this.partLoc.get(raw.id)
    if (existing) {
      existing.message.parts[existing.index] = mapped
      this.emitPart(existing.message, existing.index)
      return
    }
    const message = this.ensureCurrent()
    const index = message.parts.length
    message.parts.push(mapped)
    this.partLoc.set(raw.id, { message, index })
    this.emitPart(message, index)
  }

  private applyDelta(partID: string, delta: string): void {
    const loc = this.partLoc.get(partID)
    if (!loc || !delta) return
    const part = loc.message.parts[loc.index]
    if (!part || (part.type !== 'text' && part.type !== 'thinking')) return
    // Keep the stored part in step with what the renderer is being appended, so
    // a reload mid-stream shows the same text.
    part.text += delta
    this.deltas.queue(loc.message.id, loc.index, delta)
  }

  private removePart(partID: string): void {
    const loc = this.partLoc.get(partID)
    if (!loc) return
    loc.message.parts[loc.index] = { type: 'text', text: '' }
    this.partLoc.delete(partID)
    this.emitPart(loc.message, loc.index)
  }

  private applyTodos(todos: Parameters<typeof todosToToolPart>[0]): void {
    if (!todos.length) return
    if (this.todoLoc) {
      const part = todosToToolPart(todos, this.todoLoc.toolUseId)
      this.todoLoc.message.parts[this.todoLoc.index] = part
      this.emitPart(this.todoLoc.message, this.todoLoc.index)
      return
    }
    const toolUseId = `opencode-todo-${randomUUID()}`
    const message = this.ensureCurrent()
    const index = message.parts.length
    message.parts.push(todosToToolPart(todos, toolUseId))
    this.todoLoc = { message, index, toolUseId }
    this.emitPart(message, index)
  }

  /**
   * Re-read authoritative state after the event stream reconnected.
   *
   * The bus replays nothing, so anything that happened during the gap is only
   * visible by asking. Parts are keyed by id, so replaying them is idempotent.
   */
  private async resync(): Promise<void> {
    if (!this.sessionId || this.disposed) return
    try {
      const messages = await this.client.listMessages(this.sessionId)
      for (const message of messages) {
        for (const part of message.parts ?? []) this.applyPart(part)
      }
    } catch {
      // A failed resync is not fatal: the next event or the prompt's own
      // resolution still ends the turn.
    }
  }

  private failActiveTurn(message: string): void {
    this.denyAllPermissions()
    if (this.running) this.pushEvent('error', message)
    this.endTurn()
  }

  // ---------- permissions ----------

  private async handlePermission(request: OpencodePermissionAsked): Promise<void> {
    const id = request.id
    if (!id || this.disposed) return
    const toolName = permissionToolName(request.permission)
    this.pendingPermissions.set(id, { id, toolName })
    const diff = permissionDiff(request)
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id,
        chatId: this.chat.id,
        toolName,
        toolUseId: request.tool?.callID ?? id,
        input: {
          ...(request.metadata ?? {}),
          ...(request.patterns?.length ? { patterns: request.patterns } : {}),
          ...(diff ? { diff } : {})
        },
        // OpenCode offers its own "always" scope, so Carbon's always-allow
        // maps onto a real server-side rule rather than a local guess.
        hasSuggestions: !!request.always?.length
      }
    })
    this.setStatus('waiting-permission')
  }

  private resolvePermission(id: string, emitResolved = true): void {
    if (!this.pendingPermissions.delete(id)) return
    if (emitResolved || true) {
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId: id })
    }
    if (!this.disposed && this.pendingPermissions.size === 0 && this.running) {
      this.setStatus('streaming')
    }
  }

  private denyAllPermissions(): void {
    for (const id of [...this.pendingPermissions.keys()]) {
      void this.client.replyPermission(id, 'reject').catch(() => undefined)
      this.resolvePermission(id)
    }
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (requestId === this.planReview?.requestId) {
      this.resolvePlanReview(decision)
      return
    }
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    const reply = decisionToReply(decision)
    const message = decision.behavior === 'deny' ? decision.message : undefined
    void this.client.replyPermission(requestId, reply, message).catch(() => undefined)
    this.resolvePermission(requestId)
  }

  // ---------- plan review ----------

  /**
   * Turn a finished plan-mode turn into Carbon's plan review.
   *
   * Same shape as Codex's: a synthetic `ExitPlanMode` permission request, with
   * the review persisted on the chat so it survives a restart. OpenCode's plan
   * agent has no notion of "propose and wait" — it simply answers — so the wait
   * is Carbon's, layered on top.
   */
  private offerPlanForReview(turn: PendingTurn): void {
    if (this.disposed || this.interrupted) return
    if (turn.permissionMode !== 'plan' || this.chat.permissionMode !== 'plan') return
    if (this.planReview) return
    const plan = extractPlan(this.current?.parts ?? [])
    if (!plan) return

    const review: PersistedPlanReview = {
      requestId: `opencode-plan-${randomUUID()}`,
      plan,
      userMessageId: turn.userMessageId
    }
    this.planReview = review
    this.chat.pendingPlanReview = review
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { pendingPlanReview: review } })
    this.store.saveChat(this.chat.id)
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: review.requestId,
        chatId: this.chat.id,
        toolName: 'ExitPlanMode',
        toolUseId: review.requestId,
        input: { plan },
        hasSuggestions: false
      }
    })
    this.setStatus('waiting-permission')
  }

  private clearPlanReview(): void {
    const review = this.planReview
    this.planReview = null
    this.chat.pendingPlanReview = undefined
    if (!review) return
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId: review.requestId })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { pendingPlanReview: undefined } })
    this.store.saveChat(this.chat.id)
  }

  private resolvePlanReview(decision: PermissionDecision): void {
    const review = this.planReview
    if (!review) return
    this.clearPlanReview()
    if (decision.behavior === 'allow') {
      const restored = this.chat.modeBeforePlan ?? 'default'
      this.chat.modeBeforePlan = undefined
      this.chat.permissionMode = restored
      if (decision.model) this.chat.model = decision.model
      this.emit({
        type: 'meta',
        chatId: this.chat.id,
        patch: { permissionMode: restored, model: this.chat.model, modeBeforePlan: undefined }
      })
      this.store.saveChat(this.chat.id)
      // No session reset: the agent rides each prompt, so the implementation
      // turn simply runs as `build` on the same session — and keeps the server's
      // own memory of the planning conversation.
      this.enqueueInternal(buildApprovedPlanPrompt(review.plan), review.userMessageId, restored)
      return
    }
    const feedback = decision.message?.trim() ?? ''
    if (!feedback) {
      this.setStatus('idle')
      return
    }
    const feedbackId = randomUUID()
    this.pushMessage({ id: feedbackId, role: 'user', text: feedback, ts: Date.now() })
    this.enqueueInternal(buildPlanFeedbackPrompt(review.plan, feedback), feedbackId, 'plan')
  }

  // ---------- titles ----------

  private async maybeGenerateTitle(): Promise<void> {
    if (this.disposed || this.titledOnce || this.titledResumed || this.chat.titleManual) return
    // A windowed chat's opening message may not be hydrated; titling from a
    // partial history would name the chat after the middle of it.
    if (this.store.hiddenBefore(this.chat.id) > 0) return
    const userText = firstUserText(this.chat.messages)
    if (!userText) return
    this.titledOnce = true
    this.setTitlePending(true)
    try {
      const out = await generateOpencodeText(
        this.chat.cwd,
        this.chat.model,
        `${TITLE_SYSTEM}\n\n${buildTitlePrompt(userText)}`,
        this.client
      )
      const title = out ? cleanTitle(out) : null
      if (title && !this.disposed && !this.chat.titleManual) {
        this.chat.title = title
        this.emit({ type: 'meta', chatId: this.chat.id, patch: { title } })
        this.store.saveChatSoon(this.chat.id)
      }
    } finally {
      this.setTitlePending(false)
    }
  }

  private setTitlePending(pending: boolean): void {
    if (this.titlePending === pending) return
    this.titlePending = pending
    this.emit({ type: 'title-pending', chatId: this.chat.id, pending })
  }

  // ---------- AgentSession surface ----------

  async interrupt(): Promise<void> {
    this.interrupted = true
    this.chainQueued.clear()
    this.pending = []
    this.denyAllPermissions()
    this.clearPlanReview()
    if (this.sessionId) await this.client.abort(this.sessionId).catch(() => undefined)
    this.endTurn()
    this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    // Applied per prompt, so the next turn simply carries the new value.
    this.chat.model = model
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    if (this.chat.permissionMode === mode) return
    this.chat.permissionMode = mode
    if (mode !== 'plan') this.clearPlanReview()
    // Nothing to rebuild: build↔plan is the `agent` on the next prompt.
  }

  async stopBackgroundJob(): Promise<void> {
    // OpenCode has no background-job concept Carbon surfaces.
  }

  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const checkpoint = this.checkpoints.get(userMessageId)
    if (!checkpoint) {
      return { canRewind: false, error: 'No file checkpoint was captured for this message.' }
    }
    return await rewindWorkspaceCheckpoint(this.chat.cwd, checkpoint, dryRun)
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return []
  }

  async mcpReconnect(): Promise<OpResult> {
    return { ok: false, error: 'OpenCode manages MCP servers through its own config.' }
  }

  async mcpToggle(): Promise<OpResult> {
    return { ok: false, error: 'OpenCode manages MCP servers through its own config.' }
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      return mapProviderList((await this.client.listProviders()) as never)
    } catch {
      return []
    }
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

  pendingPlan(requestId: string): string | null {
    return this.planReview?.requestId === requestId ? this.planReview.plan : null
  }

  dispose(): void {
    // Set first: every late async continuation checks it before emitting.
    this.disposed = true
    this.dead = true
    this.setTitlePending(false)
    this.deltas.flush()
    this.chainQueued.clear()
    this.pending = []
    this.denyAllPermissions()
    if (this.sessionId) void this.client.abort(this.sessionId).catch(() => undefined)
    this.endTurn()
    this.unsubscribe?.()
    this.unsubscribe = null
    // The server is shared with other chats in this directory — never touched here.
  }
}

// ---------- module-level helpers ----------

/**
 * Whether the binary is known to be absent, so the constructor can fail fast.
 * Refreshed by `fetchOpencodeModels`, which every launch calls during model warmup.
 */
let knownMissing = false

/**
 * A throwaway one-shot on OpenCode: used for the handoff brief when switching
 * away from it, and for AI chat titles.
 *
 * Never throws and never leaves a session behind — a failure here must degrade
 * to "no brief", not to a failed turn.
 */
export async function generateOpencodeText(
  cwd: string,
  model: string | undefined,
  prompt: string,
  existing?: OpencodeClientLike
): Promise<string | null> {
  const client = existing ?? opencodeClient(cwd)
  let sessionId: string | null = null
  try {
    const ref = parseOpencodeModelId(model)
    const created = await client.createSession({ title: 'Carbon internal', agent: 'plan' })
    sessionId = created.id
    const result = (await client.prompt(created.id, {
      ...(ref ? { model: ref } : {}),
      // The plan agent, because this one-shot must not touch the workspace
      // whatever it is asked — it only summarizes a transcript.
      agent: 'plan',
      parts: [{ type: 'text', text: prompt }]
    })) as { parts?: OpencodePart[] } | null
    const text = (result?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    return text || null
  } catch {
    return null
  } finally {
    if (sessionId) void client.deleteSession(sessionId).catch(() => undefined)
  }
}

/**
 * OpenCode's picker rows, or none when it isn't installed.
 *
 * Probing first is what keeps the model warmup cheap on the majority of machines
 * that have no OpenCode at all: one `--version` rather than spawning a server.
 */
export async function fetchOpencodeModels(cwd: string): Promise<ModelOption[]> {
  const probe = await probeOpencode()
  knownMissing = !probe.installed
  if (!probe.installed) return []
  try {
    return mapProviderList((await opencodeClient(cwd).listProviders()) as never)
  } catch {
    return []
  }
}

/**
 * OpenCode's primary agents for a directory — what the mode picker offers.
 *
 * Empty means "couldn't ask", not "none": the renderer falls back to
 * `OPENCODE_BUILTIN_AGENTS` rather than showing an empty picker, and keeps no
 * cache entry, so the next chat in a directory that does have OpenCode retries.
 */
export async function fetchOpencodeAgents(cwd: string): Promise<OpencodeAgentInfo[]> {
  const probe = await probeOpencode()
  knownMissing = !probe.installed
  if (!probe.installed) return []
  try {
    return primaryAgents(await opencodeClient(cwd).listAgents())
  } catch {
    return []
  }
}

/** Test seam: reset the cached probe result between cases. */
export function __setOpencodeMissing(missing: boolean): void {
  knownMissing = missing
}

export type { AssistantPart, ToolPart }

import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_DEFAULT_MODEL,
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
import { AGENT_TOOLS } from '@shared/agentRuns'
import type { Store } from './store'
import { composePrompt, withTimeout, type AgentSession, type Emit } from './session.ts'
import { DeltaCoalescer } from './deltaCoalescer.ts'
import {
  AntigravityAcpClient,
  agyAnswerOption,
  agyMode,
  agyQuestion,
  agyToolImages,
  agyToolInput,
  agyToolName,
  agyToolOutput,
  agyToolStatus,
  buildAgyPrompt,
  geminiHome,
  isAgyQuestion,
  isAuthRequired,
  removeAgyConversation,
  withPlanCommand,
  type AgyCommand,
  type AgyModelState,
  type AgyPermissionRequest,
  type AgyRawUpdate,
  type AgySessionSetup,
  type AgyToolCall
} from './antigravityAcp.ts'
import { cliAvailable, requireCliPath } from './providerCli.ts'
import { deriveTitle } from './titles.ts'
import { PREVIEW_SESSION_RULES } from './previewTools.ts'
import { CANVAS_SESSION_RULES } from './canvasTools.ts'
import type { CarbonMcpProvider, CarbonMcpSession } from './carbonBridge.ts'
import { CARBON_MCP_NAME, carbonMcpTools, isCarbonSideEffect, isCarbonToolId } from './carbonMcp.ts'
import { projectRoot } from '../shared/types.ts'

/**
 * Google Antigravity as an `AgentSession`, on the ACP client in
 * `antigravityAcp.ts` — the same split `grok.ts` keeps against `grokAcp.ts`.
 *
 * Three things about this backend shape the class, each read off the 1.2.1
 * server's source:
 *
 *  - **Nothing needs a respawn.** Permission modes and the model both move on a
 *    live session through `session/set_config_option`, so unlike Grok there is
 *    no options key and no restart; the process lives as long as the chat.
 *  - **Plan mode is a command, not a mode.** The server's `/plan` makes the
 *    turn plan and stop, so Carbon prefixes it and — like Codex — raises its own
 *    plan review from the finished turn: the plan file the agent wrote if it
 *    wrote one, its last answer otherwise.
 *  - **Sign-in can be needed mid-chat.** A session whose credentials are gone
 *    answers "Authentication required"; the session signs in on the spot (the
 *    browser opens through `openAuthUrl`) rather than failing the send.
 */

/** Handshake + session setup + a model list round trip — no turn runs. */
const PROBE_TIMEOUT_MS = 30_000

/** A handoff brief the user is waiting on. */
const ONE_SHOT_TIMEOUT_MS = 90_000

/** The server's own OAuth deadline is five minutes; give it a little longer. */
const SIGN_IN_TIMEOUT_MS = 330_000

/**
 * Opens a sign-in link in the user's browser. Injected from `index.ts`
 * (Electron's `shell.openExternal`) so this module stays free of Electron.
 */
let openAuthUrl: (url: string) => void = () => {}
export function configureAntigravityAuth(open: (url: string) => void): void {
  openAuthUrl = open
}

interface PendingTurn {
  text: string
  attachments: Attachment[]
  userMessageId: string
}

interface PendingPermission {
  resolve: (optionId: string | null) => void
  request: AgyPermissionRequest
}

/**
 * What the server announces on `available_commands_update` (1.2.1): its one
 * built-in and the sign-out command. Served before a session exists so the
 * composer's menu is not empty on a new chat.
 */
export const ANTIGRAVITY_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'plan',
    description:
      'Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval).'
  },
  { name: 'logout', description: 'Sign out of Google for Antigravity.' }
]

/** Read the rules into a conversation once, at its first turn. */
const SESSION_RULES = [PREVIEW_SESSION_RULES, CANVAS_SESSION_RULES].join('\n\n')

export class AntigravitySession implements AgentSession {
  private chat: ChatData
  private emit: Emit
  private store: Store
  private onDead: () => void
  private onCommands: (commands: SlashCommand[]) => void

  private client: AntigravityAcpClient | null = null
  private sessionId: string | null
  private starting: Promise<AntigravityAcpClient> | null = null
  private sendChain: Promise<void> = Promise.resolve()
  private queued = new Set<PendingTurn>()

  private current: AssistantMessage | null = null
  private toolLoc = new Map<string, { message: AssistantMessage; index: number }>()
  private streamSlot: { kind: 'text' | 'thinking'; index: number } | null = null
  /** Every text part this turn produced, for the plan review's fallback. */
  private turnText: string[] = []
  /**
   * The turn did something a plan review would come *after*: answered one of
   * the server's own questions (its `/plan` can ask "proceed?" and go on to
   * build in the same turn) or ran an edit or a command. Offering such a turn's
   * summary as a plan to approve would ask for a second implementation.
   */
  private turnActed = false

  private permissions = new Map<string, PendingPermission>()
  private planReview: PersistedPlanReview | null
  private activeUserMessageId: string | null = null
  private running = false
  private interrupted = false
  private disposed = false
  private deadFlag = false
  private lastEmittedStatus: ChatStatus | null = null
  private turnStart = 0
  private models: AgyModelState | null = null
  /** The mode and model the live session is known to hold. */
  private appliedMode: string | null = null
  private appliedModel: string | null = null
  /**
   * True for a conversation this process created rather than resumed: its
   * first prompt carries Carbon's session rules, which a resumed one already
   * has in its history.
   */
  private needsRules = false
  private mcp: Promise<CarbonMcpSession | null> | null = null

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
    onCommands: (commands: SlashCommand[]) => void = () => {},
    private preview: CarbonMcpProvider | null = null
  ) {
    // Thrown here so `deliver` turns a missing server into an error card that
    // says how to install it, with the prompt preserved.
    requireCliPath('antigravity')
    this.chat = chat
    this.emit = emit
    this.store = store
    this.onDead = onDead
    this.onCommands = onCommands
    this.sessionId = chat.sessionId ?? null
    this.planReview = chat.pendingPlanReview ?? null
  }

  get dead(): boolean {
    return this.deadFlag
  }

  get idle(): boolean {
    return (
      !this.running && this.queued.size === 0 && this.permissions.size === 0 && !this.planReview
    )
  }

  // ---------- Lifecycle ----------

  private ensureClient(): Promise<AntigravityAcpClient> {
    if (this.client?.alive) return Promise.resolve(this.client)
    if (this.starting) return this.starting
    this.starting = this.startClient().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private ensureMcp(): Promise<CarbonMcpSession | null> {
    if (!this.mcp) {
      this.mcp =
        this.preview?.mcpSession({
          cwd: this.chat.cwd,
          project: projectRoot(this.chat),
          chatId: this.chat.id,
          plan: () => this.chat.permissionMode === 'plan'
        }) ?? Promise.resolve(null)
    }
    return this.mcp
  }

  private async startClient(): Promise<AntigravityAcpClient> {
    const mcp = await this.ensureMcp()
    const client = new AntigravityAcpClient({
      cwd: this.chat.cwd,
      mcpServers: mcp ? [mcp.acpServer] : [],
      callbacks: {
        onUpdate: (update) => this.handleUpdate(update),
        onPermission: (request) => this.handlePermission(request),
        onAuthUrl: (url) => this.handleAuthUrl(url),
        onExit: (error) => this.handleExit(client, error)
      }
    })
    this.client = client
    this.appliedMode = null
    this.appliedModel = null
    await client.start()
    const setup = await this.withSignIn(client, () => this.openSession(client))
    this.applySetup(setup)
    return client
  }

  private async openSession(client: AntigravityAcpClient): Promise<AgySessionSetup> {
    if (this.sessionId) {
      try {
        return await client.resumeSession(this.sessionId)
      } catch (error) {
        if (isAuthRequired(error)) throw error
        // Pruned, or written by another machine. A fresh conversation loses
        // the agent's memory of the old one but keeps the chat usable.
        this.sessionId = null
      }
    }
    const created = await client.newSession()
    if (!created.sessionId) throw new Error('Antigravity did not return a session id.')
    this.sessionId = created.sessionId
    this.needsRules = !!(await this.ensureMcp())
    this.chat.sessionId = created.sessionId
    this.store.saveChat(this.chat.id)
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { sessionId: created.sessionId }
    })
    return created
  }

  /**
   * Run `work`, signing in once if the server says nobody is. The browser opens
   * on the user's machine and the turn simply waits for it, which is what makes
   * a first send work without a trip to Settings.
   */
  private async withSignIn<T>(client: AntigravityAcpClient, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (!isAuthRequired(error)) throw error
      this.pushInfo('Antigravity needs you to sign in with Google — continue in your browser.')
      await client.authenticate()
      return work()
    }
  }

  private applySetup(setup: AgySessionSetup): void {
    if (setup.models) this.models = setup.models
    this.appliedModel = setup.models?.currentModelId ?? null
    this.appliedMode = setup.modes?.currentModeId ?? null
  }

  private handleAuthUrl(url: string): void {
    openAuthUrl(url)
  }

  /** Bring the live session's mode and model in line with the chat's. */
  private async applyOptions(client: AntigravityAcpClient): Promise<void> {
    if (!this.sessionId) return
    const mode = agyMode(this.chat.permissionMode)
    if (this.appliedMode !== mode) {
      try {
        await client.setMode(this.sessionId, mode)
        this.appliedMode = mode
      } catch {
        // Advisory: the turn still runs, in whatever mode the session holds.
      }
    }
    const model = this.launchModel()
    if (model && this.appliedModel !== model) {
      await client.setModel(this.sessionId, model)
      this.appliedModel = model
    }
  }

  private launchModel(): string | undefined {
    const model = this.chat.model
    return model && model !== ANTIGRAVITY_DEFAULT_MODEL ? model : undefined
  }

  private handleExit(client: AntigravityAcpClient, error: Error | null): void {
    // A replaced client's exit is old news.
    if (this.client !== client) return
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
    void this.mcp?.then((mcp) => mcp?.dispose())
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
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'error',
      text,
      ts: Date.now()
    })
  }

  private pushInfo(text: string): void {
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'info',
      text,
      ts: Date.now()
    })
  }

  private ensureCurrent(): AssistantMessage {
    if (!this.current) {
      this.current = {
        id: randomUUID(),
        role: 'assistant',
        parts: [],
        ts: Date.now()
      }
      this.chat.messages.push(this.current)
      this.chat.updatedAt = Date.now()
      this.emit({
        type: 'message',
        chatId: this.chat.id,
        message: this.current
      })
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
      this.emit({
        type: 'meta',
        chatId: this.chat.id,
        patch: { title: this.chat.title }
      })
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
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { updatedAt: this.chat.updatedAt }
    })
    this.setStatus(this.client?.alive ? 'streaming' : 'starting')

    const turn: PendingTurn = { text, attachments, userMessageId }
    this.queued.add(turn)
    this.sendChain = this.sendChain.then(async () => {
      let context: string | undefined
      try {
        context = (await hiddenContext) || undefined
      } catch {
        context = undefined
      }
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
    this.turnText = []
    this.turnActed = false
    const planning = this.chat.permissionMode === 'plan'
    this.setStatus('streaming')
    let stopReason: string | null = null
    try {
      const client = await this.ensureClient()
      if (!this.sessionId) throw new Error('Antigravity session could not be created.')
      await this.applyOptions(client)
      let text = withPlanCommand(turn.text, this.chat.permissionMode)
      if (this.needsRules) {
        // `/plan` has to stay first to be read as the command, so the rules
        // go after the user's words rather than ahead of them.
        text = `${text}\n\n<carbon_session_rules>\n${SESSION_RULES}\n</carbon_session_rules>`
        this.needsRules = false
      }
      const prompt = buildAgyPrompt(text, turn.attachments)
      const sessionId = this.sessionId
      stopReason = await this.withSignIn(client, () => client.prompt(sessionId, prompt))
    } catch (error) {
      if (!this.disposed && !this.interrupted) {
        this.pushError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.running = false
      this.finishTurn(stopReason, planning)
    }
  }

  private finishTurn(stopReason: string | null, planning: boolean): void {
    this.deltas.flush()
    this.current = null
    this.streamSlot = null
    // Keep only the calls still running — the background commands whose close
    // arrives after `end_turn` (see `handleUpdate`).
    for (const [id, loc] of this.toolLoc) {
      const part = loc.message.parts[loc.index]
      if (part?.type !== 'tool' || part.status !== 'running') this.toolLoc.delete(id)
    }
    if (stopReason) {
      this.pushMessage({
        id: randomUUID(),
        role: 'event',
        kind: 'turn',
        text: '',
        ts: Date.now(),
        stats: {
          // The server reports no usage at all; a Google subscription has no
          // per-turn price to show either.
          costUsd: 0,
          durationMs: Date.now() - this.turnStart,
          numTurns: 1,
          model: this.appliedModel ?? this.chat.model ?? 'Antigravity'
        }
      })
      if (planning && stopReason === 'end_turn' && !this.interrupted && !this.turnActed) {
        this.offerPlanForReview()
      }
    }
    this.setStatus(this.hasBlockingPrompt() ? 'waiting-permission' : 'idle')
    this.store.saveChat(this.chat.id)
  }

  // ---------- Stream normalization ----------

  private handleUpdate(update: AgyRawUpdate): void {
    if (this.disposed) return
    // Idle traffic is dropped, except the close of a call that outlived its
    // turn: the server parks a still-running shell command at `end_turn` and
    // sends its terminal `tool_call_update` whenever it finishes. Dropping that
    // leaves the card spinning for good. (Grok filters idle updates for replay
    // dedup; `session/resume` replays nothing, so that reason doesn't apply.)
    if (!this.running) {
      const id = (update as { toolCallId?: unknown }).toolCallId
      if (update.sessionUpdate !== 'tool_call_update' || typeof id !== 'string' || !this.toolLoc.has(id)) {
        return
      }
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendStream('text', textOf(update.content))
        return
      case 'agent_thought_chunk':
        this.appendStream('thinking', textOf(update.content))
        return
      case 'tool_call':
      case 'tool_call_update':
        this.applyToolCall(update as unknown as AgyToolCall)
        return
      case 'available_commands_update':
        this.handleCommands((update.availableCommands as AgyCommand[] | undefined) ?? [])
        return
      default:
        return
    }
  }

  private appendStream(kind: 'text' | 'thinking', delta: string): void {
    if (!delta) return
    const message = this.ensureCurrent()
    if (this.streamSlot?.kind !== kind) {
      const part: AssistantPart =
        kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', text: '' }
      message.parts.push(part)
      this.streamSlot = { kind, index: message.parts.length - 1 }
      if (kind === 'text') this.turnText.push('')
      this.emitPart(message, this.streamSlot.index)
    }
    const slot = message.parts[this.streamSlot.index]
    if (slot && (slot.type === 'text' || slot.type === 'thinking')) slot.text += delta
    if (kind === 'text') this.turnText[this.turnText.length - 1] += delta
    this.deltas.queue(message.id, this.streamSlot.index, delta)
  }

  private applyToolCall(call: AgyToolCall): void {
    if (!call.toolCallId) return
    // A clarifying question's synthetic call is drawn as the question card the
    // permission request raises, not as a tool row.
    if (call.toolCallId.startsWith('interaction_')) return
    const existing = this.toolLoc.get(call.toolCallId)
    if (!existing) {
      const message = this.ensureCurrent()
      const name = agyToolName(call) ?? 'Tool'
      // Edits only: a planning turn runs `ls` and `grep` as a matter of course.
      if (call.kind === 'edit' || name === 'Write' || name === 'Edit') this.turnActed = true
      const images = agyToolImages(call)
      const output = agyToolOutput(call)
      const part: ToolPart = {
        type: 'tool',
        toolUseId: call.toolCallId,
        name,
        input: agyToolInput(name, call.rawInput, call),
        status: agyToolStatus(call.status),
        startedAt: Date.now(),
        ...(output !== undefined &&
        call.status &&
        call.status !== 'pending' &&
        call.status !== 'in_progress'
          ? { output }
          : {}),
        ...(images ? { outputImages: images } : {}),
        // Subagents run inside the server and report only that the call is
        // open, so the roster gets a clock and nothing invented.
        ...(AGENT_TOOLS.has(name) ? { agent: { startedAt: Date.now() } } : {})
      }
      message.parts.push(part)
      const index = message.parts.length - 1
      this.toolLoc.set(call.toolCallId, { message, index })
      this.streamSlot = null
      this.emitPart(message, index)
      return
    }
    const part = existing.message.parts[existing.index]
    if (!part || part.type !== 'tool') return
    const patch: Partial<ToolPart> = {}
    if (call.status) patch.status = agyToolStatus(call.status)
    const name = call.title || call._meta ? agyToolName(call) : undefined
    if (name && name !== part.name) patch.name = name
    if (call.rawInput !== undefined && call.rawInput !== null) {
      patch.input = agyToolInput(name ?? part.name, call.rawInput, call)
    }
    if (patch.status === 'success' || patch.status === 'error') {
      const output = agyToolOutput(call)
      if (output !== undefined) patch.output = output
      else if (patch.status === 'error' && part.output === undefined) patch.output = 'Tool failed.'
      const images = agyToolImages(call)
      if (images) patch.outputImages = images
      if (part.agent) patch.agent = { ...part.agent, endedAt: Date.now() }
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

  private handleCommands(commands: AgyCommand[]): void {
    const list: SlashCommand[] = commands.map((command) => ({
      name: command.name,
      description: command.description ?? ''
    }))
    this.emit({
      type: 'commands',
      chatId: this.chat.id,
      cwd: this.chat.cwd,
      provider: 'antigravity',
      commands: list
    })
    this.onCommands(list)
  }

  // ---------- Permissions and questions ----------

  private hasBlockingPrompt(): boolean {
    return this.permissions.size > 0 || !!this.planReview
  }

  private handlePermission(request: AgyPermissionRequest): Promise<string | null> {
    // The server opens the call's row (status `pending`) just before asking,
    // so the card already holds the best name; the request is the fallback.
    const loc = this.toolLoc.get(request.toolCall?.toolCallId)
    const opened = loc?.message.parts[loc.index]
    const name =
      (opened?.type === 'tool' && opened.name !== 'Tool' ? opened.name : undefined) ??
      agyToolName(request.toolCall)
    // Carbon's own tools are app-local and allowed without asking, except a
    // dev-server start/stop while planning — the same gate the other two apply.
    if (name && isCarbonToolId(name)) {
      const deny = isCarbonSideEffect(name) && this.chat.permissionMode === 'plan'
      const option = request.options.find((entry) =>
        deny ? entry.kind?.startsWith('reject') : entry.kind === 'allow_once'
      )
      return Promise.resolve(option?.optionId ?? null)
    }
    return new Promise<string | null>((resolve) => {
      if (this.disposed || this.interrupted) {
        resolve(null)
        return
      }
      const requestId = randomUUID()
      this.permissions.set(requestId, { resolve, request })
      const tool = request.toolCall
      if (isAgyQuestion(request)) {
        this.emit({
          type: 'permission-request',
          chatId: this.chat.id,
          request: {
            id: requestId,
            chatId: this.chat.id,
            toolUseId: tool.toolCallId,
            toolName: 'AskUserQuestion',
            input: { questions: [agyQuestion(request)] },
            title: 'Answer question',
            displayName: 'Antigravity question',
            description: 'Antigravity needs your input to continue.',
            hasSuggestions: false
          }
        })
      } else {
        const toolName = name ?? 'Tool'
        this.emit({
          type: 'permission-request',
          chatId: this.chat.id,
          request: {
            id: requestId,
            chatId: this.chat.id,
            toolUseId: tool.toolCallId,
            toolName,
            input: agyToolInput(toolName, tool.rawInput, tool),
            // The server's title is its own tool id ("Run write_to_file?") or
            // a bare command; the card's "Use Write" over the input reads better
            // for both, so only an unmapped tool keeps it.
            title: toolName === tool.title || /^Run \w+\?$/.test(tool.title ?? '') || toolName === 'Bash' ? undefined : tool.title,
            hasSuggestions: request.options.some((option) => option.kind === 'allow_always')
          }
        })
      }
      this.setStatus('waiting-permission')
    })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.permissions.get(requestId)
    if (pending) {
      this.permissions.delete(requestId)
      const { request } = pending
      let optionId: string | null
      if (isAgyQuestion(request)) {
        this.turnActed = true
        optionId =
          decision.behavior === 'allow' ? agyAnswerOption(request, answersOf(decision)) : null
      } else {
        const kinds =
          decision.behavior === 'allow'
            ? decision.always
              ? ['allow_always', 'allow_once']
              : ['allow_once', 'allow_always']
            : ['reject_once', 'reject_always']
        optionId =
          kinds.map((kind) => request.options.find((option) => option.kind === kind)).find(Boolean)
            ?.optionId ?? null
      }
      pending.resolve(optionId)
      this.emit({
        type: 'permission-resolved',
        chatId: this.chat.id,
        requestId
      })
      this.setStatus(
        this.running ? 'streaming' : this.hasBlockingPrompt() ? 'waiting-permission' : 'idle'
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
      this.emit({
        type: 'permission-resolved',
        chatId: this.chat.id,
        requestId
      })
    }
    this.permissions.clear()
  }

  // ---------- Plan review ----------

  /**
   * The plan a `/plan` turn produced. The server keeps a session's artifacts
   * under `brain/<session>/`, and a plan written there is the whole plan; the
   * turn's answer is often only a pointer to it. Failing that, the last thing
   * the agent said is the plan.
   */
  private readPlan(): string {
    if (this.sessionId) {
      const dir = join(geminiHome(), 'antigravity-acp', 'brain', this.sessionId)
      try {
        const plans = readdirSync(dir)
          .filter((name) => /plan.*\.md$/i.test(name))
          .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
          .filter((entry) => entry.mtime >= this.turnStart)
          .sort((a, b) => b.mtime - a.mtime)
        if (plans[0]) return readFileSync(join(dir, plans[0].name), 'utf8').trim()
      } catch {
        // No artifacts directory: the plan is the answer.
      }
    }
    return (
      [...this.turnText]
        .reverse()
        .find((text) => text.trim())
        ?.trim() ?? ''
    )
  }

  private offerPlanForReview(): void {
    if (this.planReview) return
    const plan = this.readPlan()
    if (!plan) return
    const requestId = randomUUID()
    const review: PersistedPlanReview = {
      requestId,
      plan,
      userMessageId: this.activeUserMessageId ?? randomUUID()
    }
    this.planReview = review
    this.chat.pendingPlanReview = review
    this.store.saveChat(this.chat.id)
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { pendingPlanReview: review }
    })
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: requestId,
        chatId: this.chat.id,
        toolUseId: `antigravity-plan-${requestId}`,
        toolName: 'ExitPlanMode',
        input: { plan },
        title: 'Review plan',
        displayName: 'Antigravity plan',
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
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { pendingPlanReview: undefined }
    })
    this.emit({
      type: 'permission-resolved',
      chatId: this.chat.id,
      requestId: review.requestId
    })
    this.store.saveChat(this.chat.id)
  }

  /**
   * Approve or reject a plan. Approval restores the mode planning replaced,
   * applies a "Build with" model, and sends the plan back as the next turn.
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
    const patch: Partial<ChatMeta> = {
      permissionMode: restore,
      modeBeforePlan: undefined
    }
    if (decision.model !== undefined) {
      const next = decision.model || undefined
      if (next !== this.chat.model) {
        this.chat.model = next
        patch.model = next
      }
    }
    this.emit({ type: 'meta', chatId: this.chat.id, patch })
    this.pushInfo('Plan approved. Antigravity is implementing it.')
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
    this.deltas.flush()
    this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    this.chat.model = model
    // Applied at the next turn: switching rebuilds the server's agent, which
    // must not happen under a running one.
    if (!this.running && this.client?.alive) {
      try {
        await this.applyOptions(this.client)
      } catch {
        // Retried by the next turn's `applyOptions`.
      }
    }
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.chat.permissionMode = mode
    // Modes are live, and a prompt asked under the old one keeps its answer.
    if (this.client?.alive && this.sessionId) {
      const wanted = agyMode(mode)
      if (this.appliedMode !== wanted) {
        try {
          await this.client.setMode(this.sessionId, wanted)
          this.appliedMode = wanted
        } catch {
          // Reasserted at the next turn.
        }
      }
    }
  }

  async stopBackgroundJob(): Promise<void> {
    // Background commands live inside the server's own harness; ACP exposes no
    // per-job stop.
  }

  async rewindFiles(): Promise<RewindResult> {
    return {
      canRewind: false,
      error: 'Antigravity does not support file checkpoints.'
    }
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    if (!(await this.ensureMcp())) return []
    return [
      {
        name: CARBON_MCP_NAME,
        status: 'connected',
        scope: 'local',
        tools: carbonMcpTools()
      }
    ]
  }

  async mcpReconnect(): Promise<OpResult> {
    return {
      ok: false,
      error: 'Antigravity manages MCP servers in its own config.'
    }
  }

  async mcpToggle(): Promise<OpResult> {
    return {
      ok: false,
      error: 'Antigravity manages MCP servers in its own config.'
    }
  }

  async listModels(): Promise<ModelOption[]> {
    return antigravityModelOptions(this.models)
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

function textOf(content: unknown): string {
  const text = (content as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

function answersOf(decision: PermissionDecision): Record<string, unknown> | undefined {
  if (decision.behavior !== 'allow') return undefined
  const answers = decision.updatedInput?.answers
  return answers && typeof answers === 'object' && !Array.isArray(answers)
    ? (answers as Record<string, unknown>)
    : undefined
}

// ---------- Catalog, sign-in and one-shots ----------

/** The live catalog as picker rows, with the Default row ahead of the models. */
export function antigravityModelOptions(state: AgyModelState | null): ModelOption[] {
  const models = state?.availableModels ?? []
  if (!models.length) return []
  const current = models.find((model) => model.modelId === state?.currentModelId)
  return [
    {
      id: ANTIGRAVITY_DEFAULT_MODEL,
      label: 'Antigravity (default)',
      description: current?.name ? `Currently ${current.name}` : "Your account's default model",
      provider: 'antigravity',
      ...(current ? { resolvedModel: current.modelId } : {})
    },
    ...models.map((model): ModelOption => ({
      id: model.modelId,
      label: model.name?.trim() || model.modelId,
      description: model.description?.trim() || 'Google Antigravity',
      provider: 'antigravity'
    }))
  ]
}

/**
 * A server for one question, in a temporary folder. It approves nothing — a
 * throwaway has no user to ask — except the clarifying questions the server
 * itself raises (a first-run workspace-trust prompt for the fresh folder),
 * which it answers yes so the question it was started for can be asked.
 */
function throwawayClient(
  cwd: string,
  updates: AgyRawUpdate[] = [],
  onAuthUrl?: (url: string) => void
): AntigravityAcpClient {
  return new AntigravityAcpClient({
    cwd,
    callbacks: {
      onUpdate: (update) => updates.push(update),
      onPermission: async (request) =>
        isAgyQuestion(request)
          ? (request.options.find((option) => option.kind === 'allow_once')?.optionId ?? null)
          : null,
      onAuthUrl,
      onExit: () => {}
    }
  })
}

/**
 * Run `work` against a throwaway session, then remove the conversation it left
 * behind. Model listing needs a session — the catalog arrives on `session/new`
 * — but the user never sees this one. `onError` turns a failure (including a
 * signed-out server) into the caller's answer.
 */
async function withThrowawaySession<T>(
  work: (
    client: AntigravityAcpClient,
    setup: AgySessionSetup,
    updates: AgyRawUpdate[]
  ) => Promise<T>,
  onError: (error: unknown) => T,
  timeoutMs: number
): Promise<T> {
  if (!cliAvailable('antigravity')) return onError(new Error('Antigravity is not installed.'))
  const cwd = mkdtempSync(join(tmpdir(), 'carbon-agy-'))
  const updates: AgyRawUpdate[] = []
  let sessionId: string | undefined
  const client = throwawayClient(cwd, updates)
  const run = async (): Promise<T> => {
    await client.start()
    const setup = await client.newSession()
    sessionId = setup.sessionId
    return work(client, setup, updates)
  }
  const timedOut = Symbol('timeout')
  try {
    const result = await withTimeout<T | typeof timedOut>(run(), timeoutMs, timedOut)
    return result === timedOut ? onError(new Error('Antigravity did not answer in time.')) : result
  } catch (error) {
    return onError(error)
  } finally {
    client.dispose()
    removeAgyConversation(sessionId, cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
}

/**
 * The row a signed-out account gets instead of models. A provider that is
 * installed but answers no models would otherwise leave the picker's catalog
 * "incomplete" forever — and a user looking at it with no idea why. Disabled,
 * so it can be read but not picked.
 */
const SIGNED_OUT_ROW: ModelOption = {
  id: ANTIGRAVITY_DEFAULT_MODEL,
  label: 'Antigravity',
  description: 'Sign in with Google in Settings → Providers',
  provider: 'antigravity',
  disabled: true
}

/**
 * The account's models; the disabled sign-in row when nobody is signed in;
 * `[]` when the server is missing or fails, which is when the picker should
 * have no row for it. No turn runs, so this costs no quota.
 */
export async function fetchAntigravityModels(): Promise<ModelOption[]> {
  return withThrowawaySession(
    async (_client, setup) => antigravityModelOptions(setup.models ?? null),
    (error) => (isAuthRequired(error) ? [SIGNED_OUT_ROW] : []),
    PROBE_TIMEOUT_MS
  )
}

/** One-shot generation for the handoff brief, on a throwaway session. */
export async function generateAntigravityText(
  model: string | undefined,
  prompt: string
): Promise<string | null> {
  return withThrowawaySession(
    async (client, setup, updates) => {
      if (!setup.sessionId) return null
      if (model && model !== ANTIGRAVITY_DEFAULT_MODEL) {
        await client.setModel(setup.sessionId, model).catch(() => {})
      }
      await client.prompt(setup.sessionId, [{ type: 'text', text: prompt }])
      const text = updates
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => textOf(update.content))
        .join('')
        .trim()
      return text || null
    },
    () => null,
    ONE_SHOT_TIMEOUT_MS
  )
}

export type AntigravityAuthState = 'signed-in' | 'signed-out' | 'unavailable'

/**
 * Whether the server has a usable sign-in, by asking it for a session: the
 * answer is a session or "Authentication required", and either way no turn
 * runs. `unavailable` covers a missing binary and any other failure.
 */
export async function antigravityAuthState(): Promise<AntigravityAuthState> {
  if (!cliAvailable('antigravity')) return 'unavailable'
  const cwd = mkdtempSync(join(tmpdir(), 'carbon-agy-'))
  let sessionId: string | undefined
  const client = throwawayClient(cwd)
  try {
    const probe = async (): Promise<AntigravityAuthState> => {
      await client.start()
      try {
        sessionId = (await client.newSession()).sessionId
        return 'signed-in'
      } catch (error) {
        return isAuthRequired(error) ? 'signed-out' : 'unavailable'
      }
    }
    return await withTimeout(probe(), PROBE_TIMEOUT_MS, 'unavailable' as AntigravityAuthState)
  } catch {
    return 'unavailable'
  } finally {
    client.dispose()
    removeAgyConversation(sessionId, cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
}

/** Run the Google sign-in, opening the link in the browser. */
export async function signInToAntigravity(): Promise<OpResult> {
  if (!cliAvailable('antigravity')) return { ok: false, error: 'Antigravity is not installed.' }
  const cwd = mkdtempSync(join(tmpdir(), 'carbon-agy-'))
  const client = throwawayClient(cwd, [], (url) => openAuthUrl(url))
  try {
    await client.start()
    const done = client.authenticate().then(
      (): OpResult => ({ ok: true }),
      (error: unknown): OpResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    )
    return await withTimeout(done, SIGN_IN_TIMEOUT_MS, {
      ok: false,
      error: 'Sign-in timed out.'
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    client.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
}

export async function signOutOfAntigravity(): Promise<OpResult> {
  if (!cliAvailable('antigravity')) return { ok: false, error: 'Antigravity is not installed.' }
  const cwd = mkdtempSync(join(tmpdir(), 'carbon-agy-'))
  const client = throwawayClient(cwd)
  try {
    await client.start()
    await withTimeout(client.logout(), PROBE_TIMEOUT_MS, undefined)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    client.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
}

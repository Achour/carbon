import { randomUUID } from 'node:crypto'
import { readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type UserInput,
  type Usage
} from '@openai/codex-sdk'
import { CODEX_DEFAULT_MODEL, MODEL_OPTIONS } from '../shared/types.ts'
import { requireCliPath } from './providerCli.ts'
import type {
  AccountInfo,
  AgentInfo,
  AssistantMessage,
  AssistantPart,
  Attachment,
  BackgroundJob,
  ChatData,
  ChatMeta,
  ChatStatus,
  EffortId,
  ElementRef,
  McpServerInfo,
  ModelOption,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  PersistedPlanReview,
  RewindResult,
  ServiceTier,
  ToolPart,
  ToolStatus,
  TurnStats,
  UserQuestion,
  UsageInfo
} from '@shared/types'
import type { Store } from './store'
import { composePrompt, type AgentSession, type Emit } from './session.ts'
import { DeltaCoalescer } from './deltaCoalescer.ts'
import { IMAGE_EXT, pickTurnImages } from './imageScan.ts'
import { isMissingCodexThreadError } from './codexResume.ts'
import { parseCodexPlan } from './codexMode.ts'
import {
  codexLimitDisplayName,
  codexWindow,
  type CodexWindow
} from './usageWindows.ts'
import {
  CodexAppServerClient,
  type AppServerThreadOptions,
  type CodexClientLike,
  type CodexTurnUsage,
  isCodexCompactionItem,
  isCodexImageViewItem,
  isCodexPlanItem,
  type NativeApprovalRequest,
  type CodexThreadLike,
  type NativeMcpElicitationRequest,
  type NativeUserInputRequest
} from './codexAppServer.ts'
import {
  createCodexRolloutWatcher,
  isCodexCollabToolCallItem,
  type CodexCollabToolCallItem,
  type CodexRolloutEvent,
  type CodexRolloutWatcher,
  type CodexRolloutWatcherFactory
} from './codexRollout.ts'
import {
  captureWorkspaceTree,
  rewindWorkspaceCheckpoint,
  summarizeWorkspaceCheckpoint,
  type WorkspaceCheckpoint
} from './workspaceCheckpoint.ts'
import { TITLE_SYSTEM, buildTitlePrompt, cleanTitle, deriveTitle, firstUserText } from './titles.ts'
import { PREVIEW_SESSION_RULES } from './previewTools.ts'
import { projectRoot } from '../shared/types.ts'
import type { CanvasManager } from './canvas.ts'
import { CANVAS_SESSION_RULES } from './canvasTools.ts'
import { describeSelection } from './attachmentText.ts'

const OUTPUT_CAP = 100_000

/**
 * Carbon has two browser surfaces and Codex can drive both: `preview` is the
 * isolated project webview, while the user's configured Chrome/computer skill
 * owns their real signed-in browser. Naming the distinction in the turn rules
 * stops project verification from leaking into personal Chrome and stops an
 * explicit "use my Chrome" request from being answered with the preview.
 */
const CODEX_BROWSER_SESSION_RULES =
  "Carbon has two different browser surfaces. Use the `preview` MCP server for this project's local dev-server UI and its screenshots/console. When the user explicitly asks for their Chrome browser, an existing signed-in browser session, or a browser extension, use an enabled Chrome/browser-control skill and its configured tools instead. Do not substitute one surface for the other."

/**
 * One-shot Codex text turn on a throwaway read-only thread — backs the chat
 * title and the cross-provider handoff brief (see ChatManager). A live session
 * passes its own `client`; without one a throwaway is spawned and disposed
 * (the handoff runs after the chat's session is already gone). Returns null on
 * any error so callers can fall back.
 */
export async function generateCodexText(
  cwd: string,
  model: string | undefined,
  prompt: string,
  client?: CodexClientLike
): Promise<string | null> {
  const codex = client ?? new CodexAppServerClient({})
  try {
    const thread = codex.startThread({
      model: model && model !== CODEX_DEFAULT_MODEL ? model : undefined,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      // NB not 'minimal' — it 400s on some Codex models (e.g. gpt-5.6-sol
      // only allows none/low/medium/high/xhigh), which silently kills the turn.
      modelReasoningEffort: 'low'
    })
    const turn = await thread.run(prompt)
    return turn.finalResponse.trim() || null
  } catch {
    return null
  } finally {
    if (!client) codex.dispose?.()
  }
}

// Used only for an unknown/config-selected model. Explicit models carry their
// advertised window in MODEL_OPTIONS.
const CODEX_CONTEXT_WINDOW = 272_000

/**
 * Fast is a catalog alias enabled by the CLI feature flag. `default` explicitly
 * clears an inherited Fast preference and is omitted from model requests by the
 * CLI, yielding normal Standard processing.
 */
export function codexOptionsForServiceTier(
  serviceTier: ServiceTier = 'standard'
): CodexOptions {
  return {
    config: {
      service_tier: serviceTier === 'fast' ? 'fast' : 'default',
      features: { fast_mode: true }
    }
  }
}

interface RawCodexModel {
  id: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>
  additionalSpeedTiers?: string[]
  serviceTiers?: Array<{ id?: string }>
}

function codexModelOptions(raw: RawCodexModel[]): ModelOption[] {
  const visible = raw.filter((model) => !model.hidden)
  const options = visible.map((model): ModelOption => {
    const resolved = model.model || model.id
    const fallback = MODEL_OPTIONS.find(
      (option) => option.id === model.id || option.id === resolved
    )
    const supportedEfforts = model.supportedReasoningEfforts
      ?.map((value) => value.reasoningEffort)
      .filter((value): value is EffortId =>
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value ?? '')
      )
    return {
      id: model.id,
      label: model.displayName || fallback?.label || model.id,
      description: model.description || fallback?.description || 'OpenAI Codex',
      provider: 'codex',
      ...(resolved !== model.id ? { resolvedModel: resolved } : {}),
      ...(fallback?.contextWindow ? { contextWindow: fallback.contextWindow } : {}),
      ...(supportedEfforts?.length ? { supportedEfforts } : {}),
      supportsFastMode:
        (model.serviceTiers?.some((tier) => tier.id === 'fast') ?? false) ||
        (model.additionalSpeedTiers?.includes('fast') ?? false)
    }
  })
  const configured = visible.find((model) => model.isDefault)
  const configuredOption = options.find((option) => option.id === configured?.id)
  return [
    {
      id: CODEX_DEFAULT_MODEL,
      label: 'Codex (default)',
      description: 'Model from your Codex config',
      provider: 'codex',
      ...(configured ? { resolvedModel: configured.model || configured.id } : {}),
      ...(configuredOption?.contextWindow
        ? { contextWindow: configuredOption.contextWindow }
        : {}),
      ...(configuredOption?.supportedEfforts
        ? { supportedEfforts: configuredOption.supportedEfforts }
        : {}),
      ...(configuredOption?.supportsFastMode != null
        ? { supportsFastMode: configuredOption.supportsFastMode }
        : {})
    },
    ...options
  ]
}

/** Fetch the complete current Codex model catalog from App Server. */
export async function fetchCodexModels(client: CodexClientLike): Promise<ModelOption[]> {
  if (!client.request) return []
  const raw: RawCodexModel[] = []
  let cursor: string | null = null
  do {
    const page = (await client.request('model/list', {
      cursor,
      limit: 100,
      includeHidden: false
    })) as { data?: RawCodexModel[]; nextCursor?: string | null }
    raw.push(...(page.data ?? []))
    cursor = page.nextCursor ?? null
  } while (cursor)
  return codexModelOptions(raw)
}

interface PendingTurn {
  input: Input
  temps: string[]
  userMessageId: string
  permissionMode: PermissionModeId
  model?: string
  effort?: EffortId
  contextWindow: number
}

interface PendingNativeQuestions {
  requestId: string
  questions: UserQuestion[]
  isBlocking: boolean
}

interface PendingNativeApproval {
  requestId: string
  kind: NativeApprovalRequest['kind']
}

interface PendingMcpElicitation {
  requestId: string
  mode: NativeMcpElicitationRequest['mode']
  schema?: Record<string, unknown>
}

/**
 * Carbon's permission modes map onto App Server's native sandbox policy. Plan
 * and Full Access are intentionally non-interactive; workspace modes let App
 * Server ask before an operation needs privileges outside that sandbox.
 */
function sandboxForMode(mode: PermissionModeId): SandboxMode {
  switch (mode) {
    case 'plan':
      return 'read-only'
    case 'bypassPermissions':
      return 'danger-full-access'
    default:
      // default | acceptEdits | auto — Codex may edit within the workspace.
      return 'workspace-write'
  }
}

function approvalPolicyForMode(mode: PermissionModeId): 'never' | 'on-request' {
  return mode === 'plan' || mode === 'bypassPermissions' ? 'never' : 'on-request'
}

function approvalsReviewerForMode(
  mode: PermissionModeId
): AppServerThreadOptions['approvalsReviewer'] {
  return mode === 'auto' ? 'auto_review' : 'user'
}

/**
 * An unset effort defers to ~/.codex/config.toml. The SDK's TypeScript union
 * still lags the CLI model catalog for max/ultra, but App Server forwards the
 * string as the native turn effort.
 */
function effortForCodex(effort?: EffortId): ModelReasoningEffort | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return effort as ModelReasoningEffort
    default:
      return undefined
  }
}

function cmdStatus(status: string): ToolStatus {
  return status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'running'
}

function agentStatus(status: string): ToolStatus {
  switch (status) {
    case 'completed':
    case 'shutdown':
      return 'success'
    case 'errored':
    case 'interrupted':
    case 'not_found':
    case 'failed':
      return 'error'
    default:
      return 'running'
  }
}

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)` : text
}


const TEMP_PREFIX = 'karbun-codex-'

/** Materializes a base64 image to a temp file (Codex takes images by path). */
function writeTempImage(mediaType: string, base64: string): string | null {
  try {
    const ext = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
    const path = join(tmpdir(), `${TEMP_PREFIX}${randomUUID()}.${ext}`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  } catch (err) {
    console.error('writeTempImage failed:', err)
    return null
  }
}

let staleCleaned = false
/** One-time sweep of temp attachment copies left behind by an abnormal exit. */
function cleanupStaleTempFiles(): void {
  if (staleCleaned) return
  staleCleaned = true
  const cutoff = Date.now() - 60 * 60 * 1000
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(TEMP_PREFIX)) continue
      const p = join(tmpdir(), name)
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true })
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // tmpdir unreadable — nothing to clean
  }
}

/** Renders a picked UI element as a text block the agent can act on. */
function describeElement(el: ElementRef): string {
  const lines = [`Selected UI element from the running app (${el.url}):`]
  if (el.source?.file) {
    const col = el.source.column != null ? `:${el.source.column}` : ''
    const loc = el.source.line != null ? `${el.source.file}:${el.source.line}${col}` : el.source.file
    lines.push(`- Source: ${loc}`)
  }
  if (el.label) lines.push(`- Text: ${JSON.stringify(el.label)}`)
  if (el.selector) lines.push(`- Selector: ${el.selector}`)
  if (el.html) lines.push(`- HTML: ${el.html}`)
  return lines.join('\n')
}

/**
 * One Codex conversation for a chat. Unlike `ClaudeSession` (a single long-lived
 * SDK process fed by an input queue), Codex uses one native `codex app-server`
 * process. Its JSON-RPC events are adapted to the former SDK-shaped thread
 * stream so the established AssistantPart/ChatEvent reducer stays unchanged.
 */
/**
 * How far before a message's own timestamp a Codex turn may have started and
 * still be that message's turn. Covers `startedAt`'s truncation to whole seconds
 * plus any clock skew between the two stamps.
 */
const TURN_CLOCK_SLACK_MS = 60_000

/** The slice of `thread/turns/list` the conversation fork reads. */
interface RawTurnItem {
  type?: string
  clientId?: string | null
}
interface TurnsPage {
  data?: { id?: string; startedAt?: number; items?: RawTurnItem[] }[]
  nextCursor?: string | null
}

export class CodexSession implements AgentSession {
  private chat: ChatData
  private emit: Emit
  private store: Store
  private onDead: () => void
  private preview: {
    mcpCodexConfig(
      cwd: string,
      opts?: { plan?: boolean }
    ): Promise<Record<string, unknown> | undefined>
  } | null
  private canvas: CanvasManager | null
  private codex: CodexClientLike
  private thread: CodexThreadLike | null = null
  private threadOptionsKey: string | null = null
  private threadId: string | null
  // Rebuild the thread before the next turn — thread options (model, sandbox,
  // effort) are fixed at start/resume time and have no live setter.
  private optionsDirty = true
  private pending: PendingTurn[] = []
  /** Serializes turn enqueues so a send can await its handoff context (see send). */
  private sendChain: Promise<void> = Promise.resolve()
  /**
   * Turns still waiting in the chain, so interrupt/dispose can sweep them (and
   * their temp files) *synchronously* — a swept turn is dropped, not queued.
   */
  private chainQueued = new Set<PendingTurn>()
  private checkpoints = new Map<string, WorkspaceCheckpoint>()
  private activeUserMessageId: string | null = null
  private running = false
  private abort: AbortController | null = null
  private current: AssistantMessage | null = null
  // Codex item ids (item_0, item_1, …) restart every turn, so this map — item id
  // → part location in the current assistant message — is cleared per turn.
  private itemLoc = new Map<string, { message: AssistantMessage; index: number }>()
  /** Codex child thread id → its existing Agent card in the parent message. */
  private codexAgents = new Map<
    string,
    { message: AssistantMessage; index: number; part: ToolPart }
  >()
  /** Child tool call id → location within its parent Agent card. */
  private codexChildTools = new Map<string, { parent: ToolPart; index: number }>()
  private readonly activeCodexJobs = new Map<string, BackgroundJob>()
  private readonly rolloutWatcher: CodexRolloutWatcher
  private turnStart = 0
  // Snapshot of this thread's raw generated-image files at turn start. Built-in
  // image_gen calls are not represented in the Codex SDK ThreadItem stream, so
  // the before/after diff is the reliable fallback when the final message is
  // empty and no shell command mentions the saved path.
  private generatedBeforeTurn = new Map<string, number>()
  /** Synthetic ExitPlanMode request used to reuse Carbon's plan-review UI. */
  private planReview: PersistedPlanReview | null = null
  /** Most recent native App Server plan item for the active turn. */
  private nativePlan: string | null = null
  /** Live App Server request_user_input call blocking the current Codex turn. */
  private userQuestions: PendingNativeQuestions | null = null
  /** Native command/file/permission approvals can overlap within a turn. */
  private nativeApprovals = new Map<string, PendingNativeApproval>()
  private mcpElicitations = new Map<string, PendingMcpElicitation>()
  private compactedItems = new Set<string>()
  private activeTurn: PendingTurn | null = null
  private interrupted = false
  private lastEmittedStatus: ChatStatus | null = null
  // ---- Streaming text coalescing (mirrors ClaudeSession) ----
  // reasoning/agent_message items arrive as the full accumulated text on every
  // SDK update. Emit the part once, then only the appended suffix as coalesced
  // `part-delta`s, so a k-chunk block costs O(k) IPC bytes instead of O(k²).
  // Coalesces the appended suffixes (~80ms) into `part-delta`s. Deps are read
  // lazily so this field initializer is independent of constructor ordering.
  private readonly deltas = new DeltaCoalescer(
    (ev) => this.emit(ev),
    () => this.chat.id,
    () => this.store.saveChatSoon(this.chat.id),
    () => this.disposed
  )
  // Last full text emitted per streaming slot (`${messageId}:${partIndex}`), so
  // the next update can be diffed down to its appended suffix.
  private lastText = new Map<string, string>()
  dead = false
  private disposed = false
  // One-shot AI title guards — see ClaudeSession for the rationale. `titledResumed`
  // is fixed at construction from whether this chat already has a thread id.
  private titledOnce = false
  private titlePending = false
  private readonly titledResumed: boolean
  // Per-attempt stream evidence. A clean EOF without a terminal event used to
  // turn a vanished Codex child into a successful empty turn.
  private sawItem = false
  private sawTerminal = false

  get idle(): boolean {
    return (
      !this.running &&
      this.pending.length === 0 &&
      this.activeTurn === null &&
      !this.planReview
    )
  }

  constructor(
    chat: ChatData,
    emit: Emit,
    store: Store,
    // Kept for signature symmetry with ClaudeSession; a Codex session is warm
    // (no per-turn process to outlive it), so it never dies on its own.
    onDead: () => void,
    // Injectable for provider-boundary tests; production App Server reuses
    // ~/.codex authentication through Carbon's bundled Codex CLI.
    codex?: CodexClientLike,
    rolloutWatcherFactory: CodexRolloutWatcherFactory = createCodexRolloutWatcher,
    preview: {
      mcpCodexConfig(
        cwd: string,
        opts?: { plan?: boolean }
      ): Promise<Record<string, unknown> | undefined>
    } | null = null,
    canvas: CanvasManager | null = null
  ) {
    // Checked here rather than left to the App Server spawn: `deliver` wraps
    // session construction, so a missing or switched-off CLI becomes an error
    // card naming the install command instead of a turn that dies mid-flight.
    // Skipped when a client is injected — those tests never reach a binary.
    if (!codex) requireCliPath('codex')
    this.chat = chat
    this.emit = emit
    this.store = store
    this.onDead = onDead
    this.preview = preview
    this.canvas = canvas
    this.codex =
      codex ??
      new CodexAppServerClient({
        onUserInput: (request) => this.handleNativeUserInput(request),
        onUserInputResolved: (requestId) => this.resolveNativeUserInput(requestId),
        onApproval: (request) => this.handleNativeApproval(request),
        onApprovalResolved: (requestId) => this.resolveNativeApproval(requestId),
        onMcpElicitation: (request) => this.handleMcpElicitation(request),
        onMcpElicitationResolved: (requestId) => this.resolveMcpElicitation(requestId)
      })
    this.rolloutWatcher = rolloutWatcherFactory((event) => this.handleRolloutEvent(event))
    this.threadId = chat.sessionId ?? null
    this.planReview = chat.pendingPlanReview ?? null
    this.titledResumed = !!chat.sessionId
    // Before App Server exposed the last model call's token total, Carbon put
    // cumulative per-turn usage in this field. Chats that were not opened by
    // the intervening clearing build can still carry that value. Clear it once
    // instead of showing an impossible context meter until another turn ends.
    if (chat.contextTokens != null && chat.contextTokensVersion !== 1) {
      chat.contextTokens = undefined
      chat.contextTokensVersion = 1
      this.emit({
        type: 'meta',
        chatId: chat.id,
        patch: { contextTokens: undefined, contextTokensVersion: 1 }
      })
      this.store.saveChatSoon(chat.id)
    }
    void this.onDead
    cleanupStaleTempFiles()
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
    const part = message.parts[index]
    // A full-part emit is authoritative: drop any buffered streaming delta for
    // this slot and re-baseline its text so later deltas append onto exactly this
    // part (not onto a suffix the renderer never received).
    this.deltas.drop(message.id, index)
    const key = this.deltaKey(message.id, index)
    if (part && (part.type === 'text' || part.type === 'thinking')) {
      this.lastText.set(key, part.text)
    } else {
      this.lastText.delete(key)
    }
    this.emit({
      type: 'part',
      chatId: this.chat.id,
      messageId: message.id,
      partIndex: index,
      part
    })
    this.store.saveChatSoon(this.chat.id)
  }

  private deltaKey(messageId: string, index: number): string {
    return `${messageId}:${index}`
  }

  // ---------- Sending ----------

  send(
    text: string,
    attachments: Attachment[] = [],
    label?: string,
    hiddenContext?: string | Promise<string | undefined>
  ): void {
    if (this.disposed) return
    // A freeform message supersedes a blocking native question. Resolve it with
    // an empty answer so App Server can finish that turn before the new one runs.
    this.clearUserQuestions(true)
    this.clearMcpElicitations(true)
    if (!this.chat.title) {
      // Instant placeholder from the first message; the AI title is generated in
      // parallel with the turn (see maybeGenerateTitle) and swaps it in.
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
    // Lock the composer right away — the turn may still be waiting on its
    // handoff context below, and drain() would otherwise not flip the status
    // until that resolves.
    this.setStatus(this.threadId ? 'streaming' : 'starting')
    // Snapshot the turn now (options and temp-image writes happen once);
    // the chain only waits for the handoff context and patches it into the
    // text block, so a later plain send can't overtake this one.
    const turn = this.buildPendingTurn(text, attachments, messageId)
    this.chainQueued.add(turn)
    this.sendChain = this.sendChain.then(async () => {
      let ctx: string | undefined
      try {
        ctx = (await hiddenContext) || undefined
      } catch {
        ctx = undefined
      }
      // Swept while waiting (interrupt/dispose) — dropped, temps already gone.
      if (!this.chainQueued.delete(turn)) return
      const block = turn.input[0] as { type: string; text: string } | undefined
      if (ctx && block?.type === 'text') block.text = composePrompt(block.text, ctx)
      this.pending.push(turn)
      void this.drain()
    })
  }

  private buildPendingTurn(
    text: string,
    attachments: Attachment[],
    userMessageId: string
  ): PendingTurn {
    const permissionMode = this.chat.permissionMode
    const model = this.chat.model
    const effort = this.chat.effort
    return {
      ...this.buildInput(text, attachments),
      userMessageId,
      permissionMode,
      model,
      effort,
      contextWindow: this.contextWindow(model)
    }
  }

  private buildInput(
    text: string,
    attachments: Attachment[]
  ): { input: Input; temps: string[] } {
    const images: UserInput[] = []
    const temps: string[] = []
    const filePaths: string[] = []
    const elementNotes: string[] = []
    for (const a of attachments) {
      if ((a.kind === 'image' || a.kind === 'element') && a.data && a.mediaType) {
        // Codex takes images by file path, so materialize base64 blobs to temp
        // files (Carbon's dropped/pasted images have no path of their own). The
        // copy is deleted once the turn that consumes it finishes (see runTurn).
        const path = writeTempImage(a.mediaType, a.data)
        if (path) {
          images.push({ type: 'local_image', path })
          temps.push(path)
        }
      }
      if (a.kind === 'element' && a.element) elementNotes.push(describeElement(a.element))
      if (a.kind === 'selection' && a.selection) elementNotes.push(describeSelection(a.selection))
      if (a.kind === 'file' && a.path) filePaths.push(a.path)
    }
    let prompt = text
    if (filePaths.length) {
      prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${filePaths
        .map((p) => `- ${p}`)
        .join('\n')}`
    }
    if (elementNotes.length) {
      prompt = `${prompt ? `${prompt}\n\n` : ''}${elementNotes.join('\n\n')}`
    }
    const blocks: UserInput[] = [{ type: 'text', text: prompt }, ...images]
    return { input: blocks, temps }
  }

  // ---------- Turn loop ----------

  private contextWindow(model = this.chat.model): number {
    return (
      MODEL_OPTIONS.find((m) => m.id === model)?.contextWindow ?? CODEX_CONTEXT_WINDOW
    )
  }

  private threadOptions(
    turn?: Pick<PendingTurn, 'model' | 'permissionMode' | 'effort'>
  ): AppServerThreadOptions {
    const selectedModel = turn ? turn.model : this.chat.model
    const permissionMode = turn ? turn.permissionMode : this.chat.permissionMode
    const effort = turn ? turn.effort : this.chat.effort
    // 'codex-default' means "no model override" — let the Codex config pick.
    const model = selectedModel && selectedModel !== CODEX_DEFAULT_MODEL ? selectedModel : undefined
    return {
      model,
      workingDirectory: this.chat.cwd,
      // Carbon opens arbitrary folders (not always git repos); don't block on it.
      skipGitRepoCheck: true,
      sandboxMode: sandboxForMode(permissionMode),
      approvalPolicy: approvalPolicyForMode(permissionMode),
      approvalsReviewer: approvalsReviewerForMode(permissionMode),
      modelReasoningEffort: effortForCodex(effort),
      collaborationMode: permissionMode === 'plan' ? 'plan' : 'default',
      serviceTier: this.chat.serviceTier ?? 'standard'
    }
  }

  private async ensureThread(turn: PendingTurn): Promise<CodexThreadLike> {
    const opts = this.threadOptions(turn)
    const previewConfig = await this.preview?.mcpCodexConfig(this.chat.cwd, {
      plan: opts.collaborationMode === 'plan'
    })
    const canvasConfig = await this.canvas?.mcpCodexConfig({
      cwd: this.chat.cwd,
      project: projectRoot(this.chat),
      chatId: this.chat.id
    })
    // Both overlays key into the same `mcp_servers` table, so they are merged
    // rather than assigned — the second assignment would have dropped the
    // first server entirely, which is the kind of failure that shows up as
    // "the model just never uses the preview tools".
    const servers = {
      ...((previewConfig?.mcp_servers as Record<string, unknown> | undefined) ?? {}),
      ...((canvasConfig?.mcp_servers as Record<string, unknown> | undefined) ?? {})
    }
    const rules = [
      CODEX_BROWSER_SESSION_RULES,
      previewConfig ? PREVIEW_SESSION_RULES : '',
      canvasConfig ? CANVAS_SESSION_RULES : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (Object.keys(servers).length) {
      opts.extraConfig = { mcp_servers: servers }
    }
    opts.developerInstructions = rules
    const optionsKey = JSON.stringify(opts)
    if (this.thread && !this.optionsDirty && this.threadOptionsKey === optionsKey) return this.thread
    this.thread = this.threadId
      ? this.codex.resumeThread(this.threadId, opts)
      : this.codex.startThread(opts)
    this.threadOptionsKey = optionsKey
    this.optionsDirty = false
    return this.thread
  }

  private generatedImagesRoot(): string {
    const home = homedir()
    return join(process.env.CODEX_HOME || join(home, '.codex'), 'generated_images')
  }

  /** Current image files for this Codex thread, keyed by canonical path + mtime. */
  private threadGeneratedImages(): Map<string, number> {
    const images = new Map<string, number>()
    if (!this.threadId) return images
    const dir = join(this.generatedImagesRoot(), this.threadId)
    try {
      for (const name of readdirSync(dir)) {
        if (!IMAGE_EXT.test(name)) continue
        const path = join(dir, name)
        try {
          const st = statSync(path)
          if (st.isFile()) images.set(realpathSync(path), st.mtimeMs)
        } catch {
          // A file can disappear between readdir and stat; skip it.
        }
      }
    } catch {
      // The directory does not exist until this thread generates its first image.
    }
    return images
  }

  private generatedImagesThisTurn(): string[] {
    const current = this.threadGeneratedImages()
    const fresh: string[] = []
    for (const [path, mtimeMs] of current) {
      const before = this.generatedBeforeTurn.get(path)
      if (before == null || mtimeMs > before) fresh.push(path)
    }
    return fresh
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (this.pending.length && !this.disposed) {
        await this.runTurn(this.pending.shift()!)
      }
    } finally {
      this.running = false
    }
    if (this.disposed) return
    // A send() that arrived while the loop was tearing down couldn't start a new
    // drain (running was still true) — pick it up now so no turn is dropped.
    if (this.pending.length) {
      void this.drain()
    } else if (!this.planReview) {
      this.setStatus('idle')
      this.store.saveChat(this.chat.id)
    }
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    this.abort = new AbortController()
    this.interrupted = false
    this.turnStart = Date.now()
    this.generatedBeforeTurn = this.threadGeneratedImages()
    this.current = null
    this.nativePlan = null
    this.activeUserMessageId = turn.userMessageId
    this.activeTurn = turn
    this.itemLoc.clear()
    this.compactedItems.clear()
    this.lastText.clear()
    this.codexAgents.clear()
    this.codexChildTools.clear()
    this.clearCodexJobs()
    if (this.threadId) this.rolloutWatcher.start(this.threadId, this.turnStart)
    // 'starting' until the thread has an id (first turn / cold resume), matching
    // how a fresh Claude session reads before its init.
    this.setStatus(this.threadId ? 'streaming' : 'starting')
    // Snapshot before launching Codex. The turn is already marked active so an
    // option change during this potentially slow Git scan can still abort it.
    const before = await captureWorkspaceTree(this.chat.cwd)
    try {
      let retriedMissingThread = false
      let retriedTruncatedStream = false
      while (!this.disposed) {
        this.sawItem = false
        this.sawTerminal = false
        const resumedThreadId = this.threadId
        const thread = await this.ensureThread(turn)
        try {
          const { events } = await thread.runStreamed(turn.input, {
            signal: this.abort.signal,
            // Stamps this turn with our own message id so `forkBefore` can find
            // it again in `thread/turns/list` — across an app restart, and
            // without persisting a second id beside every message.
            clientUserMessageId: turn.userMessageId
          })
          for await (const event of events) {
            if (this.disposed) break
            this.handleEvent(event, turn)
          }
          const truncated =
            !this.sawTerminal &&
            !this.disposed &&
            !this.interrupted &&
            !this.abort.signal.aborted
          if (truncated && !this.sawItem && !retriedTruncatedStream) {
            retriedTruncatedStream = true
            // Give any contending cold-start process a moment to finish before
            // resuming this same thread. Recheck cancellation after the wait.
            await new Promise((resolve) => setTimeout(resolve, 350))
            if (this.disposed || this.interrupted || this.abort.signal.aborted) break
            continue
          }
          if (truncated) {
            this.pushError(
              this.sawItem
                ? 'Codex ended the turn unexpectedly; the output above may be incomplete.'
                : 'Codex exited before reading your message. It was not processed — please send it again.'
            )
          }
          break
        } catch (err) {
          // Carbon persists the Codex thread id, while the corresponding rollout
          // lives separately under ~/.codex/sessions. If that file was cleaned or
          // moved, retry this same prompt once in a fresh thread rather than
          // permanently poisoning the chat with an unusable resume id.
          if (
            !retriedMissingThread &&
            resumedThreadId &&
            !this.disposed &&
            !this.interrupted &&
            isMissingCodexThreadError(err)
          ) {
            retriedMissingThread = true
            this.recoverFromMissingThread()
            continue
          }
          if (!this.disposed && !this.interrupted) {
            this.pushError(err instanceof Error ? err.message : String(err))
          }
          break
        }
      }
    } finally {
      // Normal turns start titling at their first substantive event. This
      // fallback covers itemless turns, interrupts, and final startup failures
      // after the conversation process is no longer competing for cold-start
      // state. It deliberately sits outside the retry loop.
      void this.maybeGenerateTitle()
      // Event handlers called above populate `current`; TS cannot see mutation
      // through those method calls, so retain the runtime value explicitly.
      const completedMessage = this.current as AssistantMessage | null
      // Emit any trailing streaming text before the turn winds down; item.completed
      // usually reconciles each slot already, but an interrupt can end mid-stream.
      this.deltas.flush()
      // Consume records flushed immediately before turn.completed, then detach
      // before `current` is cleared so no late poll can target the next turn.
      await this.rolloutWatcher.flush()
      this.rolloutWatcher.stop()
      this.abortUnfinishedCodexAgents()
      this.terminalizeRunning()
      this.current = null
      this.activeUserMessageId = null
      this.activeTurn = null
      this.itemLoc.clear()
      this.lastText.clear()
      this.abort = null
      // The SDK consumed any temp attachment copies at turn start — drop them now
      // rather than holding them for the session's lifetime.
      for (const f of turn.temps) {
        try {
          rmSync(f, { force: true })
        } catch {
          // best-effort cleanup
        }
      }
      if (before) {
        const after = await captureWorkspaceTree(this.chat.cwd)
        if (after && after.root === before.root) {
          const checkpoint = { before, after }
          this.checkpoints.set(turn.userMessageId, checkpoint)
          if (completedMessage) {
            const fileChanges = await summarizeWorkspaceCheckpoint(checkpoint)
            completedMessage.fileChanges = fileChanges
            this.emit({ type: 'message', chatId: this.chat.id, message: completedMessage })
            // terminalizeRunning() above already drove every part of this message
            // terminal, and a later turn can push past it — so the store's
            // incremental write pass has no way to see this assignment. Flag it.
            this.store.markMessageDirty(this.chat.id, completedMessage.id)
            this.store.saveChatSoon(this.chat.id)
          }
        }
      }
    }
  }

  /**
   * Replace the placeholder title with a terse AI summary of the user's opening
   * message. Fired once the conversation produces its first substantive event,
   * proving the prompt made it past cold-start initialization; it still overlaps
   * the rest of the turn. Best-effort and fire-once: skips manually-renamed and
   * resumed chats.
  */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.disposed || this.titledOnce || this.titledResumed || this.chat.titleManual) return
    // See ClaudeSession: a windowed chat's opening message may not be hydrated.
    if (this.store.hiddenBefore(this.chat.id) > 0) return
    const userText = firstUserText(this.chat.messages)
    if (!userText) return
    this.titledOnce = true
    this.setTitlePending(true)
    try {
      const title = await this.generateCodexTitle(userText)
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

  /** Terse chat title via a generateCodexText one-shot on the session's own client. */
  private async generateCodexTitle(userText: string): Promise<string | null> {
    const out = await generateCodexText(
      this.chat.cwd,
      this.threadOptions().model,
      `${TITLE_SYSTEM}\n\n${buildTitlePrompt(userText)}`,
      this.codex
    )
    return out ? cleanTitle(out) || null : null
  }

  /** Clear only an unusable Codex resume id; transcript and current prompt stay. */
  private recoverFromMissingThread(): void {
    this.thread = null
    this.threadOptionsKey = null
    this.threadId = null
    this.optionsDirty = true
    this.generatedBeforeTurn.clear()
    this.chat.sessionId = undefined
    this.chat.contextTokens = undefined
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { sessionId: undefined, contextTokens: undefined }
    })
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'info',
      text: 'The saved Codex thread was unavailable, so Carbon started a fresh Codex session.',
      ts: Date.now()
    })
    this.setStatus('starting')
    this.store.saveChat(this.chat.id)
  }

  private handleEvent(event: ThreadEvent, turn: PendingTurn): void {
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.thread_id
        this.rolloutWatcher.start(event.thread_id, this.turnStart)
        // First turns do not have an id when runTurn starts. thread.started is
        // emitted before tools run, so take their empty/pre-existing baseline now.
        this.generatedBeforeTurn = this.threadGeneratedImages()
        if (event.thread_id && event.thread_id !== this.chat.sessionId) {
          this.chat.sessionId = event.thread_id
          this.emit({ type: 'meta', chatId: this.chat.id, patch: { sessionId: event.thread_id } })
          this.store.saveChatSoon(this.chat.id)
        }
        break
      case 'item.started':
      case 'item.updated':
        this.sawItem = true
        void this.maybeGenerateTitle()
        this.upsertItem(event.item, false)
        break
      case 'item.completed':
        this.sawItem = true
        void this.maybeGenerateTitle()
        this.upsertItem(event.item, true)
        break
      case 'turn.started':
        break
      case 'turn.completed':
        this.sawTerminal = true
        void this.maybeGenerateTitle()
        this.onTurnCompleted(event.usage, turn)
        break
      case 'turn.failed':
        this.sawTerminal = true
        void this.maybeGenerateTitle()
        if (!this.disposed && !this.interrupted) {
          this.pushError(event.error?.message ?? 'The turn failed.')
        }
        break
      case 'error':
        // The SDK defines this as an unrecoverable stream error. Treat it as a
        // terminal event so the EOF guard does not retry a possibly-consumed turn.
        this.sawTerminal = true
        void this.maybeGenerateTitle()
        if (!this.disposed && !this.interrupted) this.pushError(event.message ?? 'Codex error.')
        break
      default:
        // turn.started and any future events need no handling here.
        break
    }
  }

  /**
   * Codex's image-gen skill saves the picture to a file and only *sometimes*
   * reports its path as a markdown link (effort-dependent) — so keying off the
   * final message misses images. At turn end, scan the turn's tool output/text
   * plus the before/after diff of its generated-images directory, then render any
   * files not already shown inline.
   */
  private surfaceTurnImages(): void {
    const message = this.current
    const textParts: string[] = []
    const commands: string[] = []
    const changes: string[] = []
    for (const part of message?.parts ?? []) {
      if (!part) continue
      if (part.type === 'text') textParts.push(part.text)
      else if (part.type === 'tool') {
        if (part.output) commands.push(part.output)
        const input = part.input as Record<string, unknown> | null
        if (input && typeof input.command === 'string') commands.push(input.command)
        if (Array.isArray(input?.changes)) {
          for (const ch of input!.changes as Array<{ path?: unknown }>) {
            if (typeof ch?.path === 'string') changes.push(ch.path)
          }
        }
      }
    }
    const home = homedir()
    const show = pickTurnImages(
      {
        text: textParts.join('\n'),
        commands,
        changes,
        generated: this.generatedImagesThisTurn()
      },
      {
        cwd: this.chat.cwd,
        home,
        genDir: this.generatedImagesRoot(),
        turnStart: this.turnStart,
        stat: (abs) => {
          try {
            const st = statSync(abs)
            if (!st.isFile()) return null
            return { isFile: true, mtimeMs: st.mtimeMs, real: realpathSync(abs) }
          } catch {
            return null
          }
        }
      }
    )
    if (!show.length) return
    // image_gen may be the only item in the turn and the SDK may provide no
    // agent_message at all. Create the assistant message only once we know there
    // is an image to attach, avoiding an empty bubble for ordinary silent turns.
    const target = message ?? this.ensureCurrent()
    const index = target.parts.length
    target.parts[index] = {
      type: 'text',
      text: show.map((p) => `![generated image](${p})`).join('\n\n')
    }
    this.emitPart(target, index)
  }

  private onTurnCompleted(usage: Usage | null, turn: PendingTurn): void {
    this.surfaceTurnImages()
    const codexUsage = usage as CodexTurnUsage | null
    const window = codexUsage?.context_window ?? turn.contextWindow
    const contextTokens = codexUsage?.context_tokens
    const meta: Partial<ChatMeta> = {}
    if (this.chat.contextWindow !== window) {
      this.chat.contextWindow = window
      meta.contextWindow = window
    }
    if (contextTokens != null && this.chat.contextTokens !== contextTokens) {
      this.chat.contextTokens = contextTokens
      meta.contextTokens = contextTokens
    }
    if (contextTokens != null && this.chat.contextTokensVersion !== 1) {
      this.chat.contextTokensVersion = 1
      meta.contextTokensVersion = 1
    }
    if (Object.keys(meta).length) this.emit({ type: 'meta', chatId: this.chat.id, patch: meta })
    const stats: TurnStats = {
      // ChatGPT-subscription usage has no per-turn dollar cost to report.
      costUsd: 0,
      durationMs: Date.now() - this.turnStart,
      numTurns: 1,
      model: codexUsage?.model || turn.model || 'Codex',
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens
    }
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'turn', text: '', ts: Date.now(), stats })
    this.chat.updatedAt = Date.now()
    this.store.saveChat(this.chat.id)
    this.offerPlanForReview(turn)
  }

  /** Turn a completed Codex planning response into the same review event Claude uses. */
  private offerPlanForReview(turn: PendingTurn): void {
    if (
      turn.permissionMode !== 'plan' ||
      this.chat.permissionMode !== 'plan' ||
      this.planReview ||
      this.interrupted
    )
      return
    let plan = this.nativePlan?.trim() || ''
    // Keep compatibility with injected/older transports that returned a tagged
    // assistant message instead of App Server's dedicated plan item.
    if (!plan) {
      const message = this.current
      if (!message) return
      for (let index = message.parts.length - 1; index >= 0; index--) {
        const part = message.parts[index]
        if (!part || part.type !== 'text') continue
        const parsed = parseCodexPlan(part.text)
        if (!parsed) continue
        plan = parsed.plan
        if (parsed.displayText !== part.text) {
          message.parts[index] = { ...part, text: parsed.displayText }
          this.emitPart(message, index)
        }
        break
      }
    }
    if (!plan) return
    const requestId = randomUUID()
    const review = {
      requestId,
      plan,
      userMessageId: this.activeUserMessageId ?? ''
    }
    this.planReview = review
    this.chat.pendingPlanReview = review
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { pendingPlanReview: review }
    })
    this.store.saveChat(this.chat.id)
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: requestId,
        chatId: this.chat.id,
        toolUseId: `codex-plan-${requestId}`,
        toolName: 'ExitPlanMode',
        input: { plan },
        title: 'Review plan',
        displayName: 'Codex plan',
        description: 'Approve this plan to implement it, or request a revision.',
        hasSuggestions: false
      }
    })
    this.setStatus('waiting-permission')
  }

  private hasBlockingNativeRequest(): boolean {
    return (
      this.nativeApprovals.size > 0 ||
      this.mcpElicitations.size > 0 ||
      this.userQuestions?.isBlocking === true
    )
  }

  private restoreStreamingAfterNativeRequest(): void {
    if (this.running && !this.disposed && !this.hasBlockingNativeRequest()) {
      this.setStatus('streaming')
    }
  }

  /** Surface App Server's native request_user_input call in Carbon. */
  private handleNativeUserInput(request: NativeUserInputRequest): void {
    if (this.disposed || (this.threadId != null && request.threadId !== this.threadId)) {
      this.codex.dismissUserInput?.(request.requestId)
      return
    }
    // App Server can send another request after the first is resolved, but never
    // two live request_user_input calls for one turn. Resolve a stale card if a
    // provider bug violates that invariant.
    this.clearUserQuestions(true)
    const questions: UserQuestion[] = request.questions.map((question) => ({
      id: question.id,
      question: question.question,
      header: question.header || 'Question',
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {})
      })),
      allowOther: question.isOther || !question.options?.length,
      isSecret: question.isSecret
    }))
    this.userQuestions = {
      requestId: request.requestId,
      questions,
      isBlocking: request.isBlocking !== false
    }
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: request.requestId,
        chatId: this.chat.id,
        toolUseId: request.itemId,
        toolName: 'AskUserQuestion',
        input: { questions },
        title: 'Answer questions',
        displayName: 'Codex questions',
        description: request.isBlocking === false
          ? 'Codex requested input; the turn can continue while you answer.'
          : 'Codex needs your input to continue.',
        hasSuggestions: false
      }
    })
    if (request.isBlocking !== false) this.setStatus('waiting-permission')
  }

  private resolveNativeUserInput(requestId: string): void {
    if (this.userQuestions?.requestId !== requestId) return
    this.clearUserQuestions(false)
    this.restoreStreamingAfterNativeRequest()
  }

  private handleNativeApproval(request: NativeApprovalRequest): void {
    if (this.disposed || (this.threadId != null && request.threadId !== this.threadId)) {
      this.codex.respondToApproval?.(request.requestId, false)
      return
    }
    const { params } = request
    const command = typeof params.command === 'string' ? params.command : ''
    const cwd = typeof params.cwd === 'string' ? params.cwd : this.chat.cwd
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined
    const permissionInput =
      params.permissions && typeof params.permissions === 'object' ? params.permissions : {}
    const input =
      request.kind === 'command'
        ? { command, cwd, commandActions: params.commandActions ?? [] }
        : request.kind === 'file-change'
          ? { file_path: grantRoot, grantRoot }
          : { cwd, permissions: permissionInput }
    const title =
      request.kind === 'command'
        ? 'Approve command'
        : request.kind === 'file-change'
          ? 'Approve file access'
          : 'Approve additional access'
    const displayName =
      request.kind === 'command'
        ? 'Codex command'
        : request.kind === 'file-change'
          ? 'Codex file change'
          : 'Codex permissions'
    this.nativeApprovals.set(request.requestId, {
      requestId: request.requestId,
      kind: request.kind
    })
    this.emit({
      type: 'permission-request',
      chatId: this.chat.id,
      request: {
        id: request.requestId,
        chatId: this.chat.id,
        toolUseId: request.itemId,
        toolName:
          request.kind === 'command'
            ? 'Bash'
            : request.kind === 'file-change'
              ? 'Edit'
              : 'RequestPermissions',
        input,
        title,
        displayName,
        description: reason,
        decisionReason: reason,
        hasSuggestions: true
      }
    })
    this.setStatus('waiting-permission')
  }

  private resolveNativeApproval(requestId: string): void {
    if (!this.nativeApprovals.delete(requestId)) return
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    this.restoreStreamingAfterNativeRequest()
  }

  private handleMcpElicitation(request: NativeMcpElicitationRequest): void {
    if (this.disposed || (this.threadId != null && request.threadId !== this.threadId)) {
      this.codex.respondToMcpElicitation?.(request.requestId, false)
      return
    }
    this.mcpElicitations.set(request.requestId, {
      requestId: request.requestId,
      mode: request.mode,
      ...(request.requestedSchema ? { schema: request.requestedSchema } : {})
    })
    if (request.mode === 'url') {
      this.emit({
        type: 'permission-request',
        chatId: this.chat.id,
        request: {
          id: request.requestId,
          chatId: this.chat.id,
          toolUseId: `mcp-elicitation-${request.requestId}`,
          toolName: 'McpElicitation',
          input: { server: request.serverName, url: request.url },
          title: `${request.serverName} needs authorization`,
          displayName: 'MCP authorization',
          description: request.message,
          hasSuggestions: false
        }
      })
    } else {
      const properties =
        request.requestedSchema?.properties &&
        typeof request.requestedSchema.properties === 'object'
          ? (request.requestedSchema.properties as Record<string, unknown>)
          : {}
      const required = new Set(
        Array.isArray(request.requestedSchema?.required)
          ? request.requestedSchema.required.map(String)
          : []
      )
      const questions: UserQuestion[] = Object.entries(properties).map(([id, value]) => {
        const schema = (value ?? {}) as Record<string, unknown>
        const items =
          schema.items && typeof schema.items === 'object'
            ? (schema.items as Record<string, unknown>)
            : {}
        const enumValues = Array.isArray(schema.enum)
          ? schema.enum
          : Array.isArray(items.enum)
            ? items.enum
            : []
        return {
          id,
          header: typeof schema.title === 'string' ? schema.title : id,
          question:
            typeof schema.description === 'string' ? schema.description : `Enter ${id}`,
          options: enumValues.map((entry) => ({ label: String(entry) })),
          required: required.has(id),
          allowOther: enumValues.length === 0,
          multiSelect: schema.type === 'array',
          isSecret: schema.format === 'password'
        }
      })
      this.emit({
        type: 'permission-request',
        chatId: this.chat.id,
        request: {
          id: request.requestId,
          chatId: this.chat.id,
          toolUseId: `mcp-elicitation-${request.requestId}`,
          toolName: questions.length ? 'AskUserQuestion' : 'McpElicitation',
          input: questions.length
            ? { questions }
            : { server: request.serverName, schema: request.requestedSchema },
          title: `${request.serverName} needs input`,
          displayName: 'MCP form',
          description: request.message,
          hasSuggestions: false
        }
      })
    }
    this.setStatus('waiting-permission')
  }

  private mcpElicitationContent(
    pending: PendingMcpElicitation,
    updatedInput: Record<string, unknown> | undefined
  ): Record<string, unknown> | null {
    if (pending.mode === 'url') return null
    const answers =
      updatedInput?.answersById && typeof updatedInput.answersById === 'object'
        ? (updatedInput.answersById as Record<string, unknown>)
        : {}
    const properties =
      pending.schema?.properties && typeof pending.schema.properties === 'object'
        ? (pending.schema.properties as Record<string, unknown>)
        : {}
    const content: Record<string, unknown> = {}
    for (const [id, raw] of Object.entries(answers)) {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)]
      const schema = (properties[id] ?? {}) as Record<string, unknown>
      const value = values[0] ?? ''
      if (schema.type === 'boolean') content[id] = value.toLowerCase() === 'true'
      else if (schema.type === 'number' || schema.type === 'integer') content[id] = Number(value)
      else if (schema.type === 'array') content[id] = values
      else {
        const enumValues = Array.isArray(schema.enum) ? schema.enum : []
        content[id] = enumValues.find((entry) => String(entry) === value) ?? value
      }
    }
    return content
  }

  private resolveMcpElicitation(requestId: string): void {
    if (!this.mcpElicitations.delete(requestId)) return
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    this.restoreStreamingAfterNativeRequest()
  }

  // ---------- Item → part mapping ----------

  private upsertItem(item: ThreadItem, terminal: boolean): void {
    if (isCodexCompactionItem(item as unknown)) {
      if (!terminal || this.compactedItems.has(item.id)) return
      this.compactedItems.add(item.id)
      // Compaction is a real transcript boundary. App Server keeps the turn
      // alive afterwards, so leave the assistant accumulated before it in
      // place and make the next new item start a message below the divider.
      // Otherwise `ensureCurrent()` keeps appending into the message above the
      // divider, leaving "Codex compacted…" stuck at the bottom for the rest of
      // the turn (and violating the renderer's last-message-is-live invariant).
      this.current = null
      this.pushMessage({
        id: randomUUID(),
        role: 'event',
        kind: 'compact',
        text: 'Codex compacted the conversation context.',
        ts: Date.now()
      })
      return
    }
    if (isCodexImageViewItem(item as unknown)) {
      const image = item as unknown as { id: string; path: string }
      const part: ToolPart = {
        type: 'tool',
        toolUseId: image.id,
        name: 'Read',
        input: { file_path: image.path },
        status: terminal ? 'success' : 'running'
      }
      const message = this.ensureCurrent()
      const loc = this.itemLoc.get(image.id)
      if (loc) {
        loc.message.parts[loc.index] = part
        this.emitPart(loc.message, loc.index)
      } else {
        const index = message.parts.length
        message.parts[index] = part
        this.itemLoc.set(image.id, { message, index })
        this.emitPart(message, index)
      }
      return
    }
    if (isCodexPlanItem(item as unknown)) {
      const plan = (item as unknown as { text: string }).text
      this.nativePlan = plan
      if (!plan) return
      const part: ToolPart = {
        type: 'tool',
        toolUseId: item.id,
        name: 'ExitPlanMode',
        input: { plan },
        status: terminal ? 'success' : 'running'
      }
      const message = this.ensureCurrent()
      const loc = this.itemLoc.get(item.id)
      if (loc) {
        loc.message.parts[loc.index] = part
        this.emitPart(loc.message, loc.index)
      } else {
        const index = message.parts.length
        message.parts[index] = part
        this.itemLoc.set(item.id, { message, index })
        this.emitPart(message, index)
      }
      return
    }
    // codex exec already emits this item at runtime, but @openai/codex-sdk
    // 0.144.x has not added it to its TypeScript ThreadItem union yet.
    if (isCodexCollabToolCallItem(item as unknown)) {
      this.upsertCollabItem(item as unknown as CodexCollabToolCallItem)
      return
    }
    // Error items go through the same id-keyed upsert as everything else, so a
    // repeated lifecycle event for one error id updates in place instead of
    // appending a duplicate notice each time.
    const part =
      item.type === 'error'
        ? ({ type: 'text', text: `⚠️ ${item.message}` } as AssistantPart)
        : this.itemToPart(item, terminal)
    if (!part) return
    const message = this.ensureCurrent()
    const loc = this.itemLoc.get(item.id)
    if (loc) {
      loc.message.parts[loc.index] = part
      // reasoning/agent_message blocks re-send the full accumulated text on every
      // update; while streaming, emit only the appended suffix as a delta. Any
      // non-streaming or diverged update falls through to an authoritative part.
      if (!terminal && this.emitStreamingDelta(loc.message, loc.index, item, part)) return
      this.emitPart(loc.message, loc.index)
    } else {
      const index = message.parts.length
      message.parts[index] = part
      this.itemLoc.set(item.id, { message, index })
      // First sighting sends a full part so the renderer has a slot to append into.
      this.emitPart(message, index)
    }
  }

  /**
   * If `item` is a still-streaming reasoning/agent_message block, emit only the
   * text appended since the last emit as a coalesced `part-delta` and return true.
   * Returns false when a full-part emit is required — a non-text item, or text
   * that did not grow as a pure suffix (e.g. a rewrite) — so the caller reconciles
   * the slot with an authoritative `part`.
   */
  private emitStreamingDelta(
    message: AssistantMessage,
    index: number,
    item: ThreadItem,
    part: AssistantPart
  ): boolean {
    if (item.type !== 'agent_message' && item.type !== 'reasoning') return false
    if (part.type !== 'text' && part.type !== 'thinking') return false
    const key = this.deltaKey(message.id, index)
    const prev = this.lastText.get(key)
    if (prev == null || !part.text.startsWith(prev)) return false
    const delta = part.text.slice(prev.length)
    this.lastText.set(key, part.text)
    if (delta) this.deltas.queue(message.id, index, delta)
    return true
  }

  private ensureCodexAgent(
    threadId: string,
    description = 'Codex sub-agent'
  ): { message: AssistantMessage; index: number; part: ToolPart } {
    const existing = this.codexAgents.get(threadId)
    if (existing) {
      const input = (existing.part.input ?? {}) as Record<string, unknown>
      if ((!input.description || input.description === 'Codex sub-agent') && description) {
        this.updateCodexAgent(existing, { input: { ...input, description } })
      }
      return existing
    }

    const message = this.ensureCurrent()
    const part: ToolPart = {
      type: 'tool',
      toolUseId: `codex-agent-${threadId}`,
      name: 'Agent',
      input: {
        subagent_type: 'Codex',
        description,
        agent_id: threadId
      },
      status: 'running',
      children: [],
      // Timed from the moment the spawn is seen. The model, effort and token
      // total arrive later, off the child's own rollout file.
      agent: { startedAt: Date.now() }
    }
    const index = message.parts.length
    message.parts[index] = part
    const loc = { message, index, part }
    this.codexAgents.set(threadId, loc)
    this.emitPart(message, index)
    return loc
  }

  private emitCodexJobs(): void {
    this.emit({
      type: 'background-jobs',
      chatId: this.chat.id,
      jobs: [...this.activeCodexJobs.values()]
    })
  }

  private setCodexJob(threadId: string, description: string): void {
    const prior = this.activeCodexJobs.get(threadId)
    if (prior?.description === description) return
    this.activeCodexJobs.set(threadId, {
      id: threadId,
      type: 'subagent',
      description,
      // The current Codex SDK exposes child status but no per-child stop call.
      stoppable: false
    })
    this.emitCodexJobs()
  }

  private finishCodexJob(threadId: string): void {
    if (!this.activeCodexJobs.delete(threadId)) return
    this.emitCodexJobs()
  }

  private clearCodexJobs(): void {
    if (this.activeCodexJobs.size === 0) return
    this.activeCodexJobs.clear()
    this.emitCodexJobs()
  }

  private updateCodexAgent(
    loc: { message: AssistantMessage; index: number; part: ToolPart },
    patch: Partial<Omit<ToolPart, 'type' | 'toolUseId' | 'name'>>
  ): void {
    // A terminal status stops the run's clock, whichever path reported it — the
    // child's own rollout file, a collab item, or the parent turn ending. Doing
    // it here rather than at each site is what keeps a Codex agent from being
    // drawn finished with no duration at all.
    const status = patch.status
    if (
      loc.part.agent &&
      !patch.agent &&
      status &&
      status !== 'running' &&
      status !== 'pending'
    ) {
      patch = { ...patch, agent: { ...loc.part.agent, endedAt: Date.now() } }
    }
    Object.assign(loc.part, patch)
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId: loc.message.id,
      toolUseId: loc.part.toolUseId,
      patch
    })
    this.store.saveChatSoon(this.chat.id)
  }

  private emitCodexChildren(
    loc: { message: AssistantMessage; index: number; part: ToolPart }
  ): void {
    this.updateCodexAgent(loc, { children: [...(loc.part.children ?? [])] })
  }

  private appendCodexAgentText(threadId: string, text: string): void {
    const clean = text.trim()
    if (!clean) return
    const loc = this.ensureCodexAgent(threadId)
    const children = loc.part.children ?? (loc.part.children = [])
    const last = children.at(-1)
    if (last?.type === 'text' && last.text === clean) return
    children.push({ type: 'text', text: clean })
    this.emitCodexChildren(loc)
  }

  private startCodexAgentTool(
    threadId: string,
    toolUseId: string,
    name: string,
    input: unknown
  ): void {
    const key = `${threadId}:${toolUseId}`
    if (this.codexChildTools.has(key)) return
    const loc = this.ensureCodexAgent(threadId)
    const children = loc.part.children ?? (loc.part.children = [])
    const part: ToolPart = {
      type: 'tool',
      toolUseId: key,
      name,
      input,
      status: 'running'
    }
    const index = children.length
    children.push(part)
    this.codexChildTools.set(key, { parent: loc.part, index })
    this.emitCodexChildren(loc)
  }

  private completeCodexAgentTool(
    threadId: string,
    toolUseId: string,
    output: string | undefined,
    failed: boolean
  ): void {
    const key = `${threadId}:${toolUseId}`
    let child = this.codexChildTools.get(key)
    if (!child) {
      this.startCodexAgentTool(threadId, toolUseId, 'Tool', { description: 'Agent action' })
      child = this.codexChildTools.get(key)
    }
    const loc = this.codexAgents.get(threadId)
    if (!child || !loc?.part.children) return
    const prior = loc.part.children[child.index]
    if (prior?.type !== 'tool') return
    loc.part.children[child.index] = {
      ...prior,
      status: failed ? 'error' : 'success',
      ...(output ? { output } : {})
    }
    this.emitCodexChildren(loc)
  }

  /**
   * Fold the child's own reported vitals onto its card.
   *
   * `tokens` replaces rather than accumulates — the CLI already reports a
   * running total per thread. A no-op when nothing moved, because the watcher
   * re-reads a `token_count` line for every poll of a file that has grown, and
   * an update per poll would repaint the panel for a number that is unchanged.
   */
  private applyCodexAgentUsage(
    threadId: string,
    usage: { model?: string; effort?: string; tokens?: number }
  ): void {
    const loc = this.codexAgents.get(threadId)
    if (!loc) return
    const prior = loc.part.agent ?? { startedAt: Date.now() }
    const next = {
      ...prior,
      ...(usage.model ? { model: usage.model } : {}),
      ...(usage.effort ? { effort: usage.effort } : {}),
      ...(usage.tokens != null ? { tokens: usage.tokens } : {})
    }
    if (
      prior.model === next.model &&
      prior.effort === next.effort &&
      prior.tokens === next.tokens
    ) {
      return
    }
    this.updateCodexAgent(loc, { agent: next })
  }

  private completeCodexAgent(
    threadId: string,
    failed: boolean,
    result?: string
  ): void {
    const loc = this.ensureCodexAgent(threadId)
    if (loc.part.children) {
      loc.part.children = loc.part.children.map((child) =>
        child.type === 'tool' && (child.status === 'running' || child.status === 'pending')
          ? { ...child, status: failed ? 'error' : 'success' }
          : child
      )
    }
    this.updateCodexAgent(loc, {
      status: failed ? 'error' : 'success',
      children: [...(loc.part.children ?? [])],
      ...(result ? { output: result } : {})
    })
    this.finishCodexJob(threadId)
  }

  private abortUnfinishedCodexAgents(): void {
    for (const [threadId, loc] of this.codexAgents) {
      if (loc.part.status !== 'running' && loc.part.status !== 'pending') continue
      this.completeCodexAgent(
        threadId,
        true,
        'This agent was interrupted because the parent Codex turn ended before it finished.'
      )
    }
    this.clearCodexJobs()
  }

  private handleRolloutEvent(event: CodexRolloutEvent): void {
    if (this.disposed || !this.activeTurn) return
    switch (event.type) {
      case 'agent-start':
        this.ensureCodexAgent(event.threadId, event.name)
        this.setCodexJob(event.threadId, event.name)
        break
      case 'agent-text':
        this.appendCodexAgentText(event.threadId, event.text)
        break
      case 'agent-tool-start':
        this.startCodexAgentTool(
          event.threadId,
          event.toolUseId,
          event.name,
          event.input
        )
        break
      case 'agent-tool-complete':
        this.completeCodexAgentTool(
          event.threadId,
          event.toolUseId,
          event.output,
          event.failed
        )
        break
      case 'agent-complete':
        this.completeCodexAgent(event.threadId, event.failed, event.result)
        break
      case 'agent-usage':
        this.applyCodexAgentUsage(event.threadId, {
          model: event.model,
          effort: event.effort,
          tokens: event.tokens
        })
        break
    }
  }

  private upsertCollabItem(item: CodexCollabToolCallItem): void {
    const ids = new Set([...item.receiver_thread_ids, ...Object.keys(item.agents_states)])

    for (const threadId of ids) {
      const state = item.agents_states[threadId]
      const description = item.prompt?.trim().slice(0, 500) || state?.message || 'Codex sub-agent'
      const loc = this.ensureCodexAgent(threadId, description)
      const status = state ? agentStatus(state.status) : agentStatus(item.status)
      const patch: Partial<Omit<ToolPart, 'type' | 'toolUseId' | 'name'>> = { status }
      if (state?.message) patch.output = state.message
      this.updateCodexAgent(loc, patch)
      if (status === 'running' || status === 'pending') {
        this.setCodexJob(threadId, description)
      } else {
        this.finishCodexJob(threadId)
      }
    }
  }

  private itemToPart(item: ThreadItem, terminal: boolean): AssistantPart | null {
    switch (item.type) {
      case 'agent_message':
        return { type: 'text', text: item.text ?? '' }
      case 'reasoning':
        return { type: 'thinking', text: item.text ?? '' }
      case 'command_execution': {
        const out = item.aggregated_output ?? ''
        const withExit =
          item.exit_code != null && item.exit_code !== 0
            ? `${out}${out ? '\n' : ''}[exit ${item.exit_code}]`
            : out
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'Bash', // renders as the Terminal card, with `command` as the summary
          input: { command: item.command },
          output: withExit ? cap(withExit) : undefined,
          status: cmdStatus(item.status)
        }
      }
      case 'file_change':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'Edit', // renders as the Edit card; summary is the first path
          input: { file_path: item.changes[0]?.path, changes: item.changes },
          output: item.changes.map((c) => `${c.kind.padEnd(6)} ${c.path}`).join('\n'),
          status: cmdStatus(item.status)
        }
      case 'mcp_tool_call':
        return {
          type: 'tool',
          toolUseId: item.id,
          // `mcp__server__tool` — ToolCard strips the `mcp__` prefix for the label.
          name: `mcp__${item.server}__${item.tool}`,
          input: item.arguments,
          output: this.mcpOutput(item),
          // Image results (e.g. an image-generation tool) render inline as a
          // screenshot on the tool card.
          outputImages: this.mcpImages(item),
          status: cmdStatus(item.status)
        }
      case 'web_search':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'WebSearch',
          input: { query: item.query },
          // web_search items carry no status field, so derive it from the
          // lifecycle: only 'completed' means the results are back.
          status: terminal ? 'success' : 'running'
        }
      case 'todo_list':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'TodoWrite', // reuses the live task-checklist card
          input: {
            todos: item.items.map((t) => ({
              content: t.text,
              status: t.completed ? 'completed' : 'pending'
            }))
          },
          status: 'success'
        }
      default:
        return null
    }
  }

  private mcpOutput(item: {
    result?: { content?: unknown; structured_content?: unknown }
    error?: { message: string }
  }): string | undefined {
    if (item.error) return item.error.message
    const content = item.result?.content
    const text = (Array.isArray(content) ? content : [])
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return cap(text)
    const structured = item.result?.structured_content
    return structured == null ? undefined : cap(JSON.stringify(structured, null, 2))
  }

  /** Pulls image blocks out of an MCP tool result (MCP shape: {data, mimeType}). */
  private mcpImages(item: { result?: { content?: unknown } }):
    | { mediaType: string; data: string }[]
    | undefined {
    const content = item.result?.content
    if (!Array.isArray(content)) return undefined
    const images: { mediaType: string; data: string }[] = []
    for (const c of content as Array<Record<string, unknown>>) {
      if (c?.type !== 'image') continue
      const data = typeof c.data === 'string' ? c.data : undefined
      if (!data) continue
      const mediaType =
        typeof c.mimeType === 'string'
          ? c.mimeType
          : typeof c.mime_type === 'string'
            ? c.mime_type
            : 'image/png'
      images.push({ mediaType, data })
    }
    return images.length ? images : undefined
  }

  /**
   * On turn end (especially an interrupt), mark any tool part still shown as
   * running as errored. An aborted stream can end without a terminal item event,
   * which would otherwise leave the card spinning forever — and persist that way.
   */
  private terminalizeRunning(): void {
    const message = this.current
    if (!message) return
    let changed = false
    message.parts.forEach((part, index) => {
      if (!part || part.type !== 'tool') return
      const children = part.children?.map((child) =>
        child.type === 'tool' && (child.status === 'running' || child.status === 'pending')
          ? { ...child, status: 'error' as const }
          : child
      )
      const childrenChanged = children?.some(
        (child, childIndex) => child !== part.children?.[childIndex]
      )
      const running = part.status === 'running' || part.status === 'pending'
      if (running || childrenChanged) {
        const patch: Partial<ToolPart> = {
          ...(running ? { status: 'error' } : {}),
          ...(childrenChanged ? { children } : {})
        }
        message.parts[index] = { ...part, ...patch }
        this.emit({
          type: 'tool-update',
          chatId: this.chat.id,
          messageId: message.id,
          toolUseId: part.toolUseId,
          patch
        })
        changed = true
      }
    })
    if (changed) this.store.saveChatSoon(this.chat.id)
  }

  // ---------- Control ----------

  async interrupt(): Promise<void> {
    this.interrupted = true
    this.cleanupPendingTurns()
    this.abort?.abort()
    this.clearPlanReview()
    this.clearUserQuestions(true)
    this.clearNativeApprovals(true)
    this.clearMcpElicitations(true)
    // An active run still has terminalization/checkpoint cleanup to finish. Let
    // drain() publish idle afterward so the renderer cannot send into that gap.
    if (!this.running) this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    this.chat.model = model || undefined
    this.optionsDirty = true
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    // Thread options are fixed for a running Codex process. Abort a turn whose
    // sandbox no longer matches the selected mode instead of letting it continue
    // with broader permissions under a newly restrictive UI state.
    if (this.activeTurn && this.activeTurn.permissionMode !== mode) {
      this.interrupted = true
      this.abort?.abort()
    }
    if (mode !== 'plan') this.clearPlanReview()
    this.chat.permissionMode = mode
    this.optionsDirty = true
  }

  // ---- Unsupported-by-Codex surface: safe no-ops / empty introspection ----

  async stopBackgroundJob(): Promise<void> {}

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const questions = this.userQuestions
    if (questions && questions.requestId === requestId) {
      if (decision.behavior === 'allow') {
        this.codex.respondToUserInput?.(
          requestId,
          this.nativeAnswers(questions.questions, decision.updatedInput)
        )
      } else {
        this.codex.dismissUserInput?.(requestId)
      }
      return
    }
    const approval = this.nativeApprovals.get(requestId)
    if (approval) {
      this.codex.respondToApproval?.(
        requestId,
        decision.behavior === 'allow',
        decision.behavior === 'allow' && decision.always === true
      )
      return
    }
    const elicitation = this.mcpElicitations.get(requestId)
    if (elicitation) {
      this.codex.respondToMcpElicitation?.(
        requestId,
        decision.behavior === 'allow',
        decision.behavior === 'allow'
          ? this.mcpElicitationContent(elicitation, decision.updatedInput)
          : null
      )
      return
    }
    const review = this.planReview ?? this.chat.pendingPlanReview ?? null
    if (!review || review.requestId !== requestId) return
    this.clearPlanReview()

    if (decision.behavior === 'allow') {
      const prior = this.chat.modeBeforePlan
      const restore = prior && prior !== 'plan' ? prior : 'default'
      this.chat.modeBeforePlan = undefined
      this.chat.permissionMode = restore
      this.optionsDirty = true
      const patch: Partial<ChatMeta> = { permissionMode: restore, modeBeforePlan: undefined }
      // A plan approval may carry the model to implement with ("Build with" in
      // the plan review). Apply it before the implementation turn is built —
      // the turn snapshots chat.model, so this is what makes it take effect.
      if (decision.model !== undefined) {
        const next = decision.model || undefined
        if (next !== this.chat.model) {
          this.chat.model = next
          patch.model = next
        }
      }
      // The implementation can use a different reasoning level than planning.
      // Validate against the selected model even though the renderer already
      // constrains the menu, since permission decisions cross the IPC boundary.
      const supported = MODEL_OPTIONS.find((m) => m.id === this.chat.model)?.supportedEfforts
      if (decision.effort !== undefined) {
        const requested = decision.effort || undefined
        this.chat.effort =
          requested && supported && !supported.includes(requested) ? undefined : requested
        patch.effort = this.chat.effort
      } else if (
        decision.model !== undefined &&
        supported &&
        this.chat.effort &&
        !supported.includes(this.chat.effort)
      ) {
        // With no explicit implementation effort, retain the planning effort
        // when possible and otherwise fall back to the provider configuration.
        this.chat.effort = undefined
        patch.effort = undefined
      }
      this.emit({ type: 'meta', chatId: this.chat.id, patch })
      this.pushMessage({
        id: randomUUID(),
        role: 'event',
        kind: 'info',
        text: 'Plan approved. Codex is implementing it.',
        ts: Date.now()
      })
      this.pending.push(
        this.buildPendingTurn(
          `The user approved the following plan. Implement it completely now.\n\n<approved_plan>\n${review.plan}\n</approved_plan>`,
          [],
          review.userMessageId
        )
      )
    } else {
      const feedback = decision.message?.trim() || 'Revise the plan and propose it again.'
      const feedbackId = randomUUID()
      this.pushMessage({ id: feedbackId, role: 'user', text: feedback, ts: Date.now() })
      this.pending.push(
        this.buildPendingTurn(
          `The user requested changes to the proposed plan. Stay in Plan mode and produce a revised proposal.\n\n<previous_plan>\n${review.plan}\n</previous_plan>\n\n<plan_feedback>\n${feedback}\n</plan_feedback>`,
          [],
          feedbackId
        )
      )
    }
    this.chat.updatedAt = Date.now()
    this.store.saveChat(this.chat.id)
    void this.drain()
  }

  private nativeAnswers(
    questions: UserQuestion[],
    updatedInput: Record<string, unknown> | undefined
  ): Record<string, { answers: string[] }> {
    const byId =
      updatedInput?.answersById && typeof updatedInput.answersById === 'object'
        ? (updatedInput.answersById as Record<string, unknown>)
        : {}
    const byQuestion =
      updatedInput?.answers && typeof updatedInput.answers === 'object'
        ? (updatedInput.answers as Record<string, unknown>)
        : {}
    const result: Record<string, { answers: string[] }> = {}
    for (const question of questions) {
      if (!question.id) continue
      const raw = byId[question.id] ?? byQuestion[question.question]
      const answers = Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string' && !!value.trim())
        : typeof raw === 'string' && raw.trim()
          ? [raw.trim()]
          : []
      result[question.id] = { answers }
    }
    return result
  }

  private clearUserQuestions(dismissProvider = false): void {
    const questions = this.userQuestions
    if (!questions) return
    const { requestId } = questions
    this.userQuestions = null
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    if (dismissProvider) this.codex.dismissUserInput?.(requestId)
  }

  private clearNativeApprovals(declineProvider = false): void {
    for (const requestId of [...this.nativeApprovals.keys()]) {
      this.nativeApprovals.delete(requestId)
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
      if (declineProvider) this.codex.respondToApproval?.(requestId, false)
    }
  }

  private clearMcpElicitations(declineProvider = false): void {
    for (const requestId of [...this.mcpElicitations.keys()]) {
      this.mcpElicitations.delete(requestId)
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
      if (declineProvider) this.codex.respondToMcpElicitation?.(requestId, false)
    }
  }

  private clearPlanReview(): void {
    const review = this.planReview ?? this.chat.pendingPlanReview
    if (!review) return
    const { requestId } = review
    this.planReview = null
    this.chat.pendingPlanReview = undefined
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { pendingPlanReview: undefined }
    })
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    this.store.saveChat(this.chat.id)
  }

  private cleanupPendingTurns(): void {
    for (const turn of [...this.pending, ...this.chainQueued]) {
      for (const file of turn.temps) {
        try {
          rmSync(file, { force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
    this.pending.length = 0
    this.chainQueued.clear()
  }

  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const checkpoint = this.checkpoints.get(userMessageId)
    if (!checkpoint) {
      return { canRewind: false, error: 'No Codex workspace checkpoint is available for this turn.' }
    }
    return rewindWorkspaceCheckpoint(this.chat.cwd, checkpoint, dryRun)
  }

  /**
   * Fork the thread so it ends just before the turn for message `index` started.
   *
   * `thread/fork` is the right call rather than `thread/revert`, which the CLI
   * only serves for threads whose history was promoted to `paginated` (ours are
   * `legacy`) — and rather than `thread/rollback`, which the app server reports
   * as deprecated. The fork leaves the source thread untouched and returns a new
   * id, so a failure here costs nothing.
   *
   * The turn is found by the `clientId` our own `clientUserMessageId` put there,
   * which is why this survives a restart and needs nothing on our messages. A
   * turn that predates that stamp cannot be named, so the caller replays.
   */
  async forkBefore(index: number): Promise<string | undefined> {
    const message = this.chat.messages[index]
    if (!this.threadId || !message) return undefined
    try {
      const beforeTurnId = await this.findTurnId(this.threadId, message.id, message.ts)
      if (!beforeTurnId) return undefined
      const forked = await this.controlRequest<{ thread?: { id?: string } }>('thread/fork', {
        threadId: this.threadId,
        beforeTurnId
      })
      return forked?.thread?.id ?? undefined
    } catch (err) {
      console.error('Codex thread/fork failed:', err)
      return undefined
    }
  }

  /**
   * The Codex turn whose user message carries `clientId === messageId`.
   *
   * Turns come back newest-first, and `sentAt` is what stops the walk: once a
   * page reaches turns older than the edited message, the target cannot be
   * further back. Without it the common case is the expensive one — no thread
   * predating `clientUserMessageId` carries a `clientId` at all, so every one of
   * them would page to the front of the thread (25 turns and ~366 KB per
   * request, parsed synchronously on the main process) only to answer null.
   */
  private async findTurnId(
    threadId: string,
    messageId: string,
    sentAt: number
  ): Promise<string | null> {
    let cursor: string | null = null
    do {
      const res: TurnsPage = await this.controlRequest<TurnsPage>('thread/turns/list', {
        threadId,
        limit: 25,
        cursor
      })
      for (const turn of res?.data ?? []) {
        // startedAt is epoch SECONDS, and the turn we want starts a moment AFTER
        // its message was created here — so truncation alone puts the target up
        // to a second on the wrong side of `sentAt`, and a bare comparison
        // rejects the very turn it was walking to. The slack makes the stop mean
        // "demonstrably older" rather than "older by any amount"; being wrong in
        // this direction only costs another page.
        if (turn.startedAt && turn.startedAt * 1000 < sentAt - TURN_CLOCK_SLACK_MS) return null
        const owns = (turn.items ?? []).some(
          (item: RawTurnItem) => item?.type === 'userMessage' && item.clientId === messageId
        )
        if (owns && turn.id) return turn.id
      }
      cursor = res?.nextCursor ?? null
    } while (cursor)
    return null
  }

  private async controlRequest<T>(method: string, params: unknown): Promise<T> {
    if (!this.codex.request) throw new Error('This Codex transport does not support control requests.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.codex.request(method, params) as Promise<T>,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Codex ${method} timed out.`)), 8_000)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    interface RawTool {
      name?: string
      description?: string
      annotations?: { readOnlyHint?: boolean }
    }
    interface RawServer {
      name?: string
      serverInfo?: unknown
      authStatus?: string
      runtimeStatus?:
        | 'notStarted'
        | 'starting'
        | 'connected'
        | 'authenticationRequired'
        | 'failed'
        | 'cancelled'
        | 'disabled'
        | null
      tools?: Record<string, RawTool>
    }
    const servers: RawServer[] = []
    let cursor: string | null = null
    try {
      do {
        const page: { data?: RawServer[]; nextCursor?: string | null } =
          await this.controlRequest<{
            data?: RawServer[]
            nextCursor?: string | null
          }>('mcpServerStatus/list', {
            cursor,
            limit: 100,
            detail: 'toolsAndAuthOnly',
            threadId: this.threadId
          })
        servers.push(...(page.data ?? []))
        cursor = page.nextCursor ?? null
      } while (cursor)
    } catch {
      return []
    }
    return servers.map((server) => {
      const tools = Object.entries(server.tools ?? {}).map(([key, tool]) => ({
        name: tool.name || key,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.annotations?.readOnlyHint != null
          ? { readOnly: tool.annotations.readOnlyHint }
          : {})
      }))
      const name = server.name || 'MCP server'
      const startup = this.codex.mcpStartupStatus?.(name, this.threadId)
      const needsAuth =
        server.authStatus === 'notLoggedIn' ||
        server.runtimeStatus === 'authenticationRequired' ||
        startup?.failureReason === 'reauthenticationRequired'
      const failed =
        server.runtimeStatus === 'failed' ||
        server.runtimeStatus === 'cancelled' ||
        startup?.status === 'failed' ||
        startup?.status === 'cancelled'
      const disabled = server.runtimeStatus === 'disabled'
      const connected =
        server.runtimeStatus === 'connected' ||
        startup?.status === 'ready' ||
        server.serverInfo != null ||
        tools.length > 0
      return {
        name,
        status: disabled
          ? ('disabled' as const)
          : needsAuth
          ? ('needs-auth' as const)
          : failed
            ? ('failed' as const)
            : connected
              ? ('connected' as const)
              : ('pending' as const),
        ...(failed
          ? {
              error:
                startup?.error ||
                (startup?.status === 'cancelled' ? 'Startup cancelled.' : 'Startup failed.')
            }
          : {}),
        ...(tools.length ? { tools } : {})
      }
    })
  }

  async mcpReconnect(name: string): Promise<OpResult> {
    try {
      const server = (await this.mcpStatus()).find((value) => value.name === name)
      if (server?.status === 'needs-auth') {
        const login = await this.controlRequest<{ authorizationUrl?: string }>(
          'mcpServer/oauth/login',
          { name, threadId: this.threadId }
        )
        return login.authorizationUrl ? { ok: true, url: login.authorizationUrl } : { ok: true }
      }
      await this.controlRequest('config/mcpServer/reload', undefined)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async mcpToggle(): Promise<OpResult> {
    return { ok: false, error: 'Not supported for Codex sessions.' }
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      return await fetchCodexModels(this.codex)
    } catch {
      return []
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    return []
  }

  async accountInfo(): Promise<AccountInfo | null> {
    try {
      const response = await this.controlRequest<{
        account?:
          | { type: 'chatgpt'; email?: string | null; planType?: string }
          | { type: 'apiKey' }
          | { type: 'amazonBedrock'; usesCodexManagedCredentials?: boolean }
          | null
      }>('account/read', { refreshToken: false })
      const account = response.account
      if (!account) return null
      if (account.type === 'chatgpt') {
        return {
          ...(account.email ? { email: account.email } : {}),
          subscriptionType: account.planType,
          apiProvider: 'chatgpt'
        }
      }
      if (account.type === 'apiKey') return { apiProvider: 'apiKey' }
      return {
        ...(account.usesCodexManagedCredentials
          ? { subscriptionType: 'Codex-managed credentials' }
          : {}),
        apiProvider: 'amazonBedrock'
      }
    } catch {
      return null
    }
  }

  async usageInfo(): Promise<UsageInfo | null> {
    try {
      interface Snapshot {
        limitId?: string | null
        limitName?: string | null
        primary?: CodexWindow | null
        secondary?: CodexWindow | null
        planType?: string | null
      }
      const response = await this.controlRequest<{
        rateLimits?: Snapshot
        rateLimitsByLimitId?: Record<string, Snapshot> | null
      }>('account/rateLimits/read', undefined)
      const limits = response.rateLimits
      const buckets = Object.entries(response.rateLimitsByLimitId ?? {})
      const snapshots: Array<[string, Snapshot]> = buckets.length
        ? buckets
        : limits
          ? [[limits.limitName || limits.limitId || '', limits]]
          : []
      const prefix = snapshots.length > 1
      const windows = snapshots.flatMap(([key, snapshot]) =>
        [codexWindow(snapshot.primary), codexWindow(snapshot.secondary)]
          .filter((value): value is NonNullable<typeof value> => value != null)
          .map((value) => ({
            ...value,
            label:
              prefix && key
                ? `${codexLimitDisplayName(key, snapshot.limitName, snapshot.limitId)} · ${value.label}`
                : value.label
          }))
      )
      return {
        costUsd: 0,
        linesAdded: 0,
        linesRemoved: 0,
        subscriptionType: limits?.planType ?? snapshots[0]?.[1].planType,
        rateLimitsAvailable: windows.length > 0,
        windows
      }
    } catch {
      return null
    }
  }

  dispose(): void {
    this.setTitlePending(false)
    this.clearUserQuestions(false)
    this.clearNativeApprovals(false)
    this.clearMcpElicitations(false)
    this.disposed = true
    this.dead = true
    this.abort?.abort()
    // disposed is now set, so this clears the coalescing timer + buffer without
    // emitting — no leaked timer after the session is superseded.
    this.deltas.flush()
    this.rolloutWatcher.stop()
    this.clearCodexJobs()
    // Preserve a plan review in ChatData. Native App Server questions belong to
    // the live JSON-RPC process and are resolved when that process is disposed.
    this.cleanupPendingTurns()
    this.codex.dispose?.()
  }
}

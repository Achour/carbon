import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentOptions, Run, SDKAgent, SDKCustomTool, SDKJsonValue } from '@cursor/sdk'
import {
  CURSOR_DEFAULT_MODEL,
  cursorWireModel,
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
  type ProviderAuthState,
  type RewindResult,
  type ToolPart,
  type UsageInfo
} from '@shared/types'
import type { Store } from './store'
import { composePrompt, withTimeout, type AgentSession, type Emit } from './session.ts'
import { DeltaCoalescer } from './deltaCoalescer.ts'
import { providerEnabled } from './providerCli.ts'
import { deriveTitle } from './titles.ts'
import { PREVIEW_SESSION_RULES } from './previewTools.ts'
import { CANVAS_SESSION_RULES } from './canvasTools.ts'
import { CHART_SESSION_RULES } from './chartTool.ts'
import { DELEGATION_SESSION_RULES, canDelegate } from './delegation.ts'
import { SCHEDULE_SESSION_RULES, canSchedule } from './scheduleTools.ts'
import type { CarbonMcpProvider, CarbonMcpSession } from './carbonBridge.ts'
import { CARBON_MCP_NAME, carbonMcpTools } from './carbonMcp.ts'
import {
  CursorChildStream,
  buildCursorPrompt,
  cursorDefaultModel,
  cursorErrorMessage,
  cursorModelOptions,
  cursorModelSelection,
  cursorToolInput,
  cursorToolName,
  cursorToolOutput,
  cursorToolPart,
  cursorToolStatus,
  isActiveRunError,
  isCursorAuthError,
  isCursorShellSpawnFailure,
  isSandboxUnsupported,
  type CursorCatalogModel,
  type CursorModelSelection,
  type CursorTokenUsage,
  type CursorToolCall,
  type CursorUpdate
} from './cursorSdk.ts'
import { projectRoot } from '../shared/types.ts'

/**
 * Cursor as an `AgentSession`, on the official `@cursor/sdk`.
 *
 * Unlike the other four this is not a CLI Carbon spawns: the SDK *is* the
 * agent runtime, and it runs in this process (spawning its own sandbox helper
 * and `rg` for tools). Read `docs/cursor.md` first; the shapes below were each
 * measured against a real account. What shapes the class:
 *
 *  - **No approval prompts exist.** The SDK has no permission callback, so the
 *    permission axis is the sandbox (on/off) and Cursor's Auto-review — both
 *    *agent* options, fixed at `Agent.create` / `Agent.resume`. A mode change
 *    therefore closes the agent and the next turn resumes it with the new pair.
 *  - **Model and plan mode are per send**, so they move without a reopen.
 *  - **Plan mode ends in a `createPlan` tool call** carrying the plan as
 *    markdown; Carbon raises its own review from it once the turn ends, and
 *    approval starts a new turn — Codex's shape.
 */

/** A one-shot handoff brief the user is waiting on. */
const ONE_SHOT_TIMEOUT_MS = 90_000

/** The catalog is the account's, and a plan change is rare; re-read hourly. */
const CATALOG_TTL_MS = 60 * 60_000

/** The sign-in page polls; give the user a few minutes to finish it. */
const SIGN_IN_TIMEOUT_MS = 330_000

/** Coarser than the text coalescer: each child update ships the whole list. */
const CHILD_EMIT_MS = 250

/** What `local.settingSources` loads: the user's Cursor rules, skills and MCP. */
const SETTING_SOURCES: NonNullable<NonNullable<AgentOptions['local']>['settingSources']> = [
  'project',
  'user',
  'team',
  'mdm',
  'plugins'
]

/** Read the rules into a conversation once, at its first turn. */
const SESSION_RULES = [PREVIEW_SESSION_RULES, CANVAS_SESSION_RULES, CHART_SESSION_RULES].join('\n\n')

/**
 * Opens a sign-in link in the user's browser. Injected from `index.ts`
 * (Electron's `shell.openExternal`) so this module stays free of Electron.
 */
let openAuthUrl: (url: string) => void = () => {}
export function configureCursorAuth(open: (url: string) => void): void {
  openAuthUrl = open
}

// ---------- The SDK, loaded on first use ----------

type CursorSdkModule = typeof import('@cursor/sdk')

let sdkModule: Promise<CursorSdkModule> | null = null

/**
 * The SDK is ~10 MB of bundled JavaScript; importing it at startup would put
 * its parse on the path to first paint for everyone, Cursor user or not. It
 * loads the first time anything asks — a probe, a sign-in, a turn.
 */
export function loadCursorSdk(): Promise<CursorSdkModule> {
  if (!sdkModule) {
    installShellSpawnGuard()
    sdkModule = import('@cursor/sdk').catch((error: unknown) => {
      sdkModule = null
      throw error
    })
  }
  return sdkModule
}

let guarded = false

/**
 * The SDK rejects a promise nothing awaits when its shell wrapper cannot spawn
 * (`isCursorShellSpawnFailure`). That one is logged quietly as Cursor's.
 * Anything else is printed the way Electron's main process prints it with no
 * listener — measured, it *warns* and carries on — because adding a listener
 * at all is what replaces that default, and this must not change the app's
 * behavior for every other rejection (re-throwing would turn each one into an
 * uncaught-exception dialog).
 */
function installShellSpawnGuard(): void {
  if (guarded) return
  guarded = true
  process.on('unhandledRejection', (reason) => {
    if (isCursorShellSpawnFailure(reason)) {
      console.error('[cursor] shell spawn failed; the turn will report it:', cursorErrorMessage(reason))
      return
    }
    // Someone else is listening too; they own the decision.
    if (process.listenerCount('unhandledRejection') > 1) return
    console.warn('UnhandledPromiseRejectionWarning:', reason)
  })
}

/** Whether the SDK's package can be loaded at all — Settings' "installed". */
export async function cursorSdkLoads(): Promise<boolean> {
  try {
    await loadCursorSdk()
    return true
  } catch {
    return false
  }
}

let sandboxPrimed: Promise<void> | null = null

/**
 * The SDK decides **once per process** whether local sandboxing works, and an
 * unsandboxed agent opened first records "unsupported" — after which every
 * sandboxed run is refused. Carbon is one long-lived process mixing both modes,
 * so a sandboxed workspace is warmed (and released) before the first agent of
 * either kind. Best effort: a failure here just leaves the SDK to decide.
 * See `docs/cursor.md`.
 */
function primeSandbox(sdk: CursorSdkModule, cwd: string): Promise<void> {
  sandboxPrimed ??= (async () => {
    try {
      const platform = await sdk.createAgentPlatform({ workspaceRef: cwd })
      const release = await platform.prewarmLocalWorkspace({
        local: { cwd, settingSources: [], sandboxOptions: { enabled: true } }
      })
      await release()
    } catch {
      // Advisory.
    }
  })()
  return sandboxPrimed
}

// ---------- Catalog ----------

let catalog: { models: CursorCatalogModel[]; at: number } | null = null

/** Drop the cached catalog — after a sign-in or sign-out it is someone else's. */
export function forgetCursorCatalog(): void {
  catalog = null
}

/** The account's models, cached for the app run (an hour). Throws when signed out. */
async function cursorCatalog(): Promise<CursorCatalogModel[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models
  const sdk = await loadCursorSdk()
  const models = (await sdk.Cursor.models.list()) as CursorCatalogModel[]
  if (models.length) catalog = { models, at: Date.now() }
  return models
}

/**
 * The selection for a Carbon model id, against the live catalog. The Default
 * row resolves to `cursorDefaultModel`; an id the catalog no longer lists is
 * sent bare and left for the SDK to refuse with its own list of what the plan
 * allows, which is the clearest message there is.
 */
async function selectionFor(
  model: string | undefined,
  options: { effort?: ChatData['effort']; fast?: boolean } = {}
): Promise<{ selection: CursorModelSelection; label: string }> {
  const models = await cursorCatalog()
  const wanted = !model || model === CURSOR_DEFAULT_MODEL ? undefined : cursorWireModel(model)
  const entry = wanted
    ? models.find((candidate) => candidate.id === wanted || candidate.aliases?.includes(wanted))
    : cursorDefaultModel(models)
  if (!entry) {
    if (!wanted) throw new Error('Your Cursor plan lists no models.')
    return { selection: { id: wanted }, label: wanted }
  }
  return { selection: cursorModelSelection(entry, options), label: entry.displayName }
}

const SIGNED_OUT_ROW: ModelOption = {
  id: CURSOR_DEFAULT_MODEL,
  label: 'Cursor',
  description: 'Sign in in Settings → Providers → Cursor',
  provider: 'cursor',
  disabled: true
}

/**
 * The picker's Cursor rows: the account's catalog, the disabled sign-in row
 * when nobody is signed in (an empty answer would leave the catalog
 * "incomplete" forever with no reason given — Antigravity's rule), and `[]`
 * when Cursor is switched off or the SDK will not load.
 */
export async function fetchCursorModels(): Promise<ModelOption[]> {
  if (!providerEnabled('cursor')) return []
  try {
    if ((await cursorAuthState()) !== 'signed-in') return [SIGNED_OUT_ROW]
    return cursorModelOptions(await cursorCatalog())
  } catch (error) {
    return isCursorAuthError(error) ? [SIGNED_OUT_ROW] : []
  }
}

// ---------- Sign-in ----------

/**
 * `CURSOR_API_KEY` first — the SDK reads it before any stored login — then the
 * login `Cursor.auth.login` stored in `~/.cursor/sdk/auth.json`. That file is
 * the SDK's own default, shared with every other SDK client on the machine,
 * which is the point: one sign-in, wherever it happened.
 */
export async function cursorAuthState(): Promise<ProviderAuthState> {
  if (process.env.CURSOR_API_KEY?.trim()) return 'signed-in'
  try {
    const sdk = await loadCursorSdk()
    const status = await sdk.Cursor.auth.status()
    return status.status === 'logged-in' ? 'signed-in' : 'signed-out'
  } catch {
    return 'unavailable'
  }
}

let signingIn: Promise<OpResult> | null = null

/**
 * The browser sign-in: Cursor's page mints a named, 90-day API key (it appears
 * in the dashboard as "Carbon") and the SDK stores it. One flow at a time —
 * Settings and an in-chat send can both ask.
 */
export function signInToCursor(): Promise<OpResult> {
  signingIn ??= (async (): Promise<OpResult> => {
    const abort = new AbortController()
    try {
      const sdk = await loadCursorSdk()
      const login = sdk.Cursor.auth
        .login({
          apiKeyName: 'Carbon',
          openBrowser: (url) => openAuthUrl(url),
          signal: abort.signal
        })
        .then((): OpResult => ({ ok: true }))
      const result = await withTimeout<OpResult>(login, SIGN_IN_TIMEOUT_MS, {
        ok: false,
        error: 'Sign-in timed out.'
      })
      if (!result.ok) abort.abort()
      forgetCursorCatalog()
      return result
    } catch (error) {
      return { ok: false, error: cursorErrorMessage(error) }
    } finally {
      signingIn = null
    }
  })()
  return signingIn
}

/**
 * Forget the stored key. Local only: the key stays valid until it expires or
 * is revoked from the Cursor dashboard, which the Settings row says.
 */
export async function signOutOfCursor(): Promise<OpResult> {
  try {
    const sdk = await loadCursorSdk()
    await sdk.Cursor.auth.logout()
    forgetCursorCatalog()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: cursorErrorMessage(error) }
  }
}

// ---------- One-shot ----------

/**
 * A handoff brief: one prompt on a throwaway agent with no tools, in a temp
 * folder so it scopes to nothing of the user's.
 */
export async function generateCursorText(model: string | undefined, prompt: string): Promise<string | null> {
  if (!providerEnabled('cursor')) return null
  const cwd = mkdtempSync(join(tmpdir(), 'carbon-cursor-'))
  try {
    const sdk = await loadCursorSdk()
    const { selection } = await selectionFor(model)
    const work = sdk.Agent.prompt(prompt, {
      model: selection,
      tools: [],
      local: { cwd, settingSources: [] }
    }).then((result) => (result.status === 'finished' ? result.result?.trim() || null : null))
    return await withTimeout(work, ONE_SHOT_TIMEOUT_MS, null)
  } catch {
    return null
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ---------- The session ----------

interface PendingTurn {
  text: string
  attachments: Attachment[]
  userMessageId: string
}

/** The agent-level options a permission mode stands for. */
function permissionOptions(mode: PermissionModeId): { sandbox: boolean; autoReview: boolean } {
  switch (mode) {
    case 'bypassPermissions':
      return { sandbox: false, autoReview: false }
    case 'auto':
      return { sandbox: true, autoReview: true }
    // Ask has no Cursor equivalent — nothing can prompt — so it gets the most
    // restrictive thing that can run: the sandbox. Plan is read-only by its own
    // mode and keeps the sandbox under it.
    default:
      return { sandbox: true, autoReview: false }
  }
}

export class CursorSession implements AgentSession {
  private chat: ChatData
  private emit: Emit
  private store: Store
  private onDead: () => void

  private agent: SDKAgent | null = null
  private opening: Promise<SDKAgent> | null = null
  /** `sandbox:autoReview` the open agent was built with. */
  private openedWith: string | null = null
  private run: Run | null = null
  private sendChain: Promise<void> = Promise.resolve()
  private queued = new Set<PendingTurn>()

  private current: AssistantMessage | null = null
  private toolLoc = new Map<string, { message: AssistantMessage; index: number }>()
  private children = new Map<string, CursorChildStream>()
  private childTimers = new Map<string, NodeJS.Timeout>()
  private streamSlot: { kind: 'text' | 'thinking'; index: number } | null = null
  private streamedText = false
  /** The last `createPlan` of this turn — the plan a review offers. */
  private turnPlan: string | null = null
  private turnUsage: CursorTokenUsage | null = null

  private planReview: PersistedPlanReview | null
  private activeUserMessageId: string | null = null
  private running = false
  private interrupted = false
  private disposed = false
  private deadFlag = false
  private lastEmittedStatus: ChatStatus | null = null
  private turnStart = 0
  /**
   * True for an agent this process created rather than resumed: its first
   * prompt carries Carbon's session rules, which a resumed one already has.
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
    private preview: CarbonMcpProvider | null = null
  ) {
    // Thrown here so `deliver` turns a switched-off provider into an error card
    // with the prompt preserved, as `requireCliPath` does for the others.
    if (!providerEnabled('cursor')) throw new Error('Cursor is turned off in Settings → Providers.')
    this.chat = chat
    this.emit = emit
    this.store = store
    this.onDead = onDead
    this.planReview = chat.pendingPlanReview ?? null
  }

  get dead(): boolean {
    return this.deadFlag
  }

  get idle(): boolean {
    return !this.running && this.queued.size === 0 && !this.planReview
  }

  // ---------- Lifecycle ----------

  private delegates(): boolean {
    return canDelegate(this.chat, this.store.getDefaults())
  }

  private ensureMcp(): Promise<CarbonMcpSession | null> {
    if (!this.mcp) {
      this.mcp =
        this.preview?.mcpSession({
          cwd: this.chat.cwd,
          project: projectRoot(this.chat),
          chatId: this.chat.id,
          plan: () => this.chat.permissionMode === 'plan',
          delegate: () => this.delegates()
        }) ?? Promise.resolve(null)
    }
    return this.mcp
  }

  private ensureAgent(): Promise<SDKAgent> {
    const wanted = this.optionsKey()
    if (this.agent && this.openedWith === wanted) return Promise.resolve(this.agent)
    if (this.agent) {
      // The permission mode moved since this agent opened; its sandbox is
      // fixed at open, so it reopens with the new one and keeps the history.
      this.closeAgent()
    }
    this.opening ??= this.openAgent().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private optionsKey(): string {
    const { sandbox, autoReview } = permissionOptions(this.chat.permissionMode)
    return `${sandbox}:${autoReview}`
  }

  private async agentOptions(): Promise<AgentOptions> {
    const { sandbox, autoReview } = permissionOptions(this.chat.permissionMode)
    const { selection } = await this.selection()
    return {
      model: selection,
      name: this.chat.title || 'Carbon',
      local: {
        cwd: this.chat.cwd,
        settingSources: SETTING_SOURCES,
        sandboxOptions: { enabled: sandbox },
        autoReview,
        enableAgentRetries: true
      }
    }
  }

  /**
   * Carbon's tools as in-process callbacks, not as the MCP server every other
   * HTTP provider connects to. Measured: with the sandbox on, Cursor rejects
   * every MCP-server call ("Local SDK runs cannot request interactive approval
   * for this MCP tool call"), and callback tools are the kind it exempts. Built
   * per send, since the delegation tools come and go with the setting.
   */
  private async carbonTools(): Promise<Record<string, SDKCustomTool>> {
    const mcp = await this.ensureMcp()
    if (!mcp) return {}
    return Object.fromEntries(
      mcp.tools().map((tool): [string, SDKCustomTool] => [
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
          execute: async (args) => mcp.call(tool.name, args)
        }
      ])
    )
  }

  private async openAgent(): Promise<SDKAgent> {
    const sdk = await loadCursorSdk()
    await primeSandbox(sdk, this.chat.cwd)
    const options = await this.agentOptions()
    if (this.disposed) throw new Error('Session disposed.')
    const key = this.optionsKey()
    let agent: SDKAgent | null = null
    if (this.chat.sessionId) {
      try {
        agent = await sdk.Agent.resume(this.chat.sessionId, options)
      } catch (error) {
        if (isCursorAuthError(error)) throw error
        // Pruned, or written on another machine. A fresh agent loses its memory
        // of the old one but keeps the chat usable — Antigravity's rule.
        agent = null
      }
    }
    if (!agent) {
      agent = await sdk.Agent.create(options)
      this.needsRules = !!(await this.ensureMcp())
      this.chat.sessionId = agent.agentId
      this.store.saveChat(this.chat.id)
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { sessionId: agent.agentId } })
    }
    if (this.disposed) {
      agent.close()
      throw new Error('Session disposed.')
    }
    this.agent = agent
    this.openedWith = key
    return agent
  }

  private closeAgent(): void {
    const agent = this.agent
    this.agent = null
    this.openedWith = null
    try {
      agent?.close()
    } catch {
      // Already closed.
    }
  }

  private selection(): Promise<{ selection: CursorModelSelection; label: string }> {
    return selectionFor(this.chat.model, {
      effort: this.chat.effort,
      fast: this.chat.serviceTier === 'fast'
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queued.clear()
    for (const timer of this.childTimers.values()) clearTimeout(timer)
    this.childTimers.clear()
    const run = this.run
    if (run?.status === 'running') void run.cancel().catch(() => {})
    this.closeAgent()
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
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'error', text, ts: Date.now() })
  }

  private pushInfo(text: string): void {
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'info', text, ts: Date.now() })
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

  private patchTool(callId: string, patch: Partial<ToolPart>): void {
    const loc = this.toolLoc.get(callId)
    const part = loc?.message.parts[loc.index]
    if (!loc || part?.type !== 'tool') return
    Object.assign(part, patch)
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId: loc.message.id,
      toolUseId: callId,
      patch
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
    this.setStatus(this.agent ? 'streaming' : 'starting')

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

  /**
   * Run `work`, signing in once if the SDK says nobody is. The browser opens on
   * the user's machine and the turn waits for it — a first send works without
   * a trip to Settings, as Antigravity's does.
   */
  private async withSignIn<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (!isCursorAuthError(error)) throw error
      this.pushInfo('Cursor needs you to sign in — continue in your browser.')
      const result = await signInToCursor()
      if (!result.ok) throw new Error(result.error ?? 'Cursor sign-in failed.')
      this.closeAgent()
      return work()
    }
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    if (this.disposed) return
    this.running = true
    this.interrupted = false
    this.activeUserMessageId = turn.userMessageId
    this.turnStart = Date.now()
    this.turnPlan = null
    this.turnUsage = null
    this.streamedText = false
    const planning = this.chat.permissionMode === 'plan'
    this.setStatus('streaming')
    let status: 'finished' | 'error' | 'cancelled' | null = null
    let label = this.chat.model ?? 'Cursor'
    try {
      const run = await this.withSignIn(async () => {
        const agent = await this.ensureAgent()
        const chosen = await this.selection()
        label = chosen.label
        let text = turn.text
        if (this.needsRules) {
          const rules = [
          SESSION_RULES,
          this.delegates() ? DELEGATION_SESSION_RULES : '',
          canSchedule(this.chat) ? SCHEDULE_SESSION_RULES : ''
        ]
          .filter(Boolean)
          .join('\n\n')
          text = `${text}\n\n<carbon_session_rules>\n${rules}\n</carbon_session_rules>`
        }
        if (this.disposed || this.interrupted) throw new Error('Stopped before the prompt was sent.')
        const customTools = await this.carbonTools()
        const run = await this.sendOnce(agent, buildCursorPrompt(text, turn.attachments), {
          model: chosen.selection,
          mode: planning ? 'plan' : 'agent',
          local: { customTools },
          onDelta: ({ update }) => this.handleUpdate(update as CursorUpdate)
        })
        this.needsRules = false
        return run
      })
      this.run = run
      // Stopped while `send` was in flight: the run exists now, so stop it.
      if (this.interrupted) void run.cancel().catch(() => {})
      const result = await run.wait()
      status = result.status
      if (result.status === 'error' && !this.interrupted) {
        this.pushError(result.error?.message ?? 'The Cursor run failed.')
      } else if (result.status === 'finished' && !this.streamedText && result.result?.trim()) {
        // A run that answered without streaming any text still has an answer.
        const message = this.ensureCurrent()
        message.parts.push({ type: 'text', text: result.result.trim() })
        this.emitPart(message, message.parts.length - 1)
      }
      if (result.usage && !this.turnUsage) this.turnUsage = result.usage
    } catch (error) {
      if (!this.disposed && !this.interrupted) {
        // A sandbox the SDK has decided against: say what to do, not the stack.
        this.pushError(
          isSandboxUnsupported(error)
            ? 'Cursor could not start its sandbox on this Mac. Switch this chat to Full access to run without it.'
            : cursorErrorMessage(error)
        )
      }
    } finally {
      this.run = null
      this.running = false
      this.finishTurn(status, planning, label)
    }
  }

  /**
   * `agent.send`, recovering once from a run a crashed process left open: the
   * SDK refuses a send while its store still says "running", so the stale run
   * is cancelled and the send retried.
   */
  private async sendOnce(
    agent: SDKAgent,
    prompt: ReturnType<typeof buildCursorPrompt>,
    options: Parameters<SDKAgent['send']>[1]
  ): Promise<Run> {
    try {
      return await agent.send(prompt, options)
    } catch (error) {
      if (!isActiveRunError(error)) throw error
      const sdk = await loadCursorSdk()
      const latest = await sdk.Agent.listRuns(agent.agentId, { runtime: 'local', cwd: this.chat.cwd, limit: 1 })
      const stale = latest.items.find((run) => run.status === 'running')
      if (!stale) throw error
      await sdk.Agent.cancelRun(stale.id, { runtime: 'local', cwd: this.chat.cwd })
      return agent.send(prompt, options)
    }
  }

  private finishTurn(status: string | null, planning: boolean, label: string): void {
    this.deltas.flush()
    // Calls the run never closed — a cancel mid-tool leaves its `shell` open
    // with no completion, measured — settle here or they spin for good.
    for (const [callId, loc] of this.toolLoc) {
      const part = loc.message.parts[loc.index]
      if (part?.type !== 'tool' || (part.status !== 'running' && part.status !== 'pending')) continue
      this.flushChildren(callId)
      this.patchTool(callId, {
        status: 'error',
        partial: undefined,
        output: part.output ?? (this.interrupted ? 'Interrupted.' : 'Did not finish.'),
        ...(part.agent ? { agent: { ...part.agent, endedAt: Date.now() } } : {})
      })
    }
    this.current = null
    this.streamSlot = null
    this.toolLoc.clear()
    this.children.clear()
    if (status) {
      const usage = this.turnUsage
      this.pushMessage({
        id: randomUUID(),
        role: 'event',
        kind: 'turn',
        text: '',
        ts: Date.now(),
        stats: {
          // Cursor bills against the plan; there is no per-turn price to show.
          costUsd: 0,
          durationMs: Date.now() - this.turnStart,
          numTurns: 1,
          model: label,
          ...(usage
            ? {
                inputTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
                outputTokens: usage.outputTokens ?? 0
              }
            : {})
        }
      })
      if (planning && status === 'finished' && !this.interrupted && this.turnPlan) {
        this.offerPlanForReview(this.turnPlan)
      }
    }
    this.setStatus(this.planReview ? 'waiting-permission' : 'idle')
    this.store.saveChat(this.chat.id)
  }

  // ---------- Stream normalization ----------

  private handleUpdate(update: CursorUpdate): void {
    if (this.disposed || !this.running) return
    switch (update.type) {
      case 'text-delta':
        this.appendStream('text', String((update as { text?: unknown }).text ?? ''))
        return
      case 'thinking-delta':
        this.appendStream('thinking', String((update as { text?: unknown }).text ?? ''))
        return
      case 'thinking-completed':
        // Sent between text chunks too (with ~1 ms), so it ends a thought only.
        if (this.streamSlot?.kind === 'thinking') this.streamSlot = null
        return
      case 'step-completed':
        this.streamSlot = null
        return
      case 'partial-tool-call':
      case 'tool-call-started':
      case 'tool-call-completed': {
        const { callId, toolCall } = update as { callId?: string; toolCall?: CursorToolCall }
        if (callId && toolCall) this.applyToolCall(callId, toolCall, update.type)
        return
      }
      case 'tool-call-delta': {
        const { callId, taskUpdate } = update as { callId?: string; taskUpdate?: CursorUpdate }
        if (callId && taskUpdate) this.applyChildUpdate(callId, taskUpdate)
        return
      }
      case 'shell-output-delta':
        this.appendShellOutput(update as { callId?: string; event?: Record<string, unknown> })
        return
      case 'turn-ended': {
        const usage = (update as { usage?: CursorTokenUsage }).usage
        if (usage) this.turnUsage = usage
        return
      }
      default:
        return
    }
  }

  private appendStream(kind: 'text' | 'thinking', delta: string): void {
    if (!delta) return
    if (kind === 'text') this.streamedText = true
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

  private applyToolCall(callId: string, call: CursorToolCall, kind: CursorUpdate['type']): void {
    const completed = kind === 'tool-call-completed'
    if (call.type === 'createPlan') {
      const plan = typeof call.args?.plan === 'string' ? call.args.plan.trim() : ''
      if (plan) this.turnPlan = plan
    }
    const existing = this.toolLoc.get(callId)
    if (!existing) {
      const message = this.ensureCurrent()
      const part = cursorToolPart(callId, call, completed, kind === 'partial-tool-call')
      if (call.type === 'task') {
        part.agent = { startedAt: Date.now(), ...(completed ? { endedAt: Date.now() } : {}) }
        part.children = []
      }
      message.parts.push(part)
      const index = message.parts.length - 1
      this.toolLoc.set(callId, { message, index })
      this.streamSlot = null
      this.emitPart(message, index)
      return
    }
    const part = existing.message.parts[existing.index]
    if (part?.type !== 'tool') return
    const status = cursorToolStatus(call, completed)
    const patch: Partial<ToolPart> = {
      name: cursorToolName(call),
      input: cursorToolInput(call),
      status,
      partial: kind === 'partial-tool-call' && status === 'running' ? true : undefined
    }
    if (status !== 'running') {
      const output = cursorToolOutput(call)
      if (output !== undefined) patch.output = output
      if (call.type === 'task') {
        this.children.get(callId)?.settle(status === 'error' ? 'error' : 'success')
        this.flushChildren(callId)
        if (part.agent) patch.agent = { ...part.agent, endedAt: Date.now() }
      }
    }
    this.patchTool(callId, patch)
  }

  /** A subagent's own update, routed onto its `Agent` card's children. */
  private applyChildUpdate(callId: string, update: CursorUpdate): void {
    if (!this.toolLoc.has(callId)) return
    let stream = this.children.get(callId)
    if (!stream) {
      stream = new CursorChildStream()
      this.children.set(callId, stream)
    }
    if (!stream.apply(update)) return
    // One trailing emit per window: every update would otherwise ship the
    // whole child list, quadratic over a chatty subagent (CLAUDE.md, "three
    // more emitters are throttled").
    if (this.childTimers.has(callId)) return
    this.childTimers.set(
      callId,
      setTimeout(() => this.flushChildren(callId), CHILD_EMIT_MS)
    )
  }

  private flushChildren(callId: string): void {
    const timer = this.childTimers.get(callId)
    if (timer) clearTimeout(timer)
    this.childTimers.delete(callId)
    const stream = this.children.get(callId)
    if (!stream) return
    this.patchTool(callId, { children: stream.parts.map((part) => ({ ...part })) })
  }

  /**
   * Live shell output. No measured run has sent one, so the event's text is read from every field it might use,
   * and it is matched to the newest running shell when no `callId` is given.
   */
  private appendShellOutput(update: { callId?: string; event?: Record<string, unknown> }): void {
    const event = update.event ?? {}
    const text = ['text', 'output', 'data', 'stdout', 'stderr', 'chunk']
      .map((key) => event[key])
      .filter((value): value is string => typeof value === 'string')
      .join('')
    if (!text) return
    const id =
      update.callId ??
      [...this.toolLoc.entries()]
        .reverse()
        .find(([, loc]) => {
          const part = loc.message.parts[loc.index]
          return part?.type === 'tool' && part.name === 'Bash' && part.status === 'running'
        })?.[0]
    const loc = id ? this.toolLoc.get(id) : undefined
    const part = loc?.message.parts[loc.index]
    if (!id || part?.type !== 'tool' || part.status !== 'running') return
    this.patchTool(id, { output: `${part.output ?? ''}${text}`.slice(-40_000) })
  }

  // ---------- Plan review ----------

  private offerPlanForReview(plan: string): void {
    if (this.planReview) return
    const requestId = randomUUID()
    const review: PersistedPlanReview = {
      requestId,
      plan,
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
        toolUseId: `cursor-plan-${requestId}`,
        toolName: 'ExitPlanMode',
        input: { plan },
        title: 'Review plan',
        displayName: 'Cursor plan',
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

  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (this.planReview?.requestId === requestId) this.resolvePlanReview(decision)
  }

  pendingPlan(requestId: string): string | null {
    return this.planReview?.requestId === requestId ? this.planReview.plan : null
  }

  /**
   * Approve or reject a plan. Approval restores the mode planning replaced,
   * applies a "Build with" model, and sends the plan back as the next turn —
   * there is no suspended turn to release.
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
    const restore = prior && prior !== 'plan' ? prior : 'acceptEdits'
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
    this.emit({ type: 'meta', chatId: this.chat.id, patch })
    this.pushInfo('Plan approved. Cursor is implementing it.')
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
    const run = this.run
    if (run?.status === 'running') {
      try {
        await run.cancel()
      } catch {
        // Already settled.
      }
    }
    // Cleared here as Antigravity's is: stopped before the run existed, the
    // turn unwinds later and its idle dedups against this one.
    this.running = false
    this.deltas.flush()
    this.setStatus(this.planReview ? 'waiting-permission' : 'idle')
  }

  async setModel(model?: string): Promise<void> {
    // Per send: the next turn's `send({ model })` carries it.
    this.chat.model = model
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    // The sandbox pair is fixed per agent; `ensureAgent` reopens on the next
    // turn when it no longer matches. Plan is per send and needs nothing.
    this.chat.permissionMode = mode
  }

  async stopBackgroundJob(): Promise<void> {
    // The SDK exposes no per-job stop.
  }

  async rewindFiles(): Promise<RewindResult> {
    return { canRewind: false, error: 'Cursor does not support file checkpoints in Carbon.' }
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    if (!(await this.ensureMcp())) return []
    return [{ name: CARBON_MCP_NAME, status: 'connected', scope: 'local', tools: carbonMcpTools() }]
  }

  async mcpReconnect(): Promise<OpResult> {
    return { ok: false, error: 'Cursor manages MCP servers in its own config.' }
  }

  async mcpToggle(): Promise<OpResult> {
    return { ok: false, error: 'Cursor manages MCP servers in its own config.' }
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchCursorModels()
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


import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import type { Attachment, ElementRef, ToolPart, UserQuestion } from '@shared/types'
import { cliAvailable, providerCli } from './providerCli.ts'
import { isPreviewToolName, type PreviewToolName } from './previewTools.ts'
import { describeSelection } from './attachmentText.ts'
import type { StdioMcpServer } from './previewMcpConfig.ts'

/**
 * A JSON-RPC client for `grok agent stdio`, the xAI CLI's ACP transport.
 *
 * This is the layer Claude and Codex get from an SDK and Grok does not: there
 * is no `@xai/grok` package, so the protocol itself is the integration surface.
 * It is deliberately the *only* file that knows ACP exists — `grok.ts` above it
 * speaks `ChatEvent`, exactly as `claude.ts` and `codex.ts` do, so the provider
 * seam stays where `AgentSession` puts it.
 *
 * Shapes here were read off grok 1.0.3 rather than the published schema, which
 * summarizes several variants into one and omits every `x.ai/*` extension. Where
 * the two disagree the CLI wins, since the CLI is what we run.
 */

type JsonRpcId = string | number

interface RpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * A `session/update` payload — a *discriminated* union of the variants Carbon
 * renders, deliberately with no catch-all member.
 *
 * An `| { sessionUpdate: string; [key: string]: unknown }` arm would make this
 * assignable from any payload, which reads as tolerant but costs the narrowing:
 * inside `case 'agent_message_chunk'` the compiler resolves `content` through
 * the index signature to `{}`, so every consumer has to re-cast to an inline
 * shape and the declared variants become documentation nothing checks. The
 * unknown-variant tolerance belongs at the transport boundary instead
 * (`GrokRawUpdate`), where exactly one cast happens.
 */
export type GrokSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content?: GrokContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content?: GrokContentBlock }
  | { sessionUpdate: 'user_message_chunk'; content?: GrokContentBlock }
  | { sessionUpdate: 'session_info_update'; title?: string }
  | { sessionUpdate: 'available_commands_update'; availableCommands?: GrokCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId?: string }
  | ({ sessionUpdate: 'tool_call' } & GrokToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & GrokToolCall)
  | { sessionUpdate: 'plan'; entries?: { content: string; status?: string }[] }
  | { sessionUpdate: 'turn_completed'; usage?: GrokTurnUsage }

/** What actually comes off the wire: any `sessionUpdate`, including new ones. */
export type GrokRawUpdate = { sessionUpdate: string } & Record<string, unknown>

/**
 * Updates that reconstruct a past turn. `session/load` replays them so a
 * client with no history can paint the transcript; Carbon already has that
 * history on disk, so applying them on resume would append a duplicate of the
 * whole conversation under the next user message.
 */
export function isGrokTranscriptUpdate(kind: string): boolean {
  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
      return true
    default:
      return false
  }
}

export interface GrokContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  name?: string
  uri?: string
  description?: string
  resource?: {
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }
}

export interface GrokCommand {
  name: string
  description?: string
  input?: { hint?: string } | null
}

/**
 * Tool calls arrive twice over: `tool_call` opens one with `title` + `rawInput`,
 * then `tool_call_update` re-sends the same `toolCallId` with `status`, richer
 * `content`, and sometimes a *different* `title` ("write" becomes
 * "Execute `rm a.txt`"). Every field but the id is therefore optional — an
 * update patches whatever it carries onto the open call.
 */
export interface GrokToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | string
  rawInput?: unknown
  rawOutput?: unknown
  content?: GrokToolContent[]
  locations?: { path?: string; line?: number }[]
  _meta?: { 'x.ai/tool'?: GrokToolMeta }
}

/** xAI's own tool descriptor, richer than ACP's `kind` and the better label. */
export interface GrokToolMeta {
  version?: number
  name?: string
  kind?: string
  namespace?: string
  label?: string
  read_only?: boolean
  input?: unknown
}

export type GrokToolContent =
  | { type: 'content'; content?: GrokContentBlock }
  | { type: 'diff'; path?: string; oldText?: string | null; newText?: string }
  | { type: string; [key: string]: unknown }

export interface GrokPermissionOption {
  optionId: string
  name?: string
  /** `allow_once` / `allow_always` / `reject_once` / `reject_always`. */
  kind?: string
}

export interface GrokPermissionRequest {
  sessionId: string
  toolCall: GrokToolCall
  options: GrokPermissionOption[]
}

/** Per-turn token accounting, off the `session/prompt` reply's `_meta`. */
export interface GrokTurnUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  modelCalls?: number
  costUsdTicks?: number
  modelUsage?: Record<string, GrokTurnUsage>
}

export interface GrokPromptResult {
  /** `end_turn`, `cancelled`, `max_tokens`, … — Grok's own set, not ACP's. */
  stopReason: string
  modelId?: string
  /** The turn's token accounting, including the cost xAI settled on. */
  usage?: GrokTurnUsage
  /**
   * Tokens live in the model's context after this turn — the last call's total,
   * not the turn's sum. That difference is what makes it a separate field from
   * `usage.totalTokens`, which counts every call and would draw a context ring
   * well past 100%.
   */
  contextTokens?: number
}

export interface GrokModelInfo {
  modelId: string
  name?: string
  description?: string
  _meta?: {
    totalContextTokens?: number
    supportsReasoningEffort?: boolean
    reasoningEffort?: string
    reasoningEfforts?: { id: string; label?: string; description?: string; default?: boolean }[]
  }
}

export interface GrokModelState {
  currentModelId?: string
  availableModels?: GrokModelInfo[]
}

export interface GrokSessionInfo {
  sessionId: string
  models?: GrokModelState
}

export interface GrokAskUserQuestionRequest {
  sessionId?: string
  toolCallId?: string
  questions: UserQuestion[]
}

/**
 * Internally-tagged ext response. A result without `outcome` is what made
 * `ask_user_question` fail with "missing field `outcome` at line 1 column 2".
 */
export type GrokAskUserQuestionResult =
  | { outcome: 'answered'; answers: Record<string, string> }
  | { outcome: 'declined' }
  | { outcome: 'cancelled' }

export interface GrokAcpCallbacks {
  onUpdate(update: GrokRawUpdate): void
  /** Resolve with the chosen `optionId`, or null to cancel the request. */
  onPermission(request: GrokPermissionRequest): Promise<string | null>
  /**
   * Plan-mode (and other) clarifying questions. Grok sends these as
   * `_x.ai/ask_user_question`, not as a permission prompt — answering
   * method-not-found is what made the tool fail in Carbon.
   */
  onAskUserQuestion?(request: GrokAskUserQuestionRequest): Promise<GrokAskUserQuestionResult>
  onModels(state: GrokModelState): void
  /** The process is gone. `error` is null for a clean, expected shutdown. */
  onExit(error: Error | null): void
}

export interface GrokAcpOptions {
  cwd: string
  model?: string
  /** Reasoning effort. No live setter exists, so it is a spawn flag. */
  effort?: string
  /** `--always-approve`: skips prompts for the whole process. */
  alwaysApprove?: boolean
  /** Auto mode for the session (`_meta.autoMode`), the safety-checked middle. */
  autoMode?: boolean
  /** Extra MCP servers the client wants this session to connect to. */
  mcpServers?: StdioMcpServer[]
  /** Appended to the session system prompt (`_meta.rules`). */
  extraRules?: string
  env?: NodeJS.ProcessEnv
  callbacks: GrokAcpCallbacks
}

/**
 * Where the CLI lives. Grok was the first provider Carbon resolved this way —
 * it ships no SDK, so there was never a bundled copy to fall back to — and it
 * is now one of three: `providerCli` does the resolution, the version read and
 * the settings override for all of them. `CARBON_GROK_PATH` still works, kept
 * spelled as it was.
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  // The *candidate*, not `cliPath`'s installed-gated answer: a path the user
  // pinned is spawned verbatim so a typo fails as itself, rather than silently
  // running a different binary that happens to be on PATH.
  return providerCli('grok', env).path ?? 'grok'
}

/** True when a `grok` binary can be found — drives the "not installed" notice. */
export function grokInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return cliAvailable('grok', env)
}

/**
 * Identifies Carbon to xAI's OAuth flow. Without it the CLI cannot tell which
 * client is asking, and a SuperGrok/X subscription will not authorize the
 * session — this string is why the integration needs no API key at all.
 */
export const GROK_OAUTH_REFERRER = 'carbon'

export class GrokAcpClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private disposed = false
  private exited = false
  private readonly options: GrokAcpOptions

  constructor(options: GrokAcpOptions) {
    this.options = options
  }

  get alive(): boolean {
    return this.process !== null && !this.exited && !this.disposed
  }

  /** Spawn the agent and complete the ACP handshake. */
  async start(): Promise<GrokModelState | undefined> {
    const binary = resolveGrokBinary(this.options.env)
    // Agent options sit between `agent` and the transport name; the transport's
    // own flags would go after `stdio`. Order is load-bearing to the CLI parser.
    const args = ['agent']
    if (this.options.model) args.push('--model', this.options.model)
    if (this.options.effort) args.push('--reasoning-effort', this.options.effort)
    if (this.options.alwaysApprove) args.push('--always-approve')
    args.push('stdio')

    const child = spawn(binary, args, {
      cwd: this.options.cwd,
      env: {
        ...(this.options.env ?? process.env),
        GROK_OAUTH2_REFERRER: GROK_OAUTH_REFERRER,
        // A background update swapping the binary mid-session would kill the
        // conversation; Carbon reports updates itself.
        GROK_NO_AUTO_UPDATE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process = child

    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.warn(`[grok] ${text}`)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      this.exited = true
      this.fail(
        this.disposed
          ? null
          : new Error(
              `Grok exited unexpectedly${code != null ? ` (code ${code})` : ''}${
                signal ? ` (${signal})` : ''
              }.`
            )
      )
    })

    const init = (await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'carbon', title: 'Carbon', version: '0.1.0' },
      // Both are declared false on purpose. Turning them on makes the *client*
      // responsible for reading files and running commands on the agent's
      // behalf — Zed wants that so unsaved buffers are visible. Carbon has no
      // unsaved-buffer problem (the agent edits the same disk the tree shows),
      // and a half-implemented terminal capability is worse than none: the CLI
      // routes every command through it and each one fails.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })) as { _meta?: { modelState?: GrokModelState } }
    return init?._meta?.modelState
  }

  /**
   * Create a session. `_meta` is where the permission baseline is chosen, and
   * all three cases are stated explicitly — including `autoMode: false`.
   *
   * Omitting it is not the same as asking for the ask baseline: with no flag the
   * CLI falls back to `permission_mode` in the user's own `~/.grok/config.toml`,
   * which is frequently `auto`. A chat Carbon labels "Ask" would then quietly
   * run tools without prompting, and the composer's permission chip would be
   * describing a mode the session is not in. Saying `false` pins it.
   */
  async newSession(): Promise<GrokSessionInfo> {
    const meta: Record<string, unknown> = this.options.alwaysApprove
      ? { yoloMode: true }
      : { autoMode: !!this.options.autoMode }
    const result = (await this.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? [],
      _meta: this.sessionMeta(meta)
    })) as GrokSessionInfo
    return result
  }

  /**
   * Resume a session by id. Grok advertises `loadSession`, and its own history
   * lives in `~/.grok/sessions`, so a chat reopened after a restart continues
   * rather than starting over — the same guarantee `chat.sessionId` gives the
   * other two providers.
   */
  async loadSession(sessionId: string): Promise<GrokSessionInfo> {
    const result = (await this.request('session/load', {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? [],
      _meta: this.sessionMeta()
    })) as Omit<GrokSessionInfo, 'sessionId'>
    return { ...result, sessionId }
  }

  async prompt(sessionId: string, blocks: GrokContentBlock[]): Promise<GrokPromptResult> {
    const raw = (await this.request('session/prompt', { sessionId, prompt: blocks })) as {
      stopReason?: string
      _meta?: Record<string, unknown>
    }
    const meta = raw?._meta ?? {}
    return {
      stopReason: String(raw?.stopReason ?? 'end_turn'),
      modelId: typeof meta.modelId === 'string' ? meta.modelId : undefined,
      usage: meta.usage as GrokTurnUsage | undefined,
      contextTokens: numberOr(meta.totalTokens)
    }
  }

  /** Interrupt. A notification, so there is nothing to await. */
  cancel(sessionId: string): void {
    if (!this.alive) return
    try {
      this.notify('session/cancel', { sessionId })
    } catch {
      // A dead process is already as cancelled as it can be.
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId })
  }

  /**
   * Only `plan` and `default` move anything: verified against 1.0.3, which
   * accepts every other id with an empty result and no `current_mode_update`,
   * leaving the session exactly where it was. The permission baseline is not on
   * this axis — it is fixed at `session/new`, which is why changing it recreates
   * the session instead of calling this.
   */
  async setMode(sessionId: string, modeId: 'plan' | 'default'): Promise<void> {
    await this.request('session/set_mode', { sessionId, modeId })
  }

  private sessionMeta(base: Record<string, unknown> = {}): Record<string, unknown> | undefined {
    const rules = this.options.extraRules?.trim()
    const meta = rules ? { ...base, rules } : base
    return Object.keys(meta).length ? meta : undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [, waiter] of this.pending) waiter.reject(new Error('Grok session was closed.'))
    this.pending.clear()
    const child = this.process
    this.process = null
    if (!child || this.exited) return
    try {
      child.stdin.end()
    } catch {
      // Already torn down.
    }
    child.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error('Grok is not running.'))
        return
      }
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: RpcMessage): void {
    const stdin = this.process?.stdin
    if (!stdin?.writable) throw new Error('Grok is not running.')
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Reply to an agent request. A dead process has nothing left to hear. */
  private reply(id: JsonRpcId, payload: { result: unknown } | { error: { code: number; message: string } }): void {
    try {
      this.write({ jsonrpc: '2.0', id, ...payload })
    } catch {
      // The child exited while we were waiting on the user (a question card,
      // a permission prompt). There is no stdin left to carry the answer.
    }
  }

  private fail(error: Error | null): void {
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) waiter.reject(error ?? new Error('Grok session ended.'))
    if (!this.disposed) this.options.callbacks.onExit(error)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      // The CLI prints the odd non-JSON banner line; dropping it is correct.
      return
    }
    if (message.id != null && !message.method) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        Object.assign(error, { code: message.error.code, data: message.error.data })
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
      return
    }
    if (message.method && message.id != null) {
      void this.handleServerRequest(message.id, message.method, message.params)
      return
    }
    if (message.method) this.handleNotification(message.method, message.params)
  }

  private async handleServerRequest(id: JsonRpcId, method: string, raw: unknown): Promise<void> {
    if (isGrokAskUserQuestionMethod(method)) {
      // Always a *result* with `outcome`. A JSON-RPC error here is what the CLI
      // surfaces as "Carbon does not implement _x.ai/ask_user_question"; an
      // empty `{}` is "missing field `outcome`".
      try {
        const questions = parseGrokQuestions(raw)
        const ask = this.options.callbacks.onAskUserQuestion
        const toolCall = asRecord(raw)?.toolCall
        const result = ask
          ? await ask({
              questions,
              sessionId: stringField(raw, 'sessionId'),
              toolCallId:
                stringField(raw, 'toolCallId') ??
                stringField(raw, 'tool_call_id') ??
                stringField(toolCall, 'toolCallId')
            })
          : { outcome: 'declined' as const }
        this.reply(id, { result })
      } catch {
        this.reply(id, { result: { outcome: 'cancelled' } })
      }
      return
    }
    if (method !== 'session/request_permission') {
      // Anything else is a capability we declared we do not have. Answering
      // "method not found" is the honest reply and lets the agent fall back to
      // doing the work itself; a stubbed empty result would be deserialized as
      // a real answer and fail the tool instead.
      this.reply(id, { error: { code: -32601, message: `Carbon does not implement ${method}.` } })
      return
    }
    const request = (raw ?? {}) as GrokPermissionRequest
    try {
      const optionId = await this.options.callbacks.onPermission(request)
      this.reply(id, {
        result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
      })
    } catch {
      this.reply(id, { result: { outcome: { outcome: 'cancelled' } } })
    }
  }

  private handleNotification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>
    if (method === 'session/update') {
      const update = params.update as GrokRawUpdate | undefined
      if (update) this.options.callbacks.onUpdate(update)
      return
    }
    // The catalog is not static: it arrives on the handshake and again whenever
    // xAI ships a model, so the picker is fed from here rather than a constant.
    if (method === '_x.ai/models/update') {
      this.options.callbacks.onModels(params as GrokModelState)
      return
    }
    if (method === '_x.ai/session/update') {
      const update = params.update as GrokRawUpdate | undefined
      if (update) this.options.callbacks.onUpdate(update)
    }
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Carbon's permission modes reduced to Grok's *baseline* — the axis fixed when
 * the session is created (`_meta.yoloMode` / `_meta.autoMode`). Plan mode is the
 * other, independent axis and moves live, so it is not represented here.
 *
 * A single value rather than a set of booleans because that is what both callers
 * want: the session builder switches on it, and it is the whole permission
 * component of `optionsKey`, which decides whether a change needs a respawn.
 *
 * `acceptEdits` deliberately lands on `ask` — the CLI's own `acceptEdits` is a
 * Claude-compatibility alias its permission engine treats as ask, so mapping it
 * to `auto` would make the least-privileged of the two settings run *more*
 * without asking.
 */
export type GrokBaseline = 'yolo' | 'auto' | 'ask'

export function grokPermissionBaseline(mode: string): GrokBaseline {
  if (mode === 'bypassPermissions') return 'yolo'
  if (mode === 'auto') return 'auto'
  return 'ask'
}
/**
 * Grok's wire names → the names the renderer already groups and icons.
 *
 * Stored on `ToolPart.name`. Grouping, file-path chips, Bash humanization and
 * the turn-changes card all key off Claude/Codex ids (`Grep`, `Read`, `Bash`).
 * xAI's label ("Search") used to win here, so two greps landed as two wrench
 * cards named "Search" and never entered `GROUPABLE_TOOLS`.
 */
const GROK_TOOL_NAMES: Record<string, string> = {
  grep: 'Grep',
  read_file: 'Read',
  list_dir: 'ListDir',
  glob: 'Glob',
  run_terminal_command: 'Bash',
  write: 'Write',
  search_replace: 'Edit',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Agent',
  task: 'Agent',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
  enter_plan_mode: 'EnterPlanMode'
}

function canonicalGrokToolName(wire: string | undefined): string | undefined {
  const key = wire?.trim()
  if (!key) return undefined
  return GROK_TOOL_NAMES[key] ?? GROK_TOOL_NAMES[key.toLowerCase()]
}

/**
 * The name carried by *this* payload, or undefined when it carries none.
 *
 * Prefer the xAI `name` (then canonicalize) over the human `label`. The label
 * is what the TUI prints ("Search", "Run Command"); the renderer already has
 * its own labels, and storing those broke grouping. A status-only update
 * (`_meta: null`, no title) still returns undefined so it cannot rename a
 * finished card.
 */
export function toolNameIfNamed(call: GrokToolCall): string | undefined {
  const preview = previewToolId(call)
  if (preview) return preview
  const meta = call._meta?.['x.ai/tool']
  const fromMeta = canonicalGrokToolName(meta?.name) || meta?.name?.trim() || meta?.label?.trim()
  if (fromMeta) return fromMeta
  return canonicalGrokToolName(call.title) || call.title?.trim() || undefined
}

/**
 * Carbon's preview MCP, named the way Claude's in-process server already is
 * (`mcp__preview__start`) so the same tool card path renders it.
 */
export function previewToolId(call: GrokToolCall): `mcp__preview__${PreviewToolName}` | undefined {
  const meta = call._meta?.['x.ai/tool']
  const ns = meta?.namespace?.trim().toLowerCase()
  const named = meta?.name?.trim().toLowerCase()
  if (ns === 'preview' && named && isPreviewToolName(named)) return `mcp__preview__${named}`
  return normalizePreviewTool(meta?.name) ?? normalizePreviewTool(call.title)
}

export function isPreviewTool(call: GrokToolCall): boolean {
  return previewToolId(call) != null
}

export function isPreviewSideEffectTool(call: GrokToolCall): boolean {
  const id = previewToolId(call)
  return id === 'mcp__preview__start' || id === 'mcp__preview__stop'
}

function normalizePreviewTool(raw: string | undefined): `mcp__preview__${PreviewToolName}` | undefined {
  if (!raw) return undefined
  const key = raw.trim().toLowerCase().replace(/[-.]/g, '_')
  const match =
    /(?:mcp__preview__|preview__|preview_|preview\/|preview:)(status|start|stop|navigate|screenshot|console)$/.exec(
      key
    )
  if (!match || !isPreviewToolName(match[1])) return undefined
  return `mcp__preview__${match[1]}`
}

/**
 * The best available name for a tool card, with a fallback — for *opening* a
 * card, which must be labelled with something.
 */
export function toolName(call: GrokToolCall): string {
  return toolNameIfNamed(call) ?? 'Tool'
}

/**
 * Align Grok's input field names with the ones `toolMeta` / turn-changes read
 * (`file_path`, `content`). `read_file` sends `target_file`; `list_dir` sends
 * `target_directory`. Without this a canonical `Read` card has no path chip.
 */
export function grokToolInput(name: string, raw: unknown): unknown {
  const input = asRecord(raw)
  if (!input) return raw
  const path = firstString(input.file_path, input.target_file, input.path, input.target_directory, input.directory)
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const next = { ...input }
      if (path && next.file_path !== path) next.file_path = path
      if (name === 'Write' && typeof next.contents === 'string' && next.content === undefined) {
        next.content = next.contents
      }
      return next
    }
    case 'ListDir':
      return path && input.path !== path ? { ...input, path } : input
    default:
      return raw
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** ACP tool status → Carbon's three-state `ToolStatus`. */
export function toolStatus(status: string | undefined): ToolPart['status'] {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'error'
    default:
      return 'running'
  }
}

/**
 * Flatten a tool's result blocks into the text the card shows. Diffs are
 * rendered from their own fields rather than dropped, since a `write` reports
 * its whole result that way and would otherwise show an empty card.
 */
export function toolOutput(call: GrokToolCall): string | undefined {
  const blocks = call.content
  if (!blocks?.length) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'content') {
      const text = (block as { content?: { text?: string } }).content?.text
      if (text) parts.push(text)
    } else if (block.type === 'diff') {
      const diff = block as { path?: string; newText?: string }
      if (diff.path) parts.push(diff.path)
    }
  }
  const joined = parts.join('\n').trim()
  return joined ? joined : undefined
}

/** Image blocks a tool returned (preview screenshot). MCP shape: {data, mimeType}. */
export function toolImages(call: GrokToolCall): { mediaType: string; data: string }[] | undefined {
  const blocks = call.content
  if (!blocks?.length) return undefined
  const images: { mediaType: string; data: string }[] = []
  for (const block of blocks) {
    const inner =
      block.type === 'content'
        ? ((block as { content?: Record<string, unknown> }).content ?? null)
        : (block as Record<string, unknown>)
    if (!inner) continue
    const type = typeof inner.type === 'string' ? inner.type : undefined
    if (type === 'image') {
      const data = typeof inner.data === 'string' ? inner.data : undefined
      if (!data) continue
      const mediaType =
        typeof inner.mimeType === 'string'
          ? inner.mimeType
          : typeof inner.mime_type === 'string'
            ? inner.mime_type
            : 'image/png'
      images.push({ mediaType, data })
      continue
    }
    const resource = inner.resource as { blob?: string; mimeType?: string } | undefined
    if (type === 'resource' && resource?.blob) {
      images.push({ mediaType: resource.mimeType || 'image/png', data: resource.blob })
    }
  }
  return images.length ? images : undefined
}

/** True for the call that ends plan mode and asks for approval. */
export function isExitPlanTool(call: GrokToolCall): boolean {
  const meta = call._meta?.['x.ai/tool']
  return meta?.kind === 'exit_plan' || meta?.name === 'exit_plan_mode'
}

/** True for the clarifying-question tool — not the permission-gated ones. */
export function isAskUserQuestionTool(call: GrokToolCall): boolean {
  const meta = call._meta?.['x.ai/tool']
  return meta?.name === 'ask_user_question'
}

/**
 * Grok's ACP extension for the question card. Verified against 1.0.3: the
 * method on the wire is `_x.ai/ask_user_question` (same underscore prefix as
 * `_x.ai/session/update`). The unprefixed form is accepted so a later CLI
 * that drops the convention still lands here.
 */
export function isGrokAskUserQuestionMethod(method: string): boolean {
  return method === '_x.ai/ask_user_question' || method === 'x.ai/ask_user_question'
}

export function grokAskUserQuestionResult(
  decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> } | null
): GrokAskUserQuestionResult {
  if (!decision || decision.behavior !== 'allow') return { outcome: 'declined' }
  const raw = decision.updatedInput?.answers
  const answers: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value.trim()) answers[key] = value
      else if (Array.isArray(value) && value.length) answers[key] = value.map(String).join(', ')
    }
  }
  if (!Object.keys(answers).length) return { outcome: 'declined' }
  return { outcome: 'answered', answers }
}

/**
 * Pulls the question list out of an `_x.ai/ask_user_question` payload. The
 * CLI wraps the same `{ questions }` the tool took; be tolerant of nesting
 * (`params.questions`, `rawInput.questions`) so a shape tweak does not
 * silently render an empty card.
 */
export function parseGrokQuestions(raw: unknown): UserQuestion[] {
  const root = asRecord(raw)
  const candidates = [root?.questions, asRecord(root?.params)?.questions, asRecord(root?.rawInput)?.questions]
  let list: unknown[] | undefined
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) {
      list = candidate
      break
    }
  }
  if (!list) return []
  const questions: UserQuestion[] = []
  for (const [index, entry] of list.entries()) {
    const item = asRecord(entry)
    if (!item) continue
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    if (!question) continue
    const header =
      (typeof item.header === 'string' && item.header.trim()) ||
      (typeof item.title === 'string' && item.title.trim()) ||
      'Question'
    const multiSelect = item.multiSelect === true || item.multi_select === true
    const rawOptions = Array.isArray(item.options) ? item.options : []
    const options = rawOptions
      .map((option) => {
        if (typeof option === 'string') {
          const label = option.trim()
          return label ? { label } : null
        }
        const rec = asRecord(option)
        const label = typeof rec?.label === 'string' ? rec.label.trim() : ''
        if (!label) return null
        const description = typeof rec?.description === 'string' ? rec.description : undefined
        return description ? { label, description } : { label }
      })
      .filter((option): option is { label: string; description?: string } => !!option)
    questions.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id : `q${index}`,
      question,
      header,
      options,
      multiSelect,
      // Grok's TUI always offers a freeform Other; Carbon's card matches that.
      allowOther: item.allowOther !== false && item.allow_other !== false
    })
  }
  return questions
}

const TEMP_PREFIX = 'karbun-grok-'

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
export function cleanupStaleGrokTempFiles(): void {
  if (staleCleaned) return
  staleCleaned = true
  const cutoff = Date.now() - 60 * 60 * 1000
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(TEMP_PREFIX)) continue
      const path = join(tmpdir(), name)
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // tmpdir unreadable — nothing to clean
  }
}

export function removeGrokTempFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Already gone.
    }
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
 * Composer attachments as ACP prompt blocks.
 *
 * Grok 1.0.3 still advertises `promptCapabilities.image: false`, so a pasted
 * screenshot cannot ride as an `image` content block. Composer images also
 * have no `path` — only base64 — which is why the old "put the path in the
 * text" fallback sent nothing. The agent *does* advertise `embeddedContext`
 * and must accept `resource_link`, so we:
 *   - materialize the bytes to a temp file (so `read_file` can open them)
 *   - embed the same bytes as a `resource` blob
 *   - name every file in the text, matching the CLI's own `@file` mention
 */
export function buildGrokPrompt(
  text: string,
  attachments: Attachment[] = []
): { blocks: GrokContentBlock[]; temps: string[] } {
  const temps: string[] = []
  const filePaths: string[] = []
  const elementNotes: string[] = []
  const resources: GrokContentBlock[] = []

  for (const attachment of attachments) {
    if ((attachment.kind === 'image' || attachment.kind === 'element') && attachment.data && attachment.mediaType) {
      const path = attachment.path || writeTempImage(attachment.mediaType, attachment.data)
      if (path && !attachment.path) temps.push(path)
      const uri = path ? pathToFileURL(path).href : `attachment:${attachment.id || attachment.name}`
      resources.push({
        type: 'resource',
        resource: {
          uri,
          mimeType: attachment.mediaType,
          blob: attachment.data
        }
      })
      resources.push({
        type: 'resource_link',
        uri,
        name: attachment.name,
        mimeType: attachment.mediaType,
        description: attachment.kind === 'element' ? 'Selected UI element' : 'Attached image'
      })
      if (path) filePaths.push(path)
    } else if (attachment.kind === 'file' && attachment.path) {
      const uri = pathToFileURL(attachment.path).href
      resources.push({
        type: 'resource_link',
        uri,
        name: attachment.name,
        description: 'Attached file'
      })
      filePaths.push(attachment.path)
    }
    if (attachment.kind === 'element' && attachment.element) {
      elementNotes.push(describeElement(attachment.element))
    }
    if (attachment.kind === 'selection' && attachment.selection) {
      elementNotes.push(describeSelection(attachment.selection))
    }
  }

  let prompt = text
  if (filePaths.length) {
    prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${filePaths.map((path) => `- ${path}`).join('\n')}`
  }
  if (elementNotes.length) {
    prompt = `${prompt ? `${prompt}\n\n` : ''}${elementNotes.join('\n\n')}`
  }

  const blocks: GrokContentBlock[] = []
  if (prompt || resources.length === 0) blocks.push({ type: 'text', text: prompt })
  blocks.push(...resources)
  return { blocks, temps }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(raw: unknown, key: string): string | undefined {
  const value = asRecord(raw)?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

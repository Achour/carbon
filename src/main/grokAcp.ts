import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ToolPart } from '@shared/types'

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

/** A `session/update` payload. Only the variants Carbon renders are named. */
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
  | { sessionUpdate: string; [key: string]: unknown }

export interface GrokContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
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
  /** Cumulative for the *session*, not the turn — deltas are the caller's job. */
  usage?: GrokTurnUsage
  /** The turn's own totals, which `usage` does not give. */
  turnTokens?: { input?: number; output?: number; total?: number; cachedRead?: number; reasoning?: number }
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

export interface GrokAcpCallbacks {
  onUpdate(update: GrokSessionUpdate): void
  /** Resolve with the chosen `optionId`, or null to cancel the request. */
  onPermission(request: GrokPermissionRequest): Promise<string | null>
  onModels(state: GrokModelState): void
  onCommands(commands: GrokCommand[]): void
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
  env?: NodeJS.ProcessEnv
  callbacks: GrokAcpCallbacks
}

/**
 * Where the CLI lives. The npm install (`@xai-official/grok`) and the
 * self-installer disagree, and a GUI launched from Finder inherits neither, so
 * the explicit home directory is checked before falling back to PATH — the same
 * reason `hydrateShellPath` exists at all.
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CARBON_GROK_PATH?.trim()
  if (configured) return configured
  const home = env.HOME ?? homedir()
  const candidates = [
    join(home, '.grok', 'bin', 'grok'),
    join(home, '.local', 'bin', 'grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'grok'
}

/** True when a `grok` binary can be found — drives the "not installed" notice. */
export function grokInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolveGrokBinary(env)
  if (resolved.includes('/')) return existsSync(resolved)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'grok'))) return true
  }
  return false
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
      mcpServers: [],
      _meta: meta
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
      mcpServers: []
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
      turnTokens: {
        input: numberOr(meta.inputTokens),
        output: numberOr(meta.outputTokens),
        total: numberOr(meta.totalTokens),
        cachedRead: numberOr(meta.cachedReadTokens),
        reasoning: numberOr(meta.reasoningTokens)
      }
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
    if (method !== 'session/request_permission') {
      // Anything else is a capability we declared we do not have. Answering
      // "method not found" is the honest reply and lets the agent fall back to
      // doing the work itself; a stubbed empty result would be deserialized as
      // a real answer and fail the tool instead.
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Carbon does not implement ${method}.` } })
      return
    }
    const request = (raw ?? {}) as GrokPermissionRequest
    try {
      const optionId = await this.options.callbacks.onPermission(request)
      this.write({
        jsonrpc: '2.0',
        id,
        result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
      })
    } catch {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
    }
  }

  private handleNotification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>
    if (method === 'session/update') {
      const update = params.update as GrokSessionUpdate | undefined
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
      const update = params.update as GrokSessionUpdate | undefined
      if (update) this.options.callbacks.onUpdate(update)
    }
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Grok's own effort ids happen to match Carbon's for the four levels it has, so
 * this is a filter rather than a mapping — but it is a *function* so that the
 * day xAI adds one, exactly one place changes.
 */
export function grokEffortFlag(effort: string | undefined): string | undefined {
  if (!effort) return undefined
  return ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : undefined
}

/**
 * Carbon's permission modes against Grok's two independent axes: a *baseline*
 * fixed when the session is created, and a plan flag that moves live.
 *
 * `acceptEdits` has no Grok equivalent — the CLI's own `acceptEdits` is a
 * Claude-compatibility alias that its permission engine treats as ask — so it
 * maps to the ask baseline rather than to `auto`. Quietly upgrading it would
 * make the least-privileged of the two settings run *more* without asking.
 */
export function grokPermissionMode(mode: string): {
  alwaysApprove: boolean
  autoMode: boolean
  planMode: boolean
} {
  return {
    alwaysApprove: mode === 'bypassPermissions',
    autoMode: mode === 'auto',
    planMode: mode === 'plan'
  }
}
/**
 * The name carried by *this* payload, or undefined when it carries none.
 *
 * The distinction matters because a tool's last `tool_call_update` is typically
 * status-only — no `title`, `_meta: null` — and a naming function that always
 * answers would rename a finished "Read" card to a generic fallback at the
 * exact moment it completes. Only an update that actually names the tool may
 * rename it.
 */
export function toolNameIfNamed(call: GrokToolCall): string | undefined {
  const meta = call._meta?.['x.ai/tool']
  return meta?.label?.trim() || meta?.name?.trim() || call.title?.trim() || undefined
}

/**
 * The best available name for a tool card, with a fallback — for *opening* a
 * card, which must be labelled with something. xAI's own descriptor carries a
 * human label ("Run Command") where ACP's `title` is either the raw tool name or
 * a whole sentence; the label is preferred, then the name, then the title.
 */
export function toolName(call: GrokToolCall): string {
  return toolNameIfNamed(call) ?? 'Tool'
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
  for (const block of blocks as GrokToolContent[]) {
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

/** True for the call that ends plan mode and asks for approval. */
export function isExitPlanTool(call: GrokToolCall): boolean {
  const meta = call._meta?.['x.ai/tool']
  return meta?.kind === 'exit_plan' || meta?.name === 'exit_plan_mode'
}

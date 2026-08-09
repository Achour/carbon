import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  Input,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage,
  UserInput
} from '@openai/codex-sdk'

type JsonRpcId = string | number

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

interface RpcResponse {
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

interface RpcMessage {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

interface AppServerQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: { label: string; description: string }[] | null
}

interface AppServerUserInputRequest {
  threadId: string
  turnId: string
  itemId: string
  questions: AppServerQuestion[]
  isBlocking: boolean
  autoResolutionMs: number | null
}

export interface NativeUserInputRequest extends AppServerUserInputRequest {
  requestId: string
}

export type NativeApprovalKind = 'command' | 'file-change' | 'permissions'

export interface NativeApprovalRequest {
  requestId: string
  kind: NativeApprovalKind
  threadId: string
  turnId: string
  itemId: string
  params: Record<string, unknown>
}

export interface NativeMcpElicitationRequest {
  requestId: string
  threadId: string
  turnId: string | null
  serverName: string
  mode: 'form' | 'openai/form' | 'url'
  message: string
  url?: string
  requestedSchema?: Record<string, unknown>
}

export interface NativeMcpStartupStatus {
  threadId: string | null
  name: string
  status: 'starting' | 'ready' | 'failed' | 'cancelled'
  error: string | null
  failureReason: 'reauthenticationRequired' | null
}

/** App Server's native plan item, kept distinct from an assistant message. */
export interface CodexPlanItem {
  id: string
  type: 'codex_plan'
  text: string
}

/** App Server context-compaction marker, kept out of assistant prose. */
export interface CodexCompactionItem {
  id: string
  type: 'codex_compaction'
}

export interface CodexImageViewItem {
  id: string
  type: 'codex_image_view'
  path: string
}

export function isCodexCompactionItem(value: unknown): value is CodexCompactionItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item.type === 'codex_compaction' && typeof item.id === 'string'
}

export function isCodexImageViewItem(value: unknown): value is CodexImageViewItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item.type === 'codex_image_view' && typeof item.id === 'string'
}

/** Usage fields App Server exposes beyond the public SDK's Usage shape. */
export interface CodexTurnUsage extends Usage {
  context_tokens?: number
  context_window?: number
  model?: string
}

export function isCodexPlanItem(value: unknown): value is CodexPlanItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item.type === 'codex_plan' && typeof item.id === 'string'
}

export interface AppServerThreadOptions extends ThreadOptions {
  collaborationMode?: 'default' | 'plan'
  serviceTier?: 'standard' | 'fast'
  approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent'
}

export interface CodexThreadLike {
  readonly id?: string | null
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>
  run(
    input: Input,
    options?: TurnOptions
  ): Promise<{ items: ThreadItem[]; finalResponse: string; usage: Usage | null }>
}

export interface CodexClientLike {
  startThread(options?: AppServerThreadOptions): CodexThreadLike
  resumeThread(id: string, options?: AppServerThreadOptions): CodexThreadLike
  respondToUserInput?(
    requestId: string,
    answers: Record<string, { answers: string[] }>
  ): void
  dismissUserInput?(requestId: string): void
  respondToApproval?(requestId: string, allow: boolean, always?: boolean): void
  respondToMcpElicitation?(
    requestId: string,
    allow: boolean,
    content?: Record<string, unknown> | null
  ): void
  mcpStartupStatus?(name: string, threadId?: string | null): NativeMcpStartupStatus | undefined
  request?(method: string, params: unknown): Promise<unknown>
  dispose?(): void
}

export interface CodexAppServerCallbacks {
  onUserInput?: (request: NativeUserInputRequest) => void
  onUserInputResolved?: (requestId: string) => void
  onApproval?: (request: NativeApprovalRequest) => void
  onApprovalResolved?: (requestId: string) => void
  onMcpElicitation?: (request: NativeMcpElicitationRequest) => void
  onMcpElicitationResolved?: (requestId: string) => void
  onError?: (error: Error) => void
}

interface NativeThread {
  id: string
}

interface NativeTurn {
  id: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error?: { message?: string } | null
}

interface NativeItem {
  id: string
  type: string
  [key: string]: unknown
}

interface TokenBreakdown {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

interface TurnUsage {
  total?: TokenBreakdown
  last?: TokenBreakdown
  modelContextWindow?: number | null
}

interface BufferedNotification {
  method: string
  params: Record<string, unknown>
}

class AsyncEventQueue<T> {
  private values: T[] = []
  private waiting: ((result: IteratorResult<T>) => void)[] = []
  private ended = false
  private error: Error | null = null

  push(value: T): void {
    if (this.ended) return
    const resolve = this.waiting.shift()
    if (resolve) resolve({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.ended) return
    this.error = error
    this.end()
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!
        continue
      }
      if (this.ended) {
        if (this.error) throw this.error
        return
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
      if (next.done) {
        if (this.error) throw this.error
        return
      }
      yield next.value
    }
  }
}

class AppServerTurn {
  readonly queue = new AsyncEventQueue<ThreadEvent>()
  readonly items = new Map<string, NativeItem>()
  readonly threadId: string
  readonly turnId: string
  usage: CodexTurnUsage | null = null
  model: string | null
  planSeen = false

  constructor(threadId: string, turnId: string, model: string | null) {
    this.threadId = threadId
    this.turnId = turnId
    this.model = model
  }
}

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
}

function targetTriple(): string {
  const platform = process.platform
  const arch = process.arch
  if ((platform === 'linux' || platform === 'android') && arch === 'x64')
    return 'x86_64-unknown-linux-musl'
  if ((platform === 'linux' || platform === 'android') && arch === 'arm64')
    return 'aarch64-unknown-linux-musl'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`Unsupported platform for bundled Codex: ${platform} (${arch})`)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Resolve the same optional native package used by @openai/codex-sdk. */
export function resolveBundledCodex(): { executablePath: string; pathDirs: string[] } {
  const triple = targetTriple()
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple]
  if (!platformPackage) throw new Error(`Unsupported Codex target: ${triple}`)
  try {
    const require = createRequire(import.meta.url)
    const codexPackage = require.resolve('@openai/codex/package.json')
    const codexRequire = createRequire(codexPackage)
    const nativePackage = codexRequire.resolve(`${platformPackage}/package.json`)
    const vendor = join(dirname(nativePackage), 'vendor')
    const packageRoot = join(vendor, triple)
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    const modern = join(packageRoot, 'bin', binaryName)
    if (isFile(modern)) {
      const pathDir = join(packageRoot, 'codex-path')
      return { executablePath: modern, pathDirs: isDirectory(pathDir) ? [pathDir] : [] }
    }
    const legacy = join(packageRoot, 'codex', binaryName)
    if (isFile(legacy)) {
      const pathDir = join(packageRoot, 'path')
      return { executablePath: legacy, pathDirs: isDirectory(pathDir) ? [pathDir] : [] }
    }
  } catch (error) {
    throw new Error(
      `Unable to locate the bundled Codex CLI: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  throw new Error(`The bundled Codex CLI is missing its ${triple} binary.`)
}

function inputForAppServer(input: Input): Array<Record<string, unknown>> {
  const values: UserInput[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
  return values.map((value) =>
    value.type === 'text'
      ? { type: 'text', text: value.text, text_elements: [] }
      : { type: 'localImage', path: value.path }
  )
}

function serviceTierConfig(serviceTier: AppServerThreadOptions['serviceTier']): Record<string, unknown> {
  return {
    service_tier: serviceTier === 'fast' ? 'fast' : 'default',
    features: { fast_mode: true }
  }
}

function statusForSdk(status: unknown): 'in_progress' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'declined') return 'failed'
  return 'in_progress'
}

function collabTool(tool: unknown): 'spawn_agent' | 'send_input' | 'wait' | 'close_agent' {
  switch (tool) {
    case 'spawnAgent':
    case 'spawn_agent':
      return 'spawn_agent'
    case 'sendInput':
    case 'send_input':
    case 'resumeAgent':
      return 'send_input'
    case 'closeAgent':
    case 'close_agent':
      return 'close_agent'
    default:
      return 'wait'
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function normalizeAppServerItem(item: NativeItem): ThreadItem | null {
  switch (item.type) {
    case 'agentMessage':
      return { id: item.id, type: 'agent_message', text: String(item.text ?? '') }
    case 'plan':
      return {
        id: item.id,
        type: 'codex_plan',
        text: String(item.text ?? '')
      } as unknown as ThreadItem
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.map(String) : []
      const content = Array.isArray(item.content) ? item.content.map(String) : []
      return { id: item.id, type: 'reasoning', text: [...summary, ...content].join('\n\n') }
    }
    case 'commandExecution':
      return {
        id: item.id,
        type: 'command_execution',
        command: String(item.command ?? ''),
        aggregated_output: String(item.aggregatedOutput ?? ''),
        ...(typeof item.exitCode === 'number' ? { exit_code: item.exitCode } : {}),
        status: statusForSdk(item.status)
      }
    case 'fileChange':
      return {
        id: item.id,
        type: 'file_change',
        changes: Array.isArray(item.changes)
          ? item.changes.map((change) => {
              const raw = change as Record<string, unknown>
              return {
                path: String(raw.path ?? ''),
                kind:
                  raw.kind === 'add' || raw.kind === 'delete' ? raw.kind : ('update' as const)
              }
            })
          : [],
        status: statusForSdk(item.status)
      } as unknown as ThreadItem
    case 'mcpToolCall': {
      const result =
        item.result && typeof item.result === 'object'
          ? (item.result as Record<string, unknown>)
          : null
      return {
        id: item.id,
        type: 'mcp_tool_call',
        server: String(item.server ?? 'mcp'),
        tool: String(item.tool ?? 'tool'),
        arguments: item.arguments,
        ...(result
          ? {
              result: {
                content: Array.isArray(result.content) ? result.content : [],
                structured_content: result.structuredContent ?? null,
                _meta: result._meta ?? null
              }
            }
          : {}),
        ...(item.error != null
          ? { error: { message: stringify((item.error as Record<string, unknown>).message ?? item.error) } }
          : {}),
        status: statusForSdk(item.status)
      } as ThreadItem
    }
    case 'dynamicToolCall': {
      const contentItems = Array.isArray(item.contentItems)
        ? (item.contentItems as Array<Record<string, unknown>>)
        : []
      const content = contentItems.flatMap((entry) => {
        if (entry.type === 'inputText') return [{ type: 'text', text: String(entry.text ?? '') }]
        if (entry.type === 'inputImage') {
          return [{ type: 'text', text: String(entry.imageUrl ?? '') }]
        }
        return []
      })
      return {
        id: item.id,
        type: 'mcp_tool_call',
        server: String(item.namespace ?? 'dynamic'),
        tool: String(item.tool ?? 'tool'),
        arguments: item.arguments,
        ...(content.length ? { result: { content } } : {}),
        ...(item.success === false ? { error: { message: 'The dynamic tool call failed.' } } : {}),
        status: statusForSdk(item.status)
      } as ThreadItem
    }
    case 'collabAgentToolCall': {
      const states: Record<string, { status: string; message?: string | null }> = {}
      if (item.agentsStates && typeof item.agentsStates === 'object') {
        for (const [id, state] of Object.entries(item.agentsStates as Record<string, unknown>)) {
          const raw = (state ?? {}) as Record<string, unknown>
          const status =
            raw.status === 'pendingInit'
              ? 'pending_init'
              : raw.status === 'notFound'
                ? 'not_found'
                : String(raw.status ?? 'running')
          states[id] = {
            status,
            ...(typeof raw.message === 'string' ? { message: raw.message } : {})
          }
        }
      }
      return {
        id: item.id,
        type: 'collab_tool_call',
        tool: collabTool(item.tool),
        sender_thread_id: String(item.senderThreadId ?? ''),
        receiver_thread_ids: Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.map(String)
          : [],
        prompt: typeof item.prompt === 'string' ? item.prompt : null,
        agents_states: states,
        status: statusForSdk(item.status)
      } as unknown as ThreadItem
    }
    case 'webSearch':
      return { id: item.id, type: 'web_search', query: String(item.query ?? '') }
    case 'imageGeneration':
      return typeof item.savedPath === 'string' && item.savedPath
        ? { id: item.id, type: 'agent_message', text: `![generated image](${item.savedPath})` }
        : null
    case 'imageView':
      return {
        id: item.id,
        type: 'codex_image_view',
        path: String(item.path ?? '')
      } as unknown as ThreadItem
    case 'contextCompaction':
      return {
        id: item.id,
        type: 'codex_compaction'
      } as unknown as ThreadItem
    default:
      return null
  }
}

function usageBreakdown(raw: TokenBreakdown | undefined): Usage {
  const value = raw ?? {}
  return {
    input_tokens: value.inputTokens ?? 0,
    cached_input_tokens: value.cachedInputTokens ?? 0,
    cache_write_input_tokens: value.cacheWriteInputTokens ?? 0,
    output_tokens: value.outputTokens ?? 0,
    reasoning_output_tokens: value.reasoningOutputTokens ?? 0
  }
}

export function accumulateAppServerUsage(
  current: CodexTurnUsage | null,
  raw: TurnUsage,
  model?: string | null
): CodexTurnUsage {
  const delta = usageBreakdown(raw.last ?? raw.total)
  const context = raw.last?.totalTokens
  return {
    input_tokens: (current?.input_tokens ?? 0) + delta.input_tokens,
    cached_input_tokens: (current?.cached_input_tokens ?? 0) + delta.cached_input_tokens,
    cache_write_input_tokens:
      (current?.cache_write_input_tokens ?? 0) + delta.cache_write_input_tokens,
    output_tokens: (current?.output_tokens ?? 0) + delta.output_tokens,
    reasoning_output_tokens:
      (current?.reasoning_output_tokens ?? 0) + delta.reasoning_output_tokens,
    ...(context != null ? { context_tokens: context } : {}),
    ...(raw.modelContextWindow != null ? { context_window: raw.modelContextWindow } : {}),
    ...(model || current?.model ? { model: model || current?.model } : {})
  }
}

export function appServerApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  allow: boolean,
  always = false
): Record<string, unknown> {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return {
      decision: allow
        ? always
          ? 'approved_for_session'
          : 'approved'
        : { denied: { rejection: 'Denied by the user.' } }
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: allow ? (params.permissions ?? {}) : {},
      scope: always ? 'session' : 'turn'
    }
  }
  return { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' }
}

function updateItemFromDelta(item: NativeItem, method: string, params: Record<string, unknown>): void {
  const delta = typeof params.delta === 'string' ? params.delta : ''
  if (!delta) return
  if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    item.text = `${String(item.text ?? '')}${delta}`
    return
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    const summary = Array.isArray(item.summary) ? [...item.summary] : []
    const index = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0
    summary[index] = `${String(summary[index] ?? '')}${delta}`
    item.summary = summary
    return
  }
  if (method === 'item/reasoning/textDelta') {
    const content = Array.isArray(item.content) ? [...item.content] : []
    const index = typeof params.contentIndex === 'number' ? params.contentIndex : 0
    content[index] = `${String(content[index] ?? '')}${delta}`
    item.content = content
    return
  }
  if (method === 'item/commandExecution/outputDelta') {
    item.aggregatedOutput = `${String(item.aggregatedOutput ?? '')}${delta}`
  }
}

class CodexAppServerThread implements CodexThreadLike {
  private readonly client: CodexAppServerClient
  private readonly options: AppServerThreadOptions
  private nativeId: string | null
  private resolvedModel: string | null = null
  private initialized = false
  private boundGeneration = 0

  constructor(
    client: CodexAppServerClient,
    id: string | null,
    options: AppServerThreadOptions
  ) {
    this.client = client
    this.nativeId = id
    this.options = options
  }

  get id(): string | null {
    return this.nativeId
  }

  private async ensureThread(): Promise<string> {
    await this.client.ensureReady()
    if (
      this.initialized &&
      this.nativeId &&
      this.boundGeneration === this.client.processGeneration
    ) {
      return this.nativeId
    }
    if (this.nativeId) {
      const response = (await this.client.request('thread/resume', {
        threadId: this.nativeId,
        model: this.options.model ?? null,
        serviceTier: this.options.serviceTier === 'fast' ? 'fast' : 'default',
        cwd: this.options.workingDirectory ?? null,
        approvalPolicy: this.options.approvalPolicy ?? 'never',
        approvalsReviewer: this.options.approvalsReviewer ?? 'user',
        sandbox: this.options.sandboxMode ?? null,
        config: serviceTierConfig(this.options.serviceTier)
      })) as { thread: NativeThread; model: string }
      this.nativeId = response.thread.id
      this.resolvedModel = response.model
    } else {
      const response = (await this.client.request('thread/start', {
        model: this.options.model ?? null,
        serviceTier: this.options.serviceTier === 'fast' ? 'fast' : 'default',
        cwd: this.options.workingDirectory ?? null,
        approvalPolicy: this.options.approvalPolicy ?? 'never',
        approvalsReviewer: this.options.approvalsReviewer ?? 'user',
        sandbox: this.options.sandboxMode ?? null,
        config: serviceTierConfig(this.options.serviceTier),
        ephemeral: false
      })) as { thread: NativeThread; model: string }
      this.nativeId = response.thread.id
      this.resolvedModel = response.model
    }
    this.initialized = true
    this.boundGeneration = this.client.processGeneration
    return this.nativeId
  }

  async runStreamed(
    input: Input,
    turnOptions: TurnOptions = {}
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    const threadId = await this.ensureThread()
    const response = (await this.client.request('turn/start', {
      threadId,
      input: inputForAppServer(input),
      cwd: this.options.workingDirectory ?? null,
      approvalPolicy: this.options.approvalPolicy ?? 'never',
      approvalsReviewer: this.options.approvalsReviewer ?? 'user',
      model: this.options.model ?? null,
      serviceTier: this.options.serviceTier === 'fast' ? 'fast' : 'default',
      effort: this.options.modelReasoningEffort ?? null,
      collaborationMode: {
        mode: this.options.collaborationMode ?? 'default',
        settings: {
          model: this.resolvedModel ?? this.options.model ?? '',
          reasoning_effort: this.options.modelReasoningEffort ?? null,
          developer_instructions: null
        }
      }
    })) as { turn: NativeTurn }
    const run = this.client.attachTurn(
      threadId,
      response.turn.id,
      this.resolvedModel ?? this.options.model ?? null
    )
    run.queue.push({ type: 'thread.started', thread_id: threadId })
    run.queue.push({ type: 'turn.started' })
    this.client.drainBuffered(run)

    const onAbort = (): void => {
      void this.client
        .request('turn/interrupt', { threadId, turnId: response.turn.id })
        .catch(() => {})
    }
    if (turnOptions.signal?.aborted) onAbort()
    else turnOptions.signal?.addEventListener('abort', onAbort, { once: true })
    const events = run.queue.iterate()
    return {
      events: (async function* () {
        try {
          yield* events
        } finally {
          turnOptions.signal?.removeEventListener('abort', onAbort)
        }
      })()
    }
  }

  async run(
    input: Input,
    options?: TurnOptions
  ): Promise<{ items: ThreadItem[]; finalResponse: string; usage: Usage | null }> {
    const { events } = await this.runStreamed(input, options)
    const items = new Map<string, ThreadItem>()
    let usage: Usage | null = null
    for await (const event of events) {
      if (
        event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed'
      ) {
        items.set(event.item.id, event.item)
      } else if (event.type === 'turn.completed') {
        usage = event.usage
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error.message)
      } else if (event.type === 'error') {
        throw new Error(event.message)
      }
    }
    const values = [...items.values()]
    const finalResponse =
      [...values].reverse().find((item) => item.type === 'agent_message')?.text ?? ''
    return { items: values, finalResponse, usage }
  }
}

/**
 * Native stdio JSON-RPC transport for `codex app-server`.
 *
 * One instance owns one long-lived process and can run the conversation thread
 * plus Carbon's short-lived title thread concurrently. The public shape matches
 * the small part of @openai/codex-sdk that CodexSession consumes.
 */
export class CodexAppServerClient implements CodexClientLike {
  private readonly callbacks: CodexAppServerCallbacks
  private process: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly turns = new Map<string, AppServerTurn>()
  private readonly buffered = new Map<string, BufferedNotification[]>()
  private readonly serverRequests = new Map<
    string,
    {
      id: JsonRpcId
      method: string
      params: Record<string, unknown>
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  /** Latest process-local startup state, keyed by thread and server name. */
  private readonly mcpStartupStatuses = new Map<string, NativeMcpStartupStatus>()
  private disposed = false
  processGeneration = 0

  constructor(callbacks: CodexAppServerCallbacks = {}) {
    this.callbacks = callbacks
  }

  startThread(options: AppServerThreadOptions = {}): CodexThreadLike {
    return new CodexAppServerThread(this, null, options)
  }

  resumeThread(id: string, options: AppServerThreadOptions = {}): CodexThreadLike {
    return new CodexAppServerThread(this, id, options)
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }

  private mcpStatusKey(name: string, threadId: string | null): string {
    return `${threadId ?? '*'}\u0000${name}`
  }

  mcpStartupStatus(
    name: string,
    threadId: string | null = null
  ): NativeMcpStartupStatus | undefined {
    return (
      this.mcpStartupStatuses.get(this.mcpStatusKey(name, threadId)) ??
      this.mcpStartupStatuses.get(this.mcpStatusKey(name, null))
    )
  }

  attachTurn(threadId: string, turnId: string, model: string | null): AppServerTurn {
    const key = this.turnKey(threadId, turnId)
    const existing = this.turns.get(key)
    if (existing) return existing
    const run = new AppServerTurn(threadId, turnId, model)
    this.turns.set(key, run)
    return run
  }

  drainBuffered(run: AppServerTurn): void {
    const key = this.turnKey(run.threadId, run.turnId)
    const values = this.buffered.get(key) ?? []
    this.buffered.delete(key)
    for (const value of values) this.handleTurnNotification(run, value.method, value.params)
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted()
    return this.rawRequest(method, params)
  }

  async ensureReady(): Promise<void> {
    await this.ensureStarted()
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('Codex App Server has been disposed.')
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start()
    try {
      await this.startPromise
    } catch (error) {
      this.startPromise = null
      throw error
    }
  }

  private async start(): Promise<void> {
    const resolved = resolveBundledCodex()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'carbon'
    }
    const existingPath = env.PATH ?? ''
    env.PATH = [...resolved.pathDirs, ...existingPath.split(delimiter).filter(Boolean)].join(delimiter)
    const child = spawn(resolved.executablePath, ['app-server'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process = child
    let failed = false
    const failChild = (error: Error): void => {
      if (failed || this.process !== child) return
      failed = true
      this.failProcess(error)
    }
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.warn(`[codex app-server] ${text}`)
    })
    child.once('error', failChild)
    child.once('exit', (code, signal) => {
      if (!this.disposed) {
        failChild(
          new Error(
            `Codex App Server exited unexpectedly${code != null ? ` (code ${code})` : ''}${
              signal ? ` (${signal})` : ''
            }.`
          )
        )
      }
    })
    await this.rawRequest('initialize', {
      clientInfo: { name: 'carbon', title: 'Carbon', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
        extensions: { 'openai/form': {} }
      }
    })
    this.notify('initialized', {})
    this.processGeneration += 1
  }

  private rawRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error('Codex App Server is not running.')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      console.warn(`[codex app-server] Ignored non-JSON output: ${line}`)
      return
    }
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        Object.assign(error, { code: message.error.code, data: message.error.data })
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.id != null && message.method) {
      this.handleServerRequest(message.id, message.method, message.params)
      return
    }
    if (message.method) this.handleNotification(message.method, message.params)
  }

  private handleServerRequest(id: JsonRpcId, method: string, raw: unknown): void {
    const supported = new Set([
      'item/tool/requestUserInput',
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
      'execCommandApproval',
      'applyPatchApproval'
    ])
    if (!supported.has(method)) {
      this.write({
        id,
        error: { code: -32601, message: `Carbon does not support App Server request ${method}.` }
      })
      return
    }
    const params = (raw ?? {}) as Record<string, unknown>
    const requestId = String(id)
    const record: {
      id: JsonRpcId
      method: string
      params: Record<string, unknown>
      timer?: ReturnType<typeof setTimeout>
    } = { id, method, params }
    if (
      method === 'item/tool/requestUserInput' &&
      typeof params.autoResolutionMs === 'number' &&
      params.autoResolutionMs > 0
    ) {
      record.timer = setTimeout(() => this.dismissUserInput(requestId), params.autoResolutionMs)
    }
    this.serverRequests.set(requestId, record)
    if (method === 'item/tool/requestUserInput') {
      this.callbacks.onUserInput?.({
        ...(params as unknown as AppServerUserInputRequest),
        requestId
      })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      const mode =
        params.mode === 'url' || params.mode === 'openai/form' ? params.mode : 'form'
      this.callbacks.onMcpElicitation?.({
        requestId,
        threadId: String(params.threadId ?? ''),
        turnId: typeof params.turnId === 'string' ? params.turnId : null,
        serverName: String(params.serverName ?? 'MCP server'),
        mode,
        message: String(params.message ?? 'This MCP server needs input.'),
        ...(typeof params.url === 'string' ? { url: params.url } : {}),
        ...(params.requestedSchema && typeof params.requestedSchema === 'object'
          ? { requestedSchema: params.requestedSchema as Record<string, unknown> }
          : {})
      })
      return
    }
    const kind: NativeApprovalKind =
      method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
        ? 'command'
        : method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
          ? 'file-change'
          : 'permissions'
    const normalizedParams =
      method === 'execCommandApproval' && Array.isArray(params.command)
        ? { ...params, command: params.command.map(String).join(' ') }
        : params
    this.callbacks.onApproval?.({
      requestId,
      kind,
      threadId: String(params.threadId ?? params.conversationId ?? ''),
      turnId: String(params.turnId ?? ''),
      itemId: String(params.itemId ?? params.callId ?? ''),
      params: normalizedParams
    })
  }

  respondToUserInput(
    requestId: string,
    answers: Record<string, { answers: string[] }>
  ): void {
    const pending = this.serverRequests.get(requestId)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.serverRequests.delete(requestId)
    this.write({ id: pending.id, result: { answers } })
    this.callbacks.onUserInputResolved?.(requestId)
  }

  dismissUserInput(requestId: string): void {
    this.respondToUserInput(requestId, {})
  }

  respondToApproval(requestId: string, allow: boolean, always = false): void {
    const pending = this.serverRequests.get(requestId)
    if (
      !pending ||
      pending.method === 'item/tool/requestUserInput' ||
      pending.method === 'mcpServer/elicitation/request'
    )
      return
    this.serverRequests.delete(requestId)
    const result = appServerApprovalResponse(pending.method, pending.params, allow, always)
    this.write({ id: pending.id, result })
    this.callbacks.onApprovalResolved?.(requestId)
  }

  respondToMcpElicitation(
    requestId: string,
    allow: boolean,
    content: Record<string, unknown> | null = null
  ): void {
    const pending = this.serverRequests.get(requestId)
    if (!pending || pending.method !== 'mcpServer/elicitation/request') return
    this.serverRequests.delete(requestId)
    this.write({
      id: pending.id,
      result: { action: allow ? 'accept' : 'decline', content: allow ? content : null, _meta: null }
    })
    this.callbacks.onMcpElicitationResolved?.(requestId)
  }

  private handleNotification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>
    if (method === 'mcpServer/startupStatus/updated') {
      const name = typeof params.name === 'string' ? params.name : ''
      const status = params.status
      if (
        name &&
        (status === 'starting' ||
          status === 'ready' ||
          status === 'failed' ||
          status === 'cancelled')
      ) {
        const value: NativeMcpStartupStatus = {
          threadId: typeof params.threadId === 'string' ? params.threadId : null,
          name,
          status,
          error: typeof params.error === 'string' ? params.error : null,
          failureReason:
            params.failureReason === 'reauthenticationRequired'
              ? 'reauthenticationRequired'
              : null
        }
        this.mcpStartupStatuses.set(this.mcpStatusKey(name, value.threadId), value)
      }
      return
    }
    if (method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? '')
      const pending = this.serverRequests.get(requestId)
      if (pending?.timer) clearTimeout(pending.timer)
      this.serverRequests.delete(requestId)
      if (requestId) {
        if (pending?.method === 'item/tool/requestUserInput') {
          this.callbacks.onUserInputResolved?.(requestId)
        } else if (pending?.method === 'mcpServer/elicitation/request') {
          this.callbacks.onMcpElicitationResolved?.(requestId)
        } else {
          this.callbacks.onApprovalResolved?.(requestId)
        }
      }
      return
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    const turn =
      params.turn && typeof params.turn === 'object' ? (params.turn as NativeTurn) : null
    const turnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof turn?.id === 'string'
          ? turn.id
          : null
    if (!threadId || !turnId) return
    const key = this.turnKey(threadId, turnId)
    const run = this.turns.get(key)
    if (run) this.handleTurnNotification(run, method, params)
    else {
      const buffered = this.buffered.get(key) ?? []
      buffered.push({ method, params })
      this.buffered.set(key, buffered)
    }
  }

  private handleTurnNotification(
    run: AppServerTurn,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as NativeItem | undefined
      if (!item?.id) return
      run.items.set(item.id, item)
      const normalized = normalizeAppServerItem(item)
      if (normalized) {
        run.queue.push({
          type: method === 'item/started' ? 'item.started' : 'item.completed',
          item: normalized
        })
      }
      return
    }
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/plan/delta' ||
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta' ||
      method === 'item/commandExecution/outputDelta'
    ) {
      const itemId = String(params.itemId ?? '')
      const item = run.items.get(itemId)
      if (!item) return
      updateItemFromDelta(item, method, params)
      const normalized = normalizeAppServerItem(item)
      if (normalized) run.queue.push({ type: 'item.updated', item: normalized })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      run.usage = accumulateAppServerUsage(
        run.usage,
        (params.tokenUsage ?? {}) as TurnUsage,
        run.model
      )
      return
    }
    if (method === 'model/rerouted') {
      const toModel = typeof params.toModel === 'string' ? params.toModel : null
      if (toModel) {
        run.model = toModel
        if (run.usage) run.usage.model = toModel
      }
      return
    }
    if (method === 'turn/plan/updated') {
      const steps = Array.isArray(params.plan)
        ? (params.plan as Array<Record<string, unknown>>)
        : []
      const item = {
        id: `codex-plan-steps-${run.turnId}`,
        type: 'todo_list',
        items: steps.map((step) => ({
          text: String(step.step ?? ''),
          completed: step.status === 'completed'
        }))
      } as unknown as ThreadItem
      run.queue.push({ type: run.planSeen ? 'item.updated' : 'item.started', item })
      run.planSeen = true
      return
    }
    if (method === 'turn/completed') {
      const turn = params.turn as NativeTurn
      if (turn.status === 'failed') {
        run.queue.push({
          type: 'turn.failed',
          error: { message: turn.error?.message ?? 'The Codex turn failed.' }
        })
      } else if (turn.status === 'interrupted') {
        run.queue.push({ type: 'error', message: 'The Codex turn was interrupted.' })
      } else {
        run.queue.push({
          type: 'turn.completed',
          usage: run.usage ?? accumulateAppServerUsage(null, {}, run.model)
        })
      }
      run.queue.end()
      this.turns.delete(this.turnKey(run.threadId, run.turnId))
    }
  }

  private failProcess(error: Error): void {
    this.process = null
    this.startPromise = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const run of this.turns.values()) run.queue.fail(error)
    this.turns.clear()
    this.buffered.clear()
    this.mcpStartupStatuses.clear()
    for (const [requestId, pending] of this.serverRequests) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.method === 'item/tool/requestUserInput') {
        this.callbacks.onUserInputResolved?.(requestId)
      } else if (pending.method === 'mcpServer/elicitation/request') {
        this.callbacks.onMcpElicitationResolved?.(requestId)
      } else {
        this.callbacks.onApprovalResolved?.(requestId)
      }
    }
    this.serverRequests.clear()
    this.callbacks.onError?.(error)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.serverRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.serverRequests.clear()
    for (const run of this.turns.values()) run.queue.end()
    this.turns.clear()
    this.buffered.clear()
    this.mcpStartupStatuses.clear()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex App Server was disposed.'))
    }
    this.pending.clear()
    this.process?.kill()
    this.process = null
  }
}

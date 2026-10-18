import type { AssistantPart, Attachment, EffortId, ModelOption, ToolPart, ToolStatus } from '@shared/types'
// Relative and .ts-extensioned: runtime imports `node --test` must resolve
// without a bundler (see test/cursorSdk.test.ts).
import { CURSOR_DEFAULT_MODEL, CURSOR_MODEL_PREFIX, PROVIDER_EFFORTS } from '../shared/types.ts'
import { describeCanvas, describeElement, describeQuote, describeSelection } from './attachmentText.ts'

/**
 * The pure half of the Cursor provider: `@cursor/sdk`'s shapes in, Carbon's
 * out. Nothing here touches the SDK itself, so it runs under `node --test`.
 *
 * Every shape below was read off the 1.0.37 SDK against a real account
 * (`docs/cursor.md`), not off its type declarations — those are 2 MB of zod
 * inference, and the wire carries fields they do not mention.
 */

// ---------- Wire shapes ----------

export interface CursorModelParameter {
  id: string
  displayName?: string
  values: { value: string; displayName?: string }[]
}

export interface CursorModelVariant {
  params: { id: string; value: string }[]
  displayName: string
  description?: string
  isDefault?: boolean
}

/** One `Cursor.models.list()` row. */
export interface CursorCatalogModel {
  id: string
  displayName: string
  description?: string
  aliases?: string[]
  parameters?: CursorModelParameter[]
  variants?: CursorModelVariant[]
}

export interface CursorModelSelection {
  id: string
  params?: { id: string; value: string }[]
}

/** `toolCall` on a `tool-call-*` / `partial-tool-call` update. */
export interface CursorToolCall {
  type: string
  args?: Record<string, unknown>
  result?: { status: 'success'; value?: unknown } | { status: 'error'; error?: unknown }
}

/** One `onDelta` update. Only the fields Carbon reads are typed. */
export type CursorUpdate =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-completed'; thinkingDurationMs?: number }
  | { type: 'partial-tool-call'; callId: string; toolCall: CursorToolCall }
  | { type: 'tool-call-started'; callId: string; toolCall: CursorToolCall }
  | { type: 'tool-call-completed'; callId: string; toolCall: CursorToolCall }
  | { type: 'tool-call-delta'; callId: string; taskUpdate?: CursorUpdate }
  | { type: 'shell-output-delta'; callId?: string; event?: Record<string, unknown> }
  | { type: 'step-completed'; stepId?: number; stepDurationMs?: number }
  | { type: 'turn-ended'; usage?: CursorTokenUsage }
  | { type: 'token-delta'; tokens?: number }
  | { type: string; [key: string]: unknown }

export interface CursorTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// ---------- Models ----------

/**
 * The parameter that carries reasoning effort. Cursor spells it per model —
 * `effort` on Grok 4.6, `reasoning_effort` on Grok 4.7 — and a bare
 * `reasoning` is read too.
 */
const EFFORT_PARAMS = ['effort', 'reasoning_effort', 'reasoning']

const EFFORT_IDS = new Set<EffortId>(PROVIDER_EFFORTS.cursor)

function effortParam(model: CursorCatalogModel): CursorModelParameter | undefined {
  return model.parameters?.find((param) => EFFORT_PARAMS.includes(param.id))
}

function defaultParams(model: CursorCatalogModel): { id: string; value: string }[] {
  const variant = model.variants?.find((entry) => entry.isDefault) ?? model.variants?.[0]
  if (variant) return variant.params.map((param) => ({ ...param }))
  // No variant: the first value of every parameter is the only one the
  // catalog vouches for.
  return (model.parameters ?? [])
    .filter((param) => param.values[0])
    .map((param) => ({ id: param.id, value: param.values[0].value }))
}

/** `256k` / `1m` → tokens; undefined for anything else. */
export function parseContextSize(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(value.trim())
  if (!match) return undefined
  return Math.round(Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000))
}

/**
 * The model the account's Default row stands for. The SDK's own `default`
 * selection is refused by a plan with a fixed list, so Carbon picks: Cursor's
 * own Composer when the plan has it, otherwise the catalog's first row.
 */
export function cursorDefaultModel(models: CursorCatalogModel[]): CursorCatalogModel | undefined {
  return models.find((model) => /^composer/i.test(model.id)) ?? models[0]
}

/** The live catalog as picker rows, the Default row first. */
export function cursorModelOptions(models: CursorCatalogModel[]): ModelOption[] {
  const usable = models.filter((model) => model.id && model.displayName)
  if (!usable.length) return []
  const fallback = cursorDefaultModel(usable)
  const rows = usable.map((model): ModelOption => {
    const efforts = (effortParam(model)?.values ?? [])
      .map((entry) => entry.value as EffortId)
      .filter((value) => EFFORT_IDS.has(value))
    const fast = model.parameters?.find((param) => param.id === 'fast')
    const context = model.parameters
      ?.find((param) => param.id === 'context')
      ?.values.map((entry) => parseContextSize(entry.value) ?? 0)
      .reduce((a, b) => Math.max(a, b), 0)
    return {
      id: `${CURSOR_MODEL_PREFIX}${model.id}`,
      label: model.displayName.trim(),
      description: model.description?.trim() || 'Cursor',
      provider: 'cursor',
      ...(context ? { contextWindow: context } : {}),
      // Only the levels this account may send. One level is no choice, and an
      // empty list leaves the Reasoning menu its Default row alone.
      supportedEfforts: efforts.length > 1 ? efforts : [],
      supportsFastMode: !!fast?.values.some((entry) => entry.value === 'true')
    }
  })
  const resolved = fallback ? rows.find((row) => row.id === `${CURSOR_MODEL_PREFIX}${fallback.id}`) : undefined
  return [
    {
      // The Default row is the model it resolves to, knobs included.
      ...(resolved ?? {}),
      id: CURSOR_DEFAULT_MODEL,
      label: 'Cursor (default)',
      description: fallback ? `Currently ${fallback.displayName}` : "Your plan's default model",
      provider: 'cursor',
      ...(resolved ? { resolvedModel: resolved.id } : {})
    },
    ...rows
  ]
}

/**
 * What `Agent.create` / `send` is given for a model.
 *
 * Every parameter the default variant names is sent, not just the ones Carbon
 * changes: a plan with "fixed settings" rejects a selection that leaves one
 * out ("Model unavailable on Plus … with fixed settings"), measured. Effort and
 * Fast then replace their own entry, and only with a value the catalog lists
 * for this model — anything else is the same rejection.
 */
export function cursorModelSelection(
  model: CursorCatalogModel,
  options: { effort?: EffortId; fast?: boolean } = {}
): CursorModelSelection {
  const params = defaultParams(model)
  const set = (id: string, value: string): void => {
    const param = model.parameters?.find((entry) => entry.id === id)
    if (!param?.values.some((entry) => entry.value === value)) return
    const existing = params.find((entry) => entry.id === id)
    if (existing) existing.value = value
    else params.push({ id, value })
  }
  const effort = effortParam(model)
  if (effort && options.effort) set(effort.id, options.effort)
  if (options.fast !== undefined) set('fast', String(options.fast))
  return params.length ? { id: model.id, params } : { id: model.id }
}

// ---------- Tools ----------

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The server name the SDK gives `local.customTools`. */
export const CURSOR_CUSTOM_TOOLS = 'custom-user-tools'

/** Carbon's renderer names, per SDK tool type. Unknown types keep their own. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  shell: 'Bash',
  edit: 'Edit',
  write: 'Write',
  delete: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'ListDir',
  webSearch: 'WebSearch',
  webFetch: 'WebFetch',
  task: 'Agent',
  updateTodos: 'TodoWrite',
  readTodos: 'TodoRead',
  createPlan: 'ExitPlanMode',
  semSearch: 'SemanticSearch',
  readLints: 'ReadLints',
  generateImage: 'GenerateImage'
}

export function cursorToolName(call: CursorToolCall): string {
  if (call.type === 'mcp') {
    const args = record(call.args)
    const raw = str(args.providerIdentifier) ?? str(args.serverName) ?? 'mcp'
    // Carbon's tools reach Cursor as callbacks, which the SDK serves as its
    // own `custom-user-tools` server; they are Carbon's, and are named so.
    const server = raw === CURSOR_CUSTOM_TOOLS ? 'carbon' : raw
    const tool = str(args.toolName) ?? str(args.name) ?? 'tool'
    return `mcp__${server}__${tool}`
  }
  return TOOL_NAMES[call.type] ?? call.type
}

/** Cursor's todo statuses are camelCase; the checklist reads snake_case. */
function todoStatus(status: unknown): string {
  if (status === 'inProgress' || status === 'in_progress') return 'in_progress'
  if (status === 'completed' || status === 'cancelled') return status
  return 'pending'
}

/**
 * The checklist a todo call leaves. `args.todos` is a *merge* — measured: a
 * second call names only the items it changes — while the successful result
 * carries the whole list, so the result wins once it exists.
 */
export function cursorTodos(call: CursorToolCall): { content: string; status: string }[] {
  const value = call.result?.status === 'success' ? record(call.result.value) : {}
  const source = Array.isArray(value.todos) ? value.todos : record(call.args).todos
  if (!Array.isArray(source)) return []
  return source
    .map((todo) => record(todo))
    .filter((todo) => str(todo.content) && todo.status !== 'cancelled')
    .map((todo) => ({ content: String(todo.content), status: todoStatus(todo.status) }))
}

/** The `edit` result's unified diff, for the Edit card's patch view. */
function editChange(call: CursorToolCall, path: string | undefined): Record<string, unknown> {
  const value = call.result?.status === 'success' ? record(call.result.value) : {}
  const diff = str(value.diffString)
  const kind = call.type === 'delete' ? 'delete' : diff?.startsWith('--- /dev/null') ? 'add' : 'update'
  return { path, kind, ...(diff ? { diff } : {}) }
}

/** Input in the shape the renderer's card for `cursorToolName` reads. */
export function cursorToolInput(call: CursorToolCall): unknown {
  const args = record(call.args)
  switch (call.type) {
    case 'read':
      return { file_path: str(args.path), ...args }
    case 'shell':
      return { command: str(args.command) ?? '', ...(str(args.workingDirectory) ? { cwd: args.workingDirectory } : {}) }
    case 'edit':
    case 'delete': {
      const path = str(args.path)
      return { file_path: path, changes: [editChange(call, path)] }
    }
    case 'write':
      return { file_path: str(args.path), content: str(args.fileText) ?? str(args.content) ?? '' }
    case 'grep':
      return { pattern: str(args.pattern), ...(str(args.path) ? { path: args.path } : {}), ...(str(args.glob) ? { glob: args.glob } : {}) }
    case 'glob':
      return { pattern: str(args.globPattern) ?? str(args.pattern), ...(str(args.targetDirectory) ? { path: args.targetDirectory } : {}) }
    case 'ls':
      return { path: str(args.path) ?? str(args.targetDirectory) }
    case 'webSearch':
      return { query: str(args.searchTerm) ?? str(args.query) }
    case 'webFetch':
      return { url: str(args.url) }
    case 'task': {
      const kind = str(record(args.subagentType).kind)
      return {
        description: str(args.description) ?? 'Cursor subagent',
        prompt: str(args.prompt),
        subagent_type: kind && kind !== 'unspecified' ? kind : 'Cursor',
        ...(str(args.model) ? { model: args.model } : {})
      }
    }
    case 'updateTodos':
      return { todos: cursorTodos(call) }
    case 'createPlan':
      return { plan: str(args.plan) ?? '' }
    case 'mcp':
      return record(args.args)
    default:
      return args
  }
}

const OUTPUT_CAP = 40_000

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)` : text
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const raw = record(error)
  return str(raw.error) ?? str(raw.errorMessage) ?? str(raw.message) ?? JSON.stringify(error)
}

/** The text a settled call shows, or undefined while it runs. */
export function cursorToolOutput(call: CursorToolCall): string | undefined {
  const result = call.result
  if (!result) return undefined
  if (result.status === 'error') return cap(errorText(result.error) || 'Tool failed.')
  const value = result.value
  switch (call.type) {
    case 'shell': {
      const raw = record(value)
      const out = [str(raw.stdout), str(raw.stderr)].filter(Boolean).join('\n')
      const exit = typeof raw.exitCode === 'number' && raw.exitCode !== 0 ? `[exit ${raw.exitCode}]` : ''
      return cap([out, exit].filter(Boolean).join('\n'))
    }
    case 'read':
      return cap(str(record(value).content) ?? '')
    case 'edit':
    case 'delete': {
      const raw = record(value)
      const added = typeof raw.linesAdded === 'number' ? raw.linesAdded : 0
      const removed = typeof raw.linesRemoved === 'number' ? raw.linesRemoved : 0
      return `+${added} −${removed}`
    }
    case 'glob': {
      const files = record(value).files
      return Array.isArray(files) ? cap(files.join('\n')) : undefined
    }
    case 'grep':
      return cap(grepText(record(value).workspaceResults))
    case 'mcp': {
      const content = record(value).content
      if (!Array.isArray(content)) return undefined
      return cap(
        content
          .map((block) => {
            const raw = record(block)
            return str(record(raw.text).text) ?? str(raw.text) ?? ''
          })
          .filter(Boolean)
          .join('\n')
      )
    }
    case 'task': {
      const steps = record(value).conversationSteps
      if (!Array.isArray(steps)) return undefined
      const last = [...steps].reverse().map((step) => str(record(record(step).assistantMessage).text)).find(Boolean)
      return last ? cap(last) : undefined
    }
    case 'updateTodos':
    case 'createPlan':
      return undefined
    default: {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'string') return cap(value)
      const raw = record(value)
      const text = str(raw.results) ?? str(raw.content) ?? str(raw.text)
      return cap(text ?? JSON.stringify(value, null, 2))
    }
  }
}

/** `grep`'s per-workspace results, flattened to `file:line: text`. */
function grepText(results: unknown): string {
  const lines: string[] = []
  for (const entry of Object.values(record(results))) {
    const raw = record(entry)
    const output = record(raw.output)
    if (Array.isArray(output.matches)) {
      for (const match of output.matches) {
        const m = record(match)
        const at = typeof m.lineNumber === 'number' ? `:${m.lineNumber}` : ''
        lines.push(`${str(m.file) ?? ''}${at}: ${str(m.line) ?? ''}`)
      }
    } else if (Array.isArray(output.files)) {
      lines.push(...output.files.filter((file): file is string => typeof file === 'string'))
    } else if (Array.isArray(output.counts)) {
      for (const count of output.counts) {
        const c = record(count)
        lines.push(`${str(c.file) ?? ''}: ${String(c.count ?? 0)}`)
      }
    }
  }
  return lines.join('\n') || 'No matches.'
}

export function cursorToolStatus(call: CursorToolCall, completed: boolean): ToolStatus {
  if (call.result?.status === 'error') return 'error'
  // A shell that ran and exited non-zero is a *successful* call to the SDK;
  // the row says it failed, as Codex's and Claude's do.
  if (call.type === 'shell' && call.result?.status === 'success') {
    const exit = record(call.result.value).exitCode
    if (typeof exit === 'number' && exit !== 0) return 'error'
  }
  if (call.type === 'mcp' && record(call.result?.status === 'success' ? call.result.value : undefined).isError === true) {
    return 'error'
  }
  return completed || call.result ? 'success' : 'running'
}

/** A fresh part for a call Carbon has not seen yet. */
export function cursorToolPart(callId: string, call: CursorToolCall, completed: boolean, partial: boolean): ToolPart {
  const status = cursorToolStatus(call, completed)
  const output = status === 'running' ? undefined : cursorToolOutput(call)
  return {
    type: 'tool',
    toolUseId: callId,
    name: cursorToolName(call),
    input: cursorToolInput(call),
    status,
    startedAt: Date.now(),
    ...(partial && status === 'running' ? { partial: true } : {}),
    ...(output !== undefined ? { output } : {})
  }
}

/**
 * A subagent's own stream, as the parts of its `Agent` card. The child's
 * updates arrive one `taskUpdate` at a time on the parent call, so this keeps
 * the open text/thinking slot and the child tool index between calls.
 */
export class CursorChildStream {
  readonly parts: AssistantPart[] = []
  private slot: { kind: 'text' | 'thinking'; index: number } | null = null
  private tools = new Map<string, number>()

  /** Apply one nested update; true when `parts` changed. */
  apply(update: CursorUpdate): boolean {
    switch (update.type) {
      case 'text-delta':
      case 'thinking-delta': {
        const text = (update as { text?: unknown }).text
        if (typeof text !== 'string' || !text) return false
        const kind = update.type === 'text-delta' ? 'text' : 'thinking'
        if (this.slot?.kind !== kind) {
          this.parts.push({ type: kind, text: '' })
          this.slot = { kind, index: this.parts.length - 1 }
        }
        const part = this.parts[this.slot.index]
        if (part.type === 'text' || part.type === 'thinking') part.text += text
        return true
      }
      case 'thinking-completed':
      case 'step-completed':
        this.slot = null
        return false
      case 'partial-tool-call':
      case 'tool-call-started':
      case 'tool-call-completed': {
        const { callId, toolCall } = update as { callId?: string; toolCall?: CursorToolCall }
        if (!callId || !toolCall) return false
        this.slot = null
        const completed = update.type === 'tool-call-completed'
        const next = cursorToolPart(callId, toolCall, completed, update.type === 'partial-tool-call')
        const index = this.tools.get(callId)
        if (index === undefined) {
          this.parts.push(next)
          this.tools.set(callId, this.parts.length - 1)
        } else {
          const prior = this.parts[index] as ToolPart
          this.parts[index] = { ...next, startedAt: prior.startedAt }
        }
        return true
      }
      default:
        return false
    }
  }

  /** Close whatever is still running when the parent call ends. */
  settle(status: 'success' | 'error'): void {
    for (const index of this.tools.values()) {
      const part = this.parts[index] as ToolPart
      if (part.status === 'running' || part.status === 'pending') {
        this.parts[index] = { ...part, status, partial: undefined }
      }
    }
  }
}

// ---------- Prompts ----------

/** What the SDK accepts as an image: these four. */
const SDK_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface CursorPrompt {
  text: string
  images?: { data: string; mimeType: string }[]
}

/**
 * The user message for `agent.send`. Images ride natively; files are named by
 * path for the agent to read; selections, elements, canvases and quotes are
 * spelled out as text the way every other provider gets them.
 */
export function buildCursorPrompt(text: string, attachments: Attachment[] = []): CursorPrompt {
  const images: { data: string; mimeType: string }[] = []
  const files: string[] = []
  const notes: string[] = []
  for (const attachment of attachments) {
    if (
      (attachment.kind === 'image' || attachment.kind === 'element') &&
      attachment.data &&
      attachment.mediaType &&
      SDK_IMAGE_TYPES.has(attachment.mediaType)
    ) {
      images.push({ data: attachment.data, mimeType: attachment.mediaType })
    } else if (attachment.path) {
      files.push(attachment.path)
    }
    if (attachment.kind === 'element' && attachment.element) notes.push(describeElement(attachment.element))
    if (attachment.kind === 'selection' && attachment.selection) notes.push(describeSelection(attachment.selection))
    if (attachment.kind === 'canvas' && attachment.canvas) notes.push(describeCanvas(attachment.canvas))
    if (attachment.kind === 'quote' && attachment.quote) notes.push(describeQuote(attachment.quote))
  }
  let prompt = text
  if (files.length) {
    prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${files.map((path) => `- ${path}`).join('\n')}`
  }
  if (notes.length) prompt = `${prompt ? `${prompt}\n\n` : ''}${notes.join('\n\n')}`
  return images.length ? { text: prompt, images } : { text: prompt }
}

// ---------- Failures ----------

/**
 * The SDK rejects an internal promise nothing awaits when its shell wrapper
 * cannot spawn (a cwd that vanished): `spawn /bin/zsh ENOENT` with Cursor's
 * sandbox script in `spawnargs`. Recognized so main can log it rather than
 * treat it as a crash.
 */
const SHELL_SPAWN_MARKERS = ['dump_zsh_state', 'dump_bash_state', '__CURSOR_SANDBOX_ENV_RESTORE']

export function isCursorShellSpawnFailure(reason: unknown): boolean {
  const raw = record(reason)
  if (typeof raw.syscall !== 'string' || !raw.syscall.startsWith('spawn')) return false
  if (typeof raw.code !== 'string' || !Array.isArray(raw.spawnargs)) return false
  return raw.spawnargs.some(
    (arg) => typeof arg === 'string' && SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker))
  )
}

/** An error's message and every `cause` beneath it, outermost first. */
export function errorChain(error: unknown): string[] {
  const out: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 8; depth++) {
    const message = record(current).message
    if (typeof message === 'string' && message) out.push(message)
    current = record(current).cause
  }
  return out
}

/** A signed-out SDK: no stored key, or one the backend refused. */
export function isCursorAuthError(error: unknown): boolean {
  const raw = record(error)
  if (raw.name === 'AuthenticationError' || raw.status === 401) return true
  return errorChain(error).some((message) =>
    /no api key|api key is required|unauthenticated|authentication (failed|required)|sign in|logged out/i.test(message)
  )
}

/** A resumed agent still holding the run a crashed process left open. */
export function isActiveRunError(error: unknown): boolean {
  return errorChain(error).some((message) => /already has (an )?active run/i.test(message))
}

/** The SDK decided, once per process, that local sandboxing cannot run. */
export function isSandboxUnsupported(error: unknown): boolean {
  return errorChain(error).some((message) => /sandboxing is not supported/i.test(message))
}

/** One line for an error card: the SDK's first message, never its source. */
export function cursorErrorMessage(error: unknown): string {
  const [first] = errorChain(error)
  return first ?? String(error)
}

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Attachment, PermissionModeId, ToolPart, UserQuestion } from '@shared/types'
import { AcpMethodNotFound, AcpRpc, AcpRpcError } from './acpRpc.ts'
import { describeCanvas, describeQuote, describeSelection } from './attachmentText.ts'
import { carbonToolId, parseCarbonTool, type HttpMcpServer } from './carbonMcp.ts'
import { describeElement } from './grokAcp.ts'
import { spawnEnv } from './parentEnv.ts'
import { providerCli } from './providerCli.ts'

/**
 * A client for Google's Antigravity ACP server (`agy_acp_server`), and the
 * protocol knowledge that turns its traffic into Carbon's shapes.
 *
 * Antigravity is Carbon's second ACP backend after Grok, and the first whose
 * agent is not the user's terminal CLI: `agy` itself has no ACP mode, and its
 * headless `--output-format stream-json` cannot prompt — a tool needing
 * approval is auto-denied — so Ask mode and Carbon's own MCP tools would both
 * be impossible on it. Google ships the ACP server separately (through the ACP
 * registry), and that is what this drives.
 *
 * Shapes here were read off the 1.2.1 server's own source rather than ACP's
 * published schema. The ones that matter:
 *
 *  - **Sign-in is the server's, not the CLI's.** `authenticate` with
 *    `oauth-personal` runs a loopback OAuth flow and prints its link on stderr;
 *    the method is then remembered in `~/.gemini/antigravity-acp/settings.json`
 *    and the token in the keychain, so later processes skip `authenticate`.
 *  - **Modes move live.** `default` / `auto_edit` / `yolo` through
 *    `session/set_config_option`; there is no plan mode, only a `/plan` slash
 *    command, which is how Carbon's Plan mode is spelled for this backend.
 *  - **Tools carry no name.** A call is a `title` ("Running view_file",
 *    "Run edit_file?", or for a shell call the command itself) plus a `kind`;
 *    the closing update carries only `rawOutput` and a status.
 *  - **Questions ride `session/request_permission`**, on a synthetic
 *    `interaction_…` tool call whose options are the answers.
 *  - **No usage, no titles.** The prompt reply is a bare `stopReason`.
 */

export type AgyRawUpdate = { sessionUpdate: string } & Record<string, unknown>

export interface AgyContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  description?: string
  resource?: { uri: string; mimeType?: string; text?: string; blob?: string }
}

export interface AgyToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: { type: string; [key: string]: unknown }[] | null
  locations?: { path?: string; line?: number | null }[] | null
  _meta?: {
    mcp?: { tool?: string; server?: string }
    is_mcp_tool_call?: boolean
  } | null
}

export interface AgyPermissionOption {
  optionId: string
  name?: string
  kind?: string
  _meta?: Record<string, unknown> | null
}

export interface AgyPermissionRequest {
  sessionId: string
  toolCall: AgyToolCall
  options: AgyPermissionOption[]
}

export interface AgyModelInfo {
  modelId: string
  name?: string
  description?: string | null
}

export interface AgyModelState {
  currentModelId?: string
  availableModels?: AgyModelInfo[]
}

export interface AgySessionSetup {
  sessionId?: string
  models?: AgyModelState | null
  modes?: { currentModeId?: string } | null
}

export interface AgyCommand {
  name: string
  description?: string
}

export interface AntigravityCallbacks {
  onUpdate(update: AgyRawUpdate): void
  /** Resolve with the chosen `optionId`, or null to cancel. */
  onPermission(request: AgyPermissionRequest): Promise<string | null>
  /** The server printed a Google sign-in link and is waiting on it. */
  onAuthUrl?(url: string): void
  onExit(error: Error | null): void
}

export interface AntigravityClientOptions {
  cwd: string
  mcpServers?: HttpMcpServer[]
  callbacks: AntigravityCallbacks
}

/** The ACP auth method for a personal Google account. */
export const AGY_AUTH_GOOGLE = 'oauth-personal'

/** `-32000`, the code the server answers every "sign in first" with. */
const AUTH_REQUIRED_CODE = -32000

/** The ids `session/set_config_option` accepts for `mode`. */
export type AgyMode = 'default' | 'auto_edit' | 'yolo'

/**
 * Carbon's permission modes as the server's. Plan mode is not a mode there —
 * it is the `/plan` command, prefixed onto the prompt (`withPlanCommand`) — so
 * it asks like `default` for anything the planning turn does reach for.
 */
export function agyMode(mode: PermissionModeId): AgyMode {
  switch (mode) {
    case 'bypassPermissions':
      return 'yolo'
    case 'acceptEdits':
      return 'auto_edit'
    default:
      return 'default'
  }
}

/** Plan mode's spelling: the server's own `/plan` command ahead of the text. */
export function withPlanCommand(text: string, mode: PermissionModeId): string {
  if (mode !== 'plan' || /^\s*\/plan(\s|$)/.test(text)) return text
  return text ? `/plan ${text}` : '/plan'
}

/**
 * The binary to spawn. `providerCli` resolves it like every other provider's
 * — env override, PATH, then known locations, which for this one are Carbon's
 * own managed install and Zed's registry download.
 */
export function antigravityBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  return providerCli('antigravity', env).path
}

/**
 * The link the server prints for a browser sign-in. Python's `webbrowser` is
 * pointed at a no-op (`BROWSER`), so Carbon opens the link itself — which is
 * what lets the Settings row say what is happening instead of a browser tab
 * appearing from nowhere.
 */
export function parseAuthUrl(line: string): string | null {
  const match = /authenticate the ACP server:\s*(https:\/\/\S+)/.exec(line)
  return match ? match[1] : null
}

export function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof AcpRpcError &&
    error.code === AUTH_REQUIRED_CODE &&
    /auth|sign|log(ged)? ?(in|out)/i.test(`${error.message} ${JSON.stringify(error.data ?? '')}`)
  )
}

export class AntigravityAcpClient {
  private rpc: AcpRpc | null = null
  private readonly options: AntigravityClientOptions

  constructor(options: AntigravityClientOptions) {
    this.options = options
  }

  get alive(): boolean {
    return !!this.rpc?.alive
  }

  /** Spawn the server and run the handshake. */
  async start(): Promise<void> {
    const binary = antigravityBinary()
    if (!binary) throw new Error('Antigravity is not installed.')
    const { callbacks } = this.options
    const rpc = new AcpRpc({
      label: 'Antigravity',
      command: binary,
      // The registry's Linux entry passes an empty `--uid=`; without it the
      // server derives a uid that its sandbox helper then rejects.
      args: process.platform === 'linux' ? ['--uid='] : [],
      cwd: this.options.cwd,
      env: {
        ...spawnEnv(),
        // A no-op browser: Carbon opens the sign-in link itself (see
        // `parseAuthUrl`). Windows has no `true`, and there the server opening
        // its own tab is the lesser evil than a sign-in nobody can see.
        ...(process.platform === 'win32' ? {} : { BROWSER: 'true' })
      },
      onNotification: (method, params) => {
        if (method !== 'session/update') return
        const update = (params as { update?: AgyRawUpdate } | null)?.update
        if (update) callbacks.onUpdate(update)
      },
      onRequest: async (method, params) => {
        if (method !== 'session/request_permission') throw new AcpMethodNotFound()
        const optionId = await callbacks.onPermission(params as AgyPermissionRequest)
        return {
          outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
        }
      },
      onStderr: (line) => {
        const url = parseAuthUrl(line)
        if (url) callbacks.onAuthUrl?.(url)
      },
      onExit: (error) => callbacks.onExit(error)
    })
    this.rpc = rpc
    rpc.start()
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'carbon', title: 'Carbon', version: '0.1.0' },
      // Off, as for Grok: turned on, the server routes every read and write
      // through the client, and Carbon edits the same disk the agent does.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    })
  }

  /**
   * Sign in with a Google account. Resolves once the browser flow completes —
   * the server's own deadline is five minutes, after which it answers
   * "Onboarding failed".
   */
  async authenticate(methodId: string = AGY_AUTH_GOOGLE): Promise<void> {
    await this.req('authenticate', { methodId })
  }

  async logout(): Promise<void> {
    await this.req('logout', {})
  }

  async newSession(): Promise<AgySessionSetup> {
    return this.req<AgySessionSetup>('session/new', {
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? []
    })
  }

  /**
   * Reattach to a stored conversation. `session/resume` rather than
   * `session/load`: load replays the whole history as `session/update`s, which
   * Carbon already has on disk and would have to filter back out.
   */
  async resumeSession(sessionId: string): Promise<AgySessionSetup> {
    const setup = await this.req<AgySessionSetup>('session/resume', {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? []
    })
    return { ...setup, sessionId }
  }

  async prompt(sessionId: string, prompt: AgyContentBlock[]): Promise<string> {
    const result = await this.req<{ stopReason?: string } | null>('session/prompt', {
      sessionId,
      prompt
    })
    return String(result?.stopReason ?? 'end_turn')
  }

  /** A notification; the in-flight `prompt` resolves with `cancelled`. */
  cancel(sessionId: string): void {
    this.rpc?.notify('session/cancel', { sessionId })
  }

  async setMode(sessionId: string, mode: AgyMode): Promise<void> {
    await this.req('session/set_config_option', {
      sessionId,
      configId: 'mode',
      value: mode
    })
  }

  /** Rebuilds the server's agent on the new model; the history survives. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.req('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: modelId
    })
  }

  dispose(): void {
    this.rpc?.dispose()
    this.rpc = null
  }

  private req<T>(method: string, params: unknown): Promise<T> {
    if (!this.rpc) return Promise.reject(new Error('Antigravity is not running.'))
    return this.rpc.request<T>(method, params)
  }
}

// ---------- Tool calls ----------

/**
 * The server's tool names → the ones the renderer already groups, icons and
 * summarizes (`Read`, `Edit`, `Bash`). Kept to names read off the 1.2.1
 * source's own tool tables; anything else keeps its wire name.
 */
const AGY_TOOL_NAMES: Record<string, string> = {
  view_file: 'Read',
  read_file: 'Read',
  client_view_file: 'Read',
  view_file_outline: 'Read',
  view_code_item: 'Read',
  write_to_file: 'Write',
  create_file: 'Write',
  write_file: 'Write',
  client_create_file: 'Write',
  edit_file: 'Edit',
  client_edit_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  run_command: 'Bash',
  shell: 'Bash',
  grep_search: 'Grep',
  search_directory: 'Grep',
  find_by_name: 'Glob',
  find_file: 'Glob',
  list_dir: 'ListDir',
  list_directory: 'ListDir',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  start_subagent: 'Agent'
}

/**
 * The wire tool name inside a title. The server announces a call as
 * "Running <name>" and asks about one as "Run <name>?"; a shell call's title is
 * the command itself, which `kind: execute` identifies instead.
 */
export function agyWireToolName(call: Pick<AgyToolCall, 'title' | 'kind'>): string | undefined {
  const title = call.title?.trim()
  if (!title) return undefined
  const match = /^(?:Running|Run)\s+([A-Za-z0-9_.-]+)\??$/.exec(title)
  return match ? match[1] : undefined
}

/**
 * The card's name for a call, or undefined when this payload carries nothing
 * to name it by — a closing update has no title, and must not rename the card
 * it closes.
 */
export function agyToolName(call: AgyToolCall): string | undefined {
  const mcp = call._meta?.mcp
  if (mcp?.tool) {
    const ref = parseCarbonTool(mcp.server ? `${mcp.server}_${mcp.tool}` : mcp.tool)
    if (ref) return carbonToolId(ref)
    return mcp.server ? `mcp__${mcp.server}__${mcp.tool}` : mcp.tool
  }
  if (call.kind === 'execute') return 'Bash'
  const wire = agyWireToolName(call)
  if (wire) return AGY_TOOL_NAMES[wire] ?? wire
  return call.title?.trim() || undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/**
 * The server's argument names (PascalCase from the Go side, snake_case from the
 * Python one) → the ones `toolSummary` and the turn-changes card read
 * (`file_path`, `command`, `content`, `pattern`).
 */
export function agyToolInput(name: string, raw: unknown, call?: AgyToolCall): unknown {
  const input = asRecord(raw)
  if (!input) {
    // A shell call's title *is* the command; a card with no input still has it.
    if (name === 'Bash' && call?.title) return { command: call.title }
    return raw
  }
  const next: Record<string, unknown> = { ...input }
  const path =
    firstString(
      input,
      'file_path',
      'TargetFile',
      'target_file',
      'AbsolutePath',
      'absolute_path',
      'FilePath',
      'path'
    ) ?? call?.locations?.find((loc) => loc?.path)?.path
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      if (path) next.file_path = path
      if (name === 'Write') {
        const content = firstString(input, 'content', 'CodeContent', 'code_content')
        if (content !== undefined) next.content = content
      }
      if (name === 'Edit') {
        const oldText = firstString(input, 'old_string', 'TargetContent', 'target_content')
        const newText = firstString(
          input,
          'new_string',
          'ReplacementContent',
          'replacement_content'
        )
        if (oldText !== undefined) next.old_string = oldText
        if (newText !== undefined) next.new_string = newText
      }
      return next
    case 'Bash': {
      const command =
        firstString(input, 'command', 'CommandLine', 'command_line', 'commandLine') ?? call?.title
      if (command) next.command = command
      const cwd = firstString(input, 'Cwd', 'cwd', 'working_dir', 'WorkingDirectory')
      if (cwd && next.cwd === undefined) next.cwd = cwd
      return next
    }
    case 'Grep': {
      const pattern = firstString(input, 'pattern', 'Query', 'query', 'SearchPattern')
      if (pattern) next.pattern = pattern
      const dir = firstString(
        input,
        'SearchPath',
        'search_path',
        'SearchDirectory',
        'search_directory'
      )
      if (dir && next.path === undefined) next.path = dir
      return next
    }
    case 'Glob': {
      const pattern = firstString(input, 'pattern', 'Pattern', 'name', 'Name')
      if (pattern) next.pattern = pattern
      const dir = firstString(input, 'SearchDirectory', 'search_directory', 'DirectoryPath')
      if (dir && next.path === undefined) next.path = dir
      return next
    }
    case 'ListDir': {
      const dir = firstString(input, 'path', 'DirectoryPath', 'directory_path', 'SearchDirectory')
      if (dir) next.path = dir
      return next
    }
    case 'WebSearch': {
      const query = firstString(input, 'query', 'Query')
      if (query) next.query = query
      return next
    }
    case 'WebFetch': {
      const url = firstString(input, 'url', 'Url', 'URL')
      if (url) next.url = url
      return next
    }
    default:
      return raw
  }
}

/** ACP status → Carbon's three-state tool status. */
export function agyToolStatus(status: string | undefined): ToolPart['status'] {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
    case 'cancelled':
      return 'error'
    default:
      return 'running'
  }
}

/**
 * The text a closed call shows. The server puts results on `rawOutput` — a
 * string for most tools, a `{ combinedOutput, exitCode }` object for a shell
 * call — and only sometimes mirrors it into `content` text blocks.
 */
export function agyToolOutput(call: AgyToolCall): string | undefined {
  const raw = call.rawOutput
  if (typeof raw === 'string' && raw.trim()) return raw
  const record = asRecord(raw)
  if (record) {
    const combined = firstString(record, 'combinedOutput', 'combined_output', 'formatted_output')
    const exit = record.exitCode ?? record.exit_code
    if (combined !== undefined || exit !== undefined) {
      const body = combined ?? ''
      return typeof exit === 'number' && exit !== 0
        ? `${body}${body ? '\n' : ''}Exit code ${exit}`
        : body
    }
  }
  const parts: string[] = []
  for (const block of call.content ?? []) {
    if (block.type === 'content') {
      const text = asRecord(block.content)?.text
      if (typeof text === 'string' && text) parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  if (joined) return joined
  if (record) {
    try {
      return JSON.stringify(record, null, 2)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Image results (`generate_image`, a carbon screenshot). */
export function agyToolImages(
  call: AgyToolCall
): { mediaType: string; data: string }[] | undefined {
  const images: { mediaType: string; data: string }[] = []
  for (const block of call.content ?? []) {
    const inner = block.type === 'content' ? asRecord(block.content) : asRecord(block)
    if (inner?.type === 'image' && typeof inner.data === 'string' && inner.data) {
      images.push({
        mediaType: typeof inner.mimeType === 'string' ? inner.mimeType : 'image/png',
        data: inner.data
      })
    }
  }
  return images.length ? images : undefined
}

// ---------- Questions ----------

/**
 * The server asks its clarifying questions through the permission method, on a
 * synthetic tool call named `interaction_<hex>` whose options are the answers
 * rather than allow/deny. Telling the two apart is what keeps a question from
 * rendering as an Allow/Deny card with the answers as button labels.
 */
export function isAgyQuestion(request: AgyPermissionRequest): boolean {
  return request.toolCall?.toolCallId?.startsWith('interaction_') ?? false
}

export function agyQuestion(request: AgyPermissionRequest): UserQuestion {
  return {
    id: request.toolCall.toolCallId,
    question: request.toolCall.title?.trim() || 'Choose an option.',
    header: 'Question',
    options: request.options.map((option) => ({
      label: option.name?.trim() || option.optionId
    })),
    multiSelect: false,
    // The server takes only one of its own option ids back; free text has
    // nowhere to go.
    allowOther: false
  }
}

/** The option a question card's answer names, by label then by id. */
export function agyAnswerOption(
  request: AgyPermissionRequest,
  answers: Record<string, unknown> | undefined
): string | null {
  const values = Object.values(answers ?? {}).flatMap((value) =>
    Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
  )
  for (const value of values) {
    const option =
      request.options.find((entry) => (entry.name?.trim() || entry.optionId) === value) ??
      request.options.find((entry) => entry.optionId === value)
    if (option) return option.optionId
  }
  return null
}

// ---------- Prompts ----------

/** The image types the server's SDK takes natively. Anything else rides a path. */
const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])

/**
 * Composer attachments as ACP prompt blocks. The server advertises
 * `promptCapabilities.image`, so a pasted screenshot goes as an `image` block —
 * unlike Grok, which needs it materialized to a temp file first.
 */
export function buildAgyPrompt(text: string, attachments: Attachment[] = []): AgyContentBlock[] {
  const blocks: AgyContentBlock[] = []
  const notes: string[] = []
  const files: string[] = []
  for (const attachment of attachments) {
    if (
      (attachment.kind === 'image' || attachment.kind === 'element') &&
      attachment.data &&
      attachment.mediaType &&
      NATIVE_IMAGE_TYPES.has(attachment.mediaType)
    ) {
      blocks.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType
      })
    } else if (attachment.path) {
      files.push(attachment.path)
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name
      })
    }
    if (attachment.kind === 'element' && attachment.element)
      notes.push(describeElement(attachment.element))
    if (attachment.kind === 'selection' && attachment.selection)
      notes.push(describeSelection(attachment.selection))
    if (attachment.kind === 'canvas' && attachment.canvas)
      notes.push(describeCanvas(attachment.canvas))
    if (attachment.kind === 'quote' && attachment.quote) notes.push(describeQuote(attachment.quote))
  }
  let prompt = text
  if (files.length) {
    prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${files.map((path) => `- ${path}`).join('\n')}`
  }
  if (notes.length) prompt = `${prompt ? `${prompt}\n\n` : ''}${notes.join('\n\n')}`
  return [{ type: 'text', text: prompt }, ...blocks]
}

// ---------- Session files ----------

/** `GEMINI_HOME`, as the server resolves it. */
export function geminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_HOME?.trim() || join(env.HOME ?? homedir(), '.gemini')
}

/**
 * Remove a conversation Carbon created only to ask a question of the server —
 * a model probe or a one-shot. Guarded on the sidecar's `cwd` matching the
 * throwaway folder, so nothing the user started can ever match.
 */
export function removeAgyConversation(sessionId: string | undefined, cwd: string): void {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return
  const dir = join(geminiHome(), 'antigravity-acp')
  const base = join(dir, 'conversations', sessionId)
  try {
    if (!existsSync(`${base}.meta`)) return
    const meta = JSON.parse(readFileSync(`${base}.meta`, 'utf8')) as {
      cwd?: string
    }
    if (meta.cwd !== cwd) return
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']) {
      rmSync(`${base}${suffix}`, { force: true })
    }
    rmSync(join(dir, 'brain', sessionId), { recursive: true, force: true })
  } catch {
    // Leftover throwaway history is untidy, not harmful.
  }
}

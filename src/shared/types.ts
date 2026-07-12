export type Provider = 'claude' | 'codex'

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export type EffortId = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_OPTIONS: { id: EffortId | ''; label: string; description: string }[] = [
  { id: 'low', label: 'Low', description: 'Fastest, minimal thinking' },
  { id: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { id: '', label: 'High', description: 'Deep reasoning (default)' },
  { id: 'xhigh', label: 'X-High', description: 'Deeper than high' },
  { id: 'max', label: 'Max', description: 'Maximum effort, select models' }
]

export type ChatStatus = 'idle' | 'starting' | 'streaming' | 'waiting-permission'

export interface ChatMeta {
  id: string
  title: string
  cwd: string
  provider: Provider
  /** Model override; undefined means the user's default model. */
  model?: string
  /** Reasoning effort; undefined means the default (high). */
  effort?: EffortId
  permissionMode: PermissionModeId
  /** Mode the chat was in before switching to plan; restored on plan approval. */
  modeBeforePlan?: PermissionModeId
  /** Provider-side session id, used to resume conversations. */
  sessionId?: string
  /** Tokens currently in the model's context (from the last API call). */
  contextTokens?: number
  /** Context window size of the model in use. */
  contextWindow?: number
  createdAt: number
  updatedAt: number
}

export interface ChatData extends ChatMeta {
  messages: ChatMessage[]
}

// ---------- Messages ----------

export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
}

export interface ToolPart {
  type: 'tool'
  toolUseId: string
  name: string
  input?: unknown
  status: ToolStatus
  output?: string
  /** Image blocks a tool returned (e.g. preview_screenshot) — base64, no prefix. */
  outputImages?: { mediaType: string; data: string }[]
  denied?: boolean
  /** Sub-agent activity for Task/Agent tools: the spawned agent's own stream. */
  children?: AssistantPart[]
}

export type AssistantPart = TextPart | ThinkingPart | ToolPart

/** A UI element picked from a live page in the browser-preview panel. */
export interface ElementRef {
  /** Page URL the element was picked from. */
  url: string
  /** Lowercase tag name, e.g. "button". */
  tag: string
  /** CSS selector locating the element on the page. */
  selector: string
  /** Trimmed visible text, if any. */
  label?: string
  /** Truncated outerHTML of the element. */
  html?: string
  /** Source file:line resolved from the React fiber (dev builds only). */
  source?: { file: string; line?: number; column?: number }
}

export interface Attachment {
  id: string
  kind: 'image' | 'file' | 'element'
  name: string
  /** Images (and element screenshots): IANA media type + raw base64 (no data: prefix). */
  mediaType?: string
  data?: string
  /** Files: absolute path on disk, passed to Claude as a reference to read. */
  path?: string
  /** Elements: the picked element's location, markup, and source mapping. */
  element?: ElementRef
}

export interface UserMessage {
  id: string
  role: 'user'
  text: string
  ts: number
  attachments?: Attachment[]
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  parts: AssistantPart[]
  ts: number
}

export interface TurnStats {
  costUsd: number
  durationMs: number
  numTurns: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

export interface EventMessage {
  id: string
  role: 'event'
  kind: 'error' | 'info' | 'compact' | 'turn'
  text: string
  ts: number
  stats?: TurnStats
}

export type ChatMessage = UserMessage | AssistantMessage | EventMessage

// ---------- Permissions ----------

export interface PermissionRequestPayload {
  id: string
  chatId: string
  toolUseId: string
  toolName: string
  input: unknown
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  /** True when the provider offered "always allow" permission suggestions. */
  hasSuggestions: boolean
}

export type PermissionDecision =
  | { behavior: 'allow'; always?: boolean; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

export interface UserQuestion {
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

// ---------- Events streamed from main to renderer ----------

export type ChatEvent =
  | { type: 'message'; chatId: string; message: ChatMessage }
  | { type: 'part-delta'; chatId: string; messageId: string; partIndex: number; delta: string }
  | { type: 'part'; chatId: string; messageId: string; partIndex: number; part: AssistantPart }
  | { type: 'tool-update'; chatId: string; messageId: string; toolUseId: string; patch: Partial<ToolPart> }
  | { type: 'meta'; chatId: string; patch: Partial<ChatMeta> }
  | { type: 'status'; chatId: string; status: ChatStatus }
  | { type: 'permission-request'; chatId: string; request: PermissionRequestPayload }
  | { type: 'permission-resolved'; chatId: string; requestId: string }
  | { type: 'commands'; chatId: string; cwd: string; commands: SlashCommand[] }

// ---------- Settings ----------

export interface AppDefaults {
  model?: string
  effort?: EffortId
  permissionMode: PermissionModeId
  recentDirs: string[]
}

export interface ModelOption {
  id: string
  label: string
  description?: string
  provider: Provider
  disabled?: boolean
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: '', label: 'Default', description: 'Your Claude Code default', provider: 'claude' },
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent', provider: 'claude' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Powerful all-rounder', provider: 'claude' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Fast and capable', provider: 'claude' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest', provider: 'claude' },
  { id: 'codex:gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Coming soon', provider: 'codex', disabled: true },
  { id: 'codex:gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Coming soon', provider: 'codex', disabled: true }
]

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

export const PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'default', label: 'Ask to approve', description: 'Prompts before sensitive actions' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approves edits in the project' },
  { id: 'plan', label: 'Plan mode', description: 'Read-only, plans before acting' },
  { id: 'auto', label: 'Auto', description: 'A classifier approves safe actions for you' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks — use with care' }
]

// ---------- Files ----------

export interface FileEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
}

export type FileContent =
  | { kind: 'text'; content: string; language?: string; truncated: boolean }
  | { kind: 'image'; dataUri: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string }

// ---------- Git ----------

export interface GitFileChange {
  /** Repo-relative path. */
  path: string
  /** Former path when the change is a rename. */
  origPath?: string
  /** One-letter status: M, A, D, R, C, T, U (conflict) or ? (untracked). */
  status: string
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  hasRemote: boolean
  changes: GitFileChange[]
}

export type GitResult = { ok: true; output?: string } | { ok: false; error: string }

export interface GitDiffTarget {
  path: string
  staged: boolean
  untracked?: boolean
}

// ---------- Terminal ----------

export interface TerminalCreateOpts {
  id: string
  cwd: string
  cols: number
  rows: number
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }

// ---------- Browser preview / dev server ----------

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface PreviewState {
  cwd: string
  status: PreviewStatus
  /** The command being run, e.g. "npm run dev". */
  command?: string
  /** Detected local URL once the dev server prints it. */
  url?: string
  /** Short summary when status is 'error' (spawn failure or early exit). */
  error?: string
}

/** main → renderer dev-server lifecycle updates. */
export type PreviewEvent = { type: 'state'; state: PreviewState }

/** main → renderer request to act on a live preview (agent read-back / navigation). */
export interface PreviewCommand {
  id: string
  cwd: string
  kind: 'screenshot' | 'navigate'
  /** navigate: target URL. screenshot: URL to open one at if none exists yet. */
  url?: string
}

export interface PreviewCommandResult {
  id: string
  ok: boolean
  /** screenshot: base64 PNG, no data: prefix. */
  data?: string
  error?: string
}

// ---------- Slash commands ----------

/** A slash command available in a session (custom command, skill, or built-in). */
export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string
  description: string
  /** Hint for arguments, e.g. "<file>". */
  argumentHint?: string
  aliases?: string[]
}

// ---------- Preload API ----------

export interface Api {
  listChats(): Promise<ChatMeta[]>
  getChat(id: string): Promise<ChatData | null>
  createChat(opts: {
    cwd: string
    provider?: Provider
    model?: string
    effort?: EffortId
    permissionMode?: PermissionModeId
  }): Promise<ChatMeta>
  deleteChat(id: string): Promise<void>
  renameChat(id: string, title: string): Promise<void>
  send(chatId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** Absolute path of a dragged/picked File (empty string for in-memory files). */
  pathForFile(file: File): string
  interrupt(chatId: string): Promise<void>
  respondPermission(chatId: string, requestId: string, decision: PermissionDecision): Promise<void>
  setChatOptions(
    chatId: string,
    patch: { model?: string; effort?: EffortId | ''; permissionMode?: PermissionModeId }
  ): Promise<void>
  pickDirectory(): Promise<string | null>
  listDir(dir: string): Promise<FileEntry[]>
  readFile(path: string): Promise<FileContent>
  statPath(path: string): Promise<'file' | 'dir' | null>
  searchFiles(cwd: string, query: string): Promise<{ rel: string; path: string }[]>
  gitStatus(cwd: string): Promise<GitStatus>
  gitDiff(cwd: string, target: GitDiffTarget): Promise<string>
  gitStage(cwd: string, paths: string[]): Promise<GitResult>
  gitUnstage(cwd: string, paths: string[]): Promise<GitResult>
  gitCommit(cwd: string, message: string): Promise<GitResult>
  gitPush(cwd: string): Promise<GitResult>
  gitInit(cwd: string): Promise<GitResult>
  getDefaults(): Promise<AppDefaults>
  forgetDir(dir: string): Promise<void>
  /** Bring the app window to the foreground (notification clicks). */
  focusWindow(): Promise<void>
  // ---- Terminal ----
  terminalCreate(opts: TerminalCreateOpts): Promise<void>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalKill(id: string): Promise<void>
  /** Slash commands cached for a project folder (empty until a session inits). */
  getCommands(cwd: string): Promise<SlashCommand[]>
  // ---- Browser preview / dev server ----
  /** Detected dev command for a project, or null if none found. */
  previewDetect(cwd: string): Promise<string | null>
  previewState(cwd: string): Promise<PreviewState>
  /** Starts the dev server (auto-detected command unless one is given). */
  previewStart(cwd: string, command?: string): Promise<PreviewState>
  previewStop(cwd: string): Promise<PreviewState>
  /** Buffered dev-server output (ANSI-stripped). */
  previewLogs(cwd: string): Promise<string>
  /** Renderer forwards guest console lines so agent read-back can surface them. */
  previewReportConsole(cwd: string, line: string): void
  /** Renderer's reply to a PreviewCommand (screenshot/navigate). */
  previewCommandResult(result: PreviewCommandResult): void
  onChatEvent(cb: (ev: ChatEvent) => void): () => void
  onNewChat(cb: () => void): () => void
  onTerminalEvent(cb: (ev: TerminalEvent) => void): () => void
  onPreviewEvent(cb: (ev: PreviewEvent) => void): () => void
  onPreviewCommand(cb: (cmd: PreviewCommand) => void): () => void
}

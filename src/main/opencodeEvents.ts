import type { AssistantPart, ToolPart, ToolStatus } from '@shared/types'

/**
 * OpenCode's server events, normalized into Carbon's `AssistantPart` shape.
 *
 * Pure and dependency-free so `node --test` can drive it against the recorded
 * event stream from a real turn. Everything protocol-shaped lives here or in
 * `opencodeServer.ts`; the session itself only routes.
 */

// ---- wire shapes (only the fields we read) ----

export interface OpencodeToolState {
  status?: string
  input?: unknown
  output?: string
  error?: string
  title?: string
  metadata?: Record<string, unknown>
}

export interface OpencodePart {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  state?: OpencodeToolState
  /** step-finish only. */
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  cost?: number
}

export interface OpencodePermissionAsked {
  id?: string
  sessionID?: string
  permission?: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  always?: string[]
  tool?: { messageID?: string; callID?: string }
}

/**
 * OpenCode's tool names, in Claude's spelling.
 *
 * Re-badged rather than passed through so the transcript's existing cards do the
 * work — `ToolCard`, `GROUPABLE_TOOLS` and `FILE_MUTATION_TOOLS` all key off
 * Claude's names, and a lowercase `write` would render as an anonymous tool and
 * break the read/search run-collapsing. Codex does exactly this for the same
 * reason. Unknown tools (a plugin's, an MCP server's) pass through unchanged.
 */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  multiedit: 'MultiEdit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Read',
  todowrite: 'TodoWrite',
  todoread: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  agent: 'Agent'
}

export function toolName(raw: string | undefined): string {
  if (!raw) return 'Tool'
  return TOOL_NAMES[raw.toLowerCase()] ?? raw
}

export function toolStatus(raw: string | undefined): ToolStatus {
  switch (raw) {
    case 'completed':
      return 'success'
    case 'error':
      return 'error'
    case 'running':
      return 'running'
    default:
      return 'pending'
  }
}

/**
 * A part as Carbon renders it, or null for parts with no transcript form.
 *
 * `step-start`/`step-finish`/`patch`/`snapshot` are bookkeeping — the first two
 * bracket a model call, the others record a workspace hash. Rendering them would
 * put an empty card between every tool call.
 */
export function partToAssistantPart(part: OpencodePart): AssistantPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text ?? '' }
    case 'reasoning':
      return { type: 'thinking', text: part.text ?? '' }
    case 'tool': {
      const state = part.state ?? {}
      const tool: ToolPart = {
        type: 'tool',
        // The *part* id, not callID: it is what every later update to this tool
        // carries, and Carbon matches updates by toolUseId.
        toolUseId: part.id ?? part.callID ?? '',
        name: toolName(part.tool),
        input: state.input,
        status: toolStatus(state.status)
      }
      const output = state.status === 'error' ? state.error : state.output
      if (output) tool.output = output
      return tool
    }
    default:
      return null
  }
}

/** True for the parts that carry no transcript form (see above). */
export function isRenderablePart(part: OpencodePart): boolean {
  return part.type === 'text' || part.type === 'reasoning' || part.type === 'tool'
}

// ---- usage ----

export interface TurnUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export function emptyUsage(): TurnUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
}

/**
 * Fold a `step-finish` part into the turn's running total.
 *
 * Summed per step rather than read once at the end: a turn that calls tools runs
 * several model steps and each reports its own usage, so taking only the last
 * would undercount everything before the final message.
 */
export function addStepUsage(total: TurnUsage, part: OpencodePart): TurnUsage {
  if (part.type !== 'step-finish') return total
  const t = part.tokens
  return {
    input: total.input + (t?.input ?? 0),
    output: total.output + (t?.output ?? 0),
    reasoning: total.reasoning + (t?.reasoning ?? 0),
    cacheRead: total.cacheRead + (t?.cache?.read ?? 0),
    cacheWrite: total.cacheWrite + (t?.cache?.write ?? 0),
    costUsd: total.costUsd + (part.cost ?? 0)
  }
}

// ---- todos ----

export interface OpencodeTodo {
  id?: string
  content?: string
  status?: string
}

/**
 * The checklist as the card Carbon already has.
 *
 * OpenCode sends the whole list on every change, which is Codex's `TodoWrite`
 * shape rather than Claude Code's incremental `TaskCreate`/`TaskUpdate` — so it
 * needs no fold at all, just the same synthetic tool part Codex synthesizes.
 */
export function todosToToolPart(todos: OpencodeTodo[], toolUseId: string): ToolPart {
  return {
    type: 'tool',
    toolUseId,
    name: 'TodoWrite',
    input: {
      todos: todos.map((todo) => ({
        content: todo.content ?? '',
        status: todo.status === 'in_progress' ? 'in_progress' : todo.status === 'completed' ? 'completed' : 'pending'
      }))
    },
    status: 'success'
  }
}

// ---- permissions ----

/**
 * The tool name to show on a permission card.
 *
 * A permission names a *capability* ('edit'), not the tool that tripped it, so
 * it is mapped through the same table — an "edit" request then draws the same
 * card an Edit tool call draws, with the diff OpenCode helpfully includes.
 */
export function permissionToolName(permission: string | undefined): string {
  return toolName(permission)
}

/** The unified diff OpenCode attaches to an edit permission, when there is one. */
export function permissionDiff(request: OpencodePermissionAsked): string | undefined {
  const diff = request.metadata?.diff
  return typeof diff === 'string' && diff.trim() ? diff : undefined
}

/**
 * Whether a permission request is one the *user* should see.
 *
 * A ruleset already answered everything it could at session-creation time, so a
 * request arriving here is by definition one OpenCode decided to ask about —
 * except under a silent mode, where the session answers it without drawing a card.
 */
export function permissionRequestId(request: OpencodePermissionAsked): string | null {
  return request.id ?? null
}

// ---- plan ----

/**
 * The plan text from a finished plan-mode turn: the last non-empty text part.
 *
 * Deliberately not "all text concatenated" — a plan turn often narrates before
 * it plans, and the review panel should show the plan, not the preamble.
 */
export function extractPlan(parts: AssistantPart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === 'text' && part.text.trim()) return part.text.trim()
  }
  return ''
}

import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// The watcher exists only to surface sub-agent activity; a plain turn has none.
// 1.5s (up from 500ms) cuts the per-turn tail+parse ticks ~3x while still
// surfacing sub-agent text/tools promptly once they start.
const POLL_MS = 1_500
const FILE_SCAN_MS = 1_000
const INITIAL_TAIL_BYTES = 1024 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const OUTPUT_CAP = 100_000

export type CodexAgentStatus =
  | 'pending_init'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'not_found'

export interface CodexCollabToolCallItem {
  id: string
  type: 'collab_tool_call'
  tool: 'spawn_agent' | 'send_input' | 'wait' | 'close_agent'
  sender_thread_id: string
  receiver_thread_ids: string[]
  prompt: string | null
  agents_states: Record<string, { status: CodexAgentStatus; message?: string | null }>
  status: 'in_progress' | 'completed' | 'failed'
}

export function isCodexCollabToolCallItem(value: unknown): value is CodexCollabToolCallItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item.type === 'collab_tool_call' && typeof item.id === 'string'
}

export type CodexRolloutEvent =
  | {
      type: 'agent-start'
      threadId: string
      callId: string
      name: string
    }
  | { type: 'agent-text'; threadId: string; text: string }
  | {
      type: 'agent-tool-start'
      threadId: string
      toolUseId: string
      name: string
      input: unknown
    }
  | {
      type: 'agent-tool-complete'
      threadId: string
      toolUseId: string
      output?: string
      failed: boolean
    }
  | {
      type: 'agent-complete'
      threadId: string
      result?: string
      failed: boolean
    }

export interface CodexRolloutWatcher {
  start(parentThreadId: string, sinceMs: number): void
  pollNow(): void
  flush(): Promise<void>
  stop(): void
}

export type CodexRolloutWatcherFactory = (
  onEvent: (event: CodexRolloutEvent) => void
) => CodexRolloutWatcher

interface RolloutRecord {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

interface TailState {
  path: string
  offset: number
  remainder: string
  skipPartialFirstLine: boolean
  decoder: StringDecoder
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringsFromContent(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((block) => {
    const item = object(block)
    if (!item) return []
    const text = string(item.text)
    return text ? [text] : []
  })
}

function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  const text = stringsFromContent(value).join('')
  return text || undefined
}

function commandFromExecInput(input: string): string | undefined {
  // Codex rollout custom_tool_call records contain the JavaScript orchestration
  // passed to functions.exec. Pull the first exec_command `cmd` JSON string out
  // without evaluating that code.
  const match = input.match(/"cmd"\s*:\s*("(?:\\.|[^"\\])*")/s)
  if (!match) return undefined
  try {
    const command = JSON.parse(match[1])
    return typeof command === 'string' ? command : undefined
  } catch {
    return undefined
  }
}

function childTool(payload: Record<string, unknown>): { name: string; input: unknown } {
  const rawName = string(payload.name) ?? 'Tool'
  const rawInput = string(payload.input)
  if (rawName === 'exec' && rawInput) {
    const command = commandFromExecInput(rawInput)
    if (command) return { name: 'Bash', input: { command } }
    return { name: 'Tool', input: { description: 'Agent action' } }
  }
  return { name: rawName, input: rawInput ? { input: rawInput } : undefined }
}

function failedOutput(text: string | undefined): boolean {
  if (!text) return false
  return /(?:script|command) failed|process exited with code [1-9]|\[exit [1-9]/i.test(text)
}

function friendlyAgentName(path: string): string {
  const leaf = path.split('/').filter(Boolean).at(-1) ?? 'Codex agent'
  return leaf.replace(/[_-]+/g, ' ')
}

/**
 * Cheap pre-filter for parent-rollout lines. The parent transcript is the main
 * agent's own stream and grows fast, yet the only parent records that yield an
 * event (see `parseCodexRolloutRecord`, `kind: 'parent'`) are `sub_agent_activity`
 * event messages and child `FINAL_ANSWER` messages. Skipping the JSON.parse for
 * every other line avoids parsing the whole main-agent transcript on each poll of
 * an ordinary no-sub-agent turn. Child tails are never filtered — every child
 * record type is meaningful there.
 */
function parentLineMayMatter(line: string): boolean {
  return line.includes('sub_agent_activity') || line.includes('FINAL_ANSWER')
}

/** Parse one parent/child rollout record into stable, UI-oriented events. */
export function parseCodexRolloutRecord(
  record: RolloutRecord,
  source: { kind: 'parent' } | { kind: 'child'; threadId: string }
): CodexRolloutEvent[] {
  const payload = record.payload
  if (!payload) return []

  if (source.kind === 'parent') {
    if (record.type === 'event_msg' && payload.type === 'sub_agent_activity') {
      const threadId = string(payload.agent_thread_id)
      const callId = string(payload.event_id)
      const kind = string(payload.kind)
      if (threadId && callId && kind === 'started') {
        return [
          {
            type: 'agent-start',
            threadId,
            callId,
            name: friendlyAgentName(string(payload.agent_path) ?? threadId)
          }
        ]
      }
      if (threadId && kind && ['completed', 'errored', 'interrupted', 'shutdown'].includes(kind)) {
        return [
          {
            type: 'agent-complete',
            threadId,
            failed: kind !== 'completed' && kind !== 'shutdown'
          }
        ]
      }
    }

    // Child final answers are also recorded in the parent transcript. This is a
    // useful completion fallback if the child rollout file cannot be located.
    if (record.type === 'response_item' && payload.type === 'agent_message') {
      const author = string(payload.author)
      const text = stringsFromContent(payload.content).join('\n')
      if (author?.startsWith('/root/') && text.includes('Message Type: FINAL_ANSWER')) {
        const threadId = string(payload.thread_id)
        if (threadId) {
          return [{ type: 'agent-complete', threadId, result: text, failed: false }]
        }
      }
    }
    return []
  }

  const threadId = source.threadId
  if (record.type === 'event_msg' && payload.type === 'agent_message') {
    const text = string(payload.message)
    return text ? [{ type: 'agent-text', threadId, text }] : []
  }

  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    return [
      {
        type: 'agent-complete',
        threadId,
        result: string(payload.last_agent_message),
        failed: false
      }
    ]
  }

  if (record.type === 'event_msg' && payload.type === 'task_failed') {
    return [
      {
        type: 'agent-complete',
        threadId,
        result: string(payload.message),
        failed: true
      }
    ]
  }

  if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
    return [
      {
        type: 'agent-complete',
        threadId,
        result: 'This agent was interrupted before it could finish.',
        failed: true
      }
    ]
  }

  if (record.type === 'response_item' && payload.type === 'custom_tool_call') {
    const toolUseId = string(payload.call_id)
    if (!toolUseId) return []
    const tool = childTool(payload)
    return [
      {
        type: 'agent-tool-start',
        threadId,
        toolUseId,
        name: tool.name,
        input: tool.input
      }
    ]
  }

  if (record.type === 'response_item' && payload.type === 'custom_tool_call_output') {
    const toolUseId = string(payload.call_id)
    if (!toolUseId) return []
    const output = outputText(payload.output)?.slice(0, OUTPUT_CAP)
    return [
      {
        type: 'agent-tool-complete',
        threadId,
        toolUseId,
        output,
        failed: failedOutput(output)
      }
    ]
  }

  return []
}

async function findRolloutFiles(root: string, threadIds: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || found.size === threadIds.size) return
    let entries
    try {
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        b.name.localeCompare(a.name)
      )
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        for (const threadId of threadIds) {
          if (!found.has(threadId) && entry.name.endsWith(`${threadId}.jsonl`)) {
            found.set(threadId, path)
          }
        }
      } else if (entry.isDirectory()) {
        await visit(path, depth + 1)
      }
      if (found.size === threadIds.size) return
    }
  }
  await visit(root, 0)
  return found
}

async function tailState(path: string, fromStart: boolean): Promise<TailState> {
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    // The next poll will retry once the file is readable.
  }
  const offset = fromStart ? 0 : Math.max(0, size - INITIAL_TAIL_BYTES)
  return {
    path,
    offset,
    remainder: '',
    skipPartialFirstLine: offset > 0,
    decoder: new StringDecoder('utf8')
  }
}

async function readAppended(state: TailState): Promise<string[]> {
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    file = await open(state.path, 'r')
    const size = (await file.stat()).size
    if (size < state.offset) {
      state.offset = 0
      state.remainder = ''
      state.skipPartialFirstLine = false
      state.decoder = new StringDecoder('utf8')
    }
    const count = Math.min(size - state.offset, MAX_READ_BYTES)
    if (count <= 0) return []
    const buffer = Buffer.allocUnsafe(count)
    const { bytesRead } = await file.read(buffer, 0, count, state.offset)
    state.offset += bytesRead
    let text = state.remainder + state.decoder.write(buffer.subarray(0, bytesRead))
    if (state.skipPartialFirstLine) {
      const newline = text.indexOf('\n')
      if (newline < 0) return []
      text = text.slice(newline + 1)
      state.skipPartialFirstLine = false
    }
    const lines = text.split('\n')
    state.remainder = lines.pop() ?? ''
    return lines.filter(Boolean)
  } catch {
    return []
  } finally {
    await file?.close().catch(() => undefined)
  }
}

class RolloutWatcher implements CodexRolloutWatcher {
  private readonly sessionsRoot: string
  private readonly onEvent: (event: CodexRolloutEvent) => void
  private parentThreadId: string | null = null
  private parent: TailState | null = null
  private readonly children = new Map<string, TailState | null>()
  private sinceMs = 0
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private lastFileScan = 0

  constructor(
    onEvent: (event: CodexRolloutEvent) => void,
    codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  ) {
    this.onEvent = onEvent
    this.sessionsRoot = join(codexHome, 'sessions')
  }

  start(parentThreadId: string, sinceMs: number): void {
    if (this.parentThreadId !== parentThreadId) {
      this.parentThreadId = parentThreadId
      this.parent = null
      this.children.clear()
    }
    this.sinceMs = sinceMs
    this.pollNow()
    if (!this.timer) this.timer = setInterval(() => this.pollNow(), POLL_MS)
  }

  pollNow(): void {
    if (this.inFlight) return
    const run = this.poll(false).catch(() => {
      // Rollout introspection is a best-effort compatibility bridge. Never let
      // a partially-written/moved transcript affect the actual Codex turn.
    })
    this.inFlight = run
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
  }

  async flush(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
    await this.poll(true).catch(() => undefined)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.parentThreadId = null
    this.parent = null
    this.children.clear()
    this.lastFileScan = 0
  }

  private async poll(forceFileScan: boolean): Promise<void> {
    const parentThreadId = this.parentThreadId
    if (!parentThreadId) return

    const missing = new Set<string>()
    if (!this.parent) missing.add(parentThreadId)
    for (const [threadId, tail] of this.children) if (!tail) missing.add(threadId)
    if (
      missing.size > 0 &&
      (forceFileScan || Date.now() - this.lastFileScan >= FILE_SCAN_MS)
    ) {
      this.lastFileScan = Date.now()
      const paths = await findRolloutFiles(this.sessionsRoot, missing)
      if (this.parentThreadId !== parentThreadId) return
      const parentPath = paths.get(parentThreadId)
      if (!this.parent && parentPath) this.parent = await tailState(parentPath, false)
      for (const [threadId, path] of paths) {
        if (threadId !== parentThreadId && this.children.get(threadId) === null) {
          this.children.set(threadId, await tailState(path, true))
        }
      }
    }

    if (this.parent) {
      for (const line of await readAppended(this.parent)) {
        if (this.parentThreadId !== parentThreadId) return
        // Advance the tail past every appended line, but only parse the few that
        // can carry a sub-agent event — not the whole main-agent transcript.
        if (!parentLineMayMatter(line)) continue
        this.handleLine(line, { kind: 'parent' })
      }
    }

    for (const [threadId, tail] of this.children) {
      if (!tail) continue
      for (const line of await readAppended(tail)) {
        if (this.parentThreadId !== parentThreadId) return
        this.handleLine(line, { kind: 'child', threadId })
      }
    }
  }

  private handleLine(
    line: string,
    source: { kind: 'parent' } | { kind: 'child'; threadId: string }
  ): void {
    let record: RolloutRecord
    try {
      record = JSON.parse(line) as RolloutRecord
    } catch {
      return
    }
    const timestamp = record.timestamp ? Date.parse(record.timestamp) : NaN
    if (Number.isFinite(timestamp) && timestamp < this.sinceMs - 2_000) return
    const events = parseCodexRolloutRecord(record, source)
    for (const event of events) {
      if (event.type === 'agent-start' && !this.children.has(event.threadId)) {
        this.children.set(event.threadId, null)
      }
      this.onEvent(event)
    }
  }
}

export const createCodexRolloutWatcher: CodexRolloutWatcherFactory = (onEvent) =>
  new RolloutWatcher(onEvent)

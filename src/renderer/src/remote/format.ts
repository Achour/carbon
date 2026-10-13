import type { ChatMeta, ChatStatus, ToolPart } from '@shared/types'
import { projectRoot } from '@shared/types'
import { humanizeShellCommand } from '@/lib/toolLabels'

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

export function projectName(chat: Pick<ChatMeta, 'cwd' | 'worktree'>): string {
  return baseName(projectRoot(chat))
}

export function chatTitle(chat: Pick<ChatMeta, 'title'>): string {
  return chat.title.trim() || 'New chat'
}

/** The rows a phone lists: no side chats, no archive, no terminal chats. */
export function listedChats(chats: ChatMeta[]): ChatMeta[] {
  return chats
    .filter((c) => !c.ephemeral && !c.sideOf && !c.archivedAt && c.surface !== 'terminal')
    // The desktop sidebar's order: `sortKey`, which only a drag moves.
    .sort((a, b) => (b.sortKey ?? b.updatedAt) - (a.sortKey ?? a.updatedAt))
}

export function isBusy(status: ChatStatus | undefined): boolean {
  return !!status && status !== 'idle'
}

export function ago(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function duration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return m < 60 ? `${m}m ${secs % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ')
  return undefined
}

/**
 * Labels in the desktop's vocabulary (`lib/toolSummary.ts` counts these), so a
 * run of rows summarizes the same way on both screens.
 */
const FRIENDLY: Record<string, string> = {
  Bash: 'Terminal',
  BashOutput: 'Terminal',
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Write: 'Write',
  Grep: 'Search',
  Glob: 'Find files',
  LS: 'List',
  WebFetch: 'Fetch',
  WebSearch: 'Web search',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'Tasks',
  TaskCreate: 'Tasks',
  TaskUpdate: 'Tasks',
  ExitPlanMode: 'Plan',
  AskUserQuestion: 'Question',
  ToolSearch: 'Find tools',
  Skill: 'Skill'
}

function mcpLabel(server: string, tool: string): string {
  if (server === 'carbon') {
    if (tool.startsWith('canvas_')) return 'Canvas'
    if (tool.startsWith('preview_')) return 'Preview'
    if (tool === 'chart_render') return 'Chart'
    if (tool === 'diagram_render') return 'Diagram'
    if (tool.startsWith('agents_')) return 'Delegation'
  }
  if (server === 'claude-in-chrome') return 'Browser'
  return tool.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * One line for a tool row: what it is and what it touched. The desktop's
 * `ToolCard` knows every provider's dialect; a phone row only has to be
 * recognisable, so this reads the common input keys and stops there.
 */
export function toolLine(
  part: Pick<ToolPart, 'name' | 'input'>,
  cwd = ''
): { label: string; detail?: string } {
  const input = (part.input ?? {}) as Record<string, unknown>
  if (part.name.startsWith('mcp__')) {
    const [, server = '', ...rest] = part.name.split('__')
    const tool = rest.join('__')
    return {
      label: mcpLabel(server, tool),
      detail: str(input.title) ?? str(input.url) ?? str(input.selector) ?? str(input.text)
    }
  }
  const command = str(input.command) ?? str(input.cmd)
  if (command && (part.name === 'Bash' || part.name === 'BashOutput')) {
    const h = humanizeShellCommand(command, cwd)
    return { label: h.label, detail: h.summary }
  }
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
  const detail =
    command ??
    (path ? baseName(path) : undefined) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url) ??
    str(input.description) ??
    str(input.subject) ??
    str(input.title)
  return { label: FRIENDLY[part.name] ?? part.name, detail }
}

import type { ChatMeta, ChatStatus, ToolPart } from '@shared/types'
import { projectRoot } from '@shared/types'

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
    .sort((a, b) => {
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1
      if (a.pinnedAt && b.pinnedAt) return a.pinnedAt - b.pinnedAt
      return b.updatedAt - a.updatedAt
    })
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

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ')
  return undefined
}

const FRIENDLY: Record<string, string> = {
  Bash: 'Terminal',
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Write',
  Grep: 'Search',
  Glob: 'Find files',
  WebFetch: 'Fetch',
  WebSearch: 'Web search',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'Tasks',
  ExitPlanMode: 'Plan',
  AskUserQuestion: 'Question'
}

/**
 * One line for a tool row: what it is and what it touched. The desktop's
 * `ToolCard` knows every provider's dialect; a phone row only has to be
 * recognisable, so this reads the common input keys and stops there.
 */
export function toolLine(part: Pick<ToolPart, 'name' | 'input'>): { label: string; detail?: string } {
  const name = part.name.startsWith('mcp__')
    ? part.name.split('__').slice(2).join('__') || part.name
    : part.name
  const input = (part.input ?? {}) as Record<string, unknown>
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
  const detail =
    str(input.command) ??
    str(input.cmd) ??
    (path ? baseName(path) : undefined) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url) ??
    str(input.description) ??
    str(input.title)
  return { label: FRIENDLY[name] ?? name, detail }
}

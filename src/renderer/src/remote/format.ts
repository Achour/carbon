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

/**
 * A chat another chat's agent delegated to, still in play. The list leaves
 * delegates out (they are side chats, reached from their parent), but one
 * waiting on an approval, or still working, has to be seen somewhere.
 */
export function isLiveDelegate(chat: ChatMeta): boolean {
  return !!chat.delegation && !chat.delegation.dismissedAt && !chat.archivedAt && !!chat.sideOf
}

/**
 * The sidebar's sections, shared by the page's sidebar and the iOS app's
 * (`native.ts`): "Needs you" first, then pins, then the rest — flat in the
 * user's order, and grouped by project with the most recently active first.
 */
export function sidebarSections(
  chats: ChatMeta[],
  permissions: Record<string, unknown[] | undefined>,
  query: string,
  filterProject: string | null
): {
  waiting: ChatMeta[]
  pinned: ChatMeta[]
  groups: [string, { chats: ChatMeta[]; latest: number }][]
  flat: ChatMeta[]
} {
  const q = query.trim().toLowerCase()
  const all = listedChats(chats).filter((c) => !q || `${c.title} ${baseName(projectRoot(c))}`.toLowerCase().includes(q))
  const asking = (c: ChatMeta): boolean => (permissions[c.id]?.length ?? 0) > 0
  // "Needs you" ignores the filter: a question waiting in another project
  // is usually why the phone was picked up, and a filter must not hide it.
  // A delegate's question counts too, though the delegate itself is not listed.
  const waiting = [...all, ...chats.filter(isLiveDelegate)].filter(asking)
  const scoped = filterProject ? all.filter((c) => projectRoot(c) === filterProject) : all
  const pinned = scoped.filter((c) => !asking(c) && c.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!)
  const flat = scoped.filter((c) => !asking(c) && !c.pinnedAt)
  const byProject = new Map<string, { chats: ChatMeta[]; latest: number }>()
  for (const c of flat) {
    const root = projectRoot(c)
    const g = byProject.get(root) ?? { chats: [], latest: 0 }
    g.chats.push(c)
    g.latest = Math.max(g.latest, c.updatedAt)
    byProject.set(root, g)
  }
  const groups = [...byProject.entries()].sort((a, b) => b[1].latest - a[1].latest)
  return { waiting, pinned, groups, flat }
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

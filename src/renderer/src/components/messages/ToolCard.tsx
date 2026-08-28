import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  Compass,
  ExternalLink,
  FilePenLine,
  FileText,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  PackageSearch,
  Search,
  Shapes,
  ShieldX,
  Sparkles,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { AssistantPart, ToolPart } from '@shared/types'
import {
  formatAgentDuration,
  formatAgentTokens,
  isAgentPart,
  summarizeAgentParts
} from '@shared/agentRuns'
import { cn } from '@/lib/utils'
import { humanizeShellCommand } from '@/lib/toolLabels'
import { Markdown } from '@/components/Markdown'
import { useApp } from '@/store'
import { useAgents } from '@/agentsStore'

interface ToolMeta {
  icon: React.ComponentType<{ className?: string }>
  label: string
  summary?: string
  /**
   * How the summary opens, when it names something openable. One descriptor
   * rather than a field per destination: the destinations are mutually
   * exclusive by construction, which parallel optional strings could only
   * express by convention.
   */
  open?: { kind: 'file' | 'preview'; target: string }
  /** A published page, opened in the system browser rather than in the app. */
  external?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function toolMeta(part: ToolPart, cwd: string): ToolMeta {
  const input = (part.input ?? {}) as Record<string, unknown>
  const rel = (p?: string): string | undefined =>
    p?.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p
  // The SDKs report absolute paths, but don't rely on it — a relative one still opens.
  const abs = (p?: string): string | undefined =>
    p === undefined ? undefined : p.startsWith('/') ? p : `${cwd}/${p.replace(/^\.\//, '')}`
  /** A tool acting on one file: relative path for display, absolute one to open. */
  const file = (icon: ToolMeta['icon'], label: string, p: string | undefined): ToolMeta => {
    const target = abs(p)
    return { icon, label, summary: rel(p), open: target ? { kind: 'file', target } : undefined }
  }

  switch (part.name) {
    case 'Bash':
      if (str(input.command)) {
        const human = humanizeShellCommand(String(input.command), cwd)
        return { icon: SquareTerminal, ...human }
      }
      return { icon: SquareTerminal, label: 'Terminal', summary: str(input.description) }
    case 'BashOutput':
      return { icon: SquareTerminal, label: 'Terminal output' }
    case 'Read':
      return file(FileText, 'Read', str(input.file_path))
    case 'Write':
      return file(FilePenLine, 'Write', str(input.file_path))
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file(FilePenLine, 'Edit', str(input.file_path) ?? str(input.notebook_path))
    case 'Grep':
      return { icon: Search, label: 'Grep', summary: str(input.pattern) }
    case 'Glob':
      return { icon: Search, label: 'Glob', summary: str(input.pattern) }
    case 'ListDir':
      return file(Search, 'List', str(input.path) ?? str(input.target_directory) ?? str(input.directory))
    case 'Task':
    case 'Agent':
      return { icon: Bot, label: 'Agent', summary: str(input.description) }
    case 'WebFetch':
      return { icon: Globe, label: 'Fetch', summary: str(input.url) }
    case 'WebSearch':
      return { icon: Globe, label: 'Search', summary: str(input.query) }
    case 'TodoWrite':
      return { icon: ListChecks, label: 'Todos', summary: 'Update task list' }
    // Only reached when the fold produced no list for the call — it failed, or
    // it moved a task created before the loaded window. The checklist card
    // (see Parts.tsx) handles every other case.
    case 'TaskCreate':
      return { icon: ListChecks, label: 'Tasks', summary: str(input.subject) ?? 'Add a task' }
    case 'TaskUpdate':
      return { icon: ListChecks, label: 'Tasks', summary: 'Update a task' }
    case 'TaskList':
      return { icon: ListChecks, label: 'Tasks', summary: 'List tasks' }
    case 'ExitPlanMode':
      return { icon: ClipboardList, label: 'Plan', summary: 'Present plan for approval' }
    case 'AskUserQuestion':
      return { icon: MessageCircleQuestion, label: 'Question' }
    // Claude Code defers most of its catalog now — the checklist tools included —
    // so a run that plans anything opens with one of these. Naming the query is
    // what makes it read as a step rather than an unexplained wrench.
    case 'ToolSearch':
      return { icon: PackageSearch, label: 'Find tools', summary: str(input.query) }
    // A server-side tool: the model consulting a stronger one. It has no input
    // at all, so the default branch gave it a bare "advisor" and no summary —
    // a card that says a consult happened and nothing about it. The *outcome*
    // is the only thing this call has to say, so it goes on the collapsed row
    // rather than one expand away: whether the advice landed, whether the turn
    // ended before it did, or why it was unavailable. Read from the output
    // verbatim, so main owns the wording and the two can't drift.
    case 'advisor':
      return {
        icon: Sparkles,
        label: 'Advisor',
        // The label already says Advisor; the outcome sentences are written to
        // stand alone because they are also the expanded body, so the row drops
        // the repeated subject rather than the two being worded separately and
        // drifting.
        summary: str(part.output)?.replace(/^Advisor\s+/, '') ?? 'Consulting a stronger model…'
      }
    case 'Skill':
      return { icon: Sparkles, label: 'Skill', summary: str(input.skill) ?? str(input.name) }
    case 'Workflow':
      return { icon: Layers, label: 'Workflow', summary: str(input.name) ?? str(input.description) }
    case 'ListAgents':
      return { icon: Bot, label: 'Agents', summary: 'List available agents' }
    case 'SendMessage':
      return { icon: Bot, label: 'Message', summary: str(input.to) }
    case 'Monitor':
      return { icon: Compass, label: 'Monitor', summary: str(input.description) ?? str(input.command) }
    // The background-agent family, which is not the checklist: keyed by a
    // snake_case `task_id` hash rather than the checklist's numeric `taskId`.
    case 'TaskOutput':
      return { icon: Bot, label: 'Agent output', summary: str(input.task_id) }
    case 'TaskStop':
      return { icon: Bot, label: 'Stop agent', summary: str(input.task_id) }
    case 'TaskGet':
      return { icon: ListChecks, label: 'Tasks', summary: 'Read a task' }
    // One tool, six actions that read nothing alike: `publish` names the page
    // being published, the asset ops name the store they act on. An omitted
    // action means publish, so the fallthrough is the default rather than a
    // guess. `/design` drives this tool — an artboard is a published artifact
    // whose media and fonts ride in its asset store.
    case 'Artifact':
      switch (str(input.action) ?? 'publish') {
        case 'list':
          return { icon: Shapes, label: 'Artifacts', summary: 'List published artifacts' }
        case 'upload_asset':
          return file(Shapes, 'Artifact asset', str(input.file_path))
        case 'list_assets':
          return { icon: Shapes, label: 'Artifact assets', summary: str(input.url) }
        case 'read_asset':
          return { icon: Shapes, label: 'Artifact asset', summary: str(input.asset_id) }
        case 'delete_asset':
          return {
            icon: Shapes,
            label: 'Artifact asset',
            summary: `Delete ${str(input.asset_id) ?? 'asset'}`
          }
        default: {
          const src = str(input.file_path)
          const target = abs(src)
          return {
            icon: Shapes,
            label: 'Artifact',
            summary: str(input.title) ?? rel(src),
            // The page *is* the artifact, so an artboard renders rather than
            // opening its source. Markdown artifacts have no rendered form
            // here and stay ordinary files.
            open: target
              ? { kind: /\.html?$/i.test(src ?? '') ? 'preview' : 'file', target }
              : undefined,
            // Scraped from the result rather than read from a typed field: the
            // publish output's shape has not been checked against a real run,
            // so a URL that isn't there simply yields no button. Confined to
            // `publish` — a `list` result enumerates several, and an error may
            // merely mention one.
            external: /https:\/\/claude\.ai\/[^\s"'<>)]+/.exec(part.output ?? '')?.[0]
          }
        }
      }
    case 'mcp__preview__status':
      return { icon: Globe, label: 'Preview', summary: 'Status' }
    case 'mcp__preview__start':
      return { icon: Globe, label: 'Preview', summary: 'Start dev server' }
    case 'mcp__preview__stop':
      return { icon: Globe, label: 'Preview', summary: 'Stop dev server' }
    case 'mcp__preview__navigate':
      return { icon: Globe, label: 'Preview', summary: str(input.url) }
    case 'mcp__preview__screenshot':
      return { icon: Globe, label: 'Preview', summary: 'Screenshot' }
    case 'mcp__preview__console':
      return { icon: Globe, label: 'Preview', summary: 'Console' }
    default: {
      const firstString = Object.values(input).find((v) => typeof v === 'string') as
        | string
        | undefined
      return { icon: Wrench, label: part.name.replace(/^mcp__/, ''), summary: firstString }
    }
  }
}

/**
 * A clickable affordance inside the collapsible's trigger. Every handler stops
 * propagation — activating it acts, clicking anywhere else on the row still
 * expands the details. A `span[role=button]` rather than a `<button>`: nesting
 * one button in another is invalid HTML.
 */
function RowAction({
  title,
  ariaLabel,
  className,
  onActivate,
  children
}: {
  title: string
  ariaLabel?: string
  className?: string
  onActivate: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const act = (e: React.SyntheticEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    onActivate()
  }
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      aria-label={ariaLabel}
      className={className}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        act(e)
      }}
    >
      {children}
    </span>
  )
}

/**
 * `file://` rather than the published URL for an artboard: the page exists on
 * disk before it is published, needs no login, and `claude.ai` sends
 * `frame-ancestors 'self'` so the hosted copy cannot be embedded anyway.
 */
function openTarget(open: NonNullable<ToolMeta['open']>, cwd: string): void {
  if (open.kind === 'preview') {
    useApp.getState().openPreview(`file://${open.target}`, cwd || undefined)
  } else {
    void useApp.getState().openFile(open.target, { preview: true })
  }
}

function StatusIcon({ part }: { part: ToolPart }): React.JSX.Element {
  if (part.denied) return <ShieldX className="size-3.5 text-destructive" />
  switch (part.status) {
    case 'pending':
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-warning" />
    case 'success':
      return <Check className="size-3.5 text-success" />
    case 'error':
      return <X className="size-3.5 text-destructive" />
  }
}

function MonoBlock({
  children,
  className,
  label
}: {
  children: string
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <div>
      {label && (
        <div className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </div>
      )}
      <pre
        className={cn(
          'max-h-72 select-text overflow-auto rounded-lg border border-border bg-code p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap',
          className
        )}
      >
        {children}
      </pre>
    </div>
  )
}

interface TodoItem {
  content?: string
  status?: string
}

function ToolDetails({ part }: { part: ToolPart }): React.JSX.Element {
  const input = (part.input ?? {}) as Record<string, unknown>

  const inputView = ((): React.ReactNode => {
    switch (part.name) {
      case 'Bash':
        return str(input.command) ? <MonoBlock label="Command">{String(input.command)}</MonoBlock> : null
      case 'Edit':
        return (
          <div className="space-y-2">
            {str(input.old_string) && (
              <MonoBlock
                label="Remove"
                className="border-destructive/25 bg-destructive/8 dark:bg-destructive/10"
              >
                {String(input.old_string)}
              </MonoBlock>
            )}
            {str(input.new_string) && (
              <MonoBlock label="Add" className="border-success/25 bg-success/8 dark:bg-success/10">
                {String(input.new_string)}
              </MonoBlock>
            )}
          </div>
        )
      case 'Write':
        return str(input.content) ? <MonoBlock label="Content">{String(input.content)}</MonoBlock> : null
      case 'ExitPlanMode':
        return str(input.plan) ? (
          <div className="rounded-lg border border-border bg-code p-3">
            <Markdown text={String(input.plan)} />
          </div>
        ) : null
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : []
        return (
          <div className="space-y-1 py-0.5">
            {todos.map((todo, i) => (
              <div key={i} className="flex items-start gap-2 text-[13px]">
                <span
                  className={cn(
                    'mt-1 size-2 shrink-0 rounded-full border',
                    todo.status === 'completed' && 'border-success bg-success',
                    todo.status === 'in_progress' && 'border-warning bg-warning',
                    (todo.status === 'pending' || !todo.status) && 'border-muted-foreground/50'
                  )}
                />
                <span
                  className={cn(
                    todo.status === 'completed' && 'text-muted-foreground line-through'
                  )}
                >
                  {todo.content ?? ''}
                </span>
              </div>
            ))}
          </div>
        )
      }
      default: {
        const keys = Object.keys(input)
        if (keys.length === 0) return null
        return <MonoBlock label="Input">{JSON.stringify(input, null, 2)}</MonoBlock>
      }
    }
  })()

  return (
    <div className="space-y-2.5 border-t border-border px-3 py-2.5">
      {inputView}
      {part.output != null && part.output !== '' && (
        <MonoBlock label={part.status === 'error' ? 'Error' : 'Output'}>
          {part.output.length > 6000 ? `${part.output.slice(0, 6000)}\n… (truncated)` : part.output}
        </MonoBlock>
      )}
      {part.outputImages?.map((img, i) => (
        <img
          key={i}
          src={`data:${img.mediaType};base64,${img.data}`}
          alt="Tool screenshot"
          className="max-h-[28rem] w-full rounded-lg border border-border object-contain"
        />
      ))}
    </div>
  )
}

export const ToolCard = React.memo(function ToolCard({
  part,
  cwd,
  onOpenPlan,
  dense = false
}: {
  part: ToolPart
  cwd: string
  onOpenPlan?: (plan: string) => void
  /** Row style used inside a ToolGroup: no card chrome, just a thin divider. */
  dense?: boolean
}): React.JSX.Element {
  const meta = toolMeta(part, cwd)
  const Icon = meta.icon
  // Status is fully communicated by the header icon. Keep every tool compact
  // by default—including failures—and reveal details only when the user asks.
  const [open, setOpen] = React.useState(false)

  // Task/Agent tools render their spawned sub-agent's live activity.
  if (part.name === 'Task' || part.name === 'Agent') {
    return <AgentCard part={part} cwd={cwd} />
  }

  // Plans open in the side panel instead of expanding inline.
  const plan = (part.input as { plan?: string } | null)?.plan
  if (part.name === 'ExitPlanMode' && onOpenPlan && typeof plan === 'string' && plan) {
    return (
      <button
        type="button"
        onClick={() => onOpenPlan(plan)}
        className="group flex w-full animate-enter items-center gap-2.5 rounded-xl border border-border bg-card/60 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
      >
        <Icon className="size-4 shrink-0 text-primary" />
        <span className="shrink-0 text-[13px] font-medium">Plan</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Click to review in the side panel
        </span>
        <span className="shrink-0">
          <StatusIcon part={part} />
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
      </button>
    )
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn(!dense && 'animate-enter')}>
      <div
        className={cn(
          'overflow-hidden',
          dense
            ? 'border-b border-border/40 last:border-b-0'
            : 'rounded-xl border border-border bg-card/60'
        )}
      >
        <Collapsible.Trigger
          className={cn(
            'group flex w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50',
            dense ? 'py-1.5' : 'py-2'
          )}
        >
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[13px] font-medium">{meta.label}</span>
          {meta.summary && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {meta.open ? (
                <RowAction
                  title={`${meta.open.kind === 'preview' ? 'Preview' : 'Open'} ${meta.open.target}`}
                  className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                  onActivate={() => openTarget(meta.open!, cwd)}
                >
                  {meta.summary}
                </RowAction>
              ) : (
                meta.summary
              )}
            </span>
          )}
          {!meta.summary && <span className="flex-1" />}
          {meta.external && (
            <RowAction
              title={`Open ${meta.external}`}
              ariaLabel="Open published artifact in browser"
              className="shrink-0 cursor-pointer text-muted-foreground/60 hover:text-foreground"
              onActivate={() => void window.api.openExternal(meta.external!)}
            >
              <ExternalLink className="size-3.5" />
            </RowAction>
          )}
          <span className="shrink-0">
            <StatusIcon part={part} />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
          <ToolDetails part={part} />
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  )
})

/** Tools whose runs get coalesced into a single compact group — high-volume
 *  calls (reads, searches, spawned agents) that otherwise flood the transcript. */
export const FILE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const GROUPABLE_TOOLS = new Set([
  'Bash',
  'BashOutput',
  'Read',
  'Grep',
  'Glob',
  'ListDir',
  'NotebookRead',
  ...FILE_MUTATION_TOOLS,
  'WebFetch',
  'WebSearch',
  // Deferring most of the catalog means a run that plans anything now opens by
  // fetching the tools it needs. It is a lookup like the rest of these — it
  // reads nothing and changes nothing — so it collapses into the same run.
  'ToolSearch',
  'Task',
  'Agent'
])

/** The group header title for a uniform run (all the same tool). */
function groupTitle(label: string | undefined, n: number): string {
  const plural = (one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  switch (label) {
    case 'Read':
      return `Read ${plural('file', 'files')}`
    case 'Grep':
    case 'Glob':
      return plural('search', 'searches')
    case 'List':
      return `Listed ${plural('folder', 'folders')}`
    case 'Agent':
      return plural('agent', 'agents')
    case 'Fetch':
      return `Fetched ${plural('page', 'pages')}`
    case 'Search':
      return `${n} web ${n === 1 ? 'search' : 'searches'}`
    case 'Find tools':
      return `Found ${plural('tool', 'tools')}`
    case 'Terminal':
    case 'Run':
    case 'Git':
      return `Ran ${plural('command', 'commands')}`
    case 'Edit':
      return `Edited ${plural('file', 'files')}`
    case 'Write':
      return `Wrote ${plural('file', 'files')}`
    default:
      return label ? `${label} ×${n}` : `${n} steps`
  }
}

/** True while any call in the run — or, for agents, any of their children — is
 *  still working, so a mixed done/running group shows the spinner. */
function groupRunning(parts: ToolPart[]): boolean {
  return parts.some((p) => {
    if (p.denied) return false
    if (p.status === 'running' || p.status === 'pending') return true
    if (p.name === 'Task' || p.name === 'Agent') {
      return (p.children ?? []).some(
        (c) => c && c.type === 'tool' && (c.status === 'running' || c.status === 'pending')
      )
    }
    return false
  })
}

/**
 * A run of consecutive read/search tools shown as one collapsible row
 * ("Read 12 files") so hundreds of reads don't bury the conversation. Expand to
 * see each call as a thin, still-expandable row.
 */
export const ToolGroup = React.memo(function ToolGroup({
  parts,
  cwd
}: {
  parts: ToolPart[]
  cwd: string
}): React.JSX.Element {
  const metas = parts.map((p) => toolMeta(p, cwd))
  const labels = new Set(metas.map((m) => m.label))
  const uniform = labels.size === 1 ? metas[0] : null
  const running = groupRunning(parts)
  const errored = parts.some((p) => p.status === 'error')
  const n = parts.length

  const title = uniform ? groupTitle(uniform.label, n) : `Workspace activity · ${n} actions`
  const Icon = uniform?.icon ?? Layers
  // A run of spawns is the one group whose collapsed row can say something
  // better than "what the last call touched": how many of them are still
  // working and what they have spent between them. Same numbers as the Agents
  // panel and the activity bar, off the same fold, so the three cannot disagree.
  const agents = parts.every(isAgentPart) ? summarizeAgentParts(parts) : null
  const agentTrailing = agents
    ? [
        agents.running > 0 ? `${agents.running} working` : null,
        agents.tokens > 0 ? `Σ ${formatAgentTokens(agents.tokens)} tok` : null
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  // While running, surface the file/target of the last call for a sense of motion.
  const trailing = agentTrailing || (running ? metas[metas.length - 1]?.summary : undefined)
  // Groups follow the same stable layout as individual tools: their status is
  // visible in the header and details open only on explicit user interaction.
  const [open, setOpen] = React.useState(false)

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="animate-enter">
      <div className="overflow-hidden rounded-xl border border-border bg-card/60">
        <Collapsible.Trigger className="group flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[13px] font-medium">{title}</span>
          {trailing ? (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {trailing}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span className="shrink-0">
            {running ? (
              <Loader2 className="size-3.5 animate-spin text-warning" />
            ) : errored ? (
              <X className="size-3.5 text-destructive" />
            ) : (
              <Check className="size-3.5 text-success" />
            )}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
          <div className="border-t border-border">
            {parts.map((p) => (
              <ToolCard key={p.toolUseId} part={p} cwd={cwd} dense />
            ))}
          </div>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  )
})

/** Renders a sub-agent's own stream: its text, thinking and nested tool calls. */
function SubAgentStream({
  parts,
  cwd
}: {
  parts: AssistantPart[]
  cwd: string
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (!p) return null
        if (p.type === 'text') {
          if (!p.text) return null
          return (
            <div key={i} className="text-[13px] leading-relaxed">
              <Markdown text={p.text} cwd={cwd} />
            </div>
          )
        }
        if (p.type === 'thinking') {
          if (!p.text) return null
          return (
            <div
              key={i}
              className="border-l-2 border-border pl-3 text-[12px] leading-relaxed text-muted-foreground/70 italic whitespace-pre-wrap"
            >
              {p.text}
            </div>
          )
        }
        return <ToolCard key={p.toolUseId} part={p} cwd={cwd} />
      })}
    </div>
  )
}

/**
 * A live clock for a running agent. Ticks in the component and only while the
 * agent runs, so a settled card costs nothing and the transcript's state is
 * never rewritten once a second.
 */
function useAgentElapsed(agent: ToolPart['agent'], running: boolean): string | null {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  if (!agent?.startedAt) return null
  const end = running ? now : agent.endedAt
  if (end == null) return null
  return formatAgentDuration(end - agent.startedAt)
}

/** A spawned sub-agent, with its live activity nested under the parent tool. */
function AgentCard({ part, cwd }: { part: ToolPart; cwd: string }): React.JSX.Element {
  const input = (part.input ?? {}) as Record<string, unknown>
  const subType = str(input.subagent_type)
  const description = str(input.description) ?? str(input.prompt)
  const children = (part.children ?? []).filter(Boolean)
  const steps = children.filter((c) => c.type === 'tool').length
  // The parent Task tool_result can land (status → success) while the sub-agent
  // is still mid-step — and for background agents it lands right at spawn. Treat
  // the agent as running until its own child steps have all settled, so the card
  // never shows a checkmark while the sub-agent is visibly still working.
  const childRunning = children.some(
    (c) => c.type === 'tool' && (c.status === 'running' || c.status === 'pending')
  )
  const running = part.status === 'pending' || part.status === 'running' || childRunning

  // Collapsed by default — the header shows live status; expand to watch.
  const [open, setOpen] = React.useState(false)
  // A click in the Agents panel opens this card as it scrolls it into view.
  // Selecting down to a number keeps every other agent card out of the update.
  const focusTick = useAgents((s) => (s.focusId === part.toolUseId ? s.focusTick : 0))
  React.useEffect(() => {
    if (focusTick > 0) setOpen(true)
  }, [focusTick])
  const elapsed = useAgentElapsed(part.agent, running)
  // What the agent has spent, when its provider says. The collapsed row is
  // deliberately *short* of the panel's line: the description is the thing a
  // reader is scanning for, and a model id beside it wins the width fight in a
  // chat column and leaves the card saying "Agent · claude-sonnet-5" with the
  // task itself truncated away. Identity belongs on the expanded body below,
  // and in the roster.
  const vitals = [
    part.agent?.tokens ? `${formatAgentTokens(part.agent.tokens)} tok` : null,
    steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : null,
    elapsed
  ].filter(Boolean) as string[]
  // The full identity, for the expanded body.
  const identity = [
    part.agent?.model,
    part.agent?.effort,
    part.agent?.tokens ? `${formatAgentTokens(part.agent.tokens)} tokens` : null,
    elapsed
  ].filter(Boolean) as string[]

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="animate-enter">
      <div
        // The Agents panel scrolls the transcript to this card, the way the
        // review's next/previous change walks `[data-diff-hunk]`.
        data-agent-run={part.toolUseId}
        className={cn(
          'overflow-hidden rounded-xl border transition-colors',
          running ? 'border-warning/40 bg-warning/[0.04]' : 'border-primary/25 bg-primary/[0.03]'
        )}
      >
        <Collapsible.Trigger className="group flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-primary/[0.06] focus-visible:bg-primary/[0.06]">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
          <Bot className="size-4 shrink-0 text-primary" />
          <span className="shrink-0 text-[13px] font-medium">Agent</span>
          {subType && (
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-px font-mono text-[10px] font-medium text-primary">
              {subType}
            </span>
          )}
          {description ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {description}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {running && (
            <span className="shimmer-text shrink-0 text-[11px] font-medium">Working</span>
          )}
          {vitals.length > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
              {vitals.join(' · ')}
            </span>
          )}
          <span className="shrink-0">
            {running ? (
              <Loader2 className="size-3.5 animate-spin text-warning" />
            ) : (
              <StatusIcon part={part} />
            )}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
          <div className="space-y-3 border-t border-primary/15 px-3 py-3">
            {identity.length > 0 && (
              <div className="font-mono text-[11px] text-muted-foreground/70">
                {identity.join(' · ')}
              </div>
            )}
            {children.length > 0 ? (
              <div className="border-l-2 border-primary/20 pl-3">
                <SubAgentStream parts={children} cwd={cwd} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {running ? 'Starting…' : 'No activity recorded.'}
              </div>
            )}
            {part.output != null && part.output !== '' && (
              <div className="rounded-lg border border-border bg-code p-2.5">
                <div className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  Result
                </div>
                <div className="text-[13px] leading-relaxed">
                  <Markdown text={part.output} cwd={cwd} />
                </div>
              </div>
            )}
          </div>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  )
}

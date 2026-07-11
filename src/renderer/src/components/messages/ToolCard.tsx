import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  Search,
  ShieldX,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { ToolPart } from '@shared/types'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/Markdown'

interface ToolMeta {
  icon: React.ComponentType<{ className?: string }>
  label: string
  summary?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function toolMeta(part: ToolPart, cwd: string): ToolMeta {
  const input = (part.input ?? {}) as Record<string, unknown>
  const rel = (p?: string): string | undefined =>
    p?.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p

  switch (part.name) {
    case 'Bash':
      return {
        icon: SquareTerminal,
        label: 'Terminal',
        summary: str(input.command) ?? str(input.description)
      }
    case 'BashOutput':
      return { icon: SquareTerminal, label: 'Terminal output' }
    case 'Read':
      return { icon: FileText, label: 'Read', summary: rel(str(input.file_path)) }
    case 'Write':
      return { icon: FilePenLine, label: 'Write', summary: rel(str(input.file_path)) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        icon: FilePenLine,
        label: 'Edit',
        summary: rel(str(input.file_path) ?? str(input.notebook_path))
      }
    case 'Grep':
      return { icon: Search, label: 'Grep', summary: str(input.pattern) }
    case 'Glob':
      return { icon: Search, label: 'Glob', summary: str(input.pattern) }
    case 'Task':
    case 'Agent':
      return { icon: Bot, label: 'Agent', summary: str(input.description) }
    case 'WebFetch':
      return { icon: Globe, label: 'Fetch', summary: str(input.url) }
    case 'WebSearch':
      return { icon: Globe, label: 'Search', summary: str(input.query) }
    case 'TodoWrite':
      return { icon: ListChecks, label: 'Todos', summary: 'Update task list' }
    case 'ExitPlanMode':
      return { icon: ClipboardList, label: 'Plan', summary: 'Present plan for approval' }
    case 'AskUserQuestion':
      return { icon: MessageCircleQuestion, label: 'Question' }
    default: {
      const firstString = Object.values(input).find((v) => typeof v === 'string') as
        | string
        | undefined
      return { icon: Wrench, label: part.name.replace(/^mcp__/, ''), summary: firstString }
    }
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
    </div>
  )
}

export const ToolCard = React.memo(function ToolCard({
  part,
  cwd,
  onOpenPlan
}: {
  part: ToolPart
  cwd: string
  onOpenPlan?: (plan: string) => void
}): React.JSX.Element {
  const meta = toolMeta(part, cwd)
  const Icon = meta.icon

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
    <Collapsible.Root className="animate-enter">
      <div className="overflow-hidden rounded-xl border border-border bg-card/60">
        <Collapsible.Trigger className="group flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[13px] font-medium">{meta.label}</span>
          {meta.summary && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {meta.summary}
            </span>
          )}
          {!meta.summary && <span className="flex-1" />}
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

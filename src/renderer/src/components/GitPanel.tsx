import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Upload
} from 'lucide-react'
import type { GitFileChange } from '@shared/types'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

const STATUS_COLORS: Record<string, string> = {
  M: 'text-amber-500',
  T: 'text-amber-500',
  A: 'text-emerald-500',
  '?': 'text-emerald-500',
  D: 'text-red-500',
  R: 'text-sky-500',
  C: 'text-sky-500',
  U: 'text-orange-500'
}

function ChangeRow({
  change,
  showDir = true,
  indent = false
}: {
  change: GitFileChange
  showDir?: boolean
  indent?: boolean
}): React.JSX.Element {
  const openDiff = useApp((s) => s.openDiff)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const activeTab = useApp((s) => s.activeTab)
  const selectedCwd = useApp((s) => s.selectedCwd)

  const name = change.path.split('/').pop() ?? change.path
  const dir = change.path.includes('/')
    ? change.path.slice(0, change.path.lastIndexOf('/'))
    : ''
  const tabId = `diff:${change.staged ? 's' : 'w'}:${selectedCwd}:${change.path}`

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md py-[3px] pr-1 pl-2 text-left transition-colors hover:bg-accent/60',
        indent && 'pl-6',
        activeTab === tabId && 'bg-accent'
      )}
    >
      <button
        type="button"
        onClick={() => void openDiff(change)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
      >
        <span
          className={cn(
            'w-3 shrink-0 text-center font-mono text-[11px] font-bold',
            STATUS_COLORS[change.status] ?? 'text-muted-foreground'
          )}
        >
          {change.status === '?' ? 'U' : change.status}
        </span>
        <span className="truncate text-[12.5px]">{name}</span>
        {showDir && dir && (
          <span className="min-w-0 truncate text-[10.5px] text-muted-foreground/60">{dir}</span>
        )}
      </button>
      <WithTooltip label={change.staged ? 'Unstage' : 'Stage'}>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label={change.staged ? `Unstage ${name}` : `Stage ${name}`}
          onClick={() =>
            change.staged ? void unstagePaths([change.path]) : void stagePaths([change.path])
          }
        >
          {change.staged ? <Minus /> : <Plus />}
        </Button>
      </WithTooltip>
    </div>
  )
}

/** Groups changed files under collapsible folder headers, Cursor-style. */
function ChangeTree({ changes }: { changes: GitFileChange[] }): React.JSX.Element {
  const groups = React.useMemo(() => {
    const m = new Map<string, GitFileChange[]>()
    for (const c of changes) {
      const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''
      const arr = m.get(dir)
      if (arr) arr.push(c)
      else m.set(dir, [c])
    }
    return m
  }, [changes])

  const dirs = [...groups.keys()].filter((d) => d !== '').sort()
  const rootFiles = groups.get('') ?? []
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})

  return (
    <>
      {dirs.map((dir) => {
        const open = !collapsed[dir]
        return (
          <div key={dir}>
            <button
              type="button"
              onClick={() => setCollapsed((p) => ({ ...p, [dir]: !p[dir] }))}
              className="flex w-full items-center gap-1 rounded-md py-[3px] pr-1 pl-1.5 text-left transition-colors hover:bg-accent/40"
              title={dir}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-muted-foreground/70 transition-transform',
                  open && 'rotate-90'
                )}
              />
              <Folder className="size-3 shrink-0 text-muted-foreground/60" />
              <span className="truncate text-[11.5px] text-muted-foreground">
                {dir.replace(/\//g, ' / ')}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/50">
                {groups.get(dir)!.length}
              </span>
            </button>
            {open &&
              groups
                .get(dir)!
                .map((c) => (
                  <ChangeRow key={`${c.staged}:${c.path}`} change={c} showDir={false} indent />
                ))}
          </div>
        )
      })}
      {rootFiles.map((c) => (
        <ChangeRow key={`${c.staged}:${c.path}`} change={c} showDir={false} />
      ))}
    </>
  )
}

function Section({
  title,
  count,
  action,
  actionLabel,
  actionIcon,
  children
}: {
  title: string
  count: number
  action: () => void
  actionLabel: string
  actionIcon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1">
      <div className="group/section flex items-center gap-1.5 px-2.5 pt-2 pb-0.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <span className="rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">
          {count}
        </span>
        <div className="flex-1" />
        <WithTooltip label={actionLabel}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5 opacity-0 transition-opacity group-hover/section:opacity-100"
            aria-label={actionLabel}
            onClick={action}
          >
            {actionIcon}
          </Button>
        </WithTooltip>
      </div>
      <div className="px-1">{children}</div>
    </div>
  )
}

export function GitPanel(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const git = useApp((s) => s.git)
  const gitBusy = useApp((s) => s.gitBusy)
  const gitError = useApp((s) => s.gitError)
  const refreshGit = useApp((s) => s.refreshGit)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const commitChanges = useApp((s) => s.commitChanges)
  const pushChanges = useApp((s) => s.pushChanges)
  const initRepo = useApp((s) => s.initRepo)
  const [refreshing, setRefreshing] = React.useState(false)

  React.useEffect(() => {
    if (cwd) void refreshGit()
  }, [cwd, refreshGit])

  if (!cwd) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        Open a project to see its source control.
      </div>
    )
  }

  if (!git) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        <span className="shimmer-text">Reading repository…</span>
      </div>
    )
  }

  if (!git.isRepo) {
    return (
      <div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
        <p className="text-xs text-muted-foreground">This folder is not a git repository.</p>
        <Button size="sm" variant="secondary" onClick={() => void initRepo()}>
          <GitBranch /> Initialize repository
        </Button>
        {gitError && <p className="text-[11px] break-words text-destructive">{gitError}</p>}
      </div>
    )
  }

  const staged = git.changes.filter((c) => c.staged)
  const unstaged = git.changes.filter((c) => !c.staged)
  const canCommit = git.changes.length > 0
  const pushDisabled =
    gitBusy || !git.hasRemote || (git.hasUpstream && git.ahead === 0 && staged.length === 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Branch header */}
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5">
        <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-[11px] font-semibold text-muted-foreground">
          {git.branch || 'no branch'}
        </span>
        {git.ahead > 0 && (
          <span className="flex items-center text-[10px] text-muted-foreground">
            {git.ahead}
            <ArrowUp className="size-2.5" />
          </span>
        )}
        {git.behind > 0 && (
          <span className="flex items-center text-[10px] text-muted-foreground">
            {git.behind}
            <ArrowDown className="size-2.5" />
          </span>
        )}
        <div className="flex-1" />
        <WithTooltip label="Refresh">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="Refresh git status"
            onClick={() => {
              setRefreshing(true)
              void refreshGit().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </WithTooltip>
      </div>

      {/* Actions — committing is delegated to Claude in the chat */}
      <div className="flex flex-col gap-1.5 px-2.5 pb-2">
        <div className="flex gap-1.5">
          <WithTooltip label="Asks Claude to commit in the chat">
            <Button
              size="sm"
              className="h-6.5 flex-1 text-xs"
              disabled={!canCommit}
              onClick={() => void commitChanges()}
            >
              <Sparkles className="size-3" />
              {staged.length > 0 ? `Commit (${staged.length})` : 'Commit all'}
            </Button>
          </WithTooltip>
          <WithTooltip
            label={
              !git.hasRemote
                ? 'No git remote configured'
                : git.hasUpstream
                  ? 'Push commits to the remote'
                  : 'Publish this branch to the remote'
            }
          >
            <Button
              size="sm"
              variant="secondary"
              className="h-6.5 text-xs"
              disabled={pushDisabled}
              onClick={() => void pushChanges()}
            >
              <Upload className="size-3" />
              {git.hasUpstream ? (git.ahead > 0 ? `Push ${git.ahead}` : 'Push') : 'Publish'}
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Changes */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 pb-2">
        {git.changes.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-xs text-muted-foreground">
            <Check className="size-3.5 text-emerald-500" /> Working tree clean
          </div>
        )}
        {staged.length > 0 && (
          <Section
            title="Staged"
            count={staged.length}
            action={() => void unstagePaths(['.'])}
            actionLabel="Unstage all"
            actionIcon={<Minus />}
          >
            <ChangeTree changes={staged} />
          </Section>
        )}
        {unstaged.length > 0 && (
          <Section
            title="Changes"
            count={unstaged.length}
            action={() => void stagePaths(['.'])}
            actionLabel="Stage all"
            actionIcon={<Plus />}
          >
            <ChangeTree changes={unstaged} />
          </Section>
        )}
      </div>

      {gitError && (
        <div className="border-t border-border/60 px-3 py-2 text-[11px] break-words text-destructive">
          {gitError}
        </div>
      )}
    </div>
  )
}

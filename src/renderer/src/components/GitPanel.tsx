import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
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

function ChangeRow({ change }: { change: GitFileChange }): React.JSX.Element {
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
        {dir && (
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
  const commitMsg = useApp((s) => s.commitMsg)
  const setCommitMsg = useApp((s) => s.setCommitMsg)
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
  const canCommit = commitMsg.trim().length > 0 && git.changes.length > 0 && !gitBusy
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

      {/* Commit box */}
      <div className="flex flex-col gap-1.5 px-2.5 pb-2">
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (canCommit) void commitChanges()
            }
          }}
          placeholder="Commit message  (⌘↵ to commit)"
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs outline-none transition-colors select-text placeholder:text-muted-foreground/50 focus:border-ring/60"
        />
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className="h-6.5 flex-1 text-xs"
            disabled={!canCommit}
            onClick={() => void commitChanges()}
          >
            <Check className="size-3" />
            {staged.length > 0 ? `Commit (${staged.length})` : 'Commit all'}
          </Button>
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
            {staged.map((c) => (
              <ChangeRow key={`s:${c.path}`} change={c} />
            ))}
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
            {unstaged.map((c) => (
              <ChangeRow key={`w:${c.path}`} change={c} />
            ))}
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

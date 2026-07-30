import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  CloudUpload,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import type { GitFileChange, PrChecks, PrInfo } from '@shared/types'
import { cn } from '@/lib/utils'
import { handleTreeKeyDown } from '@/lib/treeKeyNav'
import { resolveGitActions, type GitActionId } from '@/lib/gitActions'
import { useStableChanges } from '@/lib/useStableChanges'
import { scopedChanges, useApp } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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

const INDENT = 12

/** Compact per-file line deltas (`+12 −3`), Cursor-style. */
export function LineDeltas({
  additions,
  deletions,
  className
}: {
  additions?: number
  deletions?: number
  className?: string
}): React.JSX.Element | null {
  if (!additions && !deletions) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums', className)}>
      {additions ? <span className="text-emerald-500">+{additions}</span> : null}
      {deletions ? <span className="text-red-500">−{deletions}</span> : null}
    </span>
  )
}

function ChangeRow({
  change,
  depth
}: {
  change: GitFileChange
  depth: number
}): React.JSX.Element {
  const openChanges = useApp((s) => s.openChanges)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const activeTab = useApp((s) => s.activeTab)
  const changesScroll = useApp((s) => s.changesScroll)
  // Branch scope is a read-only view of branch history — no staging there.
  const readOnly = useApp((s) => s.changeScope === 'branch')

  const name = change.path.split('/').pop() ?? change.path
  const changesActive = typeof activeTab === 'string' && activeTab.startsWith('changes:')
  const isCurrent =
    changesActive && changesScroll?.key === `${change.staged ? 's' : 'w'}:${change.path}`

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md py-[3px] pr-1 text-left transition-colors hover:bg-accent/60',
        isCurrent && 'bg-accent'
      )}
      style={{ paddingLeft: 8 + depth * INDENT }}
    >
      <button
        type="button"
        data-tree-row
        data-kind="file"
        onClick={() => openChanges({ path: change.path, staged: change.staged })}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
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
      </button>
      {readOnly && change.committed && (
        <WithTooltip label="Already committed on this branch">
          <span className="size-1.5 shrink-0 rounded-full bg-primary/60" />
        </WithTooltip>
      )}
      <LineDeltas
        additions={change.additions}
        deletions={change.deletions}
        className={cn(!readOnly && 'group-hover:hidden')}
      />
      {!readOnly && (
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
      )}
    </div>
  )
}

interface DirNode {
  /** Segment label; may be a compressed chain like `lib/ai-assistant`. */
  name: string
  /** Full path, for collapse state + keys. */
  path: string
  children: Map<string, DirNode>
  files: GitFileChange[]
}

function buildTree(changes: GitFileChange[]): DirNode {
  const root: DirNode = { name: '', path: '', children: new Map(), files: [] }
  for (const c of changes) {
    const parts = c.path.split('/')
    parts.pop() // filename
    let node = root
    let acc = ''
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg
      let child = node.children.get(seg)
      if (!child) {
        child = { name: seg, path: acc, children: new Map(), files: [] }
        node.children.set(seg, child)
      }
      node = child
    }
    node.files.push(c)
  }
  return root
}

/** Collapse single-child folder chains into one row (`lib / ai-assistant`). */
function compress(node: DirNode): DirNode {
  const children = new Map<string, DirNode>()
  for (let child of node.children.values()) {
    child = compress(child)
    while (child.children.size === 1 && child.files.length === 0) {
      const only = child.children.values().next().value as DirNode
      child = { name: `${child.name}/${only.name}`, path: only.path, children: only.children, files: only.files }
    }
    children.set(child.name, child)
  }
  return { ...node, children }
}

function countFiles(node: DirNode): number {
  let n = node.files.length
  for (const c of node.children.values()) n += countFiles(c)
  return n
}

function TreeLevel({
  node,
  depth,
  collapsed,
  setCollapsed
}: {
  node: DirNode
  depth: number
  collapsed: Record<string, boolean>
  setCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}): React.JSX.Element {
  const dirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.files].sort((a, b) =>
    (a.path.split('/').pop() ?? '').localeCompare(b.path.split('/').pop() ?? '')
  )
  return (
    <>
      {dirs.map((dir) => {
        const open = !collapsed[dir.path]
        return (
          <div key={dir.path}>
            <button
              type="button"
              data-tree-row
              data-kind="dir"
              data-expanded={open}
              onClick={() => setCollapsed((p) => ({ ...p, [dir.path]: !p[dir.path] }))}
              className="flex w-full items-center gap-1 rounded-md py-[3px] pr-1 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-primary/50"
              style={{ paddingLeft: 6 + depth * INDENT }}
              title={dir.path}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-muted-foreground/70 transition-transform',
                  open && 'rotate-90'
                )}
              />
              <Folder className="size-3 shrink-0 text-muted-foreground/60" />
              <span className="truncate text-[11.5px] text-muted-foreground">
                {dir.name.replace(/\//g, ' / ')}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/50">
                {countFiles(dir)}
              </span>
            </button>
            {open && (
              <TreeLevel
                node={dir}
                depth={depth + 1}
                collapsed={collapsed}
                setCollapsed={setCollapsed}
              />
            )}
          </div>
        )
      })}
      {files.map((c) => (
        <ChangeRow key={`${c.staged}:${c.path}`} change={c} depth={depth} />
      ))}
    </>
  )
}

/** Renders changed files as a nested, collapsible folder tree, Cursor-style. */
function ChangeTree({ changes }: { changes: GitFileChange[] }): React.JSX.Element {
  const tree = React.useMemo(() => compress(buildTree(changes)), [changes])
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  return <TreeLevel node={tree} depth={0} collapsed={collapsed} setCollapsed={setCollapsed} />
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
  action?: () => void
  actionLabel?: string
  actionIcon?: React.ReactNode
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
        {action && (
          <WithTooltip label={actionLabel ?? ''}>
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
        )}
      </div>
      <div className="px-1">{children}</div>
    </div>
  )
}

/** Icon + accent color + label for a PR's lifecycle state. */
function prAppearance(pr: PrInfo): {
  Icon: typeof GitPullRequest
  color: string
  label: string
} {
  if (pr.state === 'MERGED') return { Icon: GitMerge, color: 'text-purple-500', label: 'Merged' }
  if (pr.state === 'CLOSED')
    return { Icon: GitPullRequestClosed, color: 'text-red-500', label: 'Closed' }
  if (pr.isDraft)
    return { Icon: GitPullRequestDraft, color: 'text-muted-foreground', label: 'Draft' }
  return { Icon: GitPullRequest, color: 'text-emerald-500', label: 'Open' }
}

/** Compact CI rollup: `✗2 •1 ✓4`, only showing the nonzero buckets. */
function ChecksSummary({ checks }: { checks: PrChecks }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
      {checks.failed > 0 && (
        <span className="flex items-center gap-0.5 text-red-500">
          <XCircle className="size-3" />
          {checks.failed}
        </span>
      )}
      {checks.pending > 0 && (
        <span className="flex items-center gap-0.5 text-amber-500">
          <CircleDot className="size-3" />
          {checks.pending}
        </span>
      )}
      {checks.passed > 0 && (
        <span className="flex items-center gap-0.5 text-emerald-500">
          <CheckCircle2 className="size-3" />
          {checks.passed}
        </span>
      )}
    </span>
  )
}

/**
 * The PR status card under the git actions: state icon + number + title +
 * review/checks, linking out to GitHub. Renders nothing until a PR exists —
 * *opening* one is a rung of the action button below, not shown here.
 */
function PrCard(): React.JSX.Element | null {
  const pr = useApp((s) => s.github?.pr)
  const openPr = useApp((s) => s.openPr)
  if (!pr) return null

  const { Icon, color, label } = prAppearance(pr)
  return (
    <div className="px-2.5 pb-2">
      <WithTooltip label={`#${pr.number} · ${label} — open on GitHub`}>
        <button
          type="button"
          onClick={() => void openPr()}
          className="flex w-full items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
        >
          <Icon className={cn('size-3.5 shrink-0', color)} />
          <span className="shrink-0 text-[11px] font-semibold text-muted-foreground tabular-nums">
            #{pr.number}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">{pr.title}</span>
          {pr.reviewDecision === 'APPROVED' && (
            <Check className="size-3 shrink-0 text-emerald-500" />
          )}
          {pr.checks && <ChecksSummary checks={pr.checks} />}
        </button>
      </WithTooltip>
    </div>
  )
}

/** Icon per rung. Agent-delegated rungs get the sparkle; mechanical ones don't. */
const ACTION_ICON: Partial<Record<GitActionId, LucideIcon>> = {
  push: Upload,
  pull: ArrowDown,
  'publish-github': CloudUpload,
  'sync-cleanup': GitMerge
}

/**
 * Cursor-style split button: the primary is the sensible next step for the
 * repo's current state (see `resolveGitActions`), and the chevron opens the
 * fuller ladder. Every rung but `push` is delegated to the chat's agent.
 */
function GitActionButton(): React.JSX.Element | null {
  const git = useApp((s) => s.git)
  const github = useApp((s) => s.github)
  const gitBusy = useApp((s) => s.gitBusy)
  const runGitAction = useApp((s) => s.runGitAction)
  const preferred = useApp((s) => s.preferredGitAction)
  const setPreferred = useApp((s) => s.setPreferredGitAction)
  const agentName = useApp((s) =>
    s.chats.find((c) => c.id === s.activeId)?.provider === 'codex' ? 'Codex' : 'Claude'
  )
  const inWorktree = useApp((s) => !!s.chats.find((c) => c.id === s.activeId)?.worktree)

  const { primary, rungs } = React.useMemo(
    () => resolveGitActions(git, github, { worktree: inWorktree }),
    [git, github, inWorktree]
  )
  if (!primary) return null

  // The dropdown is a default-PICKER (Cursor-style), not an action menu: the
  // main button runs whichever action is currently selected; picking from the
  // dropdown just swaps which one that is (persisted). The sticky choice applies
  // only while it's still an available action for the current state.
  const available = [primary, ...rungs]
  const current = available.find((a) => a.id === preferred) ?? primary
  const others = available.filter((a) => a.id !== current.id)

  const Icon = ACTION_ICON[current.id] ?? Sparkles
  // push / pull are mechanical (run directly); everything else is delegated.
  const direct = current.id === 'push' || current.id === 'pull'
  const tip = direct
    ? current.id === 'pull'
      ? 'Pull changes from the remote'
      : 'Push commits to the remote'
    : `Asks ${agentName} to do this in the chat`

  return (
    <div className="flex px-2.5 pb-2">
      <WithTooltip label={tip}>
        <Button
          size="sm"
          className={cn('h-6.5 min-w-0 flex-1 text-xs', others.length > 0 && 'rounded-r-none')}
          disabled={gitBusy}
          onClick={() => void runGitAction(current.id)}
        >
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{current.label}</span>
        </Button>
      </WithTooltip>
      {others.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                className="h-6.5 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1.5"
                disabled={gitBusy}
                aria-label="Choose the default source-control action"
              >
                <ChevronDown className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-60">
            {others.map((a) => {
              const AIcon = ACTION_ICON[a.id] ?? Sparkles
              return (
                <DropdownMenuItem key={a.id} onClick={() => setPreferred(a.id)}>
                  <AIcon />
                  {a.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export function GitPanel(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const git = useApp((s) => s.git)
  const gitError = useApp((s) => s.gitError)
  const refreshGit = useApp((s) => s.refreshGit)
  const stagePaths = useApp((s) => s.stagePaths)
  const unstagePaths = useApp((s) => s.unstagePaths)
  const initRepo = useApp((s) => s.initRepo)
  const refreshGithub = useApp((s) => s.refreshGithub)
  const fetchRemote = useApp((s) => s.fetchRemote)
  // The scope (Last Turn / Uncommitted / Branch) is chosen from the review
  // panel's header; here we just read it to scope the change tree + commit.
  const changeScope = useApp((s) => s.changeScope)
  const branchChanges = useApp((s) => s.branchChanges)
  const activeId = useApp((s) => s.activeId)
  const chats = useApp((s) => s.chats)
  const messages = useApp((s) => s.messages)
  const [refreshing, setRefreshing] = React.useState(false)

  const rawChanges = React.useMemo(
    () => scopedChanges({ changeScope, git, branchChanges, activeId, chats, messages }, cwd ?? ''),
    [changeScope, git, branchChanges, activeId, chats, messages, cwd]
  )
  const changes = useStableChanges(rawChanges)

  React.useEffect(() => {
    if (cwd) {
      // Instant local status first, then a background fetch so ahead/behind
      // reflects the live remote without the user clicking Refresh.
      void refreshGit()
      void refreshGithub()
      void fetchRemote()
    }
  }, [cwd, refreshGit, refreshGithub, fetchRemote])

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

  const isBranch = changeScope === 'branch'
  const staged = changes.filter((c) => c.staged)
  const unstaged = changes.filter((c) => !c.staged)
  const branchLoading = isBranch && !branchChanges
  const emptyLabel =
    changeScope === 'last-turn'
      ? 'No changes in the last turn'
      : isBranch
        ? branchChanges?.baseBranch
          ? `No changes vs ${branchChanges.baseBranch}`
          : 'No base branch to compare against'
        : 'Working tree clean'

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
        <WithTooltip label="Fetch & refresh">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="Fetch and refresh git status"
            onClick={() => {
              setRefreshing(true)
              void fetchRemote().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </WithTooltip>
      </div>

      {/* Context-aware source-control action (agent-delegated), Cursor-style */}
      <GitActionButton />

      {/* GitHub PR status card, once a PR exists for this branch */}
      <PrCard />

      {/* Changes (scope is chosen from the review panel's header) */}
      <div
        className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 pb-2 outline-none"
        tabIndex={0}
        role="tree"
        onKeyDown={handleTreeKeyDown}
      >
        {branchLoading ? (
          <div className="px-3 py-6 text-center text-xs">
            <span className="shimmer-text">Reading branch…</span>
          </div>
        ) : changes.length === 0 ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-xs text-muted-foreground">
            <Check className="size-3.5 text-emerald-500" /> {emptyLabel}
          </div>
        ) : isBranch ? (
          // Branch scope: a flat, read-only view of the whole branch delta.
          <Section title="Files" count={changes.length}>
            <ChangeTree changes={changes} />
          </Section>
        ) : (
          <>
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
          </>
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

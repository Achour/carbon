import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  UserRound,
  WrapText,
  X
} from 'lucide-react'
import type {
  PullCheck,
  PullDetail,
  PullListResult,
  PullMergeMethod,
  PullReviewer,
  PullSummary
} from '@shared/types'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/format'
import { projectRoots } from '@/lib/projects'
import { languageForPath } from '@/lib/highlight'
import { splitPatch, type PatchFile } from '@/lib/prDiff'
import { useApp, visibleChats } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { WithTooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Markdown } from '@/components/Markdown'
import { DiffTable, MAX_ROWS } from '@/components/DiffView'
import { LazyDiffBody } from '@/components/MultiDiffView'
import { LineDeltas } from '@/components/GitPanel'
import { countRows } from '@/lib/diffRows'

/**
 * The Pull requests page: every open PR you wrote or were asked to review,
 * across every repository, with the one you pick beside the list.
 *
 * A page, like Usage, rather than a panel tab: the list is not about the open
 * chat or even the open project — that is the whole reason to have it — and a
 * right-panel tab belongs to a chat. What ties it back to the agent is "Chat":
 * the home screen in the project that holds the repository, on the PR's branch,
 * with the PR already named in the box.
 *
 * The data is the page's own rather than the store's. Nothing else reads it,
 * and a module-level cache keeps a reopen instant while the refetch that every
 * open does runs behind it.
 */

type Tab = 'all' | 'reviewing' | 'authored'

const cache: {
  list: PullListResult | null
  details: Map<string, PullDetail>
  diffs: Map<string, string>
  selected: string | null
  tab: Tab
} = {
  list: null,
  details: new Map(),
  diffs: new Map(),
  selected: null,
  tab: 'all'
}

const keyOf = (p: { repo: string; number: number }): string => `${p.repo}#${p.number}`

const ago = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? relativeTime(t) : ''
}

// ---------- Status mark ----------

/**
 * The PR glyph with a dot for where it stands: green is ready to go, red is
 * something failing or asked to change, amber is waiting on checks, and a draft
 * wears the draft glyph instead of any dot.
 */
function PullMark({ pr, className }: { pr: PullSummary; className?: string }): React.JSX.Element {
  const Icon = pr.state === 'MERGED' ? GitMerge : pr.isDraft ? GitPullRequestDraft : GitPullRequest
  const dot =
    pr.state !== 'OPEN' || pr.isDraft
      ? null
      : pr.checks === 'FAILURE' || pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'bg-red-500'
        : pr.checks === 'PENDING'
          ? 'bg-amber-500'
          : 'bg-emerald-500'
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <Icon
        className={cn(
          'size-4',
          pr.state === 'MERGED' ? 'text-violet-500' : 'text-muted-foreground'
        )}
      />
      {dot && (
        <span
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background',
            dot
          )}
        />
      )}
    </span>
  )
}

function Avatar({
  src,
  login,
  size = 16
}: {
  src?: string
  login: string
  size?: number
}): React.JSX.Element {
  const [failed, setFailed] = React.useState(false)
  if (!src || failed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"
        style={{ width: size, height: size }}
      >
        <UserRound style={{ width: size * 0.65, height: size * 0.65 }} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={login}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-secondary"
      style={{ width: size, height: size }}
    />
  )
}

// ---------- List ----------

function PullRow({
  pr,
  active,
  onSelect
}: {
  pr: PullSummary
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <PullMark pr={pr} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{pr.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {ago(pr.updatedAt)}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="max-w-[45%] shrink-0 truncate" title={`${pr.repo}#${pr.number}`}>
            {pr.repo}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" title={pr.headRef}>
            {pr.headRef}
          </span>
          <LineDeltas additions={pr.additions} deletions={pr.deletions} className="text-[11px]" />
        </span>
      </span>
    </button>
  )
}

function Section({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
      >
        {label}
        <span className="tabular-nums text-muted-foreground/60">{count}</span>
        <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  )
}

// ---------- Detail: summary ----------

function Field({
  icon,
  label,
  children
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-8 items-center gap-3 text-[13px]">
      <span className="flex w-32 shrink-0 items-center gap-2 text-muted-foreground [&_svg]:size-4">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
    </div>
  )
}

const REVIEW_LABEL: Record<PullReviewer['state'], string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  DISMISSED: 'Dismissed',
  PENDING: 'Pending'
}

const REVIEW_TONE: Record<PullReviewer['state'], string> = {
  REQUESTED: 'text-muted-foreground',
  APPROVED: 'text-emerald-500',
  CHANGES_REQUESTED: 'text-red-500',
  COMMENTED: 'text-muted-foreground',
  DISMISSED: 'text-muted-foreground/60',
  PENDING: 'text-amber-500'
}

function RequestReviewer({
  onAdd
}: {
  onAdd: (login: string) => Promise<boolean>
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [login, setLogin] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const submit = async (): Promise<void> => {
    const who = login.trim().replace(/^@/, '')
    if (!who) return
    setBusy(true)
    const ok = await onAdd(who)
    setBusy(false)
    if (ok) {
      setLogin('')
      setOpen(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] hover:bg-accent [&_svg]:size-3.5"
          />
        }
      >
        <Plus />
        Request
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="flex gap-1.5"
        >
          <Input
            autoFocus
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="GitHub username or org/team"
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" disabled={busy || !login.trim()}>
            {busy ? <DotSpinner className="size-3" /> : 'Add'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function ChecksField({ detail }: { detail: PullDetail }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const s = detail.checkSummary
  if (!s) return <span className="text-muted-foreground">No checks</span>
  const label =
    s.failed > 0 ? `${s.failed} failing` : s.pending > 0 ? `${s.pending} pending` : 'Successful'
  const tone = s.failed > 0 ? 'text-red-500' : s.pending > 0 ? 'text-amber-500' : 'text-emerald-500'
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn('flex items-center gap-1 self-start', tone)}
      >
        {label}
        {s.total > 1 && (
          <span className="text-muted-foreground">
            · {s.passed}/{s.total} passed
          </span>
        )}
        <ChevronDown
          className={cn('size-3 text-muted-foreground transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {detail.checkRuns.map((c, i) => (
            <CheckRow key={`${c.name}-${i}`} check={c} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: PullCheck }): React.JSX.Element {
  const openExternal = (url: string): void => void window.api.openExternal(url)
  return (
    <li className="flex items-center gap-2 text-[12px]">
      {check.state === 'pass' ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : check.state === 'fail' ? (
        <X className="size-3.5 text-red-500" />
      ) : (
        <CircleDot className="size-3.5 text-amber-500" />
      )}
      {check.url ? (
        <button
          type="button"
          className="truncate hover:underline"
          onClick={() => openExternal(check.url!)}
        >
          {check.name}
        </button>
      ) : (
        <span className="truncate">{check.name}</span>
      )}
    </li>
  )
}

/** Title, or the description, edited in place. */
function EditableText({
  value,
  multiline,
  onSave,
  children
}: {
  value: string
  multiline?: boolean
  onSave: ((next: string) => Promise<boolean>) | null
  children: React.ReactNode
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)
  if (!editing || !onSave) {
    return (
      <div className="group/edit relative">
        {children}
        {onSave && (
          <WithTooltip label="Edit">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Edit"
              className="absolute top-0 -right-1 opacity-0 transition-opacity group-hover/edit:opacity-100"
              onClick={() => {
                setDraft(value)
                setEditing(true)
              }}
            >
              <Pencil />
            </Button>
          </WithTooltip>
        )}
      </div>
    )
  }
  const save = async (): Promise<void> => {
    if (draft === value) return setEditing(false)
    setBusy(true)
    const ok = await onSave(draft)
    setBusy(false)
    if (ok) setEditing(false)
  }
  const common =
    'w-full rounded-md border border-border bg-transparent px-2 py-1.5 outline-none focus:border-ring'
  return (
    <div className="flex flex-col gap-2">
      {multiline ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(24, Math.max(6, draft.split('\n').length + 1))}
          className={cn(common, 'resize-y font-mono text-[12.5px] leading-relaxed')}
        />
      ) : (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
          className={cn(common, 'text-[22px] font-semibold')}
        />
      )}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || (!multiline && !draft.trim())}
        >
          {busy ? <DotSpinner className="size-3" /> : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function Summary({
  detail,
  onEdit
}: {
  detail: PullDetail
  onEdit: (edit: Parameters<typeof window.api.pullEdit>[2]) => Promise<boolean>
}): React.JSX.Element {
  const [bodyOpen, setBodyOpen] = React.useState(true)
  const editable = detail.canUpdate && detail.state === 'OPEN'
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-6">
      <div className="flex flex-col gap-2">
        <EditableText value={detail.title} onSave={editable ? (title) => onEdit({ title }) : null}>
          <h1 className="pr-8 text-[22px] leading-tight font-semibold">
            {detail.title}{' '}
            <span className="font-normal text-muted-foreground">#{detail.number}</span>
          </h1>
        </EditableText>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Avatar src={detail.authorAvatar} login={detail.author} size={18} />
          <span className="text-foreground">{detail.author}</span>
          <span>·</span>
          <span>{ago(detail.createdAt)}</span>
          <span>·</span>
          <span className="truncate">{detail.repo}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Field icon={<GitBranch />} label="Branch">
          <span className="truncate font-mono text-[12.5px]" title={detail.headRef}>
            {detail.headRef}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[12.5px]">{detail.baseRef}</span>
          <LineDeltas
            additions={detail.additions}
            deletions={detail.deletions}
            className="text-[13px]"
          />
        </Field>
        <Field icon={<UserRound />} label="Reviewers">
          {detail.reviewers.map((r) => (
            <span key={r.login} className="flex items-center gap-1.5">
              <Avatar src={r.avatar} login={r.login} />
              {r.login}
              <span className={cn('text-[12px]', REVIEW_TONE[r.state])}>
                {REVIEW_LABEL[r.state]}
              </span>
            </span>
          ))}
          {detail.state === 'OPEN' && (
            <RequestReviewer onAdd={(login) => onEdit({ addReviewer: login })} />
          )}
        </Field>
        <Field icon={<MessagesSquare />} label="Comments">
          <button
            type="button"
            className="hover:underline"
            onClick={() => void window.api.openExternal(detail.url)}
          >
            {detail.comments === 0
              ? 'No comments'
              : `${detail.comments} comment${detail.comments === 1 ? '' : 's'}`}
          </button>
        </Field>
        <Field icon={<Circle />} label="Checks">
          <ChecksField detail={detail} />
        </Field>
        <Field icon={<GitPullRequest />} label="Status">
          <StatusField detail={detail} editable={editable} onEdit={onEdit} />
        </Field>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <button
          type="button"
          onClick={() => setBodyOpen((o) => !o)}
          className="flex items-center gap-1 self-start text-[15px] font-semibold"
        >
          Description
          <ChevronDown className={cn('size-4 transition-transform', !bodyOpen && '-rotate-90')} />
        </button>
        {bodyOpen && (
          <EditableText
            value={detail.body}
            multiline
            onSave={editable ? (body) => onEdit({ body }) : null}
          >
            {detail.body.trim() ? (
              <Markdown text={detail.body} className="pr-8" />
            ) : (
              <p className="text-[13px] text-muted-foreground">No description.</p>
            )}
          </EditableText>
        )}
      </div>
    </div>
  )
}

function statusLabel(detail: PullDetail): string {
  if (detail.state === 'MERGED') return 'Merged'
  if (detail.state === 'CLOSED') return 'Closed'
  if (detail.isDraft) return 'Draft'
  if (detail.mergeable === 'CONFLICTING') return 'Has conflicts'
  if (detail.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested'
  if (detail.reviewDecision === 'APPROVED') return 'Approved'
  return 'Ready for review'
}

function StatusField({
  detail,
  editable,
  onEdit
}: {
  detail: PullDetail
  editable: boolean
  onEdit: (edit: { ready: boolean }) => Promise<boolean>
}): React.JSX.Element {
  const label = statusLabel(detail)
  const tone =
    detail.mergeable === 'CONFLICTING' || detail.reviewDecision === 'CHANGES_REQUESTED'
      ? 'text-red-500'
      : detail.state === 'MERGED'
        ? 'text-violet-500'
        : ''
  if (!editable) return <span className={tone}>{label}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn('flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent', tone)}
          />
        }
      >
        {label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {detail.isDraft ? (
          <DropdownMenuItem onClick={() => void onEdit({ ready: true })}>
            <GitPullRequest />
            Ready for review
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => void onEdit({ ready: false })}>
            <GitPullRequestDraft />
            Convert to draft
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------- Detail: code ----------

function CodeTab({ pr }: { pr: PullSummary }): React.JSX.Element {
  const key = keyOf(pr)
  const [text, setText] = React.useState<string | undefined>(() => cache.diffs.get(key))
  const [error, setError] = React.useState<string | null>(null)
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const scroller = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    let alive = true
    setError(null)
    void window.api.pullDiff(pr.repo, pr.number).then((res) => {
      if (!alive) return
      if (res.ok) {
        cache.diffs.set(key, res.output ?? '')
        setText(res.output ?? '')
      } else setError(res.error)
    })
    return () => {
      alive = false
    }
  }, [pr.repo, pr.number, key])

  const files = React.useMemo(() => (text === undefined ? [] : splitPatch(text)), [text])
  const onMount = React.useCallback(() => {}, [])
  // The review view's wrap preference, shared: it is one reader's taste in
  // diffs, not a setting of either surface.
  const diffWrap = useApp((s) => s.diffWrap)
  const toggleDiffWrap = useApp((s) => s.toggleDiffWrap)
  const allCollapsed = files.length > 0 && files.every((f) => collapsed[f.path])
  const toggleAll = (): void =>
    setCollapsed(allCollapsed ? {} : Object.fromEntries(files.map((f) => [f.path, true])))

  if (error && text === undefined) {
    return <p className="p-6 text-[13px] break-words text-destructive">{error}</p>
  }
  if (text === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <DotSpinner className="size-4" />
        Loading diff…
      </div>
    )
  }
  if (files.length === 0) {
    return <p className="p-6 text-[13px] text-muted-foreground">No changes.</p>
  }
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[length:var(--ui-row)] text-muted-foreground">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <LineDeltas additions={additions} deletions={deletions} />
        <div className="ml-auto flex items-center gap-0.5">
          <WithTooltip label={diffWrap ? 'Do not wrap long lines' : 'Wrap long lines'}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={diffWrap ? 'Do not wrap long lines' : 'Wrap long lines'}
              aria-pressed={diffWrap}
              onClick={toggleDiffWrap}
            >
              <WrapText />
            </Button>
          </WithTooltip>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[length:var(--ui-row)] font-normal"
            aria-pressed={!allCollapsed}
            onClick={toggleAll}
          >
            {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {files.map((f: PatchFile) => {
          const open = !collapsed[f.path]
          const name = f.path.split('/').pop() ?? f.path
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
          return (
            <div key={f.path} className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [f.path]: open }))}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border/40 bg-card px-2 py-[3px] text-left text-[length:var(--ui-row)]"
              >
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground/70 transition-transform',
                    open && 'rotate-90'
                  )}
                />
                <span
                  className={cn(
                    'w-3.5 shrink-0 text-center font-mono',
                    f.status === 'A'
                      ? 'text-emerald-500'
                      : f.status === 'D'
                        ? 'text-red-500'
                        : f.status === 'R'
                          ? 'text-sky-500'
                          : 'text-amber-500'
                  )}
                >
                  {f.status}
                </span>
                <span className="shrink-0 truncate">{name}</span>
                {dir && (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{dir}</span>
                )}
                <LineDeltas additions={f.additions} deletions={f.deletions} className="ml-auto" />
              </button>
              {open &&
                (f.binary || !f.text.includes('\n@@') ? (
                  <p className="px-3 py-2 text-[length:var(--ui-row)] text-muted-foreground/70">
                    {f.binary
                      ? 'Binary file'
                      : f.status === 'R'
                        ? 'Renamed without changes'
                        : 'No textual changes'}
                  </p>
                ) : (
                  <LazyDiffBody
                    sectionKey={f.path}
                    scroller={scroller}
                    rows={Math.max(1, Math.min(countRows(f.text), MAX_ROWS))}
                    forceMount={false}
                    onMount={onMount}
                  >
                    <div className={cn('min-w-0', !diffWrap && 'overflow-x-auto')}>
                      <DiffTable text={f.text} language={languageForPath(f.path)} wrap={diffWrap} />
                    </div>
                  </LazyDiffBody>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- Detail ----------

const MERGE_LABEL: Record<PullMergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

/** Why Merge is unavailable, or null when it is not. */
function mergeBlock(detail: PullDetail): string | null {
  if (detail.state !== 'OPEN') return `Already ${detail.state.toLowerCase()}`
  if (detail.isDraft) return 'Drafts cannot be merged — mark it ready for review first'
  if (detail.mergeable === 'CONFLICTING') return 'Resolve the conflicts with the base branch first'
  if (detail.mergeMethods.length === 0) return 'The repository allows no merge method'
  return null
}

function Detail({
  pr,
  projects,
  onChanged
}: {
  pr: PullSummary
  projects: Record<string, string> | null
  onChanged: () => void
}): React.JSX.Element {
  const key = keyOf(pr)
  const [tab, setTab] = React.useState<'summary' | 'code'>('summary')
  const [detail, setDetail] = React.useState<PullDetail | undefined>(() => cache.details.get(key))
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'merge' | 'chat' | null>(null)
  const chatAboutPull = useApp((s) => s.chatAboutPull)

  const load = React.useCallback(async () => {
    const res = await window.api.pullDetail(pr.repo, pr.number)
    if ('error' in res) {
      setError(res.error)
      return
    }
    cache.details.set(key, res)
    setDetail(res)
    setError(null)
  }, [pr.repo, pr.number, key])

  React.useEffect(() => {
    void load()
  }, [load])

  const act = async (run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    const res = await run()
    if (!res.ok) {
      setError(res.error ?? 'GitHub refused the change.')
      return false
    }
    setError(null)
    await load()
    onChanged()
    return true
  }

  const onEdit = (edit: Parameters<typeof window.api.pullEdit>[2]): Promise<boolean> =>
    act(() => window.api.pullEdit(pr.repo, pr.number, edit))

  const merge = async (method: PullMergeMethod): Promise<void> => {
    setBusy('merge')
    await act(() => window.api.pullMerge(pr.repo, pr.number, method))
    setBusy(null)
  }

  const root = projects?.[pr.repo.toLowerCase()]
  const chat = async (): Promise<void> => {
    if (!root) return
    setBusy('chat')
    const res = await window.api.pullCheckout(root, pr.repo, pr.number, pr.headRef)
    setBusy(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const d = detail ?? pr
    await chatAboutPull(
      res.root,
      res.target,
      `Pull request #${d.number} in ${d.repo} — "${d.title}" (${d.headRef} → ${d.baseRef}): ${d.url}\n\n`
    )
  }

  const blocked = detail ? mergeBlock(detail) : 'Loading…'
  const chatHint = !projects
    ? 'Looking for a local checkout…'
    : root
      ? `Start a chat in ${root.split('/').pop()} on ${pr.headRef}`
      : `No project in Carbon has ${pr.repo} as a remote`

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <PullMark pr={detail ?? pr} className="mr-1" />
        {(['summary', 'code'] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[13px] capitalize transition-colors',
              tab === t
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t === 'code' && detail ? `Code · ${detail.changedFiles}` : t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <WithTooltip label="Open on GitHub">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open on GitHub"
              onClick={() => void window.api.openExternal(pr.url)}
            >
              <ExternalLink />
            </Button>
          </WithTooltip>
          <WithTooltip label={chatHint}>
            {/* Wrapped so the tooltip still explains a disabled button. */}
            <span>
              <Button
                size="sm"
                variant="secondary"
                disabled={!root || busy !== null}
                onClick={() => void chat()}
              >
                {busy === 'chat' ? <DotSpinner className="size-3" /> : <MessageSquare />}
                Chat
              </Button>
            </span>
          </WithTooltip>
          <DropdownMenu>
            <WithTooltip label={blocked ?? 'Merge on GitHub'}>
              <span>
                <DropdownMenuTrigger
                  disabled={!!blocked || busy !== null}
                  render={<Button size="sm" />}
                >
                  {busy === 'merge' ? <DotSpinner className="size-3" /> : <GitMerge />}
                  Merge
                  <ChevronDown />
                </DropdownMenuTrigger>
              </span>
            </WithTooltip>
            <DropdownMenuContent align="end">
              {detail?.mergeMethods.map((m) => (
                <DropdownMenuItem key={m} onClick={() => void merge(m)}>
                  <GitMerge />
                  {MERGE_LABEL[m]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-[12px] text-destructive">
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {/* The Code tab scrolls itself: its lazy diff bodies measure against
          their own scroller, so this one must not scroll around it. */}
      <div className={cn('min-h-0 flex-1', tab === 'summary' && 'overflow-y-auto')}>
        {tab === 'code' ? (
          <CodeTab pr={pr} />
        ) : detail ? (
          <Summary detail={detail} onEdit={onEdit} />
        ) : error ? null : (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <DotSpinner className="size-4" />
            Loading pull request…
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Page ----------

function EmptyState({ list }: { list: Extract<PullListResult, { ok: false }> }): React.JSX.Element {
  const [title, hint] =
    list.reason === 'missing'
      ? [
          'The GitHub CLI is not installed',
          'Install it with `brew install gh`, then run `gh auth login`.'
        ]
      : list.reason === 'auth'
        ? ['Sign in to GitHub', 'Run `gh auth login` in a terminal, then refresh.']
        : ['GitHub did not answer', list.error]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-8 text-center">
      <GitPullRequest className="mb-2 size-6 text-muted-foreground" />
      <p className="text-[14px] font-medium">{title}</p>
      <div className="max-w-md text-[13px] text-muted-foreground">
        <Markdown text={hint} className="text-[13px]" />
      </div>
    </div>
  )
}

export function PullRequests(): React.JSX.Element {
  const closePulls = useApp((s) => s.closePulls)
  const chats = useApp((s) => s.chats)
  const projectOrder = useApp((s) => s.projectOrder)
  const [list, setList] = React.useState<PullListResult | null>(cache.list)
  const [loading, setLoading] = React.useState(false)
  const [tab, setTabState] = React.useState<Tab>(cache.tab)
  const [query, setQuery] = React.useState('')
  const [selected, setSelectedState] = React.useState<string | null>(cache.selected)
  const [projects, setProjects] = React.useState<Record<string, string> | null>(null)

  const setTab = (t: Tab): void => {
    cache.tab = t
    setTabState(t)
  }
  const setSelected = (k: string | null): void => {
    cache.selected = k
    setSelectedState(k)
  }

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.pullsList()
      cache.list = res
      setList(res)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const roots = React.useMemo(
    () => projectRoots(visibleChats(chats), projectOrder),
    [chats, projectOrder]
  )
  const rootsKey = roots.join('\n')
  React.useEffect(() => {
    let alive = true
    void window.api.pullProjects(rootsKey ? rootsKey.split('\n') : []).then((p) => {
      if (alive) setProjects(p)
    })
    return () => {
      alive = false
    }
  }, [rootsKey])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [role="menu"], [role="dialog"]')) return
      closePulls()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePulls])

  const pulls = list?.ok ? list.pulls : []
  const q = query.trim().toLowerCase()
  const visible = pulls.filter(
    (p) =>
      (tab === 'all' || p.roles.includes(tab)) &&
      (!q ||
        p.title.toLowerCase().includes(q) ||
        p.repo.toLowerCase().includes(q) ||
        p.headRef.toLowerCase().includes(q) ||
        String(p.number) === q.replace(/^#/, ''))
  )
  const reviewing = visible.filter((p) => p.roles.includes('reviewing'))
  // Under "All", a PR you wrote and were also asked to review is listed once,
  // under Review requested — the section that asks something of you.
  const authored = visible.filter(
    (p) => p.roles.includes('authored') && !(tab === 'all' && p.roles.includes('reviewing'))
  )
  // A PR merged or closed from here drops out of the (open-only) list on the
  // refresh that follows; its last detail keeps it on screen, showing the
  // outcome, rather than the pane jumping to whatever row is now first.
  const current =
    pulls.find((p) => keyOf(p) === selected) ??
    (selected ? cache.details.get(selected) : undefined) ??
    visible[0] ??
    null

  const renderRows = (rows: PullSummary[]): React.ReactNode =>
    rows.map((p) => (
      <PullRow
        key={keyOf(p)}
        pr={p}
        active={current !== null && keyOf(p) === keyOf(current)}
        onSelect={() => setSelected(keyOf(p))}
      />
    ))

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="drag flex h-[38px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <span className="text-sm font-semibold">Pull requests</span>
        <div className="flex items-center gap-1">
          <WithTooltip label="Refresh">
            <Button
              size="icon-sm"
              variant="ghost"
              className="no-drag"
              aria-label="Refresh"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
          </WithTooltip>
          <WithTooltip label="Close  esc">
            <Button
              size="icon-sm"
              variant="ghost"
              className="no-drag"
              aria-label="Close"
              onClick={closePulls}
            >
              <X />
            </Button>
          </WithTooltip>
        </div>
      </header>

      {!list ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <DotSpinner className="size-4" />
          Asking GitHub…
        </div>
      ) : !list.ok ? (
        <EmptyState list={list} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
            <div className="flex flex-col gap-2.5 px-3 pt-3 pb-2">
              <div className="flex gap-0.5">
                {(['all', 'reviewing', 'authored'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={tab === t}
                    onClick={() => setTab(t)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[13px] capitalize transition-colors',
                      tab === t
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search pull requests"
                  className="h-8 pl-8 text-[13px]"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
              {visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  {q ? 'No pull requests match.' : 'No open pull requests.'}
                </p>
              ) : tab === 'all' ? (
                <>
                  {reviewing.length > 0 && (
                    <Section label="Review requested" count={reviewing.length}>
                      {renderRows(reviewing)}
                    </Section>
                  )}
                  {authored.length > 0 && (
                    <Section label="Authored" count={authored.length}>
                      {renderRows(authored)}
                    </Section>
                  )}
                </>
              ) : (
                <div className="flex flex-col gap-0.5 pt-1">{renderRows(visible)}</div>
              )}
            </div>
          </div>
          {current ? (
            <Detail
              key={keyOf(current)}
              pr={current}
              projects={projects}
              onChanged={() => void refresh()}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              Nothing selected
            </div>
          )}
        </div>
      )}
    </div>
  )
}

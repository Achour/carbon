import * as React from 'react'
import {
  Archive,
  Ellipsis,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Image,
  Layers,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Type
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SwitchPill } from '@/components/ui/switch-pill'
import { WithTooltip } from '@/components/ui/tooltip'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { ProjectDialogs, type ProjectPrompt } from '@/components/ProjectDialogs'
import { projectGroups, projectLabel } from '@/lib/projects'
import { shortenPath } from '@/lib/format'
import { useApp, visibleChats } from '@/store'
import type { ProjectOverview, ProjectWorktreeInfo } from '@shared/types'

/**
 * Settings → Projects: every folder the app has chats in, and what is actually
 * there.
 *
 * **A project has existed as an idea since the sidebar first grouped by it, and
 * never as a thing you could inspect.** It was a folder some chats shared, with
 * three annotations (a name, a hidden flag, an archived flag) reachable only
 * from a right-click on a row that happened to be on screen — so a hidden
 * project was, in practice, unfindable: the one way back was to open its folder
 * again from the directory picker and hope it was the right one.
 *
 * Three things it says that nothing else in the app could:
 *
 * - **The folder is gone.** Chats keep working against a directory that was
 *   moved or deleted — main writes to it, git fails, and the failure surfaces as
 *   whatever the current turn happened to be doing. Here it is a fact on the
 *   row, stated once, with every action that would touch the disk stood down
 *   rather than left to fail. (What it does *not* do is offer to relocate: that
 *   means rewriting `cwd` on every chat while sessions hold the object by
 *   reference, which is a real change and not one this asked for.)
 * - **Hidden and archived are two different states**, and this is the first
 *   place either is visible as a state rather than as an action you once took —
 *   so they are switches on the project, not verbs in a menu.
 * - **What the repository is** — its branch, its remote, its worktrees. The
 *   worktrees especially: they are created per chat and outlive it, so the set
 *   of them is exactly the thing no single chat can show you.
 *
 * ### Why this section is a list and a pane, and not a page of cards
 *
 * Every other settings section is a short column of settings, so the page's
 * `max-w-2xl` reading measure is right for them. Projects is not a settings
 * list — it is a **collection**, of unbounded length, where each member has far
 * more to say than fits on a row. Stacked expandable cards made that the
 * reader's problem: a folder eleven projects down took eleven scrolls to reach,
 * expanding one pushed the rest off screen, and the column's measure left half
 * of a wide window empty while the worktree paths inside it wrapped.
 *
 * So the section takes the whole content area and splits it the way a manager
 * of a collection does: **pick on the left, read on the right.** The list stays
 * put while the detail changes, which is what makes comparing two projects a
 * click rather than a scroll; the filter belongs to the list, because the list
 * is now the navigation; and the detail has the width to lay a repo's facts out
 * in a grid instead of a wrapped sentence.
 *
 * It costs the section its `SectionHeader` — a title above a two-pane layout
 * would be a third region holding one line of text — so the heading moves
 * *into* the list pane, where it labels the thing it is actually the heading
 * for.
 *
 * The expensive half is loaded by the selection. See `main/projects.ts`.
 */

/**
 * GitHub's mark, from simple-icons (CC0) and inlined rather than depended on —
 * the trade `ui/provider-mark.tsx` already makes for the three provider logos.
 * lucide dropped its brand icons, and this is the one brand a repository row
 * genuinely has to name.
 */
const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

function GithubMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={cn('size-3', className)}>
      <path d={GITHUB_PATH} />
    </svg>
  )
}

/**
 * A remote's mark: the octocat for GitHub, a branch glyph for everywhere else.
 * Not a per-host logo set — GitLab, Gitea and a self-hosted box are all "a git
 * remote", and inventing a mark for each would be three more facts to keep
 * true about services the app does not otherwise know anything about.
 */
function RemoteMark({ host, className }: { host: string; className?: string }): React.JSX.Element {
  return host === 'github.com' ? (
    <GithubMark className={className} />
  ) : (
    <GitBranch className={cn('size-3 shrink-0', className)} />
  )
}

function Badge({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'warning'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
        tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-secondary text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

/** One labelled fact in the detail pane's repository grid. */
function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px]">{children}</div>
    </div>
  )
}

/** A heading inside the detail pane. */
function Group({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count !== undefined && count > 0 && (
          <span className="ml-1.5 text-muted-foreground/60 tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

/**
 * One **linked** worktree — the main checkout never reaches here; see
 * `checkout` / `linked` in the detail pane.
 *
 * A worktree whose directory is gone is listed rather than dropped — the
 * opposite of what the "Run on" picker does with the same data, and for the
 * opposite reason: the picker would start a chat in it, while here clearing it
 * is the only thing left to do with it. Git keeps reporting one until something
 * prunes it, and nothing else in the app ever will.
 */
function WorktreeRow({
  wt,
  root,
  onRemoved
}: {
  wt: ProjectWorktreeInfo
  /** The repo, so a worktree whose directory is gone can still be identified. */
  root: string
  onRemoved: () => void
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // A chat living in the worktree owns it: main refuses the removal, and the
  // chat's own delete flow is the supported way. Counting here says so *before*
  // the click rather than answering it with an error — main's refusal stays as
  // the authority, since only it sees chats this window has never loaded.
  //
  // A **missing** worktree is the exception, at both ends: there is no directory
  // left to strand a chat in, the chat is orphaned either way, and refusing
  // would make git's stale entry unclearable without first deleting a chat.
  const chatsHere = useApp((s) => s.chats.filter((c) => c.cwd === wt.path).length)
  const blocked = chatsHere > 0 && !wt.missing

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await window.api.worktreeRemove(wt.path, root)
    setBusy(false)
    if (res.ok) onRemoved()
    else setError(res.error)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <GitBranch
        className={cn('size-4 shrink-0', wt.missing ? 'text-warning' : 'text-muted-foreground')}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{wt.branch}</span>
          {wt.missing && <Badge tone="warning">Folder missing</Badge>}
          {wt.merged && !wt.missing && <Badge>Merged</Badge>}
          {!wt.missing && wt.dirtyFiles !== null && wt.dirtyFiles > 0 && (
            <Badge>
              {wt.dirtyFiles} uncommitted file{wt.dirtyFiles === 1 ? '' : 's'}
            </Badge>
          )}
          {chatsHere > 0 && (
            <Badge>
              {chatsHere} chat{chatsHere === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {shortenPath(wt.path)}
        </div>
        {/* Said once, on the row it applies to, so the absent button is a fact
            rather than something missing. */}
        {!wt.managed && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Created outside Carbon — remove it with <span className="font-mono">git worktree</span>.
          </div>
        )}
        {error && <div className="mt-1 text-[11px] text-destructive">{error}</div>}
      </div>
      {!wt.missing && (
        <WithTooltip label="Show in Finder">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Show ${wt.branch} in Finder`}
            onClick={() => void window.api.revealPath(wt.path)}
          >
            <FolderOpen />
          </Button>
        </WithTooltip>
      )}
      {/* A worktree Carbon did not create carries no remove button, because
          pressing it could only produce a refusal: `removeWorktree` declines
          those outright, and `listWorktrees` will not prune even a *stale* one,
          since absent is not gone and the record is what someone needs to plug
          the disk back in. */}
      {wt.managed && (
        <WithTooltip
          label={
            blocked
              ? `${chatsHere} chat${chatsHere === 1 ? '' : 's'} run here — delete ${
                  chatsHere === 1 ? 'it' : 'them'
                } to remove the worktree`
              : wt.missing
                ? chatsHere > 0
                  ? `Clear this stale worktree — ${chatsHere} chat${
                      chatsHere === 1 ? '' : 's'
                    } still point at it and will have no folder`
                  : 'Clear this stale worktree'
                : 'Remove worktree'
          }
        >
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy || blocked}
            aria-label={`Remove worktree ${wt.branch}`}
            onClick={() => void remove()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </WithTooltip>
      )}
    </div>
  )
}

/** How many branch chips are drawn before the rest become a count. */
const BRANCH_CHIPS = 14

/** One row in the list pane. */
function ProjectRow({
  root,
  label,
  chatCount,
  overview,
  selected,
  onSelect
}: {
  root: string
  label: string
  chatCount: number
  overview: ProjectOverview | undefined
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const hidden = useApp((s) => !!s.hiddenProjects[root])
  const archived = useApp((s) => !!s.archivedProjects[root])
  const missing = overview !== undefined && !overview.exists

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Select ${label}`}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <ProjectAvatar
        root={root}
        name={label}
        icon={overview?.icon ?? null}
        dimmed={missing}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{label}</span>
          {missing && <TriangleAlert className="size-3 shrink-0 text-warning" />}
        </span>
        {/* One line under the name, and it is the two facts that tell projects
            apart at a glance: how much of your history is here, and which
            branch it is sitting on. The path is the detail pane's job — it is
            long, and having room for it is the point of the pane. */}
        <span className="mt-px flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="flex shrink-0 items-center gap-1">
            <MessageSquare className="size-3 shrink-0" />
            <span className="tabular-nums">{chatCount}</span>
          </span>
          {overview?.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{overview.branch}</span>
            </span>
          )}
          {hidden && <Badge>Hidden</Badge>}
          {archived && <Badge>Archived</Badge>}
        </span>
      </span>
    </button>
  )
}

/** The right-hand pane: everything about the one project that is selected. */
/**
 * The three things a project's mark can be.
 *
 * **The scan is right about almost every repo and unfixably wrong about a
 * few** — a monorepo root with no icon anywhere under it, a repo whose only
 * image is a placeholder favicon nobody replaced, a client project whose mark
 * lives in a design file. So the answer it finds is a default rather than a
 * verdict, and these are the three ways past it.
 *
 * "Use initials" is a state and not merely the absence of one: a project whose
 * folder *does* contain an icon the user does not want drawn has to be able to
 * say so, and clearing the override would hand it straight back. Both items
 * appear only when there is something for them to do — no icon is showing, so
 * nothing to replace with initials; nothing was chosen, so nothing to revert.
 */
function IconMenuItems({
  root,
  overview,
  onError
}: {
  root: string
  overview: ProjectOverview | undefined
  onError: (message: string | null) => void
}): React.JSX.Element {
  const setProjectIcon = useApp((s) => s.setProjectIcon)
  const clearProjectIcon = useApp((s) => s.clearProjectIcon)
  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          onError(null)
          void setProjectIcon(root).then(onError)
        }}
      >
        <Image /> Choose image…
      </DropdownMenuItem>
      {!!overview?.icon && (
        <DropdownMenuItem
          onClick={() => {
            onError(null)
            void clearProjectIcon(root, 'initials')
          }}
        >
          <Type /> Use initials
        </DropdownMenuItem>
      )}
      {!!overview?.customIcon && (
        <DropdownMenuItem
          onClick={() => {
            onError(null)
            void clearProjectIcon(root, 'auto')
          }}
        >
          <RotateCcw /> Use the icon in the folder
        </DropdownMenuItem>
      )}
    </>
  )
}

function ProjectDetailPane({
  root,
  chatCount,
  overview,
  onPrompt
}: {
  root: string
  chatCount: number
  overview: ProjectOverview | undefined
  onPrompt: (prompt: ProjectPrompt) => void
}): React.JSX.Element {
  const projectNames = useApp((s) => s.projectNames)
  const hidden = useApp((s) => !!s.hiddenProjects[root])
  const archived = useApp((s) => !!s.archivedProjects[root])
  const setProjectHidden = useApp((s) => s.setProjectHidden)
  const setProjectArchived = useApp((s) => s.setProjectArchived)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const openChat = useApp((s) => s.openChat)
  const closeSettings = useApp((s) => s.closeSettings)
  const detail = useApp((s) => s.projectDetails[root])
  const loadProjectDetail = useApp((s) => s.loadProjectDetail)
  const loadProjects = useApp((s) => s.loadProjects)
  const [iconError, setIconError] = React.useState<string | null>(null)

  const label = projectLabel(root, projectNames)
  const missing = overview !== undefined && !overview.exists
  const isRepo = !!overview?.exists && overview.isRepo

  /**
   * **The checkout is not a worktree, and counting it as one made the pane
   * disagree with itself** — the grid said 1 (linked worktrees, which is what
   * anyone means by the word) over a list that drew 2 rows, because git's own
   * `worktree list` leads with the main checkout.
   *
   * So the list is the linked ones only, and both numbers come from the same
   * set by construction. The checkout's row carried exactly one fact that is
   * nowhere else on the page — how many files are uncommitted in it — and that
   * moves into the grid beside the branch it belongs to. Its path, branch and
   * chats were already the header's and the grid's.
   */
  const checkout = detail?.worktrees.find((w) => w.isMain)
  const linked = detail?.worktrees.filter((w) => !w.isMain) ?? []

  // Selecting a project *is* the request for its detail — there is no second
  // gesture to hang it off, which is the point of the layout.
  React.useEffect(() => {
    if (isRepo) void loadProjectDetail(root)
  }, [root, isRepo, loadProjectDetail])

  const newChatHere = (): void => {
    setSelectedCwd(root)
    void openChat(null)
    closeSettings()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 py-7">
        <header className="flex items-start gap-3.5">
          {/* The mark is the control for itself. A menu item alone would be
              correct and unfindable — the icon is the thing you want to change
              and the thing you are looking at, so clicking it is the gesture
              anyone tries first. The same items are in the ⋯ menu for anyone
              who doesn't. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Change the icon for ${label}`}
                  className="group relative shrink-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <ProjectAvatar
                    root={root}
                    name={label}
                    icon={overview?.icon ?? null}
                    size="lg"
                    dimmed={missing}
                  />
                  <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/75 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100">
                    <Pencil className="size-4" />
                  </span>
                </button>
              }
            />
            <DropdownMenuContent align="start">
              <IconMenuItems root={root} overview={overview} onError={setIconError} />
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-semibold">{label}</h2>
              {missing && <Badge tone="warning">Folder missing</Badge>}
            </div>
            {/* The path is a button, not a caption: on this page it is the
                answer to "which folder is this?", and the next thing anyone
                wants is to go and look at it. */}
            <button
              type="button"
              disabled={missing}
              onClick={() => void window.api.revealPath(root)}
              title={missing ? root : `Show ${root} in Finder`}
              className={cn(
                'mt-0.5 block max-w-full truncate text-left font-mono text-[12px] text-muted-foreground',
                !missing && 'hover:text-foreground'
              )}
            >
              {root}
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!missing && (
              <Button size="sm" variant="secondary" onClick={newChatHere}>
                <Plus />
                New chat
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${label}`}>
                    <Ellipsis />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {/* Everything that needs the folder to be there is absent when
                    it isn't, rather than present and failing. */}
                {!missing && (
                  <DropdownMenuItem onClick={() => void window.api.revealPath(root)}>
                    <FolderOpen /> Show in Finder
                  </DropdownMenuItem>
                )}
                {overview?.remote?.url && (
                  <DropdownMenuItem
                    onClick={() => void window.api.openExternal(overview.remote!.url)}
                  >
                    <RemoteMark host={overview.remote.host} /> Open on {overview.remote.host}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onPrompt({ kind: 'rename', cwd: root })}>
                  <Pencil /> Rename project…
                </DropdownMenuItem>
                <IconMenuItems root={root} overview={overview} onError={setIconError} />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onClick={() => onPrompt({ kind: 'remove', cwd: root })}
                >
                  <Trash2 /> Remove project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Every way choosing an icon fails is something about the file that
            was picked, so the sentence names it rather than saying "failed". */}
        {iconError && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12px] text-warning">
            <TriangleAlert className="mt-px size-4 shrink-0" />
            <span>{iconError}</span>
          </div>
        )}

        {/* The folder is gone. Said once, in words, rather than left for the
            next turn to discover — and it names the two ways out, neither of
            which the app can take on the user's behalf. */}
        {missing && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12px] text-warning">
            <TriangleAlert className="mt-px size-4 shrink-0" />
            <span>
              This folder was moved or deleted. Its {chatCount === 1 ? 'chat is' : 'chats are'}{' '}
              still here and still readable, but nothing can run in it. Put the folder back where it
              was, or remove the project.
            </span>
          </div>
        )}

        <Group title="Repository">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 rounded-lg border border-border px-4 py-3.5 lg:grid-cols-3">
            <Fact label="Chats">
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="tabular-nums">{chatCount}</span>
            </Fact>
            <Fact label="Branch">
              {overview?.branch ? (
                <>
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{overview.branch}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Not a repository</span>
              )}
            </Fact>
            <Fact label="Uncommitted">
              {checkout?.dirtyFiles ? (
                <span className="tabular-nums">
                  {checkout.dirtyFiles} file{checkout.dirtyFiles === 1 ? '' : 's'}
                </span>
              ) : checkout ? (
                <span className="text-muted-foreground">Clean</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Fact>
            <Fact label="Remote">
              {overview?.remote ? (
                overview.remote.url ? (
                  <button
                    type="button"
                    onClick={() => void window.api.openExternal(overview.remote!.url)}
                    className="flex min-w-0 items-center gap-1.5 hover:text-primary"
                  >
                    <RemoteMark host={overview.remote.host} className="size-3.5" />
                    <span className="truncate">
                      {overview.remote.owner}/{overview.remote.repo}
                    </span>
                  </button>
                ) : (
                  // An SSH alias resolves nowhere in a browser, so it gets its
                  // name and no link.
                  <>
                    <RemoteMark host={overview.remote.host} className="size-3.5" />
                    <span className="truncate">
                      {overview.remote.owner}/{overview.remote.repo}
                    </span>
                  </>
                )
              ) : overview?.remoteUrl ? (
                // A remote git holds but nothing can open — a local clone, an
                // unfamiliar shape. The honest answer is the string itself.
                <span className="truncate font-mono text-[12px]">{overview.remoteUrl}</span>
              ) : (
                <span className="text-muted-foreground">Not connected</span>
              )}
            </Fact>
            <Fact label="Worktrees">
              <Layers className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="tabular-nums">{overview?.worktrees ?? 0}</span>
            </Fact>
            <Fact label="Branches">
              <span className="tabular-nums">{overview?.branches ?? 0}</span>
            </Fact>
            <Fact label="Default branch">
              {detail?.defaultBranch ? (
                <span className="truncate">{detail.defaultBranch}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Fact>
          </div>
        </Group>

        {isRepo && (
          <>
            <Group title="Worktrees" count={detail ? linked.length : undefined}>
              {!detail ? (
                <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Reading the repository…
                </div>
              ) : linked.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                  No worktrees — chats here run in the checkout itself.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {linked.map((wt) => (
                    <WorktreeRow
                      key={wt.path}
                      wt={wt}
                      root={root}
                      onRemoved={() => {
                        // Both halves: the list here *and* the "Worktrees"
                        // count in the grid above, which comes from the
                        // overview and would otherwise lie until Recheck.
                        void loadProjectDetail(root, true)
                        void loadProjects()
                      }}
                    />
                  ))}
                </div>
              )}
            </Group>

            {detail && detail.branches.length > 0 && (
              <Group title="Branches" count={detail.branches.length}>
                <div className="flex flex-wrap gap-1.5">
                  {detail.branches.slice(0, BRANCH_CHIPS).map((b) => (
                    <span
                      key={b.name}
                      className={cn(
                        'rounded px-2 py-1 font-mono text-[11px]',
                        b.name === detail.defaultBranch
                          ? 'bg-primary/15 text-primary'
                          : b.checkedOut
                            ? 'bg-secondary text-foreground'
                            : 'bg-secondary/60 text-muted-foreground'
                      )}
                    >
                      {b.name}
                    </span>
                  ))}
                  {/* A forty-branch repo is a count, not forty chips: the list
                      is sorted by last commit, so the ones that fit are the
                      ones anyone is looking for. */}
                  {detail.branches.length > BRANCH_CHIPS && (
                    <span className="px-1 py-1 text-[11px] text-muted-foreground">
                      +{detail.branches.length - BRANCH_CHIPS} more
                    </span>
                  )}
                </div>
              </Group>
            )}
          </>
        )}

        {/* Two states, two switches. They were verbs in a context menu, which
            is why hiding a project used to hide the only control that could
            unhide it — a switch says what is true now and offers the way back
            in the same gesture. Turning either one *on* still asks, because
            both take a whole project off the sidebar in one click; turning it
            off is the undo and asks nothing. */}
        <Group title="In the sidebar">
          <div className="rounded-lg border border-border">
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">Show in the sidebar</div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  Off takes the project and its {chatCount === 1 ? 'chat' : 'chats'} out of the
                  sidebar, the chat search and ⌘N. Nothing is deleted.
                </div>
              </div>
              <SwitchPill
                on={!hidden}
                label={`Show ${label} in the sidebar`}
                onChange={() =>
                  hidden ? setProjectHidden(root, false) : onPrompt({ kind: 'hide', cwd: root })
                }
              />
            </div>
            <div className="mx-4 h-px bg-border" />
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Archive className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] font-medium">Archived</span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  Folds the project into the sidebar’s Archived section instead of listing it with
                  the rest.
                </div>
              </div>
              <SwitchPill
                on={archived}
                label={`Archive ${label}`}
                onChange={() =>
                  archived
                    ? setProjectArchived(root, false)
                    : onPrompt({ kind: 'archive', cwd: root })
                }
              />
            </div>
          </div>
        </Group>
      </div>
    </div>
  )
}

export function ProjectsSection(): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const projectNames = useApp((s) => s.projectNames)
  const projectOrder = useApp((s) => s.projectOrder)
  const projects = useApp((s) => s.projects)
  const projectsLoading = useApp((s) => s.projectsLoading)
  const loadProjects = useApp((s) => s.loadProjects)

  const [prompt, setPrompt] = React.useState<ProjectPrompt | null>(null)
  const [query, setQuery] = React.useState('')
  const [picked, setPicked] = React.useState<string | null>(null)

  // Re-read on open, the way Providers does: the reason to be here is very
  // often that something about a folder just changed outside the app.
  React.useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const groups = React.useMemo(
    () => projectGroups(visibleChats(chats), projectOrder),
    [chats, projectOrder]
  )

  const q = query.trim().toLowerCase()
  const shown = q
    ? groups.filter(
        (g) =>
          projectLabel(g.cwd, projectNames).toLowerCase().includes(q) ||
          g.cwd.toLowerCase().includes(q)
      )
    : groups

  // The selection falls back rather than being *stored*: a project can be
  // removed, or filtered out of the list under it, and a pane showing a project
  // that is not in the list beside it is the layout lying.
  const selected = shown.some((g) => g.cwd === picked) ? picked : (shown[0]?.cwd ?? null)
  const selectedGroup = shown.find((g) => g.cwd === selected)
  const missing = groups.filter((g) => projects[g.cwd] && !projects[g.cwd]!.exists).length

  return (
    <div className="flex min-h-0 flex-1">
      {/* The list pane. It is the section's navigation, so it carries the
          section's own heading and its filter. */}
      <div className="flex w-[264px] shrink-0 flex-col border-r border-border">
        <div className="px-3 pt-4 pb-2.5">
          {/* The pane's heading is the *count*, not the word "Projects" — the
              settings nav says that, highlighted, 130px to the left. A label
              that repeats the one beside it is a line of chrome; a count is a
              fact you did not have. */}
          <h2 className="mb-2 px-1 text-[12px] font-medium text-muted-foreground">
            {groups.length} {groups.length === 1 ? 'project' : 'projects'}
          </h2>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter projects"
            className="h-8 text-[13px]"
          />
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {shown.map((g) => (
            <ProjectRow
              key={g.cwd}
              root={g.cwd}
              label={projectLabel(g.cwd, projectNames)}
              chatCount={g.chats.length}
              overview={projects[g.cwd]}
              selected={g.cwd === selected}
              onSelect={() => setPicked(g.cwd)}
            />
          ))}
          {shown.length === 0 && (
            <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">
              {groups.length === 0 ? 'No projects yet.' : `Nothing matches “${query}”.`}
            </div>
          )}
        </div>

        {/* Two facts about the whole list live at its foot, where they belong
            to the list rather than to whichever project is open. */}
        <div className="shrink-0 border-t border-border px-3 py-2.5">
          {missing > 0 && (
            <div className="mb-2 flex items-start gap-1.5 px-1 text-[11px] text-warning">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              <span>
                {missing === 1
                  ? '1 folder is no longer on disk'
                  : `${missing} folders are no longer on disk`}
              </span>
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            disabled={projectsLoading}
            onClick={() => void loadProjects(true)}
          >
            {projectsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Recheck all
          </Button>
        </div>
      </div>

      {selected && selectedGroup ? (
        <ProjectDetailPane
          // Keyed on the project so per-project state inside the pane (a
          // worktree row's error, its busy flag) cannot survive a change of
          // selection and be read as belonging to the new one.
          key={selected}
          root={selected}
          chatCount={selectedGroup.chats.length}
          overview={projects[selected]}
          onPrompt={setPrompt}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <div className="max-w-sm text-center">
            <FolderGit2 className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-3 text-[13px] font-medium">
              {groups.length === 0 ? 'No projects yet' : 'No project selected'}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {groups.length === 0
                ? 'Start a chat in a folder and it appears here, with its branch, its remote and the worktrees your chats leave behind.'
                : 'Pick one from the list to see its repository, worktrees and branches.'}
            </p>
          </div>
        </div>
      )}

      <ProjectDialogs prompt={prompt} onClose={() => setPrompt(null)} />
    </div>
  )
}

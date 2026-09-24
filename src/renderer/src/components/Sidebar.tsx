import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MessageCircleQuestion,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquareStack,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_LABELS, projectRoot } from '@shared/types'
import { projectGroups, projectLabel as labelOf } from '@/lib/projects'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { ProviderMark, PROVIDER_COLOR } from '@/components/ui/provider-mark'
import { ChatDeleteDialog } from '@/components/ChatDeleteDialog'
import { ProjectDialogs, type ProjectPrompt } from '@/components/ProjectDialogs'
import { cn, missingTag, MISSING_TITLE } from '@/lib/utils'
import { dateGroup, relativeTime, shortenPath } from '@/lib/format'
import { REVEAL_LABEL } from '@/lib/platform'
import { chatActivity, projectActivity, type ChatActivity } from '@/lib/chatActivity'
import {
  COLUMN_DRAG_MIME,
  draggedColumn,
  setDraggedThread,
  THREAD_DRAG_MIME
} from '@/lib/threadDrag'
import { draftSummary, sortedProjectDrafts, type ProjectDraft } from '@/lib/drafts'
import { chatMeta, columnsOf, listedChats, useApp } from '@/store'
import { UpdateBanner } from '@/components/UpdateBanner'
import { UsagePanel } from '@/components/UsagePanel'
import { Button } from '@/components/ui/button'
import { DotSpinner } from '@/components/ui/dot-spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * The line a detailed row carries under its title — what makes the row stand on
 * its own without a project heading above it.
 *
 * In a repo that is the project and the branch, because the branch is the thing
 * that differs between two chats that otherwise look identical (same project,
 * same title stem, one on a worktree branch and one on main). Outside a repo it
 * is just the folder path: the project name is the last segment of it, so
 * printing both would say the same word twice.
 */
interface ChatDetail {
  kind: 'branch' | 'path'
  text: string
}

/**
 * Everything a chat row can do, as one object built once per Sidebar mount.
 *
 * Each handler takes the chat (or project) it acts on rather than closing over
 * it, which is what lets a single object serve every row — and one *stable*
 * object is the point: `ChatItem` is memoized, and a fresh `onOpen` per render
 * would defeat that for every row at once. Anything volatile a handler needs
 * (a project's chat count, which is derived from `chats`) is read at click time
 * through `Sidebar`'s `latest` ref rather than captured here, so a stable
 * identity never means a stale answer.
 */
interface RowActions {
  open(chat: ChatMeta): void
  rename(chat: ChatMeta): void
  remove(chat: ChatMeta): void
  /** Move the chat to (or out of) the Pinned section at the top of the sidebar. */
  togglePin(chat: ChatMeta): void
  /**
   * Take the chat out of the sidebar without deleting it. One direction only:
   * a row that is on screen is by definition not archived, and the way back is
   * Settings → Archive.
   */
  archive(chat: ChatMeta): void
  /** Start another chat — possibly on another provider — in the same worktree. */
  newInWorktree(chat: ChatMeta): void
  newChatIn(cwd: string): void
  renameProject(cwd: string): void
  manageProjects(): void
  revealProject(cwd: string): void
  setProjectArchived(cwd: string, archived: boolean): void
  confirmProject(kind: 'archive' | 'hide', cwd: string): void
  removeProject(cwd: string): void
}

/** A project's own actions — the compact project row's menu, and the tail of a
 *  chat row's when no project row is on screen to carry them. */
function ProjectMenuItems({
  cwd,
  archived,
  actions
}: {
  cwd: string
  archived: boolean
  actions: RowActions
}): React.JSX.Element {
  return (
    <>
      <ContextMenuItem onClick={() => actions.renameProject(cwd)}>
        <Pencil /> Rename project…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.revealProject(cwd)}>
        <FolderOpen /> {REVEAL_LABEL}
      </ContextMenuItem>
      {/* The full list, where a project is a row rather than a right-click:
          the only place a *hidden* project can be found again, which is why it
          sits on the menu that hides them. */}
      <ContextMenuItem onClick={actions.manageProjects}>
        <FolderGit2 /> Manage projects…
      </ContextMenuItem>
      <ContextMenuSeparator />
      {archived ? (
        <ContextMenuItem onClick={() => actions.setProjectArchived(cwd, false)}>
          <ArchiveRestore /> Unarchive project
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => actions.confirmProject('archive', cwd)}>
          <Archive /> Archive project…
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => actions.confirmProject('hide', cwd)}>
        <EyeOff /> Hide project…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem destructive onClick={() => actions.removeProject(cwd)}>
        <Trash2 /> Delete project…
      </ContextMenuItem>
    </>
  )
}

/** The project a chat row has to name in its own menu, already labelled. */
interface RowProjectMenu {
  cwd: string
  label: string
  archived: boolean
}

const sameActivity = (a: ChatActivity, b: ChatActivity): boolean =>
  a.kind === b.kind &&
  a.label === b.label &&
  (a.kind === 'background' ? a.count : 0) === (b.kind === 'background' ? b.count : 0)

const sameDetail = (a: ChatDetail | null, b: ChatDetail | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.text === b.text)

/**
 * A project's mark, as a row needs it — everything to draw one, nothing to
 * look up. Passed down rather than read per row: forty rows over five projects
 * would be forty store subscriptions for a field that changes once, where the
 * sidebar already holds the map with one.
 */
interface ProjectMark {
  root: string
  name: string
  icon: string | null
}

const sameMark = (a: ProjectMark, b: ProjectMark): boolean =>
  a === b || (a.root === b.root && a.name === b.name && a.icon === b.icon)

const sameProjectMenu = (a: RowProjectMenu | null, b: RowProjectMenu | null): boolean =>
  a === b ||
  (!!a && !!b && a.cwd === b.cwd && a.label === b.label && a.archived === b.archived)

/**
 * Marks a chat the CLI draws itself. Two rows carry it because the sidebar has
 * two densities, and a chat you cannot type into from the composer has to be
 * recognizable before you open it — the alternative is clicking a row expecting
 * a transcript and getting a terminal.
 */
function TerminalMark({ active }: { active: boolean }): React.JSX.Element {
  return (
    <WithTooltip label="Terminal chat">
      <SquareTerminal
        className={cn(
          'size-3 shrink-0 transition-colors',
          active ? 'text-sidebar-foreground/70' : 'text-sidebar-foreground/40'
        )}
      />
    </WithTooltip>
  )
}

/**
 * The backend, where it no longer has an avatar: a bare 11px mark in its own
 * brand colour, at the right end of the row's second line.
 *
 * It was a corner badge on the tile above for one build, and a badge is the
 * wrong shape for this mark at this size — punched out of the sidebar's ground
 * it reads as a chip taken out of the project's icon, and OpenAI's knot at 9px
 * is a smudge. Out here nothing is occluded and nothing is shrunk past
 * legibility. It sits on the second line rather than beside the title because
 * the title is what the row is *for* and was down to three words on a 264px
 * sidebar; the rank is right either way — the project is which list this row is
 * in, the backend is a property of the row.
 */
/**
 * A pinned chat, said on the chat.
 *
 * It replaces a "Pinned" heading over the block. Being pinned is a property of
 * *this chat*, not of a group, and the heading could only say it for a block
 * whose membership is otherwise invisible — move a pin and the only thing that
 * changed was which side of a divider a row sat on. The glyph travels with the
 * row, so a pinned chat is recognizable wherever it is drawn.
 */
function PinMark({ active }: { active: boolean }): React.JSX.Element {
  return (
    <WithTooltip label="Pinned">
      <span
        className={cn(
          'flex shrink-0 items-center transition-colors',
          active ? 'text-sidebar-foreground/70' : 'text-sidebar-foreground/45'
        )}
      >
        <Pin className="size-3" />
      </span>
    </WithTooltip>
  )
}

function RowProvider({
  chat,
  active,
  titled = false
}: {
  chat: ChatMeta
  active: boolean
  /** Name the chat in the tooltip — for a thread's marks, which stand for different chats. */
  titled?: boolean
}): React.JSX.Element {
  const terminal = chat.surface === 'terminal' && !chat.sessionId
  const label = terminal ? 'Terminal' : PROVIDER_LABELS[chat.provider]
  return (
    <WithTooltip label={titled ? `${label} · ${chat.title || 'New chat'}` : label}>
      <span
        className={cn(
          'flex shrink-0 items-center transition-opacity',
          active ? 'opacity-100' : 'opacity-70 group-hover:opacity-100'
        )}
        style={terminal ? undefined : { color: PROVIDER_COLOR[chat.provider] }}
      >
        {terminal ? (
          <SquareTerminal className="size-3 text-sidebar-foreground/60" />
        ) : (
          <ProviderMark provider={chat.provider} className="size-[11px]" />
        )}
      </span>
    </WithTooltip>
  )
}

function ChatItemRow({
  chat,
  now,
  active,
  activity,
  titling,
  sides,
  detail,
  mark,
  projectMenu,
  actions
}: {
  chat: ChatMeta
  /** Minute-aligned clock supplied by the sidebar so relative labels advance. */
  now: number
  active: boolean
  /** Across every open column of this chat's thread — see `ThreadView`. */
  activity: ChatActivity
  titling: boolean
  /** The other chats open in this row's thread, in column order; empty for a plain chat. */
  sides: ChatMeta[]
  /** Second line for a detailed row; null renders the compact single-line row. */
  detail: ChatDetail | null
  /**
   * The project this row is in, always — the avatar column means one thing or
   * it means nothing.
   *
   * It was suppressed under a filter at first, on the reasoning that the
   * control at the head of the list had already named the project. That is
   * true of the *word* and false of the column: every row swapped its mark for
   * the provider's the moment a filter went on, so the one fixed point in the
   * list became the thing that moved. Repeating a mark down a filtered list
   * costs nothing; a column that changes what it depicts costs the reader the
   * habit they were building.
   *
   * Where it is *drawn* still differs by density — a detailed row has an
   * avatar column, a compact row is one line and only the Pinned section needs
   * one, since every other compact row sits under its project's own row.
   */
  mark: ProjectMark
  /**
   * This chat's *project*, whose actions are appended to the right-click menu.
   * Detailed mode has no project rows to carry them, and a mode where archiving
   * or hiding a project silently disappears is not a mode — so the row the
   * project is named on carries them instead. Null in compact mode, where the
   * project row's own menu already does.
   */
  projectMenu: RowProjectMenu | null
  actions: RowActions
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const onOpen = (): void => actions.open(chat)
  const onRename = (): void => actions.rename(chat)
  const onDelete = (): void => actions.remove(chat)
  const onTogglePin = (): void => actions.togglePin(chat)
  const onArchive = (): void => actions.archive(chat)
  const onNewInWorktree = (): void => actions.newInWorktree(chat)
  const pinned = chat.pinnedAt !== undefined
  // Cursor-style: inactive chats are muted, the open one is bright — the
  // brightness gap (plus the filled highlight) marks the active chat.
  // Bright, NOT bold — Cursor keeps regular weight, which reads cleaner.
  const titleClass = cn(
    'min-w-0 flex-1 truncate text-[13px] transition-colors',
    active
      ? 'text-sidebar-foreground'
      : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground/90',
    titling && 'title-forming'
  )
  // The timestamp yields to the ⋯ button on hover; both occupy the same corner.
  // The headline's ladder is raised: a detailed row's title is the one thing on
  // its line and has to read as the row's subject, so an inactive one sits much
  // closer to full brightness than compact's does. The gap to the active row is
  // still there, and the filled pill carries the rest of that signal.
  const detailTitleClass = cn(
    'min-w-0 truncate text-[13px] transition-colors',
    active
      ? 'text-sidebar-foreground'
      : 'text-sidebar-foreground/85 group-hover:text-sidebar-foreground',
    titling && 'title-forming'
  )
  const trailing = (
    <span
      className={cn(
        'flex shrink-0 items-center text-[11px] text-muted-foreground/80 transition-opacity group-hover:opacity-0',
        menuOpen && 'opacity-0'
      )}
    >
      {activity.kind !== 'idle' ? (
        <ActivityIndicator activity={activity} />
      ) : (
        relativeTime(chat.updatedAt, now)
      )}
    </span>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            // A chat row can be dragged into the thread on screen, to become one
            // of its columns (see `ThreadView`'s drop target).
            draggable={chat.surface !== 'terminal'}
            onDragStart={(e) => {
              e.dataTransfer.setData(THREAD_DRAG_MIME, chat.id)
              e.dataTransfer.effectAllowed = 'move'
              setDraggedThread(chat.id)
            }}
            onDragEnd={() => setDraggedThread(null)}
            className={cn(
              'group relative rounded-md transition-colors',
              // Active fill is a foreground-tinted overlay, not the sidebar-accent
              // token — the latter is barely lighter than the sidebar and vanishes
              // over the frost. This reliably reads as a raised pill in both themes.
              active ? 'bg-sidebar-foreground/[0.14] dark:bg-sidebar-foreground/[0.16]' : 'hover:bg-sidebar-accent/60'
            )}
          />
        }
      >
      {detail ? (
        // **Three lines, and the title is the headline.** Every arrangement
        // before this one led with the title and hung the row's facts off it,
        // which meant the title shared its line with a timestamp — and on a
        // 264px sidebar that is a third of the only thing the row is for. Here
        // the context comes *first*, small and muted: whose project this is,
        // and when. The title then gets a line to itself, at full width and a
        // step brighter than everything around it, so it reads as the headline
        // of the row rather than its first field. Where the work happens —
        // branch or folder — closes it, with the row's marks right-aligned
        // beside it. No column of avatars either: the mark rides the context
        // line, which is what leaves the title the whole row.
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 flex-col gap-1 px-2 py-2 text-left outline-none"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground/70">
            {/* Identity, not state — so it keeps its colour on every row and
                the brightness ladder that marks the active chat stays the
                title's job. Inactive rows only take the edge off it. */}
            <ProjectAvatar
              size="sm"
              root={mark.root}
              name={mark.name}
              icon={mark.icon}
              className={cn(
                'size-[18px] rounded-[6px] transition-opacity',
                !active && 'opacity-85 group-hover:opacity-100'
              )}
            />
            <span className="min-w-0 truncate">{mark.name}</span>
            {pinned && <PinMark active={active} />}
            <span className="ml-auto pl-2">{trailing}</span>
          </span>
          <span className={detailTitleClass}>{chat.title || 'New chat'}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground/55">
            <span className="flex min-w-0 items-center gap-1">
              {detail.kind === 'branch' ? (
                <GitBranch className="size-3 shrink-0" />
              ) : (
                <Folder className="size-3 shrink-0" />
              )}
              <span className="min-w-0 truncate">{detail.text}</span>
            </span>
            {/* Pushed to the right edge rather than trailing the branch, so
                they form a column instead of landing at a different x on every
                row. `ml-auto` and not a spacer: with all three absent the
                cluster takes no space at all. */}
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              {/* A chat you cannot type into has to be recognizable before you
                  open it, and the mark beside it is the provider's once a CLI
                  session has been found. */}
              {chat.surface === 'terminal' && chat.sessionId && (
                <TerminalMark active={active} />
              )}
              <ThreadProviders chat={chat} sides={sides} active={active} />
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left outline-none"
        >
          {/* Compact rows sit under their project's own row, which already
              wears the mark — except the Pinned section's, which are lifted out
              of their groups and share one list across every project. */}
          {pinned && <PinMark active={active} />}
          {pinned && (
            <WithTooltip label={mark.name} side="right">
              <ProjectAvatar
                size="sm"
                root={mark.root}
                name={mark.name}
                icon={mark.icon}
                className={cn('transition-opacity', !active && 'opacity-80 group-hover:opacity-100')}
              />
            </WithTooltip>
          )}
          {chat.worktree && (
            <WithTooltip label={`${chat.worktree.branch} · ${chat.cwd}`}>
              <GitBranch
                className={cn(
                  'size-3 shrink-0 transition-colors',
                  active ? 'text-sidebar-foreground/70' : 'text-sidebar-foreground/40'
                )}
              />
            </WithTooltip>
          )}
          {chat.surface === 'terminal' && <TerminalMark active={active} />}
          <span className={titleClass}>{chat.title || 'New chat'}</span>
          {sides.length > 0 && <ThreadProviders chat={chat} sides={sides} active={active} />}
          {trailing}
        </button>
      )}
      <div
        className={cn(
          'absolute right-1 opacity-0 transition-opacity group-hover:opacity-100',
          // Sits where the timestamp it replaces was, which on a two-line row is
          // the first line rather than the middle.
          detail ? 'top-1' : 'top-1/2 -translate-y-1/2',
          menuOpen && 'opacity-100'
        )}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" className="bg-sidebar-accent/80 backdrop-blur" aria-label="Chat options">
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={onTogglePin}>
              {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRename}>
              <Pencil /> Rename
            </DropdownMenuItem>
            {chat.worktree && (
              <DropdownMenuItem onClick={onNewInWorktree}>
                <GitBranch /> New chat in this worktree
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onArchive}>
              <Archive /> Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onTogglePin}>
          {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onClick={onRename}>
          <Pencil /> Rename
        </ContextMenuItem>
        {chat.worktree && (
          <ContextMenuItem onClick={onNewInWorktree}>
            <GitBranch /> New chat in this worktree
          </ContextMenuItem>
        )}
        {/* Above the separator: archiving destroys nothing, and sitting beside
            Delete is how it gets read as one of the dangerous ones. */}
        <ContextMenuItem onClick={onArchive}>
          <Archive /> Archive
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onClick={onDelete}>
          <Trash2 /> Delete
        </ContextMenuItem>
        {projectMenu && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{projectMenu.label}</ContextMenuLabel>
              <ContextMenuItem onClick={() => actions.newChatIn(projectMenu.cwd)}>
                <Plus /> New chat here
              </ContextMenuItem>
              <ProjectMenuItems
                cwd={projectMenu.cwd}
                archived={projectMenu.archived}
                actions={actions}
              />
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * A chat row re-renders only when something it draws actually moved.
 *
 * The sidebar is one of the largest trees in the app and every subscriber of
 * `chats` re-renders it whole, so the rows are where that lands: a turn's
 * status and permission traffic would otherwise rebuild every row's button,
 * avatar, tooltip and two menus several times over. `chats.map` preserves the
 * identity of every untouched chat, so the `chat` check below is what does most
 * of the work.
 *
 * The comparison is written out rather than left to `React.memo`'s default
 * because two props are freshly-built values — `chatActivity` and `chatDetail`
 * return a new object per call, which a shallow compare reads as a change every
 * time. Both are flat, so comparing them by value is exact. Being explicit
 * means a prop added later is silently *excluded*: add it here too.
 */
const ChatItem = React.memo(
  ChatItemRow,
  (prev, next) =>
    prev.chat === next.chat &&
    prev.active === next.active &&
    prev.titling === next.titling &&
    sameSides(prev.sides, next.sides) &&
    prev.actions === next.actions &&
    sameActivity(prev.activity, next.activity) &&
    (prev.activity.kind !== 'idle' ||
      relativeTime(prev.chat.updatedAt, prev.now) === relativeTime(next.chat.updatedAt, next.now)) &&
    sameDetail(prev.detail, next.detail) &&
    sameMark(prev.mark, next.mark) &&
    sameProjectMenu(prev.projectMenu, next.projectMenu)
)

/**
 * How many chats the detailed mode's flat list shows at a time. Per-batch
 * rather than per-project (the compact mode's `chatsPerProject`) because the
 * list has no projects to divide by — same idea, different unit.
 */
const FLAT_BATCH = 40

// Drag bounds for the sidebar width.
const SIDEBAR_DEFAULT = 264
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 420

/** A command-palette-style modal to search chats across every project. */
function SearchChatsDialog({
  open,
  onOpenChange,
  chats,
  now,
  onOpen
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chats: ChatMeta[]
  now: number
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [q, setQ] = React.useState('')
  const [idx, setIdx] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const projectNames = useApp((s) => s.projectNames)
  const projectIcons = useApp((s) => s.projectIcons)

  React.useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    // Base UI moves focus into the popup; nudge it to the input.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  const results = React.useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? chats.filter((c) => (c.title || 'New chat').toLowerCase().includes(term))
      : chats
    return list.slice(0, 50)
  }, [q, chats])

  React.useEffect(() => setIdx(0), [q])

  const choose = (c: ChatMeta): void => {
    onOpen(c.id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[14%] max-w-lg translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (results[idx]) choose(results[idx])
              }
            }}
            placeholder="Search chats across projects…"
            spellCheck={false}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground/70">
              {q.trim() ? 'No chats match your search.' : 'No chats yet.'}
            </div>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(c)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                  i === idx && 'bg-accent'
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.title || 'New chat'}</span>
                {/* This list is every project at once and groups by nothing, so
                    the project caption is what tells two similarly-titled chats
                    apart — and a caption is read, where a mark is recognized. */}
                <span className="flex max-w-32 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/70">
                  <ProjectAvatar
                    size="xs"
                    root={projectRoot(c)}
                    name={labelOf(projectRoot(c), projectNames)}
                    icon={projectIcons[projectRoot(c)] ?? null}
                  />
                  <span className="min-w-0 truncate">{labelOf(projectRoot(c), projectNames)}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground/50">
                  {relativeTime(c.updatedAt, now)}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Which project?" — the one question starting a chat has always had, and the
 * one it never asked. `New chat` (and ⌘N) used to drop you into whatever folder
 * happened to be selected, which is invisible state; the per-project ＋ in
 * compact mode was the only place the answer was ever explicit, and detailed
 * mode has no project rows to put one on. The project filter is the other
 * explicit pick: if the sidebar is already scoped to one folder, the chooser
 * is skipped and the chat starts there.
 *
 * Same palette shape as the chat search above: type to narrow, arrows to move,
 * Enter to start. Ordered by recency (the chat list arrives newest-first), so
 * the project you were last in is the default pick and the common case is
 * ⌘N-Enter.
 *
 * It is also where projects get **pruned**, because it is the only place the
 * whole list appears as rows — detailed mode has no project rows, so removal
 * otherwise means finding a chat that happens to belong to the project you want
 * gone. The ✕ hands off to the same confirm dialog the sidebar menu opens; a
 * palette where Enter starts a chat has no business deleting anything on one
 * click.
 */
function NewChatDialog({
  open,
  onOpenChange,
  projects,
  onPick,
  onBrowse,
  onRemove
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: { cwd: string; label: string; count: number }[]
  onPick: (cwd: string) => void
  onBrowse: () => void
  onRemove: (cwd: string) => void
}): React.JSX.Element {
  const [q, setQ] = React.useState('')
  const [idx, setIdx] = React.useState(0)
  const [missing, setMissing] = React.useState<Record<string, boolean>>({})
  const inputRef = React.useRef<HTMLInputElement>(null)
  // The marks the sidebar has already resolved. Read here rather than passed
  // in because this dialog's project list is its own (recency-ordered, archived
  // ones included) — threading a second list beside it to carry one field each
  // is how the two get to disagree about which project a row is.
  const projectIcons = useApp((s) => s.projectIcons)

  React.useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // Which folders are gone. Checked on open rather than held in the store: it's
  // one stat per project against a list this size, and a folder can vanish
  // between two openings of the same dialog. A project whose folder is missing
  // is never *hidden* — its chats are still readable, and the row is the only
  // handle for deleting them.
  React.useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all(
      projects.map(async (p) => [p.cwd, (await window.api.statPath(p.cwd)) !== 'dir'] as const)
    ).then((pairs) => {
      if (alive) setMissing(Object.fromEntries(pairs.filter(([, gone]) => gone)))
    })
    return () => {
      alive = false
    }
    // Deliberately keyed on `open` alone: re-running per keystroke would stat
    // the same folders on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const results = React.useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return projects
    // Path as well as label: a project renamed in the sidebar is still findable
    // by the folder it actually is. "missing" matches the dead ones as a group,
    // which is the whole reason someone opens this list to prune it.
    const byWord = term.length >= 3 && 'missing'.startsWith(term)
    return projects.filter(
      (p) =>
        p.label.toLowerCase().includes(term) ||
        p.cwd.toLowerCase().includes(term) ||
        (byWord && missing[p.cwd])
    )
  }, [q, projects, missing])

  React.useEffect(() => setIdx(0), [q])

  // "Open another folder…" is the last row, so it takes part in the keyboard
  // walk instead of being a mouse-only escape hatch.
  const rows = results.length + 1
  const choose = (i: number): void => {
    onOpenChange(false)
    if (i >= results.length) onBrowse()
    else onPick(results[i].cwd)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[14%] max-w-lg translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Start a new chat</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(i + 1, rows - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(idx)
              } else if ((e.key === 'Backspace' || e.key === 'Delete') && e.metaKey) {
                // ⌘⌫ on the selected row: the ✕ is visible on it, so a keyboard
                // walk down the list can prune without reaching for the mouse.
                const p = results[idx]
                if (p) {
                  e.preventDefault()
                  onRemove(p.cwd)
                }
              }
            }}
            placeholder="Start a chat in…"
            spellCheck={false}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.map((p, i) => (
            <div
              key={p.cwd}
              onMouseEnter={() => setIdx(i)}
              className={cn(
                'flex w-full items-center rounded-md transition-colors',
                i === idx && 'bg-accent'
              )}
            >
              <button
                type="button"
                onClick={() => choose(i)}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 text-left"
              >
                {/* The same mark as the sidebar's rows and the filter's. This
                    is the only surface that lists every project at once, so a
                    generic folder here would be the one place the projects all
                    look alike. */}
                <ProjectAvatar
                  size="sm"
                  root={p.cwd}
                  name={p.label}
                  icon={projectIcons[p.cwd] ?? null}
                  dimmed={missing[p.cwd]}
                />
                <span
                  className={cn(
                    'min-w-0 truncate text-[13px]',
                    missing[p.cwd] && 'text-muted-foreground'
                  )}
                >
                  {p.label}
                </span>
                {missing[p.cwd] && (
                  <span className={missingTag} title={MISSING_TITLE}>
                    missing
                  </span>
                )}
                <span className="flex-1" />
                <span className="max-w-56 shrink-0 truncate text-[11px] text-muted-foreground/60">
                  {shortenPath(p.cwd, window.api.home)}
                </span>
                <span className="w-6 shrink-0 text-right text-[11px] text-muted-foreground/50">
                  {p.count}
                </span>
              </button>
              <WithTooltip label="Remove project  ⌘⌫">
                <button
                  type="button"
                  aria-label={`Remove ${p.label}`}
                  onClick={() => onRemove(p.cwd)}
                  className={cn(
                    'mr-1.5 ml-1 shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:bg-secondary hover:text-destructive',
                    i === idx ? 'opacity-100' : 'opacity-0'
                  )}
                >
                  <X className="size-3.5" />
                </button>
              </WithTooltip>
            </div>
          ))}
          <button
            type="button"
            onMouseEnter={() => setIdx(results.length)}
            onClick={() => choose(results.length)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
              idx === results.length && 'bg-accent'
            )}
          >
            <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[13px]">Open another folder…</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One provider mark per chat open in the row's thread. The row is the thread,
 * so without this a chat with four columns reads the same as one with none —
 * and the activity beside it, which covers all of them, would look
 * misattributed. Marks rather than a count: the count said *how many* and left
 * *which* one click away, where the marks say both.
 */
function ThreadProviders({
  chat,
  sides,
  active
}: {
  chat: ChatMeta
  sides: ChatMeta[]
  active: boolean
}): React.JSX.Element {
  if (!sides.length) return <RowProvider chat={chat} active={active} />
  return (
    <span className="flex shrink-0 items-center gap-1">
      {[chat, ...sides].map((c) => (
        <RowProvider key={c.id} chat={c} active={active} titled />
      ))}
    </span>
  )
}

function sameSides(a: ChatMeta[], b: ChatMeta[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

/**
 * The sidebar as a drop target for a thread's column: dropped here, the chat
 * leaves its thread and becomes a row of its own — the reverse of dragging a row
 * onto a thread. Only a side chat can leave (the thread's own chat *is* the
 * thread), so the target offers itself only for one; the dragged id comes from
 * `threadDrag`, because the payload is unreadable until the drop.
 */
function useLeaveThreadDrop(): {
  title: string | null
  handlers: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
} {
  const [title, setTitle] = React.useState<string | null>(null)
  React.useEffect(() => {
    const clear = (): void => setTitle(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])
  const leaving = (e: React.DragEvent): ChatMeta | null => {
    if (!Array.from(e.dataTransfer.types).includes(COLUMN_DRAG_MIME)) return null
    const s = useApp.getState()
    const chat = chatMeta(s, draggedColumn())
    return chat?.sideOf && chat.sideOf === s.activeId ? chat : null
  }
  return {
    title,
    handlers: {
      onDragOver: (e) => {
        const chat = leaving(e)
        if (!chat) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const next = chat.title?.trim() || 'New chat'
        if (next !== title) setTitle(next)
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTitle(null)
      },
      onDrop: (e) => {
        setTitle(null)
        const chat = leaving(e)
        if (!chat) return
        e.preventDefault()
        void useApp.getState().leaveThread(chat.id)
      }
    }
  }
}

function ActivityIndicator({ activity }: { activity: ChatActivity }): React.JSX.Element | null {
  if (activity.kind === 'idle') return null

  return (
    <WithTooltip label={activity.label} side="right">
      <span
        role="status"
        aria-label={activity.label}
        className="inline-flex h-4 shrink-0 items-center gap-0.5 tabular-nums"
      >
        {activity.kind === 'needs-input' ? (
          <MessageCircleQuestion className="size-3.5 text-warning" />
        ) : activity.kind === 'background' ? (
          <Bot className="size-3.5 animate-pulse-soft text-primary" />
        ) : (
          <DotSpinner className="text-primary" />
        )}
      </span>
    </WithTooltip>
  )
}

/**
 * A prompt typed on the home screen and never sent.
 *
 * Deliberately not a `ChatItem`: there is no chat behind it, and creating one
 * eagerly would freeze a provider/model pair and — for a `new` worktree target —
 * leave a real checkout and branch on disk for a message that was never sent.
 * See `lib/drafts.ts`.
 */
function DraftItem({
  draft,
  mark,
  onOpen,
  onDiscard
}: {
  draft: ProjectDraft
  /** Project this belongs to — always, for the reason a chat row's is. */
  mark: ProjectMark
  onOpen: () => void
  onDiscard: () => void
}): React.JSX.Element {
  return (
    <div
      data-draft={draft.cwd}
      className="group relative rounded-md transition-colors hover:bg-sidebar-accent/60"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-2 py-1.5 pr-7 pl-2 text-left outline-none"
      >
        {/* Laid out as a chat row is, because it sits directly above them: the
            project takes the avatar column, and the mark that says what *kind*
            of row this is goes to the end of the second line, where a chat row
            keeps its provider. */}
        <ProjectAvatar
          size="md"
          root={mark.root}
          name={mark.name}
          icon={mark.icon}
          className="mt-px size-7 rounded-[9px] text-[11px]"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="min-w-0 truncate text-[13px] text-sidebar-foreground/55 transition-colors group-hover:text-sidebar-foreground/90">
            {/* Attachments with no text are still a draft worth coming back to,
                and there is nothing to quote for them. */}
            {draftSummary(draft.text) || 'Attachment'}
          </span>
          {(
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground/65">
              <span className="min-w-0 truncate">{mark.name}</span>
              <WithTooltip label="Unsent draft">
                <span className="ml-auto flex shrink-0 items-center pl-2">
                  <PencilLine className="size-3" />
                </span>
              </WithTooltip>
            </span>
          )}
        </span>
      </button>
      {/* No confirm, like the queued-message ✕ in ChatView: one unsent line, and
          the row is only reachable by hovering it. */}
      <WithTooltip label="Discard draft">
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Discard draft"
          className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </WithTooltip>
    </div>
  )
}

/**
 * Relative timestamps are derived from the wall clock, not app state. Wake the
 * sidebar on minute boundaries and immediately after returning to a visible
 * window; `ChatItem`'s comparator still skips rows whose displayed label did
 * not change, so hour/day-old histories do not all repaint every minute.
 */
function useMinuteNow(): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    let timer: number | undefined

    const arm = (at: number): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(tick, 60_000 - (at % 60_000) + 50)
    }
    const tick = (): void => {
      const at = Date.now()
      setNow(at)
      arm(at)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') tick()
    }

    arm(Date.now())
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return now
}

export function Sidebar(): React.JSX.Element {
  const now = useMinuteNow()
  // Every list on this surface derives from this one read — the chat rows, the
  // pins, the project groups, `projectChatCount` and ⌘N's project list — so the
  // side-chat filter belongs here rather than at each of them. A side chat is a
  // throwaway conversation in the right panel; showing up as history, or making
  // a project look like it has one more chat than it does, is the single thing
  // it must never do.
  //
  // Filtered in a memo rather than inside the selector: a selector that returns
  // a fresh array every call fails zustand's snapshot comparison on every read
  // and loops React into a crash — the same trap `NO_PERMISSIONS` exists for.
  const allChats = useApp((s) => s.chats)
  const chats = React.useMemo(() => listedChats(allChats), [allChats])
  const chatsById = React.useMemo(() => new Map(allChats.map((c) => [c.id, c])), [allChats])
  const activeId = useApp((s) => s.activeId)
  const statuses = useApp((s) => s.statuses)
  const sideColumns = useApp((s) => s.sideColumns)
  const sideColumnsByChat = useApp((s) => s.sideColumnsByChat)
  const permissions = useApp((s) => s.permissions)
  const backgroundJobs = useApp((s) => s.backgroundJobs)
  const titling = useApp((s) => s.titling)
  const openChat = useApp((s) => s.openChat)
  const renameChat = useApp((s) => s.renameChat)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const chatsPerProject = useApp((s) => s.chatsPerProject)
  // Hidden projects are removed from the sidebar entirely (unlike archived, which
  // stay in a collapsed section) but keep all their chats. Re-opening the folder
  // un-hides it (handled in the store's setSelectedCwd). Distinct from Delete,
  // which discards the chats.
  const hiddenProjects = useApp((s) => s.hiddenProjects)
  // Custom project display names (keyed by cwd); falls back to the folder basename.
  const projectNames = useApp((s) => s.projectNames)
  const projectLabel = (cwd: string): string => labelOf(cwd, projectNames)

  const projectDrafts = useApp((s) => s.projectDrafts)
  const openDraft = useApp((s) => s.openDraft)
  const discardProjectDraft = useApp((s) => s.discardProjectDraft)

  const detailed = useApp((s) => s.sidebarDensity) === 'detailed'
  const sidebarProject = useApp((s) => s.sidebarProject)
  const setSidebarProject = useApp((s) => s.setSidebarProject)
  const chatBranches = useApp((s) => s.chatBranches)
  const refreshChatBranches = useApp((s) => s.refreshChatBranches)
  const projectIcons = useApp((s) => s.projectIcons)
  const loadProjectIcons = useApp((s) => s.loadProjectIcons)
  // Branches are read for every chat's folder at once, so the trigger is the set
  // of folders — not each chat. Turn endings and worktree moves refresh it from
  // the store; this covers a cold start and a project appearing or leaving.
  const branchKey = detailed ? [...new Set(chats.map((c) => c.cwd))].sort().join('\n') : ''
  React.useEffect(() => {
    if (detailed) void refreshChatBranches()
  }, [detailed, branchKey, refreshChatBranches])

  // The project is no longer part of this: a detailed row draws its own mark
  // and names it on its own line, so this answers only "where in the project".
  const chatDetail = (chat: ChatMeta): ChatDetail => {
    // A worktree carries its branch on the chat itself, so those rows are
    // labelled before any git read lands.
    const branch = chat.worktree?.branch ?? chatBranches[chat.cwd]
    if (!branch) return { kind: 'path', text: shortenPath(chat.cwd, window.api.home) }
    return { kind: 'branch', text: branch }
  }

  const markFor = (root: string): ProjectMark => ({
    root,
    name: projectLabel(root),
    icon: projectIcons[root] ?? null
  })

  const newChatIn = (cwd: string | null): void => {
    if (cwd) setSelectedCwd(cwd)
    void openChat(null)
  }

  const openProject = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) {
      setSelectedCwd(dir)
      void openChat(null)
    }
  }

  const openSettings = useApp((s) => s.openSettings)
  const openUsage = useApp((s) => s.openUsage)
  const searchOpen = useApp((s) => s.searchOpen)
  const setSearchOpen = useApp((s) => s.setSearchOpen)
  const newChatOpen = useApp((s) => s.newChatOpen)
  const setNewChatOpen = useApp((s) => s.setNewChatOpen)
  const startNewChat = useApp((s) => s.startNewChat)
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null)
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const setChatPinned = useApp((s) => s.setChatPinned)
  const setChatArchived = useApp((s) => s.setChatArchived)
  const startInWorktree = useApp((s) => s.startInWorktree)
  /**
   * Which project question is open — rename, archive, hide or remove. The
   * dialogs themselves are `ProjectDialogs`, shared with Settings → Projects,
   * because archiving and hiding delete nothing but both take a whole project
   * out of the sidebar in one click, and in detailed mode they sit on a *chat's*
   * menu two rows under the chat-level Delete, where the project they act on is
   * named nowhere else on screen. Naming it is most of what the dialog is for;
   * the rest is saying how to get the project back, which is a different answer
   * for each and obvious for neither — and it must be the same answer wherever
   * it is asked.
   */
  const [projectPrompt, setProjectPrompt] = React.useState<ProjectPrompt | null>(null)
  const [collapsedProjects, setCollapsedProjects] = React.useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('collapsedProjects') ?? '{}') as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })
  const [revealedChatBatches, setRevealedChatBatches] = React.useState<Record<string, number>>({})
  // The same "show more" counter for the detailed mode's single flat list.
  const [flatBatches, setFlatBatches] = React.useState(0)

  // Stored value: true = collapsed, false = expanded. Archived projects
  // default to collapsed, active ones to expanded.
  const toggleProject = (cwd: string, collapsed: boolean): void => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [cwd]: !collapsed }
      localStorage.setItem('collapsedProjects', JSON.stringify(next))
      return next
    })
  }

  // Archived and ordered projects live in the store, not here: Settings →
  // Projects toggles both, and one `localStorage` key behind two `useState`s is
  // two copies that drift the moment either writes.
  const archivedProjects = useApp((s) => s.archivedProjects)
  const setArchived = useApp((s) => s.setProjectArchived)
  // User-controlled project order (array of cwds). Persisted; a project not yet
  // listed keeps its discovery order. `dragCwd`/`dropCwd` drive drag-to-reorder.
  const projectOrder = useApp((s) => s.projectOrder)
  const persistOrder = useApp((s) => s.setProjectOrder)
  const [dragCwd, setDragCwd] = React.useState<string | null>(null)
  const [dropCwd, setDropCwd] = React.useState<string | null>(null)
  // Whether the drop lands after (below) the target row vs before (above it).
  const [dropAfter, setDropAfter] = React.useState(false)

  const [width, setWidth] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'))
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX
      ? saved
      : SIDEBAR_DEFAULT
  })
  // State (not just a ref) because the width transition is disabled while dragging.
  const [dragging, setDragging] = React.useState(false)
  const draggingRef = React.useRef(false)

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events have no active pointer to capture
    }
  }

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    setWidth(Math.max(SIDEBAR_MIN, Math.min(Math.round(e.clientX), SIDEBAR_MAX)))
  }

  const onHandlePointerUp = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    setWidth((w) => {
      localStorage.setItem('sidebarWidth', String(w))
      return w
    })
  }

  const resetWidth = (): void => {
    draggingRef.current = false
    setDragging(false)
    setWidth(SIDEBAR_DEFAULT)
    localStorage.removeItem('sidebarWidth')
  }

  // Group chats by project folder. Chats within a project keep the order they
  // arrive in — `chats` *is* the sidebar order (store.ts `hoistChat`), which
  // moves only when a turn starts — and the PROJECT order is fixed by the
  // user's saved order, so a chat bump yanks neither the row nor its project to
  // the top. Projects not yet in the saved order keep their discovery order.
  // Pinned chats are pulled out into a section of their own at the top, so they
  // render once, not twice — but they stay in `group.chats`, which is what the
  // delete-project count means. `unpinned` is what the group actually lists;
  // keeping both is also what keeps a project whose only chat is pinned from
  // disappearing from the sidebar entirely.
  const groups = projectGroups(chats, projectOrder).map((g) => ({
    ...g,
    unpinned: g.chats.filter((c) => c.pinnedAt === undefined)
  }))
  // Oldest pin first, so pinning appends to the bottom of the section instead of
  // the order shuffling every time one of them is used.
  const pinnedChats = chats
    .filter((c) => c.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
  // Pinned chats included: `group.chats` is the whole project, which is what
  // leaves the sidebar and so what the three project dialogs have to report.
  const projectChatCount = (cwd: string): number =>
    groups.find((g) => g.cwd === cwd)?.chats.length ?? 0
  // Drag-to-reorder: move `from` just before `to`, then persist the full order.
  const moveProject = (from: string, to: string, after: boolean): void => {
    if (from === to) return
    const ordered = groups.map((g) => g.cwd).filter((c) => c !== from)
    const i = ordered.indexOf(to)
    const at = i === -1 ? ordered.length : after ? i + 1 : i
    ordered.splice(at, 0, from)
    persistOrder(ordered)
  }
  const visibleGroups = groups.filter((g) => !hiddenProjects[g.cwd])

  // **Marks arrive after the sidebar does.** A project's icon is a walk of
  // `stat`s in a folder, which is cheap but not free and answers nothing the
  // first frame needs — every row has its initials to fall back on, and that
  // is the same mark a project with no icon keeps. So it is asked for on the
  // first idle frame, `preloadHeavy`'s idiom, keyed on the project set the way
  // `branchKey` is so a folder the app has just met resolves its own mark
  // without re-shipping every icon already held.
  const iconKey = groups.map((g) => g.cwd).join('\n')
  React.useEffect(() => {
    const run = (): void => void loadProjectIcons()
    if (typeof requestIdleCallback !== 'function') {
      const t = setTimeout(run, 300)
      return () => clearTimeout(t)
    }
    const id = requestIdleCallback(run, { timeout: 10_000 })
    return () => cancelIdleCallback(id)
  }, [iconKey, loadProjectIcons])

  // "Show me one project" — the same question in both modes, so the same
  // control answers it. Detailed has no project rows and nothing else to ask
  // with; compact's answer used to be collapsing the other rows by hand. A
  // saved filter naming a project that no longer exists reads as null rather
  // than an empty sidebar — the project can be deleted from elsewhere.
  const filterProject =
    sidebarProject && visibleGroups.some((g) => g.cwd === sidebarProject) ? sidebarProject : null
  // Filtering to a project explicitly reaches an archived one; the unfiltered
  // list leaves them out, which is what archiving means. Compact still heads it
  // with the "Archived" divider, which is the only thing left saying so once
  // the list is down to that one project.
  const shownGroups = filterProject
    ? visibleGroups.filter((g) => g.cwd === filterProject)
    : visibleGroups
  const activeGroups = shownGroups.filter((g) => !archivedProjects[g.cwd])
  const archivedGroups = shownGroups.filter((g) => archivedProjects[g.cwd])

  // The new-chat chooser's rows, in *recency* order rather than the sidebar's
  // manual project order — `chats` arrives newest-first, so the project you
  // were last in is the first row, and ⌘N-Enter is the common case. Archived
  // projects are included: choosing one by name is a deliberate act, unlike
  // browsing the list they were archived out of.
  const newChatProjects: { cwd: string; label: string; count: number }[] = []
  for (const chat of chats) {
    const root = projectRoot(chat)
    if (hiddenProjects[root] || newChatProjects.some((p) => p.cwd === root)) continue
    newChatProjects.push({
      cwd: root,
      label: projectLabel(root),
      count: projectChatCount(root)
    })
  }

  // Detailed mode is a flat, recency-ordered list, not a project tree: a row
  // already names its project and branch, so grouping by project would print
  // the same folder — and, in a repo where nothing is isolated, the same branch
  // — once per row. Date buckets structure the list by the thing that actually
  // varies down it. Everything else about a row is identical between modes.
  const flatSource = filterProject ? shownGroups : activeGroups
  // A filter scopes the whole sidebar, pins included — a pin from another
  // project showing through would make the list a half-truth. This is the one
  // part that was already shared: compact reads `pinnedShown` too, so before
  // the filter appeared in both modes a pick made in detailed silently scoped
  // compact's pins with nothing on screen to clear it.
  const pinnedShown = filterProject
    ? pinnedChats.filter((c) => projectRoot(c) === filterProject)
    : pinnedChats
  // Home-screen prompts never sent. Scoped by the same filter as the pins, for
  // the same reason — a draft from another project showing through a filtered
  // sidebar makes the whole list a half-truth. Hidden projects stay hidden.
  const draftsShown = sortedProjectDrafts(projectDrafts).filter(
    (draft) => !hiddenProjects[draft.cwd] && (!filterProject || draft.cwd === filterProject)
  )
  // Take the rows from `chats` rather than from the groups: `chats` is already
  // in sidebar order (store.ts `hoistChat`) and flattening the groups would
  // impose the project grouping this mode exists to not have. Order is the
  // store's business — the list re-sorts when a turn starts, and at no other
  // time, so a streaming chat no longer walks up and down the sidebar.
  const flatCwds = new Set(flatSource.map((g) => g.cwd))
  const flatChats = chats.filter((c) => c.pinnedAt === undefined && flatCwds.has(projectRoot(c)))
  const flatShown = flatChats.slice(0, FLAT_BATCH * (flatBatches + 1))
  const flatHidden = flatChats.length - flatShown.length
  // Keyed by label, not by adjacency: order is frozen between turns while
  // `updatedAt` keeps moving, so a chat can outlive its bucket (a turn running
  // across midnight) and print a second "Yesterday" under the first.
  const flatSections: { label: string; chats: ChatMeta[] }[] = []
  for (const chat of flatShown) {
    const label = dateGroup(chat.updatedAt, now)
    const section = flatSections.find((s) => s.label === label)
    if (section) section.chats.push(chat)
    else flatSections.push({ label, chats: [chat] })
  }

  // Everything you can do to a project, in one definition — the project row's
  // menu in compact mode, and the tail of a chat row's menu in detailed mode,
  // which has no project rows.
  // Volatile helpers the row actions need at *click* time. Read through a ref
  // rather than captured, so `actions` below can be built once: a handler that
  // closed over this render's `projectChatCount` would either churn the object
  // every render (defeating the row memo) or go stale (reporting last render's
  // count in a confirm dialog). The ref is refreshed on every render, so it is
  // neither.
  const latest = React.useRef({ projectChatCount, newChatIn, setArchived, projectLabel })
  latest.current = { projectChatCount, newChatIn, setArchived, projectLabel }

  // Built once per mount. Every dependency is either a store action or a
  // `useState` setter — both stable by contract — or reached through `latest`,
  // which is why the dependency list is genuinely empty rather than
  // conveniently so.
  const actions = React.useMemo<RowActions>(
    () => ({
      open: (chat) => void openChat(chat.id),
      rename: (chat) => {
        setRenameValue(chat.title)
        setRenaming(chat)
      },
      remove: (chat) => setDeleting(chat),
      togglePin: (chat) => void setChatPinned(chat.id, chat.pinnedAt === undefined),
      archive: (chat) => void setChatArchived(chat.id, true),
      newInWorktree: (chat) => {
        // Drops to the composer with the worktree preselected; the model picker
        // there chooses the provider, so a Codex chat can pick up a worktree
        // Claude started.
        if (chat.worktree) void startInWorktree(chat.cwd, chat.worktree)
      },
      newChatIn: (cwd) => latest.current.newChatIn(cwd),
      renameProject: (cwd) => setProjectPrompt({ kind: 'rename', cwd }),
      manageProjects: () => openSettings('projects'),
      revealProject: (cwd) => void window.api.revealPath(cwd),
      setProjectArchived: (cwd, archived) => latest.current.setArchived(cwd, archived),
      confirmProject: (kind, cwd) => setProjectPrompt({ kind, cwd }),
      removeProject: (cwd) => setProjectPrompt({ kind: 'remove', cwd })
    }),
    [openChat, setChatPinned, setChatArchived, startInWorktree]
  )

  // A chat row is identical wherever it appears — in its project group or in the
  // Pinned section — so both sites render through here.
  const renderChatItem = (chat: ChatMeta): React.JSX.Element => {
    const root = projectRoot(chat)
    const mark = markFor(root)
    // The row stands for its whole thread: what any of its open columns is
    // doing shows here, the way a collapsed project row sums its chats.
    const columns = columnsOf({ activeId, sideColumns, sideColumnsByChat }, chat.id)
    const own = chatActivity(statuses[chat.id], backgroundJobs[chat.id], permissions[chat.id])
    const activity = columns.length
      ? projectActivity([
          own,
          ...columns.map((id) => chatActivity(statuses[id], backgroundJobs[id], permissions[id]))
        ])
      : own
    return (
      <ChatItem
        key={chat.id}
        chat={chat}
        now={now}
        active={chat.id === activeId}
        activity={activity}
        titling={!!titling[chat.id]}
        sides={columns.flatMap((id) => chatsById.get(id) ?? [])}
        detail={detailed ? chatDetail(chat) : null}
        mark={mark}
        // Whenever no project row is on screen to carry the project's actions —
        // always in detailed, and in compact once a filter has collapsed the
        // list to one project and its row along with it.
        projectMenu={
          detailed || filterProject
            ? { cwd: root, label: projectLabel(root), archived: !!archivedProjects[root] }
            : null
        }
        actions={actions}
      />
    )
  }

  const leaveDrop = useLeaveThreadDrop()

  return (
    <aside
      data-sidebar
      {...leaveDrop.handlers}
      style={{ width: sidebarOpen ? width : 0 }}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar',
        !dragging && 'transition-[width] duration-200 ease-out',
        !sidebarOpen && 'border-r-0'
      )}
    >
      <div className="flex h-full flex-col" style={{ width }}>
      {/* Traffic-light strip; window controls live on its right, Cursor-style */}
      <div className="drag flex h-[38px] shrink-0 items-center justify-end gap-0.5 px-2.5">
        <WithTooltip label="Hide sidebar  ⌘B">
          <Button size="icon-sm" variant="ghost" aria-label="Hide sidebar" onClick={toggleSidebar}>
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>

      {/* Primary actions, Cursor-style rows.

          **This block sets the sidebar's measure, and everything below it
          matches.** Two numbers, once: an 8px gutter on every block, and an
          8px inset on every row, so a row's hover pill always runs from 8 and
          its icon column always starts at 16. The list used to sit on 12 + 10
          — four pixels narrower a side and six further in — which read as the
          chats being squeezed relative to the three rows above them, because
          they were. The one bonus is compact mode's hanging indent: the
          project row's name and its chats' titles both land on 40 now, where
          before they missed each other by four. */}
      <div className="flex flex-col gap-0.5 px-2 pb-1">
        <button
          type="button"
          // Asks which project, unless the filter already names one. The other
          // instant paths stay where the answer is on screen: compact mode's
          // per-project ＋ and "New chat here" on a detailed row's menu.
          onClick={() => startNewChat()}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
          New chat
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">⌘N</Kbd>
        </button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          Search
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">⌘K</Kbd>
        </button>
        {/* The project filter, as the third primary row rather than a heading
            over the list.

            It was a section label that had become a control and never stopped
            looking like one: sized against the rows it headed, carrying the
            add-a-folder button, and sitting *below* the drafts and pins it
            scopes. Here it reads as what it is — "which project am I looking
            at", beside "new chat" and "search" — and everything it filters is
            underneath it. The mark is drawn at the nav icons' size so the three
            rows share one column. */}
        <div className="group flex items-center rounded-md pr-0.5 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Filter by project"
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none"
                />
              }
            >
              {filterProject ? (
                <ProjectAvatar
                  size="sm"
                  root={filterProject}
                  name={projectLabel(filterProject)}
                  icon={projectIcons[filterProject] ?? null}
                  className="size-4 rounded-[5px]"
                />
              ) : (
                // A line icon, not a tile: this is the icon column of "New
                // chat" and "Search", and "all projects" is a *state of the
                // control*, not a project with a mark of its own. A project
                // brings its own tile when one is chosen, which is the whole
                // point of the column — same 16px box either way, so nothing
                // shifts.
                <SquareStack className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">
                {filterProject ? projectLabel(filterProject) : 'All projects'}
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              <DropdownMenuItem onClick={() => setSidebarProject(null)}>
                <Check
                  className={cn(!filterProject && 'opacity-100', filterProject && 'invisible')}
                />
                <SquareStack />
                All projects
              </DropdownMenuItem>
              {visibleGroups.length > 0 && <DropdownMenuSeparator />}
              {visibleGroups.map((g) => (
                <DropdownMenuItem key={g.cwd} onClick={() => setSidebarProject(g.cwd)}>
                  {/* The tick stays: it is the one thing on the row that says
                      *selected*, and a mark that had to double as both would
                      say neither. The mark goes where a list of things you pick
                      from puts it — ahead of the name. */}
                  <Check className={cn(filterProject !== g.cwd && 'invisible')} />
                  <ProjectAvatar
                    size="sm"
                    root={g.cwd}
                    name={projectLabel(g.cwd)}
                    icon={projectIcons[g.cwd] ?? null}
                  />
                  <span className="min-w-0 truncate">{projectLabel(g.cwd)}</span>
                  <span className="ml-auto pl-3 text-[11px] text-muted-foreground/60">
                    {g.chats.length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Two verbs, not one: opening a folder the app has never seen, and
              managing the ones it has. The second is the page that answers
              every other question about a project, so the row that names one
              is where it belongs. */}
          <WithTooltip label="Add a project folder">
            <button
              type="button"
              onClick={() => void openProject()}
              aria-label="Add project"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              {/* A folder, not a bare plus: the plus alone is the new-*chat*
                  verb one row above this. */}
              <FolderPlus className="size-4" />
            </button>
          </WithTooltip>
          <WithTooltip label="Manage projects">
            <button
              type="button"
              onClick={() => openSettings('projects')}
              aria-label="Manage projects"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              {/* A gear, not sliders: sliders beside a filter read as "filter
                  options", and this is the settings page. The footer's gear
                  opens the same page's siblings — same verb, same glyph. */}
              <Settings className="size-4" />
            </button>
          </WithTooltip>
        </div>
      </div>

      {/* Unsent prompts, at the very top: this is the one section whose
          contents exist nowhere else, and a draft you can't see is a draft
          you've lost. There is at most one per project, so it costs the list a
          row or two and never a screenful. */}
      {draftsShown.length > 0 && (
        <div className="flex max-h-[25vh] shrink-0 flex-col">
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground/70">
              Drafts
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto px-2">
            <div className="space-y-px">
              {draftsShown.map((draft) => (
                <DraftItem
                  key={draft.cwd}
                  draft={draft}
                  mark={markFor(draft.cwd)}
                  onOpen={() => openDraft(draft.cwd)}
                  onDiscard={() => discardProjectDraft(draft.cwd)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Pinned chats, and they sit **under** the filter because the filter
          scopes them — `pinnedShown` is filtered — and a section a control
          governs belongs below it, not above. Still outside the list's own
          scroller, so they stay reachable however far down you are.

          No heading: the rows say it themselves now. A label costs a row to
          name a state that is a property of each chat rather than of the
          group, and it named it once for a block whose membership you cannot
          otherwise see — move a pin and the only thing that changes is which
          side of a divider a row is on. The glyph travels with the chat. */}
      {pinnedShown.length > 0 && (
        <div className="flex max-h-[35vh] shrink-0 flex-col">
          <div className="min-h-0 overflow-y-auto px-2 pt-0.5 pb-1">
            <div className="space-y-px">{pinnedShown.map(renderChatItem)}</div>
          </div>
        </div>
      )}

      {/* Detailed mode: one flat list, newest first, bucketed by date */}
      {detailed && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {flatChats.length === 0 && pinnedShown.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground">
              {filterProject
                ? `No chats in ${projectLabel(filterProject)} yet.`
                : 'Open a project to get started.'}
            </div>
          )}
          {flatSections.map((section, i) => (
            <React.Fragment key={section.label}>
              {/* "Today" goes unlabelled: the top of a newest-first list is today
                  by definition, so the heading would cost a row to say nothing. */}
              {section.label !== 'Today' && (
                <div className={cn('flex items-center gap-2 px-2 pb-0.5', i === 0 ? 'pt-1' : 'pt-4')}>
                  <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
                    {section.label}
                  </span>
                  <div className="h-px flex-1 bg-sidebar-border" />
                </div>
              )}
              <div className="space-y-px">{section.chats.map(renderChatItem)}</div>
            </React.Fragment>
          ))}
          {flatHidden > 0 && (
            <button
              type="button"
              onClick={() => setFlatBatches((n) => n + 1)}
              className="mt-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
            >
              <ChevronRight className="size-3 shrink-0" />
              Show {Math.min(FLAT_BATCH, flatHidden)} more
            </button>
          )}
        </div>
      )}

      {/* Compact mode: chats grouped by project */}
      {!detailed && (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {activeGroups.length === 0 && archivedGroups.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            Open a project to get started.
          </div>
        )}
        {[
          ...activeGroups.map((g) => ({ group: g, archived: false })),
          ...archivedGroups.map((g) => ({ group: g, archived: true }))
        ].map(({ group, archived }, i) => {
          // Filtered to this project, the header already names it — a row
          // repeating it below is the sidebar saying "ai-gui" twice in 30px.
          // Its collapse toggle would empty the sidebar, its drag handle has
          // nothing to trade places with, and the two things it does carry
          // (New chat here, the project menu) move onto the chat rows via
          // `projectMenu` — the mechanism detailed mode already uses for
          // exactly this, having no project rows either.
          const headed = !filterProject
          // Archived projects default to collapsed. Collapse can't apply with
          // no row to click, and would otherwise hide the list you just
          // filtered down to.
          const isCollapsed = headed && (collapsedProjects[group.cwd] ?? archived)
          // Pinned chats show their own indicator up top, so rolling them into
          // the collapsed project's would just say the same thing twice.
          const collapsedActivity = projectActivity(
            group.unpinned.map((chat) =>
              chatActivity(statuses[chat.id], backgroundJobs[chat.id], permissions[chat.id])
            )
          )
          const firstArchived = archived && i === activeGroups.length
          // Cap to the most-recent chats (search shows all matches). Keep the
          // open chat visible even when it's older than the cap.
          const revealedBatches = revealedChatBatches[group.cwd] ?? 0
          const chatListLimit = chatsPerProject * (revealedBatches + 1)
          const cappedChats = (() => {
            if (group.unpinned.length <= chatListLimit) return group.unpinned
            const top = group.unpinned.slice(0, chatListLimit)
            const activeInGroup = group.unpinned.find((c) => c.id === activeId)
            return activeInGroup && !top.some((c) => c.id === activeId)
              ? [...top, activeInGroup]
              : top
          })()
          const hiddenChatCount = group.unpinned.length - cappedChats.length
          return (
            <React.Fragment key={group.cwd}>
              {firstArchived && (
                <div className="flex items-center gap-2 px-2 pt-4 pb-0.5">
                  <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
                    Archived
                  </span>
                  <div className="h-px flex-1 bg-sidebar-border" />
                </div>
              )}
              <div className={cn('relative', archived && 'opacity-70')}>
                {/* Insertion line: shows exactly where the dragged project lands
                    (above or below this row) — reads as reorder, not nesting. */}
                {headed && dropCwd === group.cwd && dragCwd && dragCwd !== group.cwd && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-primary',
                      dropAfter ? '-bottom-0.5' : '-top-0.5'
                    )}
                  />
                )}
                {headed && (
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <div
                        className={cn(
                          'group/project flex items-center gap-0.5 rounded-md',
                          dragCwd === group.cwd && 'opacity-50'
                        )}
                        draggable
                        onDragStart={(e) => {
                          setDragCwd(group.cwd)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(e) => {
                          if (!dragCwd || dragCwd === group.cwd) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          const rect = e.currentTarget.getBoundingClientRect()
                          const after = e.clientY > rect.top + rect.height / 2
                          if (dropCwd !== group.cwd || dropAfter !== after) {
                            setDropCwd(group.cwd)
                            setDropAfter(after)
                          }
                        }}
                        onDragLeave={() =>
                          setDropCwd((c) => (c === group.cwd ? null : c))
                        }
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragCwd) moveProject(dragCwd, group.cwd, dropAfter)
                          setDragCwd(null)
                          setDropCwd(null)
                        }}
                        onDragEnd={() => {
                          setDragCwd(null)
                          setDropCwd(null)
                        }}
                      />
                    }
                  >
                    <WithTooltip label={group.cwd}>
                      <button
                        type="button"
                        onClick={() => toggleProject(group.cwd, isCollapsed)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60"
                        aria-expanded={!isCollapsed}
                      >
                        {/* One icon slot: the project's own mark at rest,
                            chevron on row hover (Cursor-style). The mark is
                            strictly better than the folder glyph it replaced —
                            that one was identical on every row, which is the
                            definition of a glyph carrying nothing — and the
                            swap survives it: the row being hovered is the one
                            row whose name you are already reading, and it is
                            where the collapse affordance has to appear. */}
                        <span className="relative size-4 shrink-0">
                          <ProjectAvatar
                            size="sm"
                            root={group.cwd}
                            name={projectLabel(group.cwd)}
                            icon={projectIcons[group.cwd] ?? null}
                            className="absolute inset-0 transition-all duration-150 group-hover/project:scale-75 group-hover/project:opacity-0"
                          />
                          <ChevronRight
                            className={cn(
                              'absolute inset-0 size-4 scale-75 text-muted-foreground/80 opacity-0 transition-all duration-150 group-hover/project:scale-100 group-hover/project:opacity-100',
                              !isCollapsed && 'rotate-90'
                            )}
                          />
                        </span>
                        <span className="truncate text-[13px] font-medium text-sidebar-foreground">
                          {projectLabel(group.cwd)}
                        </span>
                        {isCollapsed && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/70">
                            {group.chats.length}
                          </span>
                        )}
                        {isCollapsed && collapsedActivity.kind !== 'idle' && (
                          <ActivityIndicator activity={collapsedActivity} />
                        )}
                      </button>
                    </WithTooltip>
                    {!archived && (
                      <WithTooltip label={`New chat in ${projectLabel(group.cwd)}`}>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-5 shrink-0 opacity-0 transition-opacity group-hover/project:opacity-100"
                          onClick={() => newChatIn(group.cwd)}
                          aria-label={`New chat in ${projectLabel(group.cwd)}`}
                        >
                          <Plus />
                        </Button>
                      </WithTooltip>
                    )}
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {!archived && (
                      <>
                        <ContextMenuItem onClick={() => newChatIn(group.cwd)}>
                          <Plus /> New chat
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    <ProjectMenuItems cwd={group.cwd} archived={archived} actions={actions} />
                  </ContextMenuContent>
                </ContextMenu>
                )}
                {!isCollapsed && (
                  // The indent is the project row's hanging indent; with no row
                  // above them the chats sit flush, exactly as detailed's do.
                  <div className={cn('space-y-px pb-1', headed && 'ml-[24px]')}>
                    {cappedChats.map(renderChatItem)}
                    {(hiddenChatCount > 0 || revealedBatches > 0) && (
                      <div className="flex items-center">
                        {hiddenChatCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedChatBatches((prev) => ({
                                ...prev,
                                [group.cwd]: revealedBatches + 1
                              }))
                            }
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
                          >
                            <ChevronRight className="size-3 shrink-0" />
                            Show {Math.min(chatsPerProject, hiddenChatCount)} more
                          </button>
                        )}
                        {revealedBatches > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedChatBatches((prev) => ({ ...prev, [group.cwd]: 0 }))
                            }
                            className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/90"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })}
      </div>
      )}

      <UpdateBanner />

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-sidebar-border px-3 py-2">
        <UsagePanel />
        <div className="flex items-center">
          {/* Next to the plan-limits chip on purpose: same corner, two halves of
              one question — what's left right now, and where it has been going. */}
          <WithTooltip label="Usage over time">
            <Button size="icon-sm" variant="ghost" onClick={openUsage} aria-label="Open usage">
              <ChartColumn />
            </Button>
          </WithTooltip>
          <WithTooltip label="Settings  ⌘,">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => openSettings()}
              aria-label="Open settings"
            >
              <Settings />
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Search chats across projects */}
      <SearchChatsDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        chats={chats}
        now={now}
        onOpen={(id) => void openChat(id)}
      />

      {/* Which project a new chat starts in */}
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        projects={newChatProjects}
        onPick={(cwd) => newChatIn(cwd)}
        onBrowse={() => void openProject()}
        onRemove={(cwd) => setProjectPrompt({ kind: 'remove', cwd })}
      />

      {/* Rename dialog */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogTitle>Rename chat</DialogTitle>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (renaming && renameValue.trim()) {
                void renameChat(renaming.id, renameValue.trim())
                setRenaming(null)
              }
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              placeholder="Chat title"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename / archive / hide / remove a project — shared with
          Settings → Projects so both places say the same thing. */}
      <ProjectDialogs prompt={projectPrompt} onClose={() => setProjectPrompt(null)} />

      {/* The delete confirm is shared with Settings → Archive — it is the one
          dialog that can destroy a worktree, and what it would destroy is a
          live git read rather than a sentence. See `ChatDeleteDialog`. */}
      <ChatDeleteDialog chat={deleting} onClose={() => setDeleting(null)} />
      </div>
      {leaveDrop.title !== null && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-2 top-[42px] z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 px-4 text-center"
        >
          <span className="rounded-md bg-popover px-3 py-1.5 text-[13px] text-foreground shadow-lg">
            Move <span className="font-medium">“{leaveDrop.title}”</span> to its own chat
          </span>
        </div>
      )}
      {/* Resize handle — drag to resize, double-click to reset */}
      {sidebarOpen && (
        <div
          data-sidebar-resize
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onLostPointerCapture={onHandlePointerUp}
          onDoubleClick={resetWidth}
          className="no-drag absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
        />
      )}
    </aside>
  )
}

import * as React from 'react'
import { Archive, ArchiveRestore, GitBranch, Loader2, SquareTerminal, Trash2 } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_LABELS, projectRoot } from '@shared/types'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/format'
import { projectLabel } from '@/lib/projects'
import { chatActivity } from '@/lib/chatActivity'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'
import { ChatDeleteDialog } from '@/components/ChatDeleteDialog'

/**
 * Settings → Archive: the chats that are not in the sidebar, and the only place
 * they can be seen.
 *
 * Archiving is the sidebar's other half. A chat you are done with has exactly
 * two endings today — it stays in the list forever, or it is deleted, which
 * takes a transcript the CLI cannot give back. Between them sits the thing
 * people actually want: *put it away*. That is only a feature if the way back
 * is somewhere, which is what this page is; an archive with no reading room is
 * a delete that lies about itself.
 *
 * Three decisions worth keeping:
 *
 * - **The reading column, not the Projects layout.** Projects took the whole
 *   content area because a project has more to say than fits on a row — a
 *   remote, branches, worktrees — and the list was its navigation. An archived
 *   chat has four facts and two buttons. A list/detail split here would be a
 *   pane built to hold what a row already says.
 * - **The heading is the count.** The nav says "Archive", highlighted, 130px to
 *   the left; `12 chats` is a fact that was nowhere else in the app.
 * - **A row opens the chat, and opening restores it.** The rule lives in
 *   `openChat` (see the store) rather than on this button, because a chat on
 *   screen with no row anywhere — not in the sidebar, not in search, with a
 *   composer still willing to send into it — is a state nothing else in the app
 *   can produce. So the row is the way *back to work*, and `Restore` beside it
 *   is the way to put it back on the list without leaving this page.
 *
 * What is deliberately absent is a bulk anything. Archiving is per chat because
 * a chat is what you finish; "archive everything older than a month" is a rule
 * about time, and a rule that empties your sidebar while you are not looking is
 * not one this should invent on the user's behalf.
 */

/**
 * "Archived 3m" / "Archived Sep 9" — the sidebar's own relative vocabulary, so
 * the two lists date things the same way. Only `now` is spelled out: it is the
 * one value that reads as a state rather than a time when a word is put in
 * front of it, and it is what every row says for the first minute after the
 * click that put it here.
 */
function archivedLabel(chat: ChatMeta): string {
  const at = relativeTime(chat.archivedAt ?? chat.updatedAt, Date.now())
  return at === 'now' ? 'Archived just now' : `Archived ${at}`
}

function ArchivedRow({
  chat,
  onDelete
}: {
  chat: ChatMeta
  onDelete: () => void
}): React.JSX.Element {
  const openChat = useApp((s) => s.openChat)
  const setChatArchived = useApp((s) => s.setChatArchived)
  const projectNames = useApp((s) => s.projectNames)
  // A chat can be archived mid-turn — nothing stops it, and stopping it would
  // make "put this away" wait on an agent. So the row says when that is true:
  // this is the only surface the turn is visible on at all.
  const activity = chatActivity(
    useApp((s) => s.statuses[chat.id]),
    useApp((s) => s.backgroundJobs[chat.id]),
    useApp((s) => s.permissions[chat.id])
  )
  const label = projectLabel(projectRoot(chat), projectNames)

  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50">
      <button
        type="button"
        // Opening restores it — the store enforces that, and the tooltip says so
        // before the click rather than leaving the sidebar to explain itself.
        onClick={() => void openChat(chat.id)}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none"
      >
        {/* A terminal chat has no provider until a CLI session is found in it —
            its `provider` is a placeholder, and drawing that mark would claim a
            backend nobody started. The sidebar draws the same two cases. */}
        {chat.surface === 'terminal' && !chat.sessionId ? (
          <WithTooltip label="Terminal chat" side="right">
            <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground">
              <SquareTerminal className="size-[11px]" />
            </span>
          </WithTooltip>
        ) : (
          <WithTooltip label={PROVIDER_LABELS[chat.provider]} side="right">
            <ProviderAvatar provider={chat.provider} className="mt-px shrink-0" />
          </WithTooltip>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px]">{chat.title || 'New chat'}</span>
            {activity.kind !== 'idle' && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-primary">
                <Loader2 className="size-3 animate-spin" />
                {activity.label}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground/70">
            <span className="min-w-0 truncate">{label}</span>
            {chat.worktree && (
              <>
                <span className="shrink-0 opacity-45">·</span>
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{chat.worktree.branch}</span>
                </span>
              </>
            )}
            <span className="shrink-0 opacity-45">·</span>
            {/* The timestamp is `archivedAt`, not `updatedAt`: on this page the
                question is when you put it away, which is the only date the
                chat's own activity can no longer answer. */}
            <span className="shrink-0">{archivedLabel(chat)}</span>
          </span>
        </span>
      </button>
      {/* Both actions stay visible rather than appearing on hover. A sidebar row
          hides its ⋯ because the list is dense and the row's job is to be
          clicked; this list's whole job is the two buttons, and a page whose
          purpose only appears under the cursor does not look like one. */}
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => void setChatArchived(chat.id, false)}
        >
          <ArchiveRestore /> Restore
        </Button>
        <WithTooltip label="Delete permanently">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${chat.title || 'New chat'}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </WithTooltip>
      </div>
    </div>
  )
}

export function ArchiveSection(): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const projectNames = useApp((s) => s.projectNames)
  const [query, setQuery] = React.useState('')
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null)

  // Newest archived first. Sorted here rather than read off `chats` — that
  // array is the *sidebar's* order (`hoistChat` moves a row when a turn
  // starts), which is an order about work in progress and means nothing to a
  // list of chats that are done.
  const archived = React.useMemo(
    () =>
      chats
        .filter((c) => !c.ephemeral && c.archivedAt !== undefined)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [chats]
  )

  const q = query.trim().toLowerCase()
  const shown = q
    ? archived.filter(
        (c) =>
          (c.title || 'New chat').toLowerCase().includes(q) ||
          projectLabel(projectRoot(c), projectNames).toLowerCase().includes(q) ||
          c.cwd.toLowerCase().includes(q)
      )
    : archived

  return (
    <section>
      <div className="mb-5 px-2">
        <div className="flex items-center gap-2">
          <Archive className="size-4 text-primary" />
          <h2 className="text-[15px] font-semibold">
            {archived.length === 0
              ? 'Archive'
              : `${archived.length} archived ${archived.length === 1 ? 'chat' : 'chats'}`}
          </h2>
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Chats you’ve put away. Nothing is deleted — they keep their history and their session,
          and stay out of the sidebar, the search and ⌘N until you bring one back.
        </p>
      </div>

      {archived.length > 3 && (
        <div className="mb-2 px-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter archived chats"
            className="h-8 text-[13px]"
          />
        </div>
      )}

      <div className={cn('rounded-2xl border border-border bg-card/35 p-1.5', archived.length === 0 && 'p-0')}>
        {shown.map((chat) => (
          <ArchivedRow key={chat.id} chat={chat} onDelete={() => setDeleting(chat)} />
        ))}
        {shown.length === 0 && (
          <div className="px-6 py-10 text-center">
            <Archive className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-3 text-[13px] font-medium">
              {archived.length === 0 ? 'Nothing archived' : `Nothing matches “${query}”`}
            </p>
            {archived.length === 0 && (
              <p className="mx-auto mt-1 max-w-sm text-[12px] text-muted-foreground">
                Right-click a chat in the sidebar and choose Archive to take it off the list
                without losing it. It waits here until you open or restore it.
              </p>
            )}
          </div>
        )}
      </div>

      {/* The same confirm the sidebar asks, because it is the only one that can
          also destroy a worktree — see `ChatDeleteDialog`. */}
      <ChatDeleteDialog chat={deleting} onClose={() => setDeleting(null)} />
    </section>
  )
}

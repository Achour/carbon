import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import type { ChatMeta, OpResult } from '@shared/types'
import { basename } from '@/lib/format'
import { chatMeta, useApp } from '@/store'
import { ArrowLeftRight, GitMerge, RefreshCw, Trash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'

/**
 * "Git refused, here's what it said" — the one rendering of a failed git
 * operation, shared by every confirm-and-run flow (and the worktree picker's
 * cleanup) so multi-line refusals always present the same way.
 */
export function GitErrorDialog({
  title,
  detail = 'Nothing moved. Git said:',
  error,
  onDismiss
}: {
  title: string
  detail?: string
  error: string | null
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <Dialog open={error !== null} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{detail}</DialogDescription>
        <p className="mt-3 rounded-md bg-secondary/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-destructive">
          {error}
        </p>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The confirm-and-run dialogs behind the chat's ⋯ menu: how a branch ends.
 * They're here rather than beside the composer because the environment is
 * chosen when the chat starts and only displayed afterwards.
 *
 * No dialog re-checks whether the operation is allowed. Main owns those guards
 * (clean trees, the right branch checked out) and its refusals read as
 * instructions, so failure shows them verbatim rather than paraphrasing a
 * subset of them up front and drifting from the real rules.
 */
function ConfirmOpDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  errorTitle,
  run
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: React.ReactNode
  confirmLabel: string
  errorTitle: string
  run: () => Promise<OpResult>
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const go = async (): Promise<void> => {
    setBusy(true)
    const res = await run()
    setBusy(false)
    onOpenChange(false)
    if (!res.ok) setError(res.error)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void go()} disabled={busy}>
              {busy && <DotSpinner className="size-3" />}
              {confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <GitErrorDialog title={errorTitle} error={error} onDismiss={() => setError(null)} />
    </>
  )
}

export function WorktreeHandoffDialog({
  chat,
  open,
  onOpenChange
}: {
  chat: ChatMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const exitWorktree = useApp((s) => s.exitWorktree)
  return (
    <ConfirmOpDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Continue in local checkout"
      confirmLabel="Hand off"
      errorTitle="Couldn’t hand off"
      run={() => exitWorktree(chat.id, 'handoff')}
      body={
        <>
          Check out <span className="font-medium text-foreground">{chat.worktree?.branch}</span> in{' '}
          <span className="font-medium text-foreground">
            {chat.worktree ? basename(chat.worktree.repoRoot) : ''}
          </span>{' '}
          and remove the worktree. This chat continues there; its next message starts a fresh
          session in the new folder.
        </>
      }
    />
  )
}

/**
 * The pull-request ending: the merge already happened on the remote, so all
 * that's left locally is to retire the worktree. Deliberately not a rung on the
 * source-control ladder — `sync-cleanup`, its equivalent for a plain checkout,
 * switches to the default branch, which git refuses inside a worktree.
 */
export function WorktreeFinishDialog({
  chat,
  open,
  onOpenChange
}: {
  chat: ChatMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const exitWorktree = useApp((s) => s.exitWorktree)
  return (
    <ConfirmOpDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Remove worktree"
      confirmLabel="Remove"
      errorTitle="Couldn’t remove the worktree"
      run={() => exitWorktree(chat.id, 'finish')}
      body={
        <>
          Delete the worktree folder and the{' '}
          <span className="font-medium text-foreground">{chat.worktree?.branch}</span> branch. This
          chat continues in{' '}
          <span className="font-medium text-foreground">
            {chat.worktree ? basename(chat.worktree.repoRoot) : ''}
          </span>
          . Use this once the work has landed — through a merged pull request, say. Git refuses if
          the branch holds anything that isn’t merged.
        </>
      }
    />
  )
}

/**
 * Landing a branch without a pull request — one dialog for both shapes of the
 * same ending, because from the user's side it is the same thing ("put this in
 * main"). What differs is whose directory changes: a worktree chat merges into
 * a checkout nobody is sitting in and then disappears, while a plain chat has
 * to switch its own folder over. The second case says so explicitly, since the
 * files under the agent are about to change.
 *
 * Everything shown here reads straight from the store's `git` slice — the same
 * fields the ↓n staleness chip renders — so the dialog can never disagree with
 * the strip beside it, and opening it costs no extra git reads.
 */
export function MergeIntoMainDialog({
  chat,
  open,
  onOpenChange
}: {
  chat: ChatMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const exitWorktree = useApp((s) => s.exitWorktree)
  const mergeBranchInPlace = useApp((s) => s.mergeBranchInPlace)
  // Primitive selectors, deliberately: `git` is replaced wholesale on every
  // status refresh, and this component is mounted whenever the chat is off the
  // default branch — subscribing to the object would re-render it constantly.
  const branchName = useApp((s) => s.git?.branch)
  const target = useApp((s) => s.git?.defaultBranch) ?? 'main'
  const behind = useApp((s) => s.git?.behindDefault) ?? 0
  const commits = useApp((s) => s.git?.aheadDefault)

  const inWorktree = !!chat.worktree
  const branch = chat.worktree?.branch ?? branchName

  return (
    <ConfirmOpDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Merge into ${target}`}
      confirmLabel="Merge"
      errorTitle="Couldn’t merge"
      run={() => (inWorktree ? exitWorktree(chat.id, 'merge') : mergeBranchInPlace())}
      body={
        <>
          Merge <span className="font-medium text-foreground">{branch}</span>
          {commits != null && commits > 0 && (
            <>
              {' '}
              ({commits} commit{commits === 1 ? '' : 's'})
            </>
          )}{' '}
          into <span className="font-medium text-foreground">{target}</span>
          {inWorktree ? (
            <>
              {' '}
              in{' '}
              <span className="font-medium text-foreground">
                {chat.worktree ? basename(chat.worktree.repoRoot) : ''}
              </span>
              , then remove the worktree and its branch. This chat continues in the main checkout.
            </>
          ) : (
            <>
              {' '}
              and delete the branch. This switches{' '}
              <span className="font-medium text-foreground">{basename(chat.cwd)}</span> over to{' '}
              {target}, so the files in your editor change — but the merged work is all still
              there.
            </>
          )}
          {behind > 0 && (
            <>
              {' '}
              <span className="text-warning">
                {target} has {behind} commit{behind === 1 ? '' : 's'} this branch doesn’t
              </span>{' '}
              — if the merge conflicts it will be undone, and “Update from main” can resolve it
              here first.
            </>
          )}
        </>
      }
    />
  )
}

/**
 * How a branch ends, on the thing that names the branch: keep it current, land
 * it in the default branch, or — in a worktree — move out of it or retire it
 * once the work landed through a PR. It hangs off the folder/branch pill and the
 * session rail's branch row, which is where these lived after the thread's ⋯
 * menu went: rename and delete were already on the sidebar row, but these
 * cannot go there, because they read the store's `git` slice — the *open*
 * thread's checkout — and a sidebar row would offer them for any chat.
 *
 * `chatId` names the thread's own chat, which carries the worktree. With nothing to
 * offer (not a repo, on the default branch outside a worktree) the trigger is
 * drawn as plain content, so a pill that does nothing does not look clickable.
 */
export function BranchMenu({
  chatId,
  tooltip,
  className,
  actionClassName,
  children
}: {
  /**
   * The thread's own chat, resolved here rather than by the caller: a column
   * selecting the thread's whole meta would re-render on every patch to it,
   * strip shown or not.
   */
  chatId: string
  tooltip: React.ReactNode
  /** The trigger with nothing to offer. */
  className?: string
  /** The trigger as a menu button. */
  actionClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  const chat = useApp((s) => chatMeta(s, chatId))
  // Primitives, for `MergeIntoMainDialog`'s reason: `git` is replaced wholesale
  // on every status refresh.
  const branch = useApp((s) => (s.git?.isRepo ? s.git.branch : undefined))
  const defaultBranch = useApp((s) => s.git?.defaultBranch)
  const busy = useApp((s) => (s.statuses[chatId] ?? 'idle') !== 'idle')
  const runGitAction = useApp((s) => s.runGitAction)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [handoffOpen, setHandoffOpen] = React.useState(false)
  const [finishOpen, setFinishOpen] = React.useState(false)
  // Merging is only ever offered off the default branch — on it there is
  // nothing to land. `defaultBranch` is the field the ↓n chip and the merge
  // dialog read, so the label names the branch the operation targets.
  const canMerge = !!branch && !!defaultBranch && branch !== defaultBranch
  const target = defaultBranch ?? 'main'

  if (!chat || (!canMerge && !chat.worktree)) {
    return (
      <WithTooltip label={tooltip}>
        <div className={className}>{children}</div>
      </WithTooltip>
    )
  }
  return (
    <>
      <DropdownMenu>
        <WithTooltip label={tooltip}>
          <DropdownMenuTrigger
            render={
              <button type="button" className={actionClassName}>
                {children}
              </button>
            }
          />
        </WithTooltip>
        <DropdownMenuContent align="start">
          {canMerge && (
            <>
              <DropdownMenuItem onClick={() => void runGitAction('update-from-main')}>
                <RefreshCw /> Update from {target}
              </DropdownMenuItem>
              {/* Merging rewrites the chat's own directory when there's no
                  worktree, so that one waits for idle. */}
              <DropdownMenuItem onClick={() => setMergeOpen(true)} disabled={busy}>
                <GitMerge /> Merge into {target}
              </DropdownMenuItem>
            </>
          )}
          {canMerge && chat.worktree && <DropdownMenuSeparator />}
          {chat.worktree && (
            <>
              <DropdownMenuItem onClick={() => setHandoffOpen(true)}>
                <ArrowLeftRight /> Continue in local checkout
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFinishOpen(true)}>
                <Trash /> Remove worktree
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canMerge && <MergeIntoMainDialog chat={chat} open={mergeOpen} onOpenChange={setMergeOpen} />}
      {chat.worktree && (
        <>
          <WorktreeHandoffDialog chat={chat} open={handoffOpen} onOpenChange={setHandoffOpen} />
          <WorktreeFinishDialog chat={chat} open={finishOpen} onOpenChange={setFinishOpen} />
        </>
      )}
    </>
  )
}

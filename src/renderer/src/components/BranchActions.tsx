import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { ChatMeta, OpResult } from '@shared/types'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
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
              {busy && <Loader2 className="size-3 animate-spin" />}
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

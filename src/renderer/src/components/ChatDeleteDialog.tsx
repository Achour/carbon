import * as React from 'react'
import type { ChatMeta, WorktreeStatus } from '@shared/types'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/** "3 uncommitted files and 2 unmerged commits" — what a force-delete destroys, '' when nothing is. */
function describeAtRisk({ dirtyFiles, unmergedCommits }: WorktreeStatus): string {
  const parts: string[] = []
  if (dirtyFiles > 0) parts.push(`${dirtyFiles} uncommitted file${dirtyFiles === 1 ? '' : 's'}`)
  if (unmergedCommits && unmergedCommits > 0) {
    parts.push(`${unmergedCommits} unmerged commit${unmergedCommits === 1 ? '' : 's'}`)
  }
  return parts.join(' and ')
}

/**
 * "Delete this chat?" — wherever it is asked.
 *
 * It was `Sidebar.tsx`'s, because the sidebar was the only place a chat could be
 * deleted from. Settings → Archive is the second, and a second confirm written
 * beside it is how two dialogs end up saying different things about what gets
 * destroyed — the same reasoning that moved the four project dialogs into
 * `ProjectDialogs.tsx`. This one has more to lose by drifting than those do: it
 * is the only dialog in the app that can take a worktree, and *what it would
 * destroy* is a live git read, not a sentence.
 *
 * The component owns that read, the three-way disposition it decides, and the
 * report of git's refusal afterwards. A host passes the chat and takes it back
 * to null — nothing else.
 */
export function ChatDeleteDialog({
  chat,
  onClose
}: {
  /** The chat being deleted; null closes the dialog. */
  chat: ChatMeta | null
  onClose: () => void
}): React.JSX.Element {
  const deleteChat = useApp((s) => s.deleteChat)
  const [wt, setWt] = React.useState<WorktreeStatus | null>(null)
  // git's refusal when worktree cleanup failed, shown after the dialog closes.
  const [error, setError] = React.useState<string | null>(null)

  // Fetch the dirty/unmerged report when a worktree chat's delete dialog opens,
  // so the confirm can say what would actually be lost.
  React.useEffect(() => {
    setWt(null)
    if (!chat?.worktree) return
    let cancelled = false
    void window.api.worktreeStatus(chat.id).then((s) => {
      if (!cancelled) setWt(s)
    })
    return () => {
      cancelled = true
    }
  }, [chat])

  // What a force-delete would destroy ('' when nothing), and whether the report
  // is still in flight — both derived, so the predicate lives in one place.
  const atRisk = wt ? describeAtRisk(wt) : ''
  const loading = !!chat?.worktree && !wt

  return (
    <>
      <Dialog open={error !== null} onOpenChange={(open) => !open && setError(null)}>
        <DialogContent>
          <DialogTitle>The worktree couldn’t be removed</DialogTitle>
          <DialogDescription>
            The chat was deleted, but its worktree is still on disk. Git said:
          </DialogDescription>
          <p className="mt-3 rounded-md bg-secondary/50 p-2 font-mono text-[11px] break-words text-destructive">
            {error}
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={chat !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            “{chat?.title || 'New chat'}” and its history will be removed permanently.
            {chat?.worktree && (
              <>
                {' '}
                It runs in the worktree{' '}
                <span className="font-medium text-foreground">{chat.worktree.branch}</span>.
                {wt
                  ? atRisk
                    ? ` It has ${atRisk} that deleting the worktree would destroy.`
                    : ' The worktree is clean and safe to delete.'
                  : ' Checking for uncommitted work…'}
              </>
            )}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {chat?.worktree && (
              <Button
                variant="ghost"
                onClick={() => {
                  void deleteChat(chat.id, 'keep')
                  onClose()
                }}
              >
                Keep worktree
              </Button>
            )}
            <Button
              variant="destructive"
              // Deleting is blocked only while we don't yet know what's at risk.
              disabled={loading}
              onClick={() => {
                if (!chat) return
                // Nothing at risk → a plain remove (git still refuses if it
                // disagrees). Otherwise the user has read the warning and forces.
                const disposition = !chat.worktree ? undefined : atRisk ? 'force' : 'remove'
                void deleteChat(chat.id, disposition).then((res) => {
                  // The chat is gone either way; a worktree git refused to
                  // remove is reported here, where the user asked for it.
                  if (!res.ok) setError(res.error)
                })
                onClose()
              }}
            >
              {!chat?.worktree ? 'Delete' : atRisk ? 'Delete anyway' : 'Delete with worktree'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

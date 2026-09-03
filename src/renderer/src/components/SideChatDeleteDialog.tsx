import * as React from 'react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/**
 * Confirms deleting a side chat.
 *
 * Rendered by `App` beside `CanvasDeleteDialog`, for that dialog's reason: the
 * state is store state, and the one surface a delete starts from — the panel's
 * `+` menu — closes the instant the ✕ is clicked, which would take the question
 * off screen with the answer still pending.
 *
 * It asks at all because a side chat is no longer temporary. While the app
 * deleted them on quit, the ✕ in the reopen list was discarding something the
 * next launch would have discarded anyway; now it is the only thing that ever
 * removes one, so it is a real deletion and says so. Same register as the
 * canvas dialog and for the same reason — this is a row in Carbon's own
 * database, with no file behind it and nothing in the Trash — and deliberately
 * *not* the wording of the chat delete it resembles, which can offer a
 * worktree disposition. A side chat never takes one.
 */
export function SideChatDeleteDialog(): React.JSX.Element {
  const pending = useApp((s) => s.pendingSideChatDelete)
  const confirmSideChatDelete = useApp((s) => s.confirmSideChatDelete)
  const deleteSideChat = useApp((s) => s.deleteSideChat)
  const [deleting, setDeleting] = React.useState(false)

  // The name goes in the *body*, not the title, and this is the one dialog where
  // that matters: a side chat's only title is the one `send` derives from the
  // first message, and the first message is very often a question — so
  // `Delete “…what is a race condition?”?` was the common case rather than an
  // edge one. `CanvasDeleteDialog` can name its subject in the title because a
  // canvas is titled with a noun phrase. Trimming the user's own punctuation to
  // fit the template would be the wrong fix; asking the question in the app's
  // words and quoting theirs underneath is not.
  const title = pending?.title?.trim()
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && confirmSideChatDelete(null)}>
      <DialogContent>
        <DialogTitle>Delete this side chat?</DialogTitle>
        <DialogDescription>
          {title ? <span className="text-foreground">“{title}”</span> : 'The conversation'} and
          everything in it is deleted permanently. Side chats are stored by Carbon, so there is no
          file to recover and nothing in the Trash.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => confirmSideChatDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              if (!pending) return
              setDeleting(true)
              void deleteSideChat(pending.id).finally(() => setDeleting(false))
            }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

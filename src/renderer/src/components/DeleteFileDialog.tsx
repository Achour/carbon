import * as React from 'react'
import { useApp } from '@/store'
import { basename } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/**
 * Confirms deleting a file or folder from the tree.
 *
 * Rendered by `App` rather than by `FileTree`, the way `PublishDialog` and
 * `FileSearchDialog` are: its open state is store state, and the tree it was
 * opened from unmounts whenever the dock switches to the changes view or the
 * panel closes — which would take the question off screen with the answer
 * still pending.
 *
 * The Trash is what makes this answerable rather than frightening: the question
 * is "are you sure", not "is this gone forever", and saying where it goes is
 * most of the reassurance.
 */
export function DeleteFileDialog(): React.JSX.Element {
  const pending = useApp((s) => s.pendingDelete)
  const confirmDelete = useApp((s) => s.confirmDelete)
  const deletePath = useApp((s) => s.deletePath)
  const [deleting, setDeleting] = React.useState(false)

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && confirmDelete(null)}>
      <DialogContent>
        <DialogTitle>Delete “{pending ? basename(pending.path) : ''}”?</DialogTitle>
        <DialogDescription>
          {pending?.kind === 'dir'
            ? 'The folder and everything in it moves to the Trash. Any of its files open in a tab will close.'
            : 'It moves to the Trash. If it is open in a tab, the tab will close.'}
        </DialogDescription>
        {pending?.error && (
          <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {pending.error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => confirmDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              if (!pending) return
              setDeleting(true)
              void deletePath(pending.path).finally(() => setDeleting(false))
            }}
          >
            {deleting ? 'Deleting…' : 'Move to Trash'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

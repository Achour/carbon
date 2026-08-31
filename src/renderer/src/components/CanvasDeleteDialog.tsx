import * as React from 'react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/**
 * Confirms deleting a canvas.
 *
 * Rendered by `App` beside `DeleteFileDialog`, for that dialog's reason: the
 * state is store state, and both surfaces the delete can be started from — the
 * Canvas tab and the sidebar inside an open canvas — unmount the moment the
 * panel switches tabs, which would take the question off screen with the answer
 * still pending.
 *
 * It asks in stronger terms than the file one, and has to: a file goes to the
 * Trash and can be fetched back, while a canvas is a row in Carbon's own
 * database with nowhere to go. The honest question here really is "is this gone
 * forever", so it says so rather than borrowing reassurance it cannot give.
 */
export function CanvasDeleteDialog(): React.JSX.Element {
  const pending = useApp((s) => s.pendingCanvasDelete)
  const confirmCanvasDelete = useApp((s) => s.confirmCanvasDelete)
  const deleteCanvas = useApp((s) => s.deleteCanvas)
  const [deleting, setDeleting] = React.useState(false)

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => !open && confirmCanvasDelete(null)}
    >
      <DialogContent>
        <DialogTitle>Delete “{pending?.title ?? ''}”?</DialogTitle>
        <DialogDescription>
          This canvas is deleted permanently. It is stored by Carbon rather than in your project,
          so there is no file to recover and nothing in the Trash.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => confirmCanvasDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              if (!pending) return
              setDeleting(true)
              void deleteCanvas(pending.id).finally(() => setDeleting(false))
            }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

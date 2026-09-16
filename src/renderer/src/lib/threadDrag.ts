/**
 * A sidebar chat being dragged toward a thread.
 *
 * The drag payload's own type keeps the composer's file drop and the column
 * reorder from reacting to it. The id is also held here, because a drop target
 * has to say *while hovering* whether the drop would be accepted — full thread,
 * other folder — and `dataTransfer.getData` is empty until the drop itself.
 */
export const THREAD_DRAG_MIME = 'application/x-carbon-thread'

let dragged: string | null = null

export function setDraggedThread(id: string | null): void {
  dragged = id
}

export function draggedThread(): string | null {
  return dragged
}

/**
 * A thread's column being dragged — to another column to reorder, or onto the
 * sidebar to leave the thread and become a chat of its own. Held for the same
 * reason as the thread: the sidebar has to know, while hovering, whether the
 * column *can* leave (the thread's own chat cannot).
 */
export const COLUMN_DRAG_MIME = 'application/x-carbon-thread-chat'

let draggedCol: string | null = null

export function setDraggedColumn(id: string | null): void {
  draggedCol = id
}

export function draggedColumn(): string | null {
  return draggedCol
}

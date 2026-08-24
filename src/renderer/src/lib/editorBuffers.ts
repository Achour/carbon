import { EditorState, type Extension, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Open editor buffers, held **outside React and outside zustand**.
 *
 * Outside React because `EditorState` must survive a tab switch: `RightPanel`
 * unmounts the inactive editor, and re-creating the state on return would lose
 * undo history, cursor and scroll position — the same reason drafts are keyed
 * per chat rather than rebuilt.
 *
 * Outside zustand because the document changes on every keystroke. Routing it
 * through the store would re-render every subscriber twice a second while
 * typing; the store learns only about *transitions* (clean ⇄ dirty), which
 * happen once per edit session rather than once per character.
 */
export interface Buffer {
  state: EditorState
  /**
   * The document as it was last read from — or written to — disk, kept as
   * CodeMirror's own `Text` rather than as a string. `Text.eq` compares ropes
   * structurally and skips shared subtrees by reference, so an untouched buffer
   * settles on an identity check and an undone one on a handful of pointer
   * comparisons; flattening to a string would rebuild the whole file each time.
   */
  baseDoc: Text
  /** mtime of that disk snapshot; the write guard's `expectedMtimeMs`. */
  mtimeMs: number
  /**
   * Cached `doc !== baseDoc`. Recomputed only when a transaction actually
   * changed the document, so cursor movement — which dispatches a transaction
   * per mousemove of a drag — costs a field read rather than a comparison.
   */
  dirty: boolean
}

const buffers = new Map<string, Buffer>()

/** Set while `adoptDisk` moves a buffer, so `syncBuffer` stays quiet. */
let adopting = false

/**
 * Mounted views, by path. Only the active tab has one — `RightPanel` renders a
 * single editor — which is why `adoptDisk` cannot assume there is one, and why a
 * jump needs this to find the view for a file it just asked the store to open.
 */
const views = new Map<string, EditorView>()

/**
 * Scroll offset per path. It is a property of *viewing* the file rather than of
 * its content, and unlike the selection it cannot be recovered from
 * `EditorState` — so it lives here, next to the buffer, and is released by the
 * same call. Held in a component it was a second thing every disposal site had
 * to remember, and the sites disagreed.
 */
const scrollTops = new Map<string, number>()

/** Notified when a path's dirty state flips, so the store can repaint the tab. */
type DirtyListener = (path: string, dirty: boolean) => void
let onDirtyChange: DirtyListener | null = null

export function setDirtyListener(fn: DirtyListener | null): void {
  onDirtyChange = fn
}

export function getBuffer(path: string): Buffer | undefined {
  return buffers.get(path)
}

export function createBuffer(
  path: string,
  opts: { text: string; mtimeMs: number; extensions: Extension }
): Buffer {
  const state = EditorState.create({ doc: opts.text, extensions: opts.extensions })
  const buf: Buffer = { state, baseDoc: state.doc, mtimeMs: opts.mtimeMs, dirty: false }
  buffers.set(path, buf)
  return buf
}

/**
 * Record the state after a transaction and report a dirty transition.
 *
 * Dirtiness is `doc !== baseDoc`, not a sticky "was edited" flag, so typing a
 * character and deleting it leaves the tab clean — and, more usefully, an undo
 * back to the saved text does too.
 *
 * The early return sits above any comparison because `dispatchTransactions`
 * fires for *every* transaction, and selection-only ones outnumber edits by a
 * wide margin — `MouseSelection` dispatches one per mousemove of a drag.
 */
export function syncBuffer(path: string, state: EditorState, docChanged: boolean): void {
  const buf = buffers.get(path)
  if (!buf) return
  buf.state = state
  // Mid-adopt the doc and the base move together, and a transition reported off
  // that half-applied pair would flash an unsaved dot on a file nobody touched.
  if (adopting || !docChanged) return
  const nowDirty = !state.doc.eq(buf.baseDoc)
  if (nowDirty === buf.dirty) return
  buf.dirty = nowDirty
  onDirtyChange?.(path, nowDirty)
}

export function isDirty(path: string): boolean {
  return buffers.get(path)?.dirty ?? false
}

/** Current text — what `saveFile` writes. */
export function bufferText(path: string): string | null {
  const buf = buffers.get(path)
  return buf ? buf.state.doc.toString() : null
}

export function bufferMtime(path: string): number | null {
  return buffers.get(path)?.mtimeMs ?? null
}

/**
 * After a successful write: the buffer becomes its own disk snapshot. The doc
 * that was written *is* the new base, so this is a reference assignment and the
 * next comparison settles on `Text.eq`'s identity check.
 */
export function markSaved(path: string, mtimeMs: number): void {
  const buf = buffers.get(path)
  if (!buf) return
  buf.baseDoc = buf.state.doc
  buf.mtimeMs = mtimeMs
  if (!buf.dirty) return
  buf.dirty = false
  onDirtyChange?.(path, false)
}

/**
 * Adopt a new disk snapshot (the agent, a terminal, or a git operation changed
 * the file while it sat open).
 *
 * This has to move the *buffer*, not just the view, because only the active tab
 * has a view. Advancing the base while leaving a background tab's doc on the old
 * text is the worst outcome available: the buffer reads as dirty though nothing
 * was typed, the tab shows stale content when you return to it, and ⌘S then
 * writes that stale doc under the *new* mtime — so the guard passes and the
 * agent's edit is silently reverted.
 *
 * A mounted view is updated by dispatching into it rather than by rebuilding —
 * replacing the view would drop scroll position and flash the pane.
 *
 * Refuses on a dirty buffer unless forced: that is a conflict, and the store
 * handles it by asking rather than by picking a winner. `force` is how the
 * user's answer ("discard mine") is applied.
 */
export function adoptDisk(
  path: string,
  text: string,
  mtimeMs: number,
  opts?: { force?: boolean }
): boolean {
  const buf = buffers.get(path)
  if (!buf || (buf.dirty && !opts?.force)) return false
  const wasDirty = buf.dirty
  const len = buf.state.doc.length
  // Same bytes, new mtime (a touch, or a rewrite with identical content).
  // Taking the mtime is what stops the next refresh re-reading it forever.
  const identical = len === text.length && buf.state.doc.toString() === text
  if (!identical) {
    const changes = { from: 0, to: len, insert: text }
    const view = views.get(path)
    adopting = true
    try {
      if (view) view.dispatch({ changes })
      else buf.state = buf.state.update({ changes }).state
    } finally {
      adopting = false
    }
  }
  buf.baseDoc = buf.state.doc
  buf.mtimeMs = mtimeMs
  buf.dirty = false
  if (wasDirty) onDirtyChange?.(path, false)
  return true
}

/** Force a buffer's base mtime forward without touching the doc (Overwrite). */
export function rebaseTo(path: string, mtimeMs: number): void {
  const buf = buffers.get(path)
  if (buf) buf.mtimeMs = mtimeMs
}

/**
 * Move a buffer to a new path (a rename, or a folder above it being renamed).
 *
 * Re-keying rather than dropping and re-reading is what makes a rename
 * non-destructive: the document, its undo history, its cursor and its unsaved
 * state are all properties of the *file*, not of its name. Dropping the buffer
 * would silently discard unsaved edits at the moment the user was only
 * relabelling something.
 */
export function renameBuffer(from: string, to: string): void {
  const buf = buffers.get(from)
  if (buf) {
    buffers.delete(from)
    buffers.set(to, buf)
  }
  const top = scrollTops.get(from)
  if (top !== undefined) {
    scrollTops.delete(from)
    scrollTops.set(to, top)
  }
  // The view is deliberately *not* moved: `CodeEditor`'s mount effect is keyed
  // on `path`, so it tears the old one down and builds a new one against the
  // re-keyed buffer — which is also what rebinds the language server to the new
  // uri, something renaming a map entry could not do.
  views.delete(from)
}

/** Releases everything keyed by this path, so a caller has one call to make. */
export function dropBuffer(path: string): void {
  const buf = buffers.get(path)
  if (!buf) return
  buffers.delete(path)
  scrollTops.delete(path)
  if (buf.dirty) onDirtyChange?.(path, false)
}

export function registerView(path: string, view: EditorView): void {
  views.set(path, view)
}

export function unregisterView(path: string, view: EditorView): void {
  if (views.get(path) === view) views.delete(path)
}

export function viewForPath(path: string): EditorView | null {
  return views.get(path) ?? null
}

export function scrollTop(path: string): number | undefined {
  return scrollTops.get(path)
}

export function setScrollTop(path: string, top: number): void {
  scrollTops.set(path, top)
}

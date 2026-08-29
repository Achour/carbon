import { useApp } from '@/store'
import { viewForPath } from '@/lib/editorBuffers'

/**
 * Route ⌘F to CodeMirror's search panel when the active tab is an editor.
 *
 * `FindBar` collects ranges by walking the DOM under `#editor-find-scope`, which
 * is correct for the diff view and the Markdown preview and wrong for
 * CodeMirror: only the visible viewport exists in the DOM, so a DOM search
 * silently limits itself to what is on screen — the worst kind of wrong answer,
 * because it looks like a complete one.
 *
 * Returns false when there is no editor to search, so the caller falls back.
 */
export function openEditorSearch(): boolean {
  const path = useApp.getState().activeTab
  if (!path) return false
  const view = viewForPath(path)
  if (!view) return false
  view.focus()
  // Dynamic, but never actually a wait: a *view* exists, so the editor chunk
  // that owns `@codemirror/search` is already loaded and this resolves on a
  // microtask. Statically it would have pulled that chunk into the entry for
  // every session, to answer a question that is `false` until a file is open.
  void import('@codemirror/search').then(({ openSearchPanel }) => openSearchPanel(view))
  return true
}

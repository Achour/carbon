import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useApp } from './store'
import { useTaskList } from './taskListStore'
import { useAgents } from './agentsStore'
import { previewForCwd } from './lib/previewRegistry'
import { releaseAllServers } from './lib/lspBridge'
import {
  applyCodeFontSize,
  applyTheme,
  applyTranslucent,
  installThemes,
  storedCodeFontSize,
  storedTheme,
  storedThemeMode,
  storedTranslucent
} from './lib/themes'

installThemes()
applyTheme(storedTheme(), storedThemeMode())
applyCodeFontSize(storedCodeFontSize())
applyTranslucent(storedTranslucent())

const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)')
systemAppearance.addEventListener('change', () => useApp.getState().syncSystemAppearance())

const syncWindowActivity = (): void => {
  const visible = document.visibilityState === 'visible'
  document.documentElement.dataset.windowVisible = String(visible)
  document.documentElement.dataset.windowActive = String(visible && document.hasFocus())
}
syncWindowActivity()
document.addEventListener('visibilitychange', syncWindowActivity)
window.addEventListener('focus', syncWindowActivity)
window.addEventListener('blur', syncWindowActivity)

// Language servers are child processes held by a refcount that this window owns
// — nothing else ever decrements it, so without this they sit idle until their
// timeout rather than exiting with the window that started them.
window.addEventListener('beforeunload', releaseAllServers)

// Stream events parked while the window was hidden replay on reveal.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') useApp.getState().flushHiddenEvents()
})

if (import.meta.env.DEV) {
  // Expose the store (and preview registry) for the AIGUI_E2E dev hook.
  ;(window as unknown as Record<string, unknown>).__app = useApp
  ;(window as unknown as Record<string, unknown>).__previewForCwd = previewForCwd
  // The two app-wide singletons a second transcript must never publish into
  // (see Side chats). They are stores of their own, so `__app` cannot reach
  // them, and "the side chat quietly took over the dock" has no other symptom
  // than the wrong chat's checklist — which is exactly what a probe is for.
  ;(window as unknown as Record<string, unknown>).__tasks = useTaskList
  ;(window as unknown as Record<string, unknown>).__agents = useAgents
  // The editor's buffers and views live outside React and outside the store, so
  // the E2E hook needs its own handle on them to assert anything about editing.
  //
  // Imported dynamically, and *only* here: statically, these three modules put
  // the whole of CodeMirror in the entry chunk of every build, including the
  // packaged one where this block is dead code. The hook lands a tick after
  // load, which is well before an E2E script can reach it.
  void Promise.all([
    import('./lib/editorBuffers'),
    import('./lib/lspClient'),
    import('./components/CodeEditor')
  ]).then(([buffers, lsp, editor]) => {
    ;(window as unknown as Record<string, unknown>).__editor = {
      viewForPath: buffers.viewForPath,
      isDirty: buffers.isDirty,
      bufferText: buffers.bufferText,
      jump: lsp.jumpToDefinitionAt,
      jumpFailure: lsp.jumpFailure,
      addSel: editor.addSelectionToChat
    }
  })
  window.addEventListener('error', (e) => console.error('[window error]', e.message))
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[unhandled rejection]', e.reason?.message ?? String(e.reason))
  )
}

// A boundary *outside* `App`, not just the one around the content pane. React
// unmounts the entire root when a render throws with no boundary above it, and
// everything the pane's boundary does not cover — the sidebar, the dialogs, the
// providers — is on that path: one unrenderable chat row left the window a flat
// sheet of the theme's background color, with no error, no UI and no way back.
// This one cannot make the app work, but it can always say what broke.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)

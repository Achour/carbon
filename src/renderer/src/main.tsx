import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useApp } from './store'
import { previewForCwd } from './lib/previewRegistry'
import { bufferText, isDirty, viewForPath } from './lib/editorBuffers'
import { jumpToDefinition, releaseAllServers } from './lib/lspClient'
import { addSelectionToChat } from './components/CodeEditor'
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
  // The editor's buffers and views live outside React and outside the store, so
  // the E2E hook needs its own handle on them to assert anything about editing.
  ;(window as unknown as Record<string, unknown>).__editor = {
    viewForPath,
    isDirty,
    bufferText,
    jump: jumpToDefinition,
    addSel: addSelectionToChat
  }
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

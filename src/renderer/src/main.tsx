import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useApp } from './store'
import {
  applyCodeFontSize,
  applyTheme,
  installThemes,
  storedCodeFontSize,
  storedTheme
} from './lib/themes'

installThemes()
applyTheme(storedTheme())
applyCodeFontSize(storedCodeFontSize())

if (import.meta.env.DEV) {
  // Expose the store for the AIGUI_E2E dev hook.
  ;(window as unknown as Record<string, unknown>).__app = useApp
  window.addEventListener('error', (e) => console.error('[window error]', e.message))
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[unhandled rejection]', e.reason?.message ?? String(e.reason))
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

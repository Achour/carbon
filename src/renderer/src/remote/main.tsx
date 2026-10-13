import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { App } from './App'
import './remote.css'

// The desktop's tokens key dark mode off `.dark`; a phone follows its own
// system appearance, live. `remote.html` sets it once before first paint.
const dark = window.matchMedia('(prefers-color-scheme: dark)')
dark.addEventListener('change', () => document.documentElement.classList.toggle('dark', dark.matches))

createRoot(document.getElementById('root')!).render(<App />)

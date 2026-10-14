import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ImageLightbox } from '@/components/ImageView'
import { App } from './App'
import { installDesktopBridge } from './desktop'
import { installPushWorker } from './push'
import './remote.css'

// The desktop's tokens key dark mode off `.dark`; a phone follows its own
// system appearance, live. `remote.html` sets it once before first paint.
const dark = window.matchMedia('(prefers-color-scheme: dark)')
dark.addEventListener('change', () => document.documentElement.classList.toggle('dark', dark.matches))

// Before the first render: the transcript is the desktop's components.
installDesktopBridge()
// So a tap on a notification can open its chat, whatever screen this launched on.
installPushWorker()

createRoot(document.getElementById('root')!).render(
  <TooltipProvider delay={500}>
    <App />
    <ImageLightbox />
  </TooltipProvider>
)

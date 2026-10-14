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

// A Home Screen app draws under its translucent status bar, yet iOS still
// reports `100dvh` as the screen minus that bar, which left a strip the bar's
// height empty at the bottom. Running full screen, the app's height is the
// screen's own, so measure that; anywhere else (a Safari tab, an iPad window
// that is not full width) `--app-height` stays unset and `100dvh` answers.
function fitStandalone(): void {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  if (!standalone) return
  const fit = (): void => {
    const landscape = window.matchMedia('(orientation: landscape)').matches
    const long = Math.max(screen.width, screen.height)
    const short = Math.min(screen.width, screen.height)
    const [w, h] = landscape ? [long, short] : [short, long]
    const root = document.documentElement.style
    if (window.innerWidth === w && h > window.innerHeight) root.setProperty('--app-height', `${h}px`)
    else root.removeProperty('--app-height')
  }
  fit()
  window.addEventListener('resize', fit)
}
fitStandalone()

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

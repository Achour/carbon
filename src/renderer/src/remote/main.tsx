import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ImageLightbox } from '@/components/ImageView'
import { App } from './App'
import { installDesktopBridge } from './desktop'
import { installPushWorker } from './push'
import { installPrefs } from './prefs'
import './remote.css'

// The palette, the color mode (System follows the phone, live) and both type
// sizes. `remote.html` has already painted the first frame in the right one.
installPrefs()

// A Home Screen app added while the page asked for a translucent status bar
// (`remote.html`, before it asked for the default one) still draws under that
// bar, yet iOS reports `100dvh` as the screen minus it, which left a strip the
// bar's height empty at the bottom. There the app's height is the screen's
// own, so measure that. An icon added since starts below the bar, where
// `100dvh` is right, and so does everywhere else (a Safari tab, an iPad window
// that is not full width): `--app-height` stays unset.
function fitStandalone(): void {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  if (!standalone || !underStatusBar()) return
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

// With the keyboard up, the app is the visible area above it (`--kb-height`).
// Left full height, the page is taller than what shows, and iOS scrolls the
// whole of it up to reveal the composer, taking the header off the top. Sized
// to the visual viewport there is nothing for it to scroll, so the header
// stays and the composer sits on the keys, as in Messages.
function followKeyboard(): void {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement.style
  let full = window.innerHeight
  const apply = (): void => {
    if (vv.height > full) full = vv.height
    const open = full - vv.height > 120
    document.documentElement.classList.toggle('kb-open', open)
    if (open) {
      root.setProperty('--kb-height', `${Math.round(vv.height)}px`)
      // What iOS already scrolled before the resize landed.
      if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0)
    } else root.removeProperty('--kb-height')
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  // A rotation changes what "no keyboard" measures.
  window.addEventListener('orientationchange', () => {
    full = 0
    setTimeout(() => {
      full = window.innerHeight
      apply()
    }, 300)
  })
}
followKeyboard()

/** The page reaches up under the status bar: a top safe-area inset is reported. */
function underStatusBar(): boolean {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;visibility:hidden;padding-top:env(safe-area-inset-top)'
  document.body.appendChild(probe)
  const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  return inset > 0
}

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

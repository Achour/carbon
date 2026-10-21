import * as React from 'react'
import { PanelLeft, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import * as api from './api'
import { ChatScreen } from './ChatScreen'
import { NewChatScreen } from './NewChat'
import { PairScreen } from './Pair'
import { UsageScreen } from './UsageScreen'
import { Sidebar } from './Sidebar'
import { useAppBadge } from './board'
import { clearCache, loadSnapshot } from './cache'

/**
 * Routes live in the hash — `#/` (a new chat), `#/c/<id>`, `#/new/<project>`,
 * `#/usage` —
 * so a reload, or iOS restoring a Home Screen app, lands where the user was.
 * `#pair=<code>` is the QR code's link: it pre-fills the pairing screen and is
 * then dropped. The chat list is not a route: it is the sidebar, as on the Mac.
 */
type Route =
  | { name: 'chat'; id: string }
  | { name: 'new'; cwd: string | null; worktree?: { path: string; branch: string } }
  | { name: 'usage' }

function readRoute(): Route {
  const h = location.hash
  if (h === '#/usage') return { name: 'usage' }
  const chat = /^#\/c\/(.+)$/.exec(h)
  if (chat) return { name: 'chat', id: decodeURIComponent(chat[1]) }
  // `#/new/<project>?wt=<path>&branch=<name>`: "New chat in this worktree".
  const fresh = /^#\/new\/([^?]+)(?:\?(.*))?$/.exec(h)
  if (!fresh) return { name: 'new', cwd: null }
  const q = new URLSearchParams(fresh[2] ?? '')
  const path = q.get('wt')
  const branch = q.get('branch')
  return {
    name: 'new',
    cwd: decodeURIComponent(fresh[1]),
    worktree: path && branch ? { path, branch } : undefined
  }
}

/** The New-chat screen for `root`, run in that worktree of it. */
export function newChatInWorktreeHash(root: string, path: string, branch: string): string {
  return `#/new/${encodeURIComponent(root)}?${new URLSearchParams({ wt: path, branch })}`
}

/**
 * Replaced, never pushed: the app keeps no history. iOS reads a swipe from the
 * left edge as Back whenever there is history behind the page, and takes it
 * before the drawer's own edge swipe sees a touch, so each chat opened was
 * one more screen the drawer gesture would go back to instead of opening.
 * Nothing here uses Back: navigation is the sidebar, as on the Mac.
 */
export function navigate(hash: string): void {
  if (location.hash !== hash) location.replace(hash)
}

export function App(): React.JSX.Element {
  const [route, setRoute] = React.useState<Route>(readRoute)
  const [pairCode] = React.useState(() => /^#pair=(\d+)/.exec(location.hash)?.[1] ?? null)
  // With a cache from an earlier launch the app draws at once, as paired: the
  // check below still runs, and an answer of "not paired" takes over. Without
  // one there is nothing to draw until the Mac says.
  const [paired, setPaired] = React.useState<boolean | null>(() => (loadSnapshot() ? true : null))
  const connection = useRemote((s) => s.connection)

  React.useEffect(() => {
    if (pairCode) history.replaceState(null, '', '/#/')
    const onHash = (): void => {
      // A pairing link opened onto a page already showing: start over with it.
      if (location.hash.startsWith('#pair=')) location.reload()
      else setRoute(readRoute())
    }
    window.addEventListener('hashchange', onHash)
    void api
      .paired()
      .then((ok) => {
        if (!ok) clearCache()
        setPaired(ok)
      })
      // Unreachable is not unpaired: a launch with a cache stays on it and
      // says it is reconnecting.
      .catch(() => setPaired((p) => p ?? false))
    return () => window.removeEventListener('hashchange', onHash)
  }, [pairCode])

  React.useEffect(() => {
    if (paired) useRemote.getState().start()
  }, [paired])

  const openId = route.name === 'chat' ? route.id : null
  React.useEffect(() => {
    if (paired) void useRemote.getState().openChat(openId)
  }, [paired, openId])

  if (paired === null) return <div className="h-[var(--kb-height,var(--app-height,100dvh))]" />
  if (!paired || connection === 'unpaired') {
    return <PairScreen initialCode={pairCode ?? ''} onPaired={() => location.reload()} />
  }

  const key =
    route.name === 'chat'
      ? `c:${route.id}`
      : route.name === 'usage'
        ? 'usage'
        : `n:${route.cwd ?? ''}:${route.worktree?.path ?? ''}`
  return (
    <>
      <Shell activeId={openId}>
        {/* Keyed, so each screen arrives with the short fade the desktop's
            panes use rather than swapping in place. */}
        <div key={key} className="h-full animate-in fade-in duration-200">
          {route.name === 'chat' ? (
            <ChatScreen chatId={route.id} />
          ) : route.name === 'usage' ? (
            <UsageScreen />
          ) : (
            <NewChatScreen
              initialCwd={route.cwd}
              initialTarget={
                route.worktree && route.cwd
                  ? { kind: 'existing', path: route.worktree.path, branch: route.worktree.branch, repoRoot: route.cwd }
                  : undefined
              }
            />
          )}
        </div>
      </Shell>
      <ErrorToast />
    </>
  )
}

/** Where a swipe has to start to open the drawer: the screen's left edge. */
const EDGE = 28
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * The page and its sidebar drawer. The drawer follows the finger — from the
 * left edge to open it, anywhere to close it — and settles open or shut on
 * release by distance and speed, the way a native drawer does. During a drag
 * the transforms are written straight to the elements: a React render per
 * touch-move would re-render the transcript sixty times a second.
 */
function Shell({ activeId, children }: { activeId: string | null; children: React.ReactNode }): React.JSX.Element {
  const open = useRemote((s) => s.drawer)
  const setDrawer = useRemote((s) => s.setDrawer)
  useAppBadge()
  const drawer = React.useRef<HTMLDivElement>(null)
  const main = React.useRef<HTMLDivElement>(null)
  const scrim = React.useRef<HTMLDivElement>(null)
  const width = (): number => Math.min(window.innerWidth * 0.86, 340)

  const paint = React.useCallback((offset: number, animate: boolean): void => {
    const w = Math.min(window.innerWidth * 0.86, 340)
    const t = animate
      ? `transform 380ms ${EASE}, opacity 380ms ${EASE}, box-shadow 380ms ${EASE}`
      : 'none'
    const p = Math.max(0, Math.min(1, offset / w))
    if (drawer.current) {
      drawer.current.style.transition = t
      drawer.current.style.transform = `translateX(${offset - w}px)`
      // Faded with the drawer: at full strength it reaches 40px past the
      // drawer's edge, which is onto the page while the drawer is closed.
      drawer.current.style.boxShadow = `8px 0 32px rgb(0 0 0 / ${0.18 * p})`
    }
    if (main.current) {
      main.current.style.transition = t
      main.current.style.transform = p ? `translateX(${offset * 0.22}px)` : ''
    }
    if (scrim.current) {
      scrim.current.style.transition = t
      scrim.current.style.opacity = String(p)
      scrim.current.style.pointerEvents = p > 0 ? 'auto' : 'none'
    }
  }, [])

  React.useLayoutEffect(() => {
    paint(open ? width() : 0, true)
  }, [open, paint])

  const gesture = React.useRef<{
    x: number
    y: number
    base: number
    axis: 'x' | 'y' | null
    offset: number
    t: number
    v: number
  } | null>(null)

  const onTouchStart = (e: React.TouchEvent): void => {
    const touch = e.touches[0]
    if (!open && touch.clientX > EDGE) return
    gesture.current = {
      x: touch.clientX,
      y: touch.clientY,
      base: open ? width() : 0,
      axis: null,
      offset: open ? width() : 0,
      t: e.timeStamp,
      v: 0
    }
  }
  const onTouchMove = (e: React.TouchEvent): void => {
    const g = gesture.current
    if (!g) return
    const touch = e.touches[0]
    const dx = touch.clientX - g.x
    const dy = touch.clientY - g.y
    if (!g.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (g.axis !== 'x') return
    const offset = Math.max(0, Math.min(width(), g.base + dx))
    const dt = Math.max(1, e.timeStamp - g.t)
    g.v = (offset - g.offset) / dt
    g.offset = offset
    g.t = e.timeStamp
    paint(offset, false)
  }
  const onTouchEnd = (): void => {
    const g = gesture.current
    gesture.current = null
    if (!g || g.axis !== 'x') return
    const next = g.v > 0.35 ? true : g.v < -0.35 ? false : g.offset > width() / 2
    if (next === open) paint(next ? width() : 0, true)
    else setDrawer(next)
  }

  return (
    // Not `position: fixed`: a Home Screen app clips fixed content to a
    // viewport a status bar shorter than the screen, which cut the composer
    // off at the bottom. The header is what is pinned (`Header`).
    <div
      className="relative h-[var(--kb-height,var(--app-height,100dvh))] overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div ref={main} className="h-full will-change-transform">
        {children}
      </div>
      <div
        ref={scrim}
        aria-hidden
        onClick={() => setDrawer(false)}
        className="absolute inset-0 z-30 bg-black/45 opacity-0"
        style={{ pointerEvents: 'none' }}
      />
      <div
        ref={drawer}
        className="absolute inset-y-0 left-0 z-40 w-[min(86vw,340px)] will-change-transform"
        style={{ transform: 'translateX(-100%)' }}
      >
        <Sidebar activeId={activeId} onNavigate={() => setDrawer(false)} />
      </div>
    </div>
  )
}

/**
 * The bar every screen wears: the sidebar, a title, and the screen's menu.
 *
 * `floating` lays it over the screen's scroller; the hairline appears only
 * once something is under it.
 *
 * Always `position: fixed` and opaque, for iOS rather than for layout: in
 * flow, a spacer the bar's measured height holds its place. iOS lays its own
 * progressive blur over the top of a Home Screen web app, above the page, and
 * this bar sat in it. Two things turn it off, and both are needed, measured
 * in the Simulator as a Home Screen app: the default status bar
 * (`remote.html`), so the page starts below it, and an opaque bar fixed to
 * the top. `sticky` does not count where nothing scrolls around it, and
 * translucent with a blur it is sharp but shows a seam against the status
 * bar. Tapping the title is the
 * status-bar tap iOS gives a page's own scroll and not an inner scroller's.
 */
export function Header({
  title,
  subtitle,
  floating,
  scrolled,
  onTitleTap,
  actions,
  ref
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  floating?: boolean
  scrolled?: boolean
  onTitleTap?: () => void
  /** The right-hand button: the chat screen's own menu. */
  actions?: React.ReactNode
  ref?: React.Ref<HTMLElement>
}): React.JSX.Element {
  const setDrawer = useRemote((s) => s.setDrawer)
  const waiting = useRemote((s) => Object.values(s.permissions).some((list) => list.length > 0))
  const own = React.useRef<HTMLElement | null>(null)
  const [height, setHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = own.current
    if (floating || !el) return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [floating])
  const setRef = (el: HTMLElement | null): void => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as React.RefObject<HTMLElement | null>).current = el
  }
  return (
    <>
    <header
      ref={setRef}
      className={cn(
        'fixed inset-x-0 top-0 z-20 bg-background pt-[env(safe-area-inset-top)]',
        floating && 'border-b transition-[border-color] duration-200',
        floating && (scrolled ? 'border-border/70' : 'border-transparent')
      )}
    >
      <div className="flex h-[52px] items-center gap-1 px-1.5">
        <button
          type="button"
          aria-label="Open sidebar"
          onClick={() => setDrawer(true)}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
        >
          <PanelLeft className="size-[21px]" />
          {/* Something somewhere is waiting on you — the sidebar says what. */}
          {waiting && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-warning ring-2 ring-background" />}
        </button>
        <button
          type="button"
          tabIndex={onTitleTap ? 0 : -1}
          onClick={onTitleTap}
          className="min-w-0 flex-1 text-center"
        >
          <div className="truncate text-[16px] font-semibold">{title}</div>
          {subtitle && <div className="truncate text-[12.5px] leading-tight text-muted-foreground">{subtitle}</div>}
        </button>
        {/* New chats start from the sidebar; the right is the screen's own
            menu, or the sidebar button's width of nothing, so the title stays
            centred. */}
        {actions ?? <span aria-hidden className="size-11 shrink-0" />}
      </div>
      <ConnectionStrip />
    </header>
    {!floating && <div aria-hidden className="shrink-0" style={{ height }} />}
    </>
  )
}

function ErrorToast(): React.JSX.Element | null {
  const error = useRemote((s) => s.error)
  const setError = useRemote((s) => s.setError)
  React.useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(t)
  }, [error, setError])
  if (!error) return null
  return (
    <button
      type="button"
      onClick={() => setError(null)}
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+60px)] z-50 animate-in rounded-2xl border border-destructive/30 bg-popover px-4 py-3 text-left text-[14px] text-destructive shadow-lg fade-in slide-in-from-top-2"
    >
      {error}
    </button>
  )
}

/** Says the Mac is not answering, and that it is retrying. */
function ConnectionStrip(): React.JSX.Element | null {
  const connection = useRemote((s) => s.connection)
  if (connection === 'live' || connection === 'unpaired') return null
  return (
    <div
      className={cn(
        'mx-3 mb-1 flex animate-in items-center justify-center gap-2 rounded-full py-1.5 text-[12.5px] fade-in',
        connection === 'down' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'
      )}
    >
      {connection === 'down' ? (
        <>
          <WifiOff className="size-3.5" /> Can’t reach your Mac — retrying…
        </>
      ) : (
        'Connecting…'
      )}
    </div>
  )
}

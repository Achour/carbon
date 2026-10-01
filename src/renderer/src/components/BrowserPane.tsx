import * as React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  Ellipsis,
  ExternalLink,
  MonitorSmartphone,
  MousePointerClick,
  Play,
  RotateCw,
  RotateCwSquare,
  ScrollText,
  Server,
  Square,
  X
} from 'lucide-react'
import type { Attachment, ElementRef, LocalServer, PreviewEmulation } from '@shared/types'
import {
  applyViewportPatch,
  describeViewport,
  FILL_VIEWPORT,
  PREVIEW_DEVICES,
  viewportSize,
  type PreviewColorScheme,
  type PreviewViewport
} from '@shared/previewDevices'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { registerPreview, unregisterPreview, type PreviewHandle } from '@/lib/previewRegistry'
import { classifyInk } from '@/lib/faviconInk'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/** Minimal shape of Electron's <webview> tag — enough for what we drive here. */
interface WV extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(code: string): Promise<unknown>
  getWebContentsId(): number
  openDevTools(): void
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{
    toDataURL(): string
    isEmpty(): boolean
  }>
}

const PICK_PREFIX = '__KARBUN_PICK__'

/** What the injected picker posts back (via console) when an element is clicked. */
interface PickPayload {
  url: string
  tag: string
  selector: string
  label?: string
  html?: string
  source?: { file: string; line?: number; column?: number } | null
  /** React 19: where the element was created, as a served-module frame to resolve. */
  frame?: { url: string; line: number; column: number } | null
  component?: string | null
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Runs inside the guest page (main world, so it can read React fibers). Draws a
 * hover highlight, and on click posts the element's location + source via
 * console.log with a magic prefix the host listens for. Stringified and
 * injected on every dom-ready, so it survives navigations. (Uncaught errors
 * reach the agent through CDP in main now, whoever started the server.)
 */
function karbunPicker(): void {
  const w = window as unknown as Record<string, unknown>
  if (w.__karbunPickInstalled) return
  w.__karbunPickInstalled = true
  const PREFIX = '__KARBUN_PICK__'
  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #4f8cff;background:rgba(79,140,255,0.14);border-radius:2px;display:none;'
  let enabled = false
  let current: Element | null = null

  const ensure = (): void => {
    if (!overlay.parentNode && document.body) document.body.appendChild(overlay)
  }
  const place = (el: Element): void => {
    ensure()
    const r = el.getBoundingClientRect()
    overlay.style.display = 'block'
    overlay.style.left = r.left + 'px'
    overlay.style.top = r.top + 'px'
    overlay.style.width = r.width + 'px'
    overlay.style.height = r.height + 'px'
  }
  const fiberOf = (el: Element): Record<string, unknown> | null => {
    for (const k in el) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
        return (el as unknown as Record<string, unknown>)[k] as Record<string, unknown>
      }
    }
    return null
  }
  const sourceOf = (el: Element): PickPayload['source'] => {
    let f = fiberOf(el)
    let guard = 0
    while (f && guard < 2000) {
      guard++
      const props = f.memoizedProps as { __source?: Record<string, unknown> } | undefined
      const s = (f._debugSource as Record<string, unknown>) || props?.__source
      if (s && s.fileName) {
        return {
          file: s.fileName as string,
          line: s.lineNumber as number | undefined,
          column: s.columnNumber as number | undefined
        }
      }
      f = f.return as Record<string, unknown> | null
    }
    return null
  }
  // **React 19 dropped `_debugSource`.** What a dev fiber keeps instead is
  // `_debugStack`, an Error captured where the element was created; its first
  // frame outside React and the bundler is the user's JSX — as a *served*
  // module position, which the host resolves through the dev server's source
  // map (`main/previewSource.ts`).
  const LIB = /node_modules|\/\.vite\/deps\/|jsx-dev-runtime|jsx-runtime|react-dom|react-refresh|\/@vite\/|next\/dist|\[turbopack\]|turbopack\/|react-server-dom/i
  const frameOf = (el: Element): PickPayload['frame'] => {
    let f = fiberOf(el)
    let guard = 0
    while (f && guard < 200) {
      guard++
      const stack = (f._debugStack as { stack?: string } | undefined)?.stack
      if (stack) {
        for (const line of stack.split('\n').slice(1)) {
          const m = /^\s*at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line)
          if (m && !LIB.test(m[1]) && /^(https?|webpack-internal|webpack|file):/i.test(m[1])) {
            return { url: m[1], line: Number(m[2]), column: Number(m[3]) }
          }
        }
      }
      f = f.return as Record<string, unknown> | null
    }
    return null
  }
  /** The nearest component above the element: what a person would call it. */
  const componentOf = (el: Element): string | null => {
    let f = fiberOf(el)
    let guard = 0
    while (f && guard < 200) {
      guard++
      const t = f.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | string | null
      if (t && typeof t !== 'string') {
        const name = t.displayName || t.name || t.render?.name || t.type?.name
        if (name && /^[A-Z]/.test(name)) return name
      }
      f = f.return as Record<string, unknown> | null
    }
    return null
  }
  const selectorOf = (start: Element): string => {
    const parts: string[] = []
    let node: Element | null = start
    let depth = 0
    while (node && node.nodeType === 1 && depth < 5) {
      let sel = node.nodeName.toLowerCase()
      if (node.id) {
        parts.unshift(sel + '#' + node.id)
        break
      }
      const cn = typeof node.className === 'string' ? node.className.trim() : ''
      if (cn) sel += '.' + cn.split(/\s+/).slice(0, 2).join('.')
      const parent: Element | null = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.nodeName === node!.nodeName
        ) as Element[]
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(sel)
      node = node.parentElement
      depth++
    }
    return parts.join(' > ')
  }
  const setEnabled = (v: boolean): void => {
    enabled = !!v
    if (document.body) document.body.style.cursor = enabled ? 'crosshair' : ''
    if (!enabled) {
      overlay.style.display = 'none'
      current = null
    }
  }
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!enabled) return
      const el = e.target as Element | null
      if (el && el !== overlay) {
        current = el
        place(el)
      }
    },
    true
  )
  document.addEventListener(
    'click',
    (e) => {
      if (!enabled) return
      e.preventDefault()
      e.stopPropagation()
      const el = current || (e.target as Element)
      if (!el) return
      const r = el.getBoundingClientRect()
      const x = Math.max(0, r.left)
      const y = Math.max(0, r.top)
      const rect = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(0, Math.min(r.right, window.innerWidth) - x)),
        height: Math.round(Math.max(0, Math.min(r.bottom, window.innerHeight) - y))
      }
      const label = ((el as HTMLElement).innerText || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)
      const payload: PickPayload = {
        url: location.href,
        tag: el.nodeName.toLowerCase(),
        selector: selectorOf(el),
        label,
        html: (el.outerHTML || '').slice(0, 600),
        source: sourceOf(el),
        frame: null,
        component: componentOf(el),
        rect
      }
      if (!payload.source) payload.frame = frameOf(el)
      setEnabled(false)
      // eslint-disable-next-line no-console
      console.log(PREFIX + JSON.stringify(payload))
    },
    true
  )
  document.addEventListener(
    'keydown',
    (e) => {
      if (enabled && e.key === 'Escape') {
        e.preventDefault()
        setEnabled(false)
        // eslint-disable-next-line no-console
        console.log(PREFIX + 'CANCEL')
      }
    },
    true
  )
  w.__karbunSetInspect = setEnabled
}

const PICKER_JS = '(' + karbunPicker.toString() + ')()'

/**
 * Declared icons tried before the pane gives up and keeps the globe. A page
 * often declares a set — GitHub sends a `.png` and an `.svg` — and the first
 * that is really an image wins.
 */
const MAX_ICON_CANDIDATES = 4

/** The origin a page belongs to, or null for anything main could not fetch. */
function pageOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

function normalizeUrl(input: string): string {
  const v = input.trim()
  if (!v) return v
  if (/^[a-z]+:\/\//i.test(v) || v.startsWith('about:')) return v
  return 'http://' + v
}

function attachmentName(p: PickPayload): string {
  if (p.component && p.source?.file) {
    const base = p.source.file.split('/').pop() ?? p.source.file
    return `<${p.component}> · ${base}${p.source.line != null ? `:${p.source.line}` : ''}`
  }
  if (p.source?.file) {
    const base = p.source.file.split('/').pop() ?? p.source.file
    return `${p.tag} · ${base}${p.source.line != null ? `:${p.source.line}` : ''}`
  }
  if (p.label) return `${p.tag} · ${p.label.slice(0, 24)}`
  return p.tag
}

export function BrowserPane({
  id,
  active,
  cwd
}: {
  id: string
  active: boolean
  cwd: string
}): React.JSX.Element {
  const initialUrl = React.useRef(
    useApp.getState().previews.find((p) => p.id === id)?.url ?? 'http://localhost:3000'
  )
  const setPreviewUrl = useApp((s) => s.setPreviewUrl)
  const devState = useApp((s) => (cwd ? s.previewStates[cwd] : undefined))
  const startPreview = useApp((s) => s.startPreview)
  const stopPreview = useApp((s) => s.stopPreview)
  const viewport = useApp((s) => s.previews.find((p) => p.id === id)?.viewport) ?? FILL_VIEWPORT

  const rootRef = React.useRef<HTMLDivElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const coverRef = React.useRef<HTMLDivElement>(null)
  const hostRef = React.useRef<HTMLDivElement>(null)
  // Mirrors `active` for the imperative handle, and when it last was.
  const activeRef = React.useRef(active)
  const lastActiveRef = React.useRef(active ? Date.now() : 0)
  // Resolves once main holds this pane's guest; replaced when the guest is.
  const attachRef = React.useRef<{ promise: Promise<boolean>; resolve: (v: boolean) => void; wcId: number | null } | null>(
    null
  )
  if (!attachRef.current) {
    let resolve: (v: boolean) => void = () => {}
    const promise = new Promise<boolean>((r) => (resolve = r))
    attachRef.current = { promise, resolve, wcId: null }
  }
  const viewportRef = React.useRef(viewport)
  viewportRef.current = viewport
  const wvRef = React.useRef<WV | null>(null)
  const readyRef = React.useRef(false)
  // Mirrors `loading` for the imperative capture() closure (which can't read
  // React state directly).
  const loadingRef = React.useRef(true)
  const inspectRef = React.useRef(false)
  const manualNavRef = React.useRef(false)
  const autoUrlRef = React.useRef<string | null>(null)
  // Mirrors `editing` for the mount-once nav handlers (they can't read state).
  const editingRef = React.useRef(false)
  // ---- The site's mark on this pane's tab ----
  // `iconSeq` names the resolution a result belongs to. `page-favicon-updated`
  // fires more than once per page — the parsed `<link>`s, then anything the
  // page changes later — and each candidate costs an async IPC, so a slow
  // first answer must never land on top of a newer one.
  const iconSeqRef = React.useRef(0)
  // The origin the current mark belongs to, so a reload keeps it and a new site
  // does not inherit it.
  const iconOriginRef = React.useRef<string | null>(null)
  // Whether this document declared any icon, whether the guess has already run
  // for it, and whether it failed to load — the three `did-stop-loading` reads
  // to decide about the `/favicon.ico` guess.
  const declaredIconRef = React.useRef(false)
  const guessedIconRef = React.useRef(false)
  const loadFailedRef = React.useRef(false)

  const [address, setAddress] = React.useState(initialUrl.current)
  const [editing, setEditingState] = React.useState(false)
  const setEditing = (v: boolean): void => {
    editingRef.current = v
    setEditingState(v)
  }
  const [loading, setLoading] = React.useState(true)
  const [nav, setNav] = React.useState({ back: false, forward: false })
  const [inspect, setInspectState] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [picked, setPicked] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [logs, setLogs] = React.useState('')
  const [stage, setStage] = React.useState({ width: 0, height: 0 })
  const [servers, setServers] = React.useState<LocalServer[] | null>(null)
  const pickedTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setInspect = (v: boolean): void => {
    inspectRef.current = v
    setInspectState(v)
    if (readyRef.current) {
      void wvRef.current
        ?.executeJavaScript(`window.__karbunSetInspect && window.__karbunSetInspect(${v})`)
        .catch(() => {})
    }
  }

  // <webview> methods throw *synchronously* ("must be attached to the DOM…") if
  // called before the guest attaches (dom-ready). Guard every imperative call so
  // an early effect/handler can't crash the pane.
  const callWV = <T,>(fn: (wv: WV) => T): T | undefined => {
    const wv = wvRef.current
    if (!wv || !readyRef.current) return undefined
    try {
      return fn(wv)
    } catch {
      return undefined
    }
  }
  // Navigate when attached; otherwise set the src attribute, which is safe
  // pre-attach and loads once the guest comes up.
  const loadOrSrc = (url: string): void => {
    const wv = wvRef.current
    if (!wv) return
    if (readyRef.current) {
      try {
        void wv.loadURL(url).catch(() => {})
        return
      } catch {
        // fall through to setting src
      }
    }
    try {
      wv.src = url
    } catch {
      // ignore
    }
  }

  /**
   * Tells main what this pane's guest should emulate. The size itself is the
   * `<webview>`'s own (laid out below); what CDP adds is what a sized box
   * cannot give — the pixel ratio, touch, a mobile user agent and
   * `prefers-color-scheme`. Re-sent on every attach, since a new guest starts
   * with none of it.
   */
  const applyEmulation = async (v: PreviewViewport): Promise<void> => {
    const size = viewportSize(v)
    const emulation: PreviewEmulation = size
      ? { width: size.width, height: size.height, dpr: size.dpr, mobile: size.mobile, os: size.os, colorScheme: v.colorScheme }
      : { colorScheme: v.colorScheme }
    await window.api.previewEmulate(id, emulation).catch(() => {})
  }

  const publishIcon = React.useCallback(
    (uri: string | null, ink: boolean): void => {
      useApp.getState().setPreviewFavicon(id, uri, ink)
    },
    [id]
  )

  /**
   * The first candidate that is really an image, measured and published.
   *
   * The bytes are fetched in main rather than pointed at from an `<img>`: a
   * cross-origin image taints the canvas, and the canvas is how a
   * black-on-transparent glyph is recognized as needing inverting on a dark tab
   * strip. Measuring before publishing — rather than at draw time — is what
   * keeps the tab from flashing an invisible mark for a frame.
   */
  const resolveIcon = React.useCallback(
    async (candidates: string[], seq: number): Promise<void> => {
      for (const candidate of candidates.slice(0, MAX_ICON_CANDIDATES)) {
        const uri = await window.api.faviconImage(candidate).catch(() => null)
        // Superseded while the fetch was in flight: the newer resolution owns
        // the tab now, and finishing this one would undo it.
        if (seq !== iconSeqRef.current) return
        if (!uri) continue
        const ink = await classifyInk(candidate, uri)
        if (seq !== iconSeqRef.current) return
        publishIcon(uri, ink)
        return
      }
    },
    [publishIcon]
  )

  const handlePick = React.useCallback(async (p: PickPayload): Promise<void> => {
    const wv = wvRef.current
    let data: string | undefined
    let mediaType: string | undefined
    try {
      const r = p.rect
      if (wv && r && r.width > 1 && r.height > 1) {
        const img = await wv.capturePage({ x: r.x, y: r.y, width: r.width, height: r.height })
        const url = img.toDataURL()
        if (url && url.length > 100) {
          data = url.replace(/^data:[^;]*;base64,/, '')
          mediaType = 'image/png'
        }
      }
    } catch {
      // Screenshot is a bonus; the text description is what matters.
    }
    if (!p.source && p.frame && cwd) {
      const frame = p.frame
      p.source = await Promise.race([
        window.api.previewResolveSource(cwd, frame).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 3000))
      ])
    }
    const element: ElementRef = {
      url: p.url,
      tag: p.tag,
      selector: p.selector,
      label: p.label || undefined,
      html: p.html || undefined,
      source: p.source ?? undefined,
      component: p.component ?? undefined
    }
    const att: Attachment = {
      id: crypto.randomUUID(),
      kind: 'element',
      name: attachmentName(p),
      element,
      ...(data && mediaType ? { data, mediaType } : {})
    }
    useApp.getState().addAttachment(att)
    // The guest picker disarms itself after a pick; sync the host so the toolbar
    // button doesn't stay lit (and unresponsive) until the next toggle.
    setInspect(false)
    setPicked(true)
    clearTimeout(pickedTimer.current)
    pickedTimer.current = setTimeout(() => setPicked(false), 1100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  // Create the <webview> once and wire its events. It outlives tab switches
  // (every preview tab stays mounted, the inactive ones hidden) so page state
  // survives.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview') as unknown as WV
    wv.setAttribute('partition', 'persist:karbun-preview')
    // Popups on, on purpose: `allowpopups` is a boolean attribute, so the old
    // `="false"` turned them on anyway, and the window-open handler in main is
    // what makes them safe — it loads a `target=_blank` link or `window.open`
    // in this pane and refuses the new window. With popups off those links
    // would silently do nothing.
    wv.setAttribute('allowpopups', '')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = '0'
    wv.style.backgroundColor = '#fff'
    wv.src = initialUrl.current
    wvRef.current = wv

    const syncNav = (): void => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        // canGoBack throws before the guest attaches; ignore.
      }
    }
    const onDomReady = (): void => {
      readyRef.current = true
      syncNav()
      // Hand the guest to main so the agent can drive it and its console and
      // network are recorded. Fires on every navigation; main makes repeats a
      // no-op, and a new guest (after a crash) re-attaches here.
      let wcId: number | null = null
      try {
        wcId = wv.getWebContentsId()
      } catch {
        wcId = null
      }
      const attach = attachRef.current!
      if (wcId !== null && wcId !== attach.wcId && cwd) {
        if (attach.wcId !== null) {
          let resolve: (v: boolean) => void = () => {}
          const promise = new Promise<boolean>((r) => (resolve = r))
          attachRef.current = { promise, resolve, wcId }
        } else {
          attach.wcId = wcId
        }
        const current = attachRef.current!
        void window.api
          .previewGuestAttach(id, cwd, wcId)
          .then((ok) => {
            current.resolve(ok)
            if (ok) void applyEmulation(viewportRef.current)
          })
          .catch(() => current.resolve(false))
      }
      void wv
        .executeJavaScript(PICKER_JS)
        .then(() => {
          if (inspectRef.current) {
            return wv.executeJavaScript('window.__karbunSetInspect && window.__karbunSetInspect(true)')
          }
          return undefined
        })
        .catch(() => {})
    }
    const onNavigate = (e: Event): void => {
      const url = (e as unknown as { url?: string }).url
      if (url) {
        // Don't overwrite the address bar (and caret) while the user is typing a
        // URL — a guest-side route/redirect can fire mid-edit. Still record the
        // real navigated URL for tab restore.
        if (!editingRef.current) setAddress(url)
        setPreviewUrl(id, url)
      }
      // A new site is a new mark. A same-origin move — a reload, an in-page
      // route — keeps the one it has until the next lands, the way a browser
      // tab does; clearing on `did-start-loading` instead flashes the globe on
      // every reload.
      const origin = url ? pageOrigin(url) : iconOriginRef.current
      if (origin !== iconOriginRef.current) {
        iconOriginRef.current = origin
        iconSeqRef.current++
        publishIcon(null, false)
      }
      setError(null)
      syncNav()
    }
    // **The spinner events are every frame's; only a commit is a new document.**
    // `did-start-loading` fires for an iframe too — an embed, an analytics
    // frame, an ad — so resetting "this page declared nothing" there meant a
    // subframe landing seconds after the page did re-armed the guess and put
    // `/favicon.ico` over the icon the page had actually declared. Measured:
    // one iframe swapped a declared green SVG for the server's magenta `.ico`.
    // A main-frame commit is the one event that really is a new document, and
    // `did-navigate-in-page` is deliberately not one — an SPA route change
    // keeps the mark its document declared.
    const onCommit = (e: Event): void => {
      declaredIconRef.current = false
      guessedIconRef.current = false
      onNavigate(e)
    }
    const onFavicon = (e: Event): void => {
      const declared = (e as unknown as { favicons?: string[] }).favicons ?? []
      if (!declared.length) return
      declaredIconRef.current = true
      void resolveIcon(declared, ++iconSeqRef.current)
    }
    const onStart = (): void => {
      loadingRef.current = true
      loadFailedRef.current = false
      setLoading(true)
    }
    const onStop = (): void => {
      loadingRef.current = false
      setLoading(false)
      syncNav()
      // **A page that declares nothing usually still serves `/favicon.ico`.**
      // Chromium reports only what the document declares — example.com, which
      // declares none, fires no `page-favicon-updated` at all — so the
      // conventional path is a guess this side has to make. Only after a load
      // that actually succeeded: a refused connection would otherwise be
      // remembered as "this site has no icon" for as long as the dev server
      // takes to come up, which is the one site this pane always points at.
      if (declaredIconRef.current || guessedIconRef.current || loadFailedRef.current) return
      let here = ''
      try {
        here = wv.getURL()
      } catch {
        // Not attached yet; there is no page to guess for.
      }
      const origin = pageOrigin(here)
      if (!origin) return
      // Once per document, whatever the guess turns up: a page with no icon at
      // all still finishes a subframe now and then, and each one would be
      // another round trip for the same answer.
      guessedIconRef.current = true
      void resolveIcon([`${origin}/favicon.ico`], ++iconSeqRef.current)
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      // -3 is a user-initiated abort (e.g. navigating away); not an error.
      if (ev.isMainFrame && ev.errorCode !== -3) {
        loadFailedRef.current = true
        // The page this mark belonged to is gone — a dead dev server is the
        // usual way here — and `did-navigate` never fires for a load that
        // failed, so nothing else would take it off the tab.
        iconOriginRef.current = null
        iconSeqRef.current++
        publishIcon(null, false)
        setError(ev.errorDescription || 'Failed to load')
        setLoading(false)
        // A failed load may not be followed by did-stop-loading; clear the ref
        // too or an agent screenshot stalls the full 8s waiting on it.
        loadingRef.current = false
      }
    }
    const onConsole = (e: Event): void => {
      const ev = e as unknown as { message?: string; level?: number }
      const msg = ev.message ?? ''
      if (msg.startsWith(PICK_PREFIX)) {
        const rest = msg.slice(PICK_PREFIX.length)
        if (rest === 'CANCEL') {
          setInspect(false)
          return
        }
        try {
          void handlePick(JSON.parse(rest) as PickPayload)
        } catch {
          // Malformed payload — drop it.
        }
        return
      }
      // Everything else reaches the agent through CDP in main.
    }

    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onCommit)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('console-message', onConsole)
    wv.addEventListener('page-favicon-updated', onFavicon)
    host.appendChild(wv)

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    // Two frames for a layout to land — with a timer beside it, because a
    // window in the background gets no animation frames at all, and the agent
    // works while the user is in another app.
    const frames = (): Promise<void> =>
      new Promise((r) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          r()
        }
        requestAnimationFrame(() => requestAnimationFrame(finish))
        setTimeout(finish, 120)
      })
    const visibleNow = (): boolean => activeRef.current && useApp.getState().panelOpen
    // What had keyboard focus before an agent `focus`, to hand it back after.
    let priorFocus: HTMLElement | null = null
    const root = (): HTMLDivElement | null => rootRef.current

    // Expose an imperative handle so agent commands can reach this pane by
    // project folder. Page work happens in main over CDP; this answers only for
    // what the renderer owns.
    const handle: PreviewHandle = {
      cwd,
      isVisible: visibleNow,
      lastActive: () => lastActiveRef.current,
      attached: () => attachRef.current!.promise,
      getURL: () => {
        try {
          return wv.getURL()
        } catch {
          return initialUrl.current
        }
      },
      loadURL: (url) => {
        manualNavRef.current = true
        setAddress(url)
        setError(null)
        loadOrSrc(url)
      },
      capture: async () => {
        // Wait for the guest to attach (dom-ready) and for the page to stop
        // loading before shooting — capturing mid-navigation is what makes the
        // guest-view compositor throw UnknownVizError.
        const deadline = Date.now() + 8000
        while ((!readyRef.current || loadingRef.current) && Date.now() < deadline) {
          await sleep(120)
        }
        if (!readyRef.current) return null

        // **A hidden pane is shot where it is, under a cover.** A guest whose
        // pane is `visibility: hidden` produces no frames, so its capture
        // never resolves; the old answer was to switch the user's panel to the
        // preview tab and leave it there. Measured instead: the guest's own
        // `capturePage()` succeeds while an opaque cover sits *over* it, so
        // the pane is made visible beneath its cover (and beneath the tab the
        // user is looking at) for the length of the shot, then hidden again.
        const hidden = !visibleNow()
        const el = root()
        if (hidden && el) {
          if (coverRef.current) coverRef.current.style.display = 'block'
          el.style.visibility = 'visible'
          el.style.zIndex = '-1'
          await frames()
        }
        try {
          // capturePage() can *hang* (the main-process guest-view handler
          // throws and never replies) or return an empty frame, so bound each
          // attempt and retry a few times.
          for (let i = 0; i < 3 && Date.now() < deadline + 3000; i++) {
            const img = await Promise.race([wv.capturePage().catch(() => null), sleep(1500).then(() => null)])
            if (img && !img.isEmpty()) {
              const url = img.toDataURL()
              // A real screenshot is a sizeable data URI; a blank frame is tiny.
              if (url && url.length > 1024) return url.replace(/^data:[^;]*;base64,/, '')
            }
            await sleep(200)
          }
        } finally {
          if (hidden && el) {
            el.style.visibility = ''
            el.style.zIndex = ''
            if (coverRef.current) coverRef.current.style.display = 'none'
          }
        }
        if (hidden) return null

        // Fallback: the guest is composited into the app window, so crop the
        // window's capture to this pane's on-screen rect. Reliable even when the
        // webview's own capturePage is wedged — but only for a pane on screen.
        const guestBox = hostRef.current
        if (guestBox) {
          const r = guestBox.getBoundingClientRect()
          if (r.width > 2 && r.height > 2) {
            return window.api.previewCaptureWindow({
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height
            })
          }
        }
        return null
      },
      focus: () => {
        const before = document.activeElement
        if (before && before !== wv) priorFocus = before as HTMLElement
        try {
          wv.focus()
        } catch {
          // not attached yet
        }
      },
      unfocus: () => {
        const back = priorFocus
        priorFocus = null
        if (document.activeElement !== wv) return
        if (back && back !== document.body && back.isConnected) back.focus({ preventScroll: true })
        // Nothing focusable had it (or it would not take it back): just let go.
        if (document.activeElement === wv) wv.blur()
      },
      reveal: async () => {
        const el = root()
        if (!el || visibleNow()) return
        el.style.visibility = 'visible'
        el.style.zIndex = '30'
        await frames()
        await sleep(80)
      },
      conceal: () => {
        const el = root()
        if (!el) return
        el.style.visibility = ''
        el.style.zIndex = ''
      },
      setViewport: async (patch) => {
        const next = applyViewportPatch(viewportRef.current, patch)
        useApp.getState().setPreviewViewport(id, next)
        viewportRef.current = next
        await frames()
        await applyEmulation(next)
        return next
      }
    }
    registerPreview(id, handle)

    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onCommit)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('console-message', onConsole)
      wv.removeEventListener('page-favicon-updated', onFavicon)
      // **The guest is ours to remove.** React unmounts the host div, but a
      // cleanup that runs *without* one — StrictMode's mount → cleanup → mount
      // in dev, or a Fast Refresh — leaves this webview in the host and the
      // next run appends a second beside it. Both fill the pane, so the dead
      // one sits on top: every click, and the address bar's own navigation,
      // goes to a guest with no listeners and no picker injected, while the
      // live one is pushed a pane's height below the fold. That is the element
      // picker "doing nothing" — the crosshair and the highlight are in the
      // copy nobody can see.
      wv.remove()
      unregisterPreview(id, handle)
      window.api.previewGuestDetach(id)
      clearTimeout(pickedTimer.current)
      wvRef.current = null
      readyRef.current = false
    }
    // Mount-once: id/cwd/handlers are stable for this pane's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the dev server comes up, auto-load its URL — unless the user has taken
  // manual control of the address bar.
  const devUrl = devState?.status === 'running' ? devState.url : undefined
  React.useEffect(() => {
    if (!devUrl || manualNavRef.current || autoUrlRef.current === devUrl) return
    autoUrlRef.current = devUrl
    setAddress(devUrl)
    setError(null)
    loadOrSrc(devUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devUrl])

  // Leaving the tab cancels an in-progress pick so it doesn't linger armed.
  React.useEffect(() => {
    activeRef.current = active
    if (active) lastActiveRef.current = Date.now()
    if (!active && inspectRef.current) setInspect(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // A viewport change from the device menu (the agent's goes through the
  // handle, which applies it itself).
  const viewportKey = JSON.stringify(viewport)
  const firstViewport = React.useRef(true)
  React.useEffect(() => {
    if (firstViewport.current) {
      firstViewport.current = false
      return
    }
    void applyEmulation(viewport)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportKey])

  // The stage's size, for fitting a device viewport larger than the pane.
  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setStage((prev) =>
        Math.round(prev.width) === Math.round(r.width) && Math.round(prev.height) === Math.round(r.height)
          ? prev
          : { width: r.width, height: r.height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const refreshServers = React.useCallback((): void => {
    void window.api
      .previewLocalServers()
      .then(setServers)
      .catch(() => setServers([]))
  }, [])
  // A failed load is usually "nothing on that port" — offer what *is* running.
  React.useEffect(() => {
    if (error) refreshServers()
  }, [error, refreshServers])

  // Poll dev-server logs while the drawer is open.
  React.useEffect(() => {
    if (!logsOpen || !cwd) return
    let alive = true
    const pull = (): void => {
      void window.api.previewLogs(cwd).then((t) => {
        if (alive) setLogs(t)
      })
    }
    pull()
    const timer = setInterval(pull, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [logsOpen, cwd, devState?.status])

  const go = (raw: string): void => {
    const url = normalizeUrl(raw)
    if (!url) return
    manualNavRef.current = true
    setAddress(url)
    setEditing(false)
    setPreviewUrl(id, url)
    setError(null)
    loadOrSrc(url)
  }

  const status = devState?.status ?? 'stopped'
  const serverRunning = status === 'running' || status === 'starting'
  const external = serverRunning && devState?.external === true
  const dotClass =
    status === 'running'
      ? 'bg-emerald-500'
      : status === 'starting'
        ? 'bg-amber-500 animate-pulse'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40'

  const size = viewportSize(viewport)
  // Leave a margin round a device so its edge reads as an edge; never enlarge.
  const fit =
    size && stage.width > 0 && stage.height > 0
      ? Math.min(1, (stage.width - 24) / size.width, (stage.height - 44) / size.height)
      : 1
  const scale = Math.max(0.1, fit)
  const setViewport = (v: PreviewViewport): void => useApp.getState().setPreviewViewport(id, v)
  const pickDevice = (device: string): void =>
    setViewport({ ...(device === 'fill' ? { device } : { device, rotated: viewport.device === device ? viewport.rotated : undefined }), colorScheme: viewport.colorScheme })
  const pickScheme = (colorScheme: PreviewColorScheme | undefined): void =>
    setViewport(colorScheme ? { ...viewport, colorScheme } : { ...viewport, colorScheme: undefined })
  const groups = [
    { label: 'Phones', devices: PREVIEW_DEVICES.filter((d) => d.group === 'phone') },
    { label: 'Tablets', devices: PREVIEW_DEVICES.filter((d) => d.group === 'tablet') },
    { label: 'Desktop', devices: PREVIEW_DEVICES.filter((d) => d.group === 'desktop') }
  ]
  const tick = (on: boolean): React.JSX.Element => <Check className={cn(!on && 'invisible')} />

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-card/20">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <WithTooltip
          label={
            external
              ? `Using ${devState?.command ?? 'a server started outside Carbon'} — stop it where it runs. Click to check it is still up.`
              : serverRunning
                ? status === 'starting'
                  ? 'Starting dev server…'
                  : 'Stop dev server'
                : 'Run dev server'
          }
        >
          <Button
            size="icon-sm"
            variant="ghost"
            className="relative shrink-0"
            aria-label={external ? 'Dev server started outside Carbon' : serverRunning ? 'Stop dev server' : 'Run dev server'}
            onClick={() => {
              // Not Carbon's to stop; asking to start re-checks it is still up.
              if (external) void startPreview(cwd)
              else void (serverRunning ? stopPreview(cwd) : startPreview(cwd))
            }}
          >
            {external ? <Server /> : serverRunning ? <Square className="fill-current" /> : <Play />}
            <span
              className={cn(
                'absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-1 ring-background',
                dotClass
              )}
            />
          </Button>
        </WithTooltip>
        <WithTooltip label="Back">
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            disabled={!nav.back}
            aria-label="Back"
            onClick={() => callWV((wv) => wv.goBack())}
          >
            <ArrowLeft />
          </Button>
        </WithTooltip>
        <WithTooltip label="Forward">
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            disabled={!nav.forward}
            aria-label="Forward"
            onClick={() => callWV((wv) => wv.goForward())}
          >
            <ArrowRight />
          </Button>
        </WithTooltip>
        <WithTooltip label={loading ? 'Stop' : 'Reload'}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label={loading ? 'Stop' : 'Reload'}
            onClick={() => callWV((wv) => (loading ? wv.stop() : wv.reload()))}
          >
            {loading ? <X /> : <RotateCw />}
          </Button>
        </WithTooltip>
        <input
          value={address}
          onChange={(e) => {
            setAddress(e.target.value)
            setEditing(true)
          }}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go(e.currentTarget.value)
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              setAddress(callWV((wv) => wv.getURL()) || address)
              setEditing(false)
              e.currentTarget.blur()
            }
          }}
          spellCheck={false}
          placeholder="http://localhost:3000"
          aria-label="Address"
          className={cn(
            'no-drag h-6 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[11px] outline-none transition-colors',
            editing ? 'border-ring/60' : 'border-transparent hover:border-border'
          )}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className={cn('shrink-0', (size || viewport.colorScheme) && 'bg-primary/15 text-primary')}
                aria-label={`Viewport: ${describeViewport(viewport)}`}
                title={`Viewport: ${describeViewport(viewport)}`}
              >
                <MonitorSmartphone />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onClick={() => pickDevice('fill')}>
              {tick(viewport.device === 'fill')}
              Fill the pane
            </DropdownMenuItem>
            {groups.map((g) => (
              <DropdownMenuSub key={g.label}>
                <DropdownMenuSubTrigger>
                  {tick(g.devices.some((d) => d.id === viewport.device))}
                  {g.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuContent side="right" className="min-w-52">
                  {g.devices.map((d) => (
                    <DropdownMenuItem key={d.id} onClick={() => pickDevice(d.id)}>
                      {tick(viewport.device === d.id)}
                      <span className="flex-1">{d.label}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {d.width}×{d.height}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenuSub>
            ))}
            <DropdownMenuItem
              disabled={!size}
              onClick={() => setViewport({ ...viewport, rotated: viewport.rotated ? undefined : true })}
            >
              <RotateCwSquare />
              {viewport.rotated ? 'Portrait' : 'Landscape'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => pickScheme(undefined)}>
              {tick(!viewport.colorScheme)}
              System color scheme
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => pickScheme('light')}>
              {tick(viewport.colorScheme === 'light')}
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => pickScheme('dark')}>
              {tick(viewport.colorScheme === 'dark')}
              Dark
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <WithTooltip label={inspect ? 'Cancel select (Esc)' : 'Select an element to attach'}>
          <Button
            size="icon-sm"
            variant="ghost"
            className={cn(
              'shrink-0',
              picked && 'text-emerald-500',
              inspect && !picked && 'bg-primary/15 text-primary'
            )}
            aria-label="Select element"
            aria-pressed={inspect}
            onClick={() => setInspect(!inspect)}
          >
            {picked ? <Check /> : <MousePointerClick />}
          </Button>
        </WithTooltip>
        <WithTooltip label="Dev server logs">
          <Button
            size="icon-sm"
            variant="ghost"
            className={cn('shrink-0', logsOpen && 'bg-accent text-foreground')}
            aria-label="Dev server logs"
            aria-pressed={logsOpen}
            onClick={() => setLogsOpen((v) => !v)}
          >
            <ScrollText />
          </Button>
        </WithTooltip>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) refreshServers()
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" className="shrink-0" aria-label="More" title="More">
                <Ellipsis />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onClick={() => callWV((wv) => wv.openDevTools())}>
              <Bug />
              Open DevTools
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open(callWV((wv) => wv.getURL()) || address, '_blank')}>
              <ExternalLink />
              Open in browser
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Local servers
            </div>
            {servers === null ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Looking…</div>
            ) : servers.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">None found</div>
            ) : (
              servers.map((srv) => (
                <DropdownMenuItem key={`${srv.pid}:${srv.port}`} onClick={() => go(srv.url)}>
                  <Server />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">
                      localhost:{srv.port}
                      {srv.title ? <span className="text-muted-foreground"> · {srv.title}</span> : null}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {srv.command}
                      {srv.cwd ? ` · ${srv.cwd.split('/').slice(-2).join('/')}` : ''}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Guest surface */}
      <div
        ref={stageRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          size && 'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:14px_14px]'
        )}
      >
        <div
          className={cn(!size && 'absolute inset-0')}
          style={
            size
              ? {
                  position: 'absolute',
                  left: Math.max(0, (stage.width - size.width * scale) / 2),
                  top: 12,
                  width: size.width * scale,
                  height: size.height * scale
                }
              : undefined
          }
        >
          <div
            ref={hostRef}
            className={cn(
              '[&>webview]:h-full [&>webview]:w-full',
              size ? 'overflow-hidden rounded-md shadow-lg ring-1 ring-border' : 'absolute inset-0'
            )}
            style={
              size
                ? { width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: '0 0' }
                : undefined
            }
          />
        </div>
        {size && (
          <div className="pointer-events-none absolute inset-x-0 bottom-1.5 flex justify-center">
            <div className="rounded-full bg-popover/90 px-2 py-0.5 font-mono text-[10px] text-muted-foreground shadow ring-1 ring-border">
              {describeViewport(viewport)}
              {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
            </div>
          </div>
        )}
        {/* Covers the guest while a hidden pane is captured (see `capture`). */}
        <div ref={coverRef} className="absolute inset-0 z-40 hidden bg-background" />
        {inspect && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
            <div className="rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-lg">
              Click an element to attach it · Esc to cancel
            </div>
          </div>
        )}
        {picked && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white shadow-lg">
              <Check className="size-3" /> Added to your message
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/95 p-6 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground/70">{address}</p>
            <div className="mt-1 flex gap-2">
              {!serverRunning && (
                <Button size="sm" onClick={() => void startPreview(cwd)}>
                  <Play className="size-3.5" /> Run dev server
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => go(address)}>
                <RotateCw className="size-3.5" /> Retry
              </Button>
            </div>
            {servers && servers.length > 0 && (
              <div className="mt-3 flex max-w-sm flex-col items-center gap-1.5">
                <p className="text-[11px] text-muted-foreground/80">Running on this machine</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {servers.slice(0, 6).map((srv) => (
                    <Button key={`${srv.pid}:${srv.port}`} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => go(srv.url)}>
                      <Server className="size-3" /> localhost:{srv.port}
                      {srv.title ? <span className="max-w-28 truncate text-muted-foreground">{srv.title}</span> : null}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {/* Dev-server log drawer */}
        {logsOpen && (
          <div className="absolute inset-x-0 bottom-0 z-20 flex h-1/2 flex-col border-t border-border bg-popover/98 shadow-2xl backdrop-blur">
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2.5">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', dotClass)} />
                {devState?.command ?? 'Dev server'}
                {devState?.error && <span className="text-destructive">· {devState.error}</span>}
              </span>
              <button
                type="button"
                onClick={() => setLogsOpen(false)}
                aria-label="Close logs"
                className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-2.5 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
              {logs ||
                (external
                  ? 'This server was started outside Carbon, so its output is in the terminal that runs it.'
                  : 'No output yet. Press ▶ to run the dev server.')}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

import * as React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  MousePointerClick,
  Play,
  RotateCw,
  ScrollText,
  Square,
  X
} from 'lucide-react'
import type { Attachment, ElementRef } from '@shared/types'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { registerPreview, unregisterPreview } from '@/lib/previewRegistry'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

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
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Runs inside the guest page (main world, so it can read React fibers). Draws a
 * hover highlight, and on click posts the element's location + source via
 * console.log with a magic prefix the host listens for. Also forwards uncaught
 * errors to the console so the host can surface them to the agent. Stringified
 * and injected on every dom-ready, so it survives navigations.
 */
function karbunPicker(): void {
  const w = window as unknown as Record<string, unknown>
  if (w.__karbunPickInstalled) return
  w.__karbunPickInstalled = true
  const PREFIX = '__KARBUN_PICK__'
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[uncaught] ' + (e.message || e.error))
  })
  window.addEventListener('unhandledrejection', (e) => {
    // eslint-disable-next-line no-console
    console.error('[unhandledrejection] ' + ((e as PromiseRejectionEvent).reason ?? ''))
  })
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
        rect
      }
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

function normalizeUrl(input: string): string {
  const v = input.trim()
  if (!v) return v
  if (/^[a-z]+:\/\//i.test(v) || v.startsWith('about:')) return v
  return 'http://' + v
}

function attachmentName(p: PickPayload): string {
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

  const hostRef = React.useRef<HTMLDivElement>(null)
  const wvRef = React.useRef<WV | null>(null)
  const readyRef = React.useRef(false)
  // Mirrors `loading` for the imperative capture() closure (which can't read
  // React state directly).
  const loadingRef = React.useRef(true)
  const inspectRef = React.useRef(false)
  const manualNavRef = React.useRef(false)
  const autoUrlRef = React.useRef<string | null>(null)

  const [address, setAddress] = React.useState(initialUrl.current)
  const [editing, setEditing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [nav, setNav] = React.useState({ back: false, forward: false })
  const [inspect, setInspectState] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [picked, setPicked] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [logs, setLogs] = React.useState('')
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
    const element: ElementRef = {
      url: p.url,
      tag: p.tag,
      selector: p.selector,
      label: p.label || undefined,
      html: p.html || undefined,
      source: p.source ?? undefined
    }
    const att: Attachment = {
      id: crypto.randomUUID(),
      kind: 'element',
      name: attachmentName(p),
      element,
      ...(data && mediaType ? { data, mediaType } : {})
    }
    useApp.getState().addAttachment(att)
    setPicked(true)
    clearTimeout(pickedTimer.current)
    pickedTimer.current = setTimeout(() => setPicked(false), 1100)
  }, [])

  // Create the <webview> once and wire its events. It outlives tab switches
  // (the pane is hidden, not unmounted) so page state survives.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview') as unknown as WV
    wv.setAttribute('partition', 'persist:karbun-preview')
    wv.setAttribute('allowpopups', 'false')
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
        setAddress(url)
        setPreviewUrl(id, url)
      }
      setError(null)
      syncNav()
    }
    const onStart = (): void => {
      loadingRef.current = true
      setLoading(true)
    }
    const onStop = (): void => {
      loadingRef.current = false
      setLoading(false)
      syncNav()
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      // -3 is a user-initiated abort (e.g. navigating away); not an error.
      if (ev.isMainFrame && ev.errorCode !== -3) {
        setError(ev.errorDescription || 'Failed to load')
        setLoading(false)
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
      // Forward warnings/errors so the agent's preview.console tool can see them.
      if (cwd && ((ev.level ?? 0) >= 2 || /error|warn|fail|uncaught|exception/i.test(msg))) {
        window.api.previewReportConsole(cwd, msg)
      }
    }

    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('console-message', onConsole)
    host.appendChild(wv)

    // Expose an imperative handle so agent-driven commands (navigate/screenshot)
    // can reach this pane by project folder.
    registerPreview(id, {
      cwd,
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
        loadOrSrc(url)
      },
      capture: async () => {
        // The pane may have just been mounted/activated for this very capture,
        // so wait for the guest to attach (dom-ready) and for the page to stop
        // loading before shooting — capturing mid-navigation is what makes the
        // guest-view compositor throw UnknownVizError.
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        const deadline = Date.now() + 8000
        while ((!readyRef.current || loadingRef.current) && Date.now() < deadline) {
          await sleep(120)
        }
        if (!readyRef.current) return null

        // Preferred path: the webview's own capture. capturePage() can *hang*
        // (the main-process guest-view handler throws and never replies) or
        // return an empty frame, so bound each attempt and retry a few times.
        for (let i = 0; i < 3 && Date.now() < deadline; i++) {
          const img = await Promise.race([
            wv.capturePage().catch(() => null),
            sleep(1500).then(() => null)
          ])
          if (img && !img.isEmpty()) {
            const url = img.toDataURL()
            // A real screenshot is a sizeable data URI; a blank frame is tiny.
            if (url && url.length > 1024) return url.replace(/^data:[^;]*;base64,/, '')
          }
          await sleep(200)
        }

        // Fallback: the guest is composited into the app window, so crop the
        // window's capture to this pane's on-screen rect. Reliable even when the
        // webview's own capturePage is wedged.
        const host = hostRef.current
        if (host) {
          const r = host.getBoundingClientRect()
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
      activate: () => {
        const s = useApp.getState()
        s.setActiveTab(id)
        if (!s.panelOpen) s.togglePanel()
      }
    })

    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('console-message', onConsole)
      unregisterPreview(id)
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
    if (!active && inspectRef.current) setInspect(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

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
  const dotClass =
    status === 'running'
      ? 'bg-emerald-500'
      : status === 'starting'
        ? 'bg-amber-500 animate-pulse'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40'

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/20">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <WithTooltip
          label={
            serverRunning
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
            aria-label={serverRunning ? 'Stop dev server' : 'Run dev server'}
            onClick={() => (serverRunning ? void stopPreview(cwd) : void startPreview(cwd))}
          >
            {serverRunning ? <Square className="fill-current" /> : <Play />}
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
        <WithTooltip label="Open in browser">
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label="Open in external browser"
            onClick={() => window.open(callWV((wv) => wv.getURL()) || address, '_blank')}
          >
            <ExternalLink />
          </Button>
        </WithTooltip>
      </div>

      {/* Guest surface */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0 [&>webview]:h-full [&>webview]:w-full" />
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
              {logs || 'No output yet. Press ▶ to run the dev server.'}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

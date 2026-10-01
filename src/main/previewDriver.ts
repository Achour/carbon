import { nativeImage, webContents, type WebContents } from 'electron'
import type { PreviewEmulation } from '@shared/types'
import { formatConsole, formatConsoleArgs, formatNetwork, isProblem, PreviewLog, type ConsoleLevel, type RemoteObjectLike } from './previewLog.ts'
import { agentCall, isFunctionSource, SERIALIZE_FN } from './previewPage.ts'
import { parseKeyCombo } from './previewInput.ts'
import { isLoopbackUrl } from './previewSource.ts'
import type { PreviewToolInput } from './previewTools.ts'

/**
 * The preview's agent automation, done in main over the Chrome DevTools
 * Protocol on each pane's guest.
 *
 * **Why main and not the renderer.** The `<webview>`'s own methods are what
 * the toolbar uses, but they cannot synthesize a *trusted* input event, read
 * the network, or emulate a device; `webContents.debugger` can do all three,
 * and it lives in main. The renderer still owns what it owns — which pane is a
 * project's, its tab, its pixels — and answers `PreviewCommand`s for those;
 * everything that happens *inside* the page happens here.
 *
 * **Clicks are real input, not `el.click()`.** `Input.dispatchMouseEvent` goes
 * through hit-testing, focus, `pointerdown`/`mousedown`/`mouseup`/`click` in
 * order and with `isTrusted` set, which is what a framework's handlers, a
 * focus trap or a drag library expect. The cost is that a click lands on
 * whatever is *at* the point, so the target is scrolled into view first and a
 * click on an element something else covers is refused rather than sent to the
 * cover. Measured in the probe that settled this design: a CDP click lands
 * where the guest's own `getBoundingClientRect()` says even while the
 * `<webview>` is CSS-scaled for an oversized device preset, because the input
 * is injected into the guest's widget, below the embedder's transform.
 *
 * The guest's console and network are recorded from the moment it attaches,
 * whoever started the dev server — the old path forwarded lines from the
 * renderer only when *Carbon* had started it.
 */

interface Guest {
  paneId: string
  cwd: string
  wc: WebContents
  log: PreviewLog
  /** The guest's own user agent, restored when a mobile preset is cleared. */
  userAgent: string
  /** Per caller: the log position its last snapshot reported up to. */
  snapshotMarks: Map<string, number>
  /** Agent actions in flight — a JS dialog that opens during one is answered. */
  acting: number
  /** The main frame's id and its default execution context, as CDP reported them. */
  mainFrameId?: string
  mainContext?: { uniqueId: string; origin: string }
  dispose: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const LEVELS: Record<string, ConsoleLevel> = {
  log: 'log',
  info: 'info',
  warning: 'warn',
  error: 'error',
  assert: 'error',
  debug: 'debug',
  trace: 'debug',
  dir: 'log',
  dirxml: 'log',
  table: 'log',
  count: 'log',
  timeEnd: 'log'
}

const MOBILE_UA: Record<'ios' | 'android', string> = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
}

/** Hides fixed and sticky elements (once per capture), remembering how they were. */
const HIDE_FIXED = `(() => {
  if (window.__carbonFixed) return
  const hidden = []
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position
    if (p === 'fixed' || p === 'sticky') {
      hidden.push([el, el.style.visibility])
      el.style.visibility = 'hidden'
    }
  }
  window.__carbonFixed = hidden
})()`
const SHOW_FIXED = `(() => {
  for (const [el, v] of window.__carbonFixed || []) el.style.visibility = v
  delete window.__carbonFixed
})()`

/** The tallest page a full-page capture takes, in CSS pixels. */
const FULL_PAGE_MAX = 12_000

function shortSource(url: string | undefined, line: number | undefined): string | undefined {
  if (!url) return undefined
  let path = url
  try {
    const u = new URL(url)
    path = u.pathname
  } catch {
    // not a URL; keep it
  }
  if (path.includes('/node_modules/')) return undefined
  return `${path}${line !== undefined ? `:${line + 1}` : ''}`
}

export class PreviewDriver {
  private guests = new Map<string, Guest>()

  /** Takes over a pane's guest. Idempotent per guest; a new guest replaces the old. */
  attach(paneId: string, cwd: string, webContentsId: number): boolean {
    const existing = this.guests.get(paneId)
    if (existing && existing.wc.id === webContentsId && !existing.wc.isDestroyed()) {
      existing.cwd = cwd
      if (!existing.wc.debugger.isAttached()) this.connect(existing)
      return true
    }
    if (existing) this.detach(paneId)
    const wc = webContents.fromId(webContentsId)
    // Only a `<webview>` guest: the id comes from the renderer, and the app's
    // own window (or a canvas) is not something an agent tool may drive.
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return false
    const guest: Guest = {
      paneId,
      cwd,
      wc,
      log: new PreviewLog(),
      userAgent: wc.getUserAgent(),
      snapshotMarks: new Map(),
      acting: 0,
      dispose: () => {}
    }
    const onMessage = (_e: unknown, method: string, params: Record<string, unknown>): void =>
      this.onEvent(guest, method, params)
    const onDetach = (): void => {
      // DevTools opening does not detach us (CDP takes several clients);
      // a crashed or replaced guest does. The next command reattaches.
    }
    const onDestroyed = (): void => {
      if (this.guests.get(paneId) === guest) this.guests.delete(paneId)
    }
    wc.debugger.on('message', onMessage)
    wc.debugger.on('detach', onDetach)
    wc.once('destroyed', onDestroyed)
    guest.dispose = () => {
      wc.debugger.removeListener('message', onMessage)
      wc.debugger.removeListener('detach', onDetach)
      wc.removeListener('destroyed', onDestroyed)
    }
    this.guests.set(paneId, guest)
    return this.connect(guest)
  }

  private connect(g: Guest): boolean {
    try {
      if (!g.wc.debugger.isAttached()) g.wc.debugger.attach('1.3')
    } catch (err) {
      console.warn('[preview] debugger attach failed:', err)
      return false
    }
    for (const domain of ['Runtime.enable', 'Page.enable', 'Log.enable']) {
      void g.wc.debugger.sendCommand(domain).catch(() => {})
    }
    // The page behaves as focused whether or not the user's keyboard is in it:
    // typed text lands in a field the agent focused, without the preview
    // taking focus away from the composer the user is typing in.
    void g.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    // Bodies are only read for failed API calls, so the buffer stays small.
    void g.wc.debugger
      .sendCommand('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 })
      .catch(() => {})
    return true
  }

  detach(paneId: string): void {
    const g = this.guests.get(paneId)
    if (!g) return
    this.guests.delete(paneId)
    g.dispose()
    try {
      if (!g.wc.isDestroyed() && g.wc.debugger.isAttached()) g.wc.debugger.detach()
    } catch {
      // already gone
    }
  }

  guest(paneId: string): Guest | undefined {
    const g = this.guests.get(paneId)
    if (g && g.wc.isDestroyed()) {
      this.detach(paneId)
      return undefined
    }
    return g
  }

  /** The guests showing a project, for reads that need no pane in particular. */
  guestsFor(cwd: string): Guest[] {
    return [...this.guests.values()].filter((g) => g.cwd === cwd && !g.wc.isDestroyed())
  }

  private onEvent(g: Guest, method: string, p: Record<string, any>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const frame = p.stackTrace?.callFrames?.[0]
        g.log.addConsole(
          LEVELS[p.type as string] ?? 'log',
          formatConsoleArgs((p.args ?? []) as RemoteObjectLike[]),
          shortSource(frame?.url, frame?.lineNumber)
        )
        return
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {}
        const text = d.exception?.description ?? d.text ?? 'Uncaught exception'
        g.log.addConsole('error', /^Uncaught/.test(text) ? text : `Uncaught ${text}`, shortSource(d.url, d.lineNumber))
        return
      }
      case 'Log.entryAdded': {
        const e = p.entry ?? {}
        if (e.level === 'verbose') return
        const level: ConsoleLevel = e.level === 'warning' ? 'warn' : e.level === 'error' ? 'error' : 'info'
        g.log.addConsole(level, e.url && e.source === 'network' ? `${e.text} (${e.url})` : String(e.text ?? ''))
        return
      }
      case 'Network.requestWillBeSent':
        g.log.requestStarted(p.requestId, p.request?.method ?? 'GET', p.request?.url ?? '', p.type ?? 'Other')
        return
      case 'Network.responseReceived':
        g.log.responseReceived(p.requestId, p.response?.status ?? 0, p.response?.statusText ?? '', p.response?.mimeType ?? '')
        return
      case 'Network.loadingFinished':
        g.log.requestFinished(p.requestId)
        return
      case 'Network.loadingFailed':
        g.log.requestFailed(p.requestId, p.errorText ?? 'failed', p.canceled === true)
        return
      case 'Page.frameNavigated':
        if (!p.frame?.parentId && p.frame?.url) {
          g.mainFrameId = p.frame.id
          g.log.navigated(p.frame.url)
        }
        return
      case 'Runtime.executionContextCreated': {
        const c = p.context ?? {}
        if (c.auxData?.isDefault && (!g.mainFrameId || c.auxData.frameId === g.mainFrameId) && c.uniqueId) {
          g.mainFrameId = c.auxData.frameId
          g.mainContext = { uniqueId: c.uniqueId, origin: String(c.origin ?? '') }
        }
        return
      }
      case 'Runtime.executionContextsCleared':
        g.mainContext = undefined
        return
      case 'Page.javascriptDialogOpening':
        // A dialog blocks the page — every later command would hang behind it.
        // While the agent is acting it is answered (accepting, which is what
        // the agent's click was trying to do) and logged so the agent knows;
        // otherwise it is the user's, and Electron shows it to them.
        if (g.acting > 0) {
          g.log.addConsole('info', `[${p.type} dialog] ${p.message ?? ''} — accepted`)
          void this.send(g, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
        }
        return
    }
  }

  private async send<T = any>(g: Guest, method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (g.wc.isDestroyed()) throw new Error('The preview page is gone.')
    if (!g.wc.debugger.isAttached()) this.connect(g)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        g.wc.debugger.sendCommand(method, params) as Promise<T>,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Evaluates in the page's main world and returns the value, or throws the page's error. */
  private async evaluate<T = unknown>(g: Guest, expression: string, timeoutMs = 10_000): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      g,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    )
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Script error')
    }
    return res.result.value as T
  }

  /** Waits for the page to go quiet after an action: no load, no in-flight fetch, for a beat. */
  async settle(g: Guest, maxMs = 3000): Promise<void> {
    await sleep(120)
    const end = Date.now() + maxMs
    let quietSince = Date.now()
    while (Date.now() < end) {
      if (g.wc.isDestroyed()) return
      const busy = g.wc.isLoading() || g.log.pending() > 0
      if (busy) quietSince = Date.now()
      else if (Date.now() - quietSince >= 200) return
      await sleep(80)
    }
  }

  /** The tail every action reports: where the page is now and what went wrong after it. */
  private report(g: Guest, head: string, mark: number, beforeUrl: string): string {
    const lines = [head]
    const url = g.wc.isDestroyed() ? '' : g.wc.getURL()
    if (url && url !== beforeUrl) lines.push(`The page navigated to ${url}`)
    const problems = g.log.problemsSince(mark)
    if (problems.console.length) lines.push(`Console after the action:\n${formatConsole(problems.console)}`)
    if (problems.network.length) lines.push(`Failed requests after the action:\n${formatNetwork(problems.network, originOf(url))}`)
    return lines.join('\n')
  }

  private async act<T>(g: Guest, fn: () => Promise<T>): Promise<T> {
    g.acting++
    try {
      return await fn()
    } finally {
      g.acting--
    }
  }

  async snapshot(g: Guest, caller: string): Promise<string> {
    const snap = await this.evaluate<{
      url: string
      title: string
      viewport: { width: number; height: number; scrollY: number; scrollHeight: number }
      focused: string | null
      tree: string
      dropped: number
    }>(g, agentCall('snapshot', { maxChars: 16_000 }))
    const v = snap.viewport
    const below = Math.max(0, v.scrollHeight - v.scrollY - v.height)
    const lines = [
      `Page: ${snap.title || '(untitled)'} — ${snap.url}`,
      `Viewport ${v.width}×${v.height}, scrolled to ${v.scrollY}px${below > 0 ? ` (${below}px more below)` : ''}${snap.focused ? `; focused: ${snap.focused}` : ''}`,
      '',
      snap.tree || '(the page has no visible content)'
    ]
    if (snap.dropped > 0) {
      lines.push(`… ${snap.dropped} more lines not shown. Scroll, or use preview_evaluate to read a specific part.`)
    }
    const mark = g.snapshotMarks.get(caller) ?? 0
    g.snapshotMarks.set(caller, g.log.mark())
    const problems = g.log.problemsSince(mark)
    if (problems.console.length) lines.push('', `Console errors/warnings since your last snapshot:\n${formatConsole(problems.console)}`)
    if (problems.network.length) {
      lines.push('', `Failed requests since your last snapshot:\n${formatNetwork(problems.network, originOf(snap.url))}`)
    }
    return lines.join('\n')
  }

  private async mouse(g: Guest, x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): Promise<void> {
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
    await this.send(g, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const clicks = double ? [1, 2] : [1]
    for (const clickCount of clicks) {
      await this.send(g, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount })
      await this.send(g, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount })
    }
  }

  async click(g: Guest, input: PreviewToolInput): Promise<string> {
    return this.act(g, async () => {
      let x: number
      let y: number
      let desc: string
      if (input.ref || input.selector || input.text) {
        const p = await this.evaluate<{ x: number; y: number; desc: string; ref: string; obscuredBy?: string } | { error: string }>(
          g,
          agentCall('point', { ref: input.ref, selector: input.selector, text: input.text })
        )
        if ('error' in p) return p.error
        if (p.obscuredBy) {
          return `Not clicked: ${p.desc} [ref=${p.ref}] is covered by ${p.obscuredBy} at its centre. Close or dismiss what covers it first, or click at x/y if the cover is what you mean.`
        }
        x = p.x
        y = p.y
        desc = `${p.desc} [ref=${p.ref}]`
      } else if (typeof input.x === 'number' && typeof input.y === 'number') {
        x = input.x
        y = input.y
        desc = `(${Math.round(x)}, ${Math.round(y)})`
      } else {
        return 'Name what to click: ref (from preview_snapshot), selector, text, or x and y.'
      }
      const mark = g.log.mark()
      const before = g.wc.getURL()
      const button = input.button === 'right' || input.button === 'middle' ? input.button : 'left'
      await this.mouse(g, x, y, button, input.double === true)
      await this.settle(g)
      return this.report(g, `${input.double ? 'Double-clicked' : 'Clicked'} ${desc}.`, mark, before)
    })
  }

  /** A real click on an element, for the input focus `el.focus()` cannot give. */
  private async focusByClick(g: Guest, target: { ref?: string; focused?: boolean }): Promise<void> {
    const p = await this.evaluate<{ x: number; y: number } | { error: string }>(g, agentCall('point', target)).catch(() => null)
    if (!p || 'error' in p) return
    await this.mouse(g, p.x, p.y, 'left', false)
  }

  private async key(g: Guest, combo: string): Promise<string | null> {
    const k = parseKeyCombo(combo)
    if ('error' in k) return k.error
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers }
    await this.send(g, 'Input.dispatchKeyEvent', {
      ...base,
      type: k.text ? 'keyDown' : 'rawKeyDown',
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
      ...(k.commands ? { commands: k.commands } : {})
    })
    await this.send(g, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    return null
  }

  async type(g: Guest, input: PreviewToolInput): Promise<string> {
    return this.act(g, async () => {
      const prep = await this.evaluate<{ desc: string; ref: string; selected?: string } | { error: string }>(
        g,
        agentCall('prepareType', { ref: input.ref, selector: input.selector, append: input.append === true, text: input.text ?? '' })
      )
      if ('error' in prep) return prep.error
      const mark = g.log.mark()
      const before = g.wc.getURL()
      if (prep.selected !== undefined) {
        await this.settle(g)
        return this.report(g, `Selected ${JSON.stringify(prep.selected)} in ${prep.desc}.`, mark, before)
      }
      // Text only lands once the guest's widget has input focus, which a
      // real click gives and `el.focus()` does not (measured: focus in the
      // DOM, `insertText` dropped). So click the field like a person would,
      // then select its contents again — the click moved the caret.
      await this.focusByClick(g, { ref: prep.ref })
      await this.evaluate(
        g,
        agentCall('prepareType', { ref: prep.ref, append: input.append === true, text: input.text ?? '' })
      ).catch(() => {})
      const text = input.text ?? ''
      if (text) await this.send(g, 'Input.insertText', { text })
      else if (input.append !== true) await this.key(g, 'Backspace')
      if (input.submit) await this.key(g, 'Enter')
      await this.settle(g)
      const value = await this.evaluate<unknown>(g, agentCall('valueOf', prep.ref)).catch(() => null)
      const now =
        typeof value === 'string'
          ? ` It now holds ${JSON.stringify(value.length > 200 ? value.slice(0, 200) + '…' : value)}.`
          : ''
      return this.report(
        g,
        `Typed into ${prep.desc} [ref=${prep.ref}].${now}${input.submit ? ' Pressed Enter.' : ''}`,
        mark,
        before
      )
    })
  }

  async press(g: Guest, input: PreviewToolInput): Promise<string> {
    return this.act(g, async () => {
      let where = 'the focused element'
      if (input.ref || input.selector) {
        const f = await this.evaluate<{ desc: string; ref: string } | { error: string }>(
          g,
          agentCall('focus', { ref: input.ref, selector: input.selector })
        )
        if ('error' in f) return f.error
        where = `${f.desc} [ref=${f.ref}]`
        await this.focusByClick(g, { ref: f.ref })
      } else {
        await this.focusByClick(g, { focused: true })
      }
      const mark = g.log.mark()
      const before = g.wc.getURL()
      const err = await this.key(g, input.key ?? '')
      if (err) return err
      await this.settle(g)
      return this.report(g, `Pressed ${input.key} on ${where}.`, mark, before)
    })
  }

  async scroll(g: Guest, input: PreviewToolInput): Promise<string> {
    type State = { y: number; x: number; height: number; viewport: number }
    const describe = (s: State): string => {
      const max = Math.max(0, s.height - s.viewport)
      return `Scrolled to y=${Math.min(s.y, max)} of ${max}px${s.x ? `, x=${s.x}` : ''}.`
    }
    if (input.to === 'top' || input.to === 'bottom') {
      return describe(await this.evaluate<State>(g, agentCall('scrollTo', input.to)))
    }
    let x: number | undefined
    let y: number | undefined
    let desc = ''
    if (input.ref || input.selector || input.text) {
      const p = await this.evaluate<{ x: number; y: number; desc: string; ref: string } | { error: string }>(
        g,
        agentCall('point', { ref: input.ref, selector: input.selector, text: input.text })
      )
      if ('error' in p) return p.error
      x = p.x
      y = p.y
      desc = `${p.desc} [ref=${p.ref}]`
    }
    const dy = input.dy ?? 0
    const dx = input.dx ?? 0
    if (dy || dx) {
      if (x === undefined || y === undefined) {
        const vp = await this.evaluate<{ w: number; h: number }>(g, '({ w: innerWidth, h: innerHeight })')
        x = vp.w / 2
        y = vp.h / 2
      }
      await this.send(g, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy })
      await sleep(250)
    } else if (!desc) {
      return 'Say where to scroll: a ref/selector/text to bring into view, dy/dx pixels, or to "top"/"bottom".'
    }
    const state = await this.evaluate<State>(g, agentCall('scrollState'))
    return (desc && !(dy || dx) ? `Brought ${desc} into view. ` : '') + describe(state)
  }

  async waitFor(g: Guest, input: PreviewToolInput): Promise<string> {
    const timeout = Math.min(Math.max(input.timeout_ms ?? 5000, 100), 30_000)
    const want = !input.gone
    const what = input.selector ? `selector ${JSON.stringify(input.selector)}` : `text ${JSON.stringify(input.text)}`
    const start = Date.now()
    for (;;) {
      let present: boolean | null
      try {
        present = await this.evaluate<boolean>(g, agentCall('present', { text: input.text, selector: input.selector }))
      } catch (err) {
        // A navigation tearing the context down mid-poll is expected; anything
        // else (the guest gone, CDP detached) must not read as "it's gone".
        if (g.wc.isDestroyed() || !/context|navigat|Target closed|Inspected target/i.test(String(err))) throw err
        present = null
      }
      if (present === want) return `${want ? 'Found' : 'Gone'}: ${what} after ${Date.now() - start}ms.`
      if (Date.now() - start >= timeout) {
        return `Timed out after ${timeout}ms waiting for ${what} to ${want ? 'appear' : 'disappear'}. Take a preview_snapshot to see what is there.`
      }
      await sleep(150)
    }
  }

  /**
   * Runs the agent's script. Local pages only: the preview's session persists
   * cookies across every site the user has opened in it, so a script on a
   * page the user is signed in to is a read of their account — a prompt
   * injection away from exfiltration. A dev server's page is the agent's own
   * work and fair game.
   */
  async evaluateTool(g: Guest, input: PreviewToolInput): Promise<string> {
    // Judged by the *context's* origin, as CDP reported it, not the URL: a
    // remote page that navigates itself to `about:blank` keeps its origin. And
    // the script runs in that exact context (`uniqueContextId`), so a
    // navigation in between makes it fail rather than run on the new page.
    if (!g.mainContext) await this.evaluate(g, '1').catch(() => {})
    const ctx = g.mainContext
    if (!ctx || !isLoopbackUrl(`${ctx.origin}/`)) {
      return `preview_evaluate only runs on local dev-server pages; the preview is showing ${ctx?.origin || originOf(g.wc.getURL()) || g.wc.getURL()}. Use preview_snapshot to read it.`
    }
    return this.act(g, async () => {
      const source = (input.expression ?? '').trim()
      const expression = isFunctionSource(source) ? `(${source})()` : source
      const res = await this.send<{
        result: { type: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string; objectId?: string }
        exceptionDetails?: { exception?: { description?: string }; text?: string }
      }>(
        g,
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: false, userGesture: true, replMode: true, uniqueContextId: ctx.uniqueId },
        20_000
      )
      if (res.exceptionDetails) {
        return `The script threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'error'}`
      }
      const r = res.result
      let value: unknown
      if (r.objectId) {
        const ser = await this.send<{ result: { value?: unknown } }>(g, 'Runtime.callFunctionOn', {
          functionDeclaration: SERIALIZE_FN,
          objectId: r.objectId,
          returnByValue: true
        }).catch(() => ({ result: { value: r.description } }))
        value = ser.result.value
        void this.send(g, 'Runtime.releaseObject', { objectId: r.objectId }).catch(() => {})
      } else if (r.type === 'undefined') {
        return 'undefined'
      } else {
        value = r.unserializableValue ?? r.value
      }
      const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2)
      return text === undefined ? String(value) : text.length > 20_000 ? `${text.slice(0, 20_000)}… (truncated)` : text
    })
  }

  async history(g: Guest, action: 'back' | 'forward' | 'reload'): Promise<string> {
    const nav = g.wc.navigationHistory
    const before = g.wc.getURL()
    const mark = g.log.mark()
    if (action === 'back') {
      if (!nav.canGoBack()) return 'There is no page to go back to.'
      nav.goBack()
    } else if (action === 'forward') {
      if (!nav.canGoForward()) return 'There is no page to go forward to.'
      nav.goForward()
    } else {
      g.wc.reload()
    }
    await this.settle(g, 10_000)
    return this.report(g, `${action === 'reload' ? 'Reloaded' : `Went ${action}`}: ${g.wc.getURL()} — ${g.wc.getTitle()}`, mark, action === 'reload' ? g.wc.getURL() : before)
  }

  /** After a navigation the renderer started: wait for it to land, then say where it is. */
  async afterNavigate(g: Guest, mark: number): Promise<string> {
    await sleep(150)
    await this.settle(g, 15_000)
    const url = g.wc.getURL()
    return this.report(g, `Loaded ${url} — ${g.wc.getTitle() || '(untitled)'}`, mark, url)
  }

  console(g: Guest | undefined, caller: string, all: boolean): string {
    if (!g) return ''
    return formatConsole(g.log.readConsole(caller, { all }))
  }

  async network(g: Guest, caller: string, input: PreviewToolInput): Promise<string> {
    const entries = g.log.readNetwork(caller, {
      all: input.all === true,
      failedOnly: input.failed_only === true,
      filter: input.filter
    })
    if (!entries.length) {
      return input.all ? 'No requests recorded.' : 'No new requests since your last read.'
    }
    const origin = originOf(g.wc.getURL())
    const lines = [formatNetwork(entries, origin)]
    // A failed API call's body is usually the error message the agent needs.
    const failedApi = entries.filter((e) => isProblem(e) && !e.failed && (e.type === 'XHR' || e.type === 'Fetch')).slice(-4)
    for (const e of failedApi) {
      const body = await this.send<{ body: string; base64Encoded: boolean }>(g, 'Network.getResponseBody', { requestId: e.id }, 3000).catch(
        () => null
      )
      if (body && !body.base64Encoded && body.body) {
        const snippet = body.body.length > 600 ? `${body.body.slice(0, 600)}…` : body.body
        lines.push(`\n${e.method} ${e.url} responded ${e.status}:\n${snippet}`)
      }
    }
    return lines.join('\n')
  }

  async viewportInfo(g: Guest): Promise<string> {
    const v = await this.evaluate<{ w: number; h: number; dpr: number; dark: boolean; touch: boolean }>(
      g,
      "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches, touch: navigator.maxTouchPoints > 0 })"
    )
    return `The page now sees a ${v.w}×${v.h} viewport at ${v.dpr}x, ${v.dark ? 'dark' : 'light'} color scheme${v.touch ? ', touch' : ''}.`
  }

  /**
   * A whole-page PNG at 1 CSS px per pixel, scrolled and stitched.
   *
   * CDP's own answer — `captureBeyondViewport`, or a device-metrics override
   * the height of the page — does not work on a `<webview>` guest: measured,
   * both return the first ~1,300 px and then the top of the page again, tiled
   * down the image. A viewport capture is reliable, so the page is captured a
   * viewport at a time and the tiles are joined here. Fixed and sticky
   * elements are hidden after the first tile, or a header would be stamped
   * onto every screenful. Needs a painted guest, so the caller puts the pane
   * on screen first (`reveal`).
   */
  async captureFullPage(g: Guest): Promise<string | null> {
    type Info = { w: number; h: number; total: number; y: number; dpr: number }
    const info = await this.evaluate<Info>(
      g,
      '({ w: innerWidth, h: innerHeight, total: (document.scrollingElement || document.documentElement).scrollHeight, y: scrollY, dpr: devicePixelRatio })'
    )
    const total = Math.min(info.total, FULL_PAGE_MAX)
    let width = 0
    let scale = 0
    let out: Buffer | null = null
    // Overlay scrollbars would otherwise be painted into every tile.
    await this.send(g, 'Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {})
    try {
      for (let y = 0; y < total; y += info.h) {
        if (y > 0) await this.evaluate(g, HIDE_FIXED)
        // `instant` overrides a page's `scroll-behavior: smooth`, and the
        // offset is read after the paint, so the tile is where it is assumed.
        await this.evaluate(g, `scrollTo({ top: ${y}, left: 0, behavior: 'instant' })`)
        await sleep(140)
        const at = await this.evaluate<number>(g, 'scrollY')
        const shot = await this.send<{ data: string }>(g, 'Page.captureScreenshot', { format: 'png' }, 8000)
        const img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
        const size = img.getSize()
        if (!out) {
          width = size.width
          scale = size.width / info.w
          out = Buffer.alloc(width * Math.round(total * scale) * 4)
        }
        const bitmap = img.toBitmap()
        // The tile covers [at, at + h); the slice wanted is [y, min(y + h, total)).
        const from = Math.max(0, Math.round((y - at) * scale))
        const rows = Math.min(Math.round((Math.min(y + info.h, total) - y) * scale), size.height - from)
        const dest = Math.round(y * scale)
        const stride = size.width * 4
        for (let r = 0; r < rows && dest + r < out.length / (width * 4); r++) {
          bitmap.copy(out, (dest + r) * width * 4, (from + r) * stride, (from + r) * stride + Math.min(stride, width * 4))
        }
      }
    } finally {
      await this.evaluate(g, `${SHOW_FIXED}; scrollTo(0, ${info.y})`).catch(() => {})
      await this.send(g, 'Emulation.setScrollbarsHidden', { hidden: false }).catch(() => {})
    }
    if (!out) return null
    let image = nativeImage.createFromBitmap(out, { width, height: out.length / (width * 4), scaleFactor: 1 })
    if (scale > 1) image = image.resize({ width: Math.round(width / scale), quality: 'good' })
    return image.toPNG().toString('base64')
  }

  /**
   * Device emulation for a pane. Size is the `<webview>` element's own (the
   * renderer lays it out); what CDP adds is what a sized box cannot: the
   * pixel ratio, touch, the mobile user agent, and `prefers-color-scheme`.
   */
  async emulate(paneId: string, emu: PreviewEmulation): Promise<void> {
    const g = this.guest(paneId)
    if (!g) return
    await this.send(g, 'Emulation.setEmulatedMedia', {
      features: emu.colorScheme ? [{ name: 'prefers-color-scheme', value: emu.colorScheme }] : []
    }).catch(() => {})
    if (emu.width && emu.height && (emu.mobile || (emu.dpr && emu.dpr > 0))) {
      await this.send(g, 'Emulation.setDeviceMetricsOverride', {
        width: emu.width,
        height: emu.height,
        deviceScaleFactor: emu.dpr ?? 0,
        mobile: emu.mobile === true,
        screenWidth: emu.width,
        screenHeight: emu.height
      }).catch(() => {})
    } else {
      await this.send(g, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
    }
    await this.send(g, 'Emulation.setTouchEmulationEnabled', { enabled: emu.mobile === true, maxTouchPoints: emu.mobile ? 5 : 1 }).catch(
      () => {}
    )
    await this.send(g, 'Emulation.setUserAgentOverride', {
      userAgent: emu.mobile ? MOBILE_UA[emu.os ?? 'ios'] : g.userAgent
    }).catch(() => {})
  }

  disposeAll(): void {
    for (const id of [...this.guests.keys()]) this.detach(id)
  }
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined
  } catch {
    return undefined
  }
}

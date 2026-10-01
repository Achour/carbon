/**
 * What the preview page has said and fetched, kept for the agent.
 *
 * Fed by CDP in main (`previewDriver.ts`) rather than by the renderer, which is
 * the fix for two old gaps at once: console lines used to be forwarded only
 * when *Carbon* had started the dev server (a server from the user's own
 * terminal produced an empty `preview_console`), and only lines that looked
 * like errors were forwarded at all, so a `console.log` the agent added to
 * debug something never came back.
 *
 * **Reads are per caller.** Each chat gets its own cursor, so a read answers
 * "what is new since *you* last looked" — the question an agent iterating on a
 * fix is asking — and two chats on one project do not consume each other's
 * lines. `all` still returns the recent tail.
 *
 * Dependency-free on purpose — `node --test` runs it straight off the `.ts`.
 */

export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'

export interface ConsoleEntry {
  seq: number
  ts: number
  level: ConsoleLevel
  text: string
  /** `file:line` where it was logged, when the page said. */
  source?: string
  /** A navigation marker rather than something the page logged. */
  marker?: boolean
}

export interface NetworkEntry {
  id: string
  /** Bumped on every update, so "new since" sees a request when it settles. */
  seq: number
  ts: number
  method: string
  url: string
  type: string
  status?: number
  statusText?: string
  mime?: string
  /** `net::ERR_…` when the request never got a response. */
  failed?: string
  ms?: number
  done: boolean
}

const CONSOLE_CAP = 400
const NETWORK_CAP = 400

/** Lines nothing in the page wrote: Electron's own dev warning, the picker's channel. */
const NOISE = [/^Electron Security Warning/, /^%cElectron Security Warning/, /^__KARBUN_PICK__/, /Download the React DevTools/]

export class PreviewLog {
  private seq = 0
  private consoleEntries: ConsoleEntry[] = []
  private network = new Map<string, NetworkEntry>()
  private cursors = new Map<string, { console: number; network: number }>()

  /** The current position — an action records it and reports what landed after. */
  mark(): number {
    return this.seq
  }

  addConsole(level: ConsoleLevel, text: string, source?: string): void {
    if (NOISE.some((re) => re.test(text))) return
    this.pushConsole({ seq: ++this.seq, ts: Date.now(), level, text: clip(text, 2000), source })
  }

  /** A main-frame navigation, so a read can tell which page a line came from. */
  navigated(url: string): void {
    this.pushConsole({ seq: ++this.seq, ts: Date.now(), level: 'info', text: `— navigated to ${url} —`, marker: true })
  }

  private pushConsole(e: ConsoleEntry): void {
    this.consoleEntries.push(e)
    if (this.consoleEntries.length > CONSOLE_CAP) this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_CAP)
  }

  requestStarted(id: string, method: string, url: string, type: string): void {
    if (url.startsWith('data:') || url.startsWith('blob:')) return
    this.network.set(id, { id, seq: ++this.seq, ts: Date.now(), method, url, type, done: false })
    if (this.network.size > NETWORK_CAP) {
      const oldest = this.network.keys().next().value
      if (oldest !== undefined) this.network.delete(oldest)
    }
  }

  responseReceived(id: string, status: number, statusText: string, mime: string): void {
    const e = this.network.get(id)
    if (!e) return
    e.status = status
    e.statusText = statusText
    e.mime = mime
  }

  requestFinished(id: string): void {
    const e = this.network.get(id)
    if (!e) return
    e.done = true
    e.ms = Date.now() - e.ts
    e.seq = ++this.seq
  }

  requestFailed(id: string, errorText: string, canceled: boolean): void {
    const e = this.network.get(id)
    if (!e) return
    e.done = true
    e.ms = Date.now() - e.ts
    // A cancelled request is the page changing its mind (a navigation, an
    // aborted fetch), not a failure the agent should chase.
    e.failed = canceled ? 'canceled' : errorText
    e.seq = ++this.seq
  }

  /** In-flight requests, for waiting until the page settles after an action. */
  pending(): number {
    let n = 0
    for (const e of this.network.values()) if (!e.done && (e.type === 'XHR' || e.type === 'Fetch' || e.type === 'Document')) n++
    return n
  }

  private cursor(caller: string): { console: number; network: number } {
    let c = this.cursors.get(caller)
    if (!c) {
      c = { console: 0, network: 0 }
      this.cursors.set(caller, c)
    }
    return c
  }

  /**
   * Console entries for `caller`: new since its last read, or the recent tail
   * with `all`. `debug` lines are left out unless `all` asks — a dev server's
   * HMR chatter is `debug`, and it would bury everything else.
   */
  readConsole(caller: string, opts: { all?: boolean; limit?: number } = {}): ConsoleEntry[] {
    const c = this.cursor(caller)
    const limit = opts.limit ?? 80
    const from = opts.all ? 0 : c.console
    const out = this.consoleEntries.filter((e) => e.seq > from && (opts.all || e.level !== 'debug'))
    c.console = this.seq
    return out.slice(-limit)
  }

  readNetwork(caller: string, opts: { all?: boolean; failedOnly?: boolean; filter?: string; limit?: number } = {}): NetworkEntry[] {
    const c = this.cursor(caller)
    const limit = opts.limit ?? 60
    const from = opts.all ? 0 : c.network
    const needle = opts.filter?.toLowerCase()
    const out = [...this.network.values()].filter(
      (e) =>
        (opts.all ? true : e.done && e.seq > from) &&
        (!opts.failedOnly || isProblem(e)) &&
        (!needle || e.url.toLowerCase().includes(needle))
    )
    c.network = this.seq
    return out.sort((a, b) => a.ts - b.ts).slice(-limit)
  }

  /** Errors, warnings and failed requests that landed after `mark`. */
  problemsSince(mark: number): { console: ConsoleEntry[]; network: NetworkEntry[] } {
    return {
      console: this.consoleEntries.filter((e) => e.seq > mark && (e.level === 'error' || e.level === 'warn')).slice(-12),
      network: [...this.network.values()].filter((e) => e.seq > mark && e.done && isProblem(e)).slice(-12)
    }
  }

  clear(): void {
    this.consoleEntries = []
    this.network.clear()
  }
}

export function isProblem(e: NetworkEntry): boolean {
  if (e.failed === 'canceled') return false
  return !!e.failed || (e.status !== undefined && e.status >= 400)
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text
}

export function formatConsole(entries: ConsoleEntry[]): string {
  return entries
    .map((e) => (e.marker ? e.text : `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ''}`))
    .join('\n')
}

/** Paths relative to the page's origin read better than the origin repeated on every line. */
export function formatNetwork(entries: NetworkEntry[], origin?: string): string {
  return entries
    .map((e) => {
      const url = origin && e.url.startsWith(origin) ? e.url.slice(origin.length) || '/' : e.url
      const outcome = e.failed
        ? `FAILED ${e.failed}`
        : e.status !== undefined
          ? `${e.status}${e.statusText ? ` ${e.statusText}` : ''}`
          : e.done
            ? 'done'
            : 'pending'
      const ms = e.ms !== undefined ? ` ${e.ms}ms` : ''
      return `${e.method} ${url} → ${outcome}${ms} [${e.type}]`
    })
    .join('\n')
}

/** A CDP `Runtime.RemoteObject`, as far as formatting needs it. */
export interface RemoteObjectLike {
  type: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  preview?: {
    type?: string
    subtype?: string
    overflow?: boolean
    properties?: { name: string; type: string; value?: string; subtype?: string }[]
  }
}

function formatRemote(o: RemoteObjectLike): string {
  if (o.type === 'string') return String(o.value)
  if (o.unserializableValue) return o.unserializableValue
  if (o.type === 'undefined') return 'undefined'
  if (o.subtype === 'null') return 'null'
  if (o.type === 'number' || o.type === 'boolean' || o.type === 'bigint') return String(o.value ?? o.description)
  if (o.subtype === 'error') return o.description ?? 'Error'
  const props = o.preview?.properties
  if (props) {
    const isArray = o.subtype === 'array'
    const inner = props
      .map((p) => {
        const v = p.type === 'string' ? JSON.stringify(p.value ?? '') : (p.value ?? p.type)
        return isArray ? v : `${p.name}: ${v}`
      })
      .join(', ')
    const more = o.preview?.overflow ? ', …' : ''
    return isArray ? `[${inner}${more}]` : `{${inner}${more}}`
  }
  return o.description ?? o.type
}

/**
 * `console.log`'s arguments as one line, applying the format string the way
 * the console does: `%s %d %i %f %o %O` take the next argument and `%c` takes
 * one and prints nothing — it is CSS, and React's own banner leads with it.
 */
export function formatConsoleArgs(args: RemoteObjectLike[]): string {
  if (!args.length) return ''
  const [first, ...rest] = args
  if (first.type !== 'string' || !/%[sdifoOc]/.test(String(first.value))) {
    return args.map(formatRemote).join(' ')
  }
  const queue = [...rest]
  const head = String(first.value).replace(/%([sdifoOc%])/g, (m, spec: string) => {
    if (spec === '%') return '%'
    const next = queue.shift()
    if (!next) return m
    if (spec === 'c') return ''
    if (spec === 'd' || spec === 'i') return String(Math.trunc(Number(next.value ?? next.description)))
    if (spec === 'f') return String(Number(next.value ?? next.description))
    return formatRemote(next)
  })
  return [head, ...queue.map(formatRemote)].join(' ').trim()
}

/**
 * Fetching, validating and caching the icon for one origin.
 *
 * Everything the favicon mark needs lives here, and the module imports only
 * `node:*` (plus the global `fetch`) so `node --test` can load the `.ts`
 * directly — the same trade `store.ts` makes by taking its directory as a
 * constructor argument rather than asking Electron for it. `favicons.ts` is the
 * ten-line Electron half: it knows where `userData` is, and nothing else.
 *
 * **The icon is fetched from the site itself, never from a favicon service.**
 * Google's and DuckDuckGo's endpoints are one request instead of two and answer
 * for hosts that have nothing — and they are told, for every link, which domain
 * a reader is looking at. The domain is one the *model* chose to cite, so that
 * is a reading list, and no icon is worth handing one over.
 *
 * The gate that matters is `imageMime`, not the fetch: a 200 at `/favicon.ico`
 * is routinely an SPA's catch-all `index.html`, and a server that types a
 * response off the extension will stamp `image/x-icon` on it. Either one becomes
 * a `data:image/x-icon;base64,PCFET0NUWVBF…` that draws nothing, so the body is
 * sniffed and markup is refused whatever the header claims.
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One request's ceiling. A mark nobody is waiting for must not hold a socket. */
export const REQUEST_TIMEOUT_MS = 3_000

/**
 * The whole resolution's ceiling. A site can cost up to six requests (the .ico
 * guess, the page, four declared icons) and a per-request timeout alone would
 * let that run to 18s — long enough that the in-flight entry stops being a
 * de-duplication and starts being a leak.
 */
export const TOTAL_BUDGET_MS = 8_000

/** A 16px mark; anything near this cap is already the wrong asset. */
export const ICON_MAX_BYTES = 256 * 1024

/** Only `<head>` is ever read, and the read stops at `</head>` before this. */
export const HTML_MAX_BYTES = 512 * 1024

/** Below this a body cannot be an image — and a 0-byte 200 is common. */
const ICON_MIN_BYTES = 16

/** A found icon is re-fetched monthly; a miss is retried the next day. */
export const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

/** Declared icons tried before giving up, best-ranked first. */
const MAX_DECLARED = 4

/** Origins held in memory; a transcript cites far fewer. */
const MEMORY_MAX = 512

const USER_AGENT = 'Carbon (+https://github.com/Achour/carbon)'

// ---- Pure: origins, markup, sniffing (all tested offline) ----

/**
 * The origin an external link belongs to, or null.
 *
 * http(s) only: a `mailto:` or `file:` link has no favicon to fetch, and a
 * scheme we don't recognize is not something to hand to `fetch`. `URL.origin`
 * lowercases the host and drops a default port, so `HTTPS://Example.com:443/a`
 * and `https://example.com/b` share one cache entry.
 */
export function originOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.origin
}

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false
  return true
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** The image format a body actually is, by magic bytes, or null. */
export function sniffImage(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, ascii('GIF8'))) return 'image/gif'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  // ICO and CUR share a header; only the type word differs (1 = icon).
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  if (startsWith(bytes, ascii('BM'))) return 'image/bmp'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic'
  }
  return null
}

/** The first 1 KB as text, for the markup checks. */
function head(bytes: Uint8Array): string {
  let text = ''
  const n = Math.min(bytes.length, 1024)
  for (let i = 0; i < n; i++) text += String.fromCharCode(bytes[i]!)
  // A BOM — U+FEFF, or the three raw bytes of a UTF-8 one read as latin-1 —
  // and any leading whitespace must not hide the `<`.
  return text.replace(/^(?:\uFEFF|\u00EF\u00BB\u00BF|\s)+/, '')
}

/**
 * The mime a body may be encoded as, or null.
 *
 * The order is the whole point. Magic bytes are believed over the header, a
 * body that starts with `<` is refused whatever the header says — the one
 * exception being an SVG, which is markup by nature — and the declared
 * content-type only ever answers for a format we can't sniff.
 */
export function imageMime(bytes: Uint8Array, contentType?: string | null): string | null {
  if (bytes.length < ICON_MIN_BYTES) return null

  const sniffed = sniffImage(bytes)
  if (sniffed) return sniffed

  const declared = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

  const text = head(bytes)
  if (text.startsWith('<')) {
    // `<svg` may sit behind an XML declaration, a doctype or a comment; an HTML
    // document is refused even when it carries an inline `<svg` that early.
    const html = /^<(!doctype\s+html|html[\s>])/i.test(text)
    const svg = /<svg[\s>]/i.test(text)
    return !html && (svg || declared === 'image/svg+xml') ? 'image/svg+xml' : null
  }

  // Nothing we can sniff — take the server's word, but only for a well-formed
  // image type, so junk can never reach an `<img src>`.
  return /^image\/[a-z0-9][a-z0-9.+-]*$/.test(declared) ? declared : null
}

// ---- Pure: the declared icons in a page's <head> ----

export interface IconLink {
  href: string
  rel: string
  sizes: string
  type: string
}

const ENTITIES: Record<string, string | undefined> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#47': '/',
  '#x2f': '/'
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const key = name.toLowerCase()
    const named = ENTITIES[key]
    if (named !== undefined) return named
    const dec = /^#(\d+)$/.exec(key)
    if (dec) return String.fromCodePoint(Number(dec[1]))
    const hex = /^#x([0-9a-f]+)$/.exec(key)
    if (hex) return String.fromCodePoint(parseInt(hex[1]!, 16))
    return whole
  })
}

const ATTR = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g

function attrs(tag: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase()
    if (out[name] === undefined) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/**
 * Every `<link rel="…icon…">` a page declares, in document order.
 *
 * The read stops at `</head>` — a `<link rel=icon>` in the body is not a
 * declaration anyone honors, and the tail of a large page is not worth
 * scanning. `mask-icon` is dropped on purpose: Safari's pinned-tab asset is a
 * monochrome silhouette, so drawing it beside a link gives a black square.
 */
export function parseIconLinks(html: string): IconLink[] {
  const end = html.search(/<\/head\s*>/i)
  const scope = end === -1 ? html : html.slice(0, end)
  const links: IconLink[] = []
  for (const tag of scope.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(tag[0])
    const rel = (a.rel ?? '').trim().toLowerCase()
    const tokens = rel.split(/\s+/)
    if (!tokens.some((t) => t.includes('icon'))) continue
    if (tokens.includes('mask-icon')) continue
    const href = (a.href ?? '').trim()
    if (!href) continue
    links.push({ href, rel, sizes: (a.sizes ?? '').trim().toLowerCase(), type: (a.type ?? '').trim().toLowerCase() })
  }
  return links
}

/** The pixel size a `sizes` attribute claims, as a distance from the 32px we want. */
function sizeDistance(sizes: string): number {
  if (!sizes) return 40 // undeclared: usable, but outranked by anything that says
  if (sizes.includes('any')) return 0 // scalable — exactly what a mark wants
  let best = Infinity
  for (const m of sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/g)) {
    const px = Math.max(Number(m[1]), Number(m[2]))
    best = Math.min(best, Math.abs(px - 32))
  }
  return Number.isFinite(best) ? best : 40
}

function relRank(rel: string): number {
  const tokens = rel.split(/\s+/)
  // `icon` and the legacy `shortcut icon` are the declaration for this job.
  if (tokens.includes('icon')) return 0
  if (tokens.some((t) => t.startsWith('apple-touch-icon'))) return 1
  return 2 // fluid-icon and friends: better than nothing, worse than either
}

/**
 * The declared icons, best first: a real `icon` above an `apple-touch-icon`,
 * and within each the size nearest 32px. Ties keep document order, so the
 * ranking is total and the same page always resolves to the same asset.
 */
export function rankIconLinks(links: IconLink[]): IconLink[] {
  return links
    .map((link, i) => ({ link, i, score: relRank(link.rel) * 1000 + sizeDistance(link.sizes) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((e) => e.link)
}

/**
 * Declared hrefs as absolute http(s) URLs, deduplicated.
 *
 * `base` is the URL the HTML actually came *from* rather than the origin asked
 * for: `https://php.net/` redirects to `https://www.php.net/`, and a relative
 * `images/favicon.png` resolved against the origin would 404. A cross-origin
 * href is kept — a site pointing at its own CDN is still the site's own answer,
 * not a third party we chose.
 */
export function resolveIconUrls(base: string, links: IconLink[]): string[] {
  const out: string[] = []
  for (const link of links) {
    let abs: URL
    try {
      abs = new URL(link.href, base)
    } catch {
      continue
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue
    const href = abs.toString()
    if (!out.includes(href)) out.push(href)
  }
  return out
}

/** The cache file for an origin: readable at a glance, unique by hash. */
export function cacheFileName(origin: string): string {
  const safe = origin.replace(/^https?:\/\//, (m) => (m === 'http://' ? 'http_' : '')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  return `${safe}-${createHash('sha256').update(origin).digest('hex').slice(0, 8)}.json`
}

interface CacheEntry {
  /** The origin, re-checked on read so a hash collision can't answer wrongly. */
  o: string
  /** The data URI, or null for a host we looked at and found nothing on. */
  d: string | null
  /** When it was written, in epoch ms. */
  t: number
}

function entryFresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.d === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS
  return now - entry.t < ttl && now - entry.t > -POSITIVE_TTL_MS
}

/**
 * Whether the host replied at all during one resolution — a 404 or a 200 with
 * no icon is an answer, a refused connection or a timeout is not, and a 5xx is
 * read as the outage it usually is. It is what keeps a network failure out of
 * the disk cache.
 */
interface Reach {
  answered: boolean
}

// ---- The resolver ----

export class FaviconCache {
  /** Answered origins, positive *and* negative — a host with no icon is cited
   * as often as one with, and re-fetching it per link per render is the whole
   * cost this exists to avoid. */
  private readonly memory = new Map<string, string | null>()

  /** One request per origin, however many links arrive in the same frame. */
  private readonly inFlight = new Map<string, Promise<string | null>>()

  /** Where the disk half lives; `node --test` passes a temp directory, and a
   * parameter property would not survive Node's strip-only type removal. */
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * The icon for a URL's origin as a `data:` URI, or null. Never throws: a
   * missing mark is the ordinary outcome, not an error to report.
   */
  async get(url: string): Promise<string | null> {
    const origin = originOf(url)
    if (!origin) return null

    const known = this.memory.get(origin)
    if (known !== undefined) return known

    const existing = this.inFlight.get(origin)
    if (existing) return existing

    const pending = this.resolve(origin).catch(() => null)
    this.inFlight.set(origin, pending)
    try {
      const icon = await pending
      this.remember(origin, icon)
      return icon
    } finally {
      this.inFlight.delete(origin)
    }
  }

  private remember(origin: string, icon: string | null): void {
    if (this.memory.size >= MEMORY_MAX) {
      const oldest = this.memory.keys().next()
      if (!oldest.done) this.memory.delete(oldest.value)
    }
    this.memory.set(origin, icon)
  }

  /** Disk, then the network. The disk read is inside the in-flight promise, so
   * a burst of links costs one read as well as one request. */
  private async resolve(origin: string): Promise<string | null> {
    const cached = await this.readDisk(origin)
    if (cached) return cached.d

    const reach: Reach = { answered: false }
    const icon = await this.fetchIcon(origin, reach)
    // **An outage is not an answer.** A miss is only worth remembering when the
    // host actually replied: writing one for a DNS failure or a timeout would
    // blank every cited host for a day after the network came back, which is
    // exactly the state someone opening the app on bad wifi would be left in.
    // The in-memory entry still holds for the session either way, so a dead
    // host is not re-probed once per link per render.
    if (icon !== null || reach.answered) await this.writeDisk(origin, icon)
    return icon
  }

  /**
   * `<origin>/favicon.ico` first — one request answers most sites — and only on
   * a miss the page's own declarations. The .ico guess wins a tie by being
   * asked first; that is the order, and it never depends on what the page says.
   */
  private async fetchIcon(origin: string, reach: Reach): Promise<string | null> {
    const deadline = Date.now() + TOTAL_BUDGET_MS

    const guess = await this.fetchImage(`${origin}/favicon.ico`, deadline, reach)
    if (guess) return guess

    const page = await this.fetchHtml(`${origin}/`, deadline, reach)
    if (!page) return null

    const urls = resolveIconUrls(page.url, rankIconLinks(parseIconLinks(page.html)))
    for (const url of urls.slice(0, MAX_DECLARED)) {
      const icon = await this.fetchImage(url, deadline, reach)
      if (icon) return icon
    }
    return null
  }

  private signal(deadline: number): AbortSignal | null {
    const left = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())
    return left > 0 ? AbortSignal.timeout(left) : null
  }

  /** A fetched body that is really an image, as a `data:` URI. */
  private async fetchImage(url: string, deadline: number, reach: Reach): Promise<string | null> {
    const signal = this.signal(deadline)
    if (!signal) return null
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: { Accept: 'image/*,*/*;q=0.8', 'User-Agent': USER_AGENT }
      })
      if (res.status < 500) reach.answered = true
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      if (tooLarge(res, ICON_MAX_BYTES)) {
        await res.body.cancel().catch(() => {})
        return null
      }
      const bytes = await readCapped(res.body, ICON_MAX_BYTES)
      if (!bytes) return null
      const mime = imageMime(bytes, res.headers.get('content-type'))
      if (!mime) return null
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    } catch {
      return null
    }
  }

  /** The page's `<head>`, and the URL it was finally served from. */
  private async fetchHtml(
    url: string,
    deadline: number,
    reach: Reach
  ): Promise<{ html: string; url: string } | null> {
    const signal = this.signal(deadline)
    if (!signal) return null
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT }
      })
      if (res.status < 500) reach.answered = true
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const html = await readHead(res.body, HTML_MAX_BYTES)
      return html ? { html, url: res.url || url } : null
    } catch {
      return null
    }
  }

  // ---- Disk ----

  private async readDisk(origin: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(join(this.dir, cacheFileName(origin)), 'utf8')
      const entry = JSON.parse(raw) as CacheEntry
      if (!entry || entry.o !== origin || typeof entry.t !== 'number') return null
      if (entry.d !== null && !(typeof entry.d === 'string' && entry.d.startsWith('data:image/'))) {
        return null
      }
      return entryFresh(entry, Date.now()) ? entry : null
    } catch {
      return null
    }
  }

  private async writeDisk(origin: string, icon: string | null): Promise<void> {
    const file = join(this.dir, cacheFileName(origin))
    const tmp = `${file}.${process.pid}.tmp`
    const entry: CacheEntry = { o: origin, d: icon, t: Date.now() }
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(tmp, JSON.stringify(entry), 'utf8')
      await rename(tmp, file)
    } catch {
      // A cache that can't be written is still a working resolver.
      await unlink(tmp).catch(() => {})
    }
  }
}

// ---- Capped reads ----

function tooLarge(res: Response, cap: number): boolean {
  const len = Number(res.headers.get('content-length'))
  return Number.isFinite(len) && len > cap
}

/** The whole body, or null if it runs past `cap` — the cap is a refusal, not a
 * truncation: half an icon is not an icon. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  cap: number
): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > cap) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** The document up to `</head>` — truncation is *expected* here, and the read
 * stops at the tag rather than pulling a megabyte of body to find it. */
async function readHead(body: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let html = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) html += decoder.decode(value, { stream: true })
      if (/<\/head\s*>/i.test(html) || html.length >= cap) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    // Whatever arrived before the failure may still hold the whole <head>.
  }
  return html
}

import { posix } from 'node:path'
import type { ThemeExtension, ThemeExtensionFile } from '@shared/types'
import { appearanceFromVsCode, mergeVsCodeThemes, parseJsonc } from '@shared/themeImport'
import { openZip } from './zip'

/**
 * Community themes from Open VSX — the open registry VS Code forks publish to,
 * with a public, unauthenticated API. Fetched here rather than in the renderer
 * because every file it serves is a 302 to another host the page's CORS would
 * refuse.
 *
 * Only the manifest is served as a loose file; the theme JSON lives inside the
 * `.vsix`, so adding a theme downloads the extension and reads the few files a
 * theme needs out of it (`zip.ts`). Nothing is executed or kept on disk.
 */

const API = 'https://open-vsx.org/api'
const MAX_VSIX_BYTES = 40 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 60_000

interface Manifest {
  contributes?: { themes?: Array<{ label?: string; uiTheme?: string; path?: string }> }
}

/** Search hits keep their download link, so adding one is a single request. */
const downloads = new Map<string, string>()
const manifests = new Map<string, Promise<Manifest | null>>()
const extensionThemes = new Map<string, Promise<ThemeExtensionFile[]>>()
/** Converted theme files are small; a few dozen extensions is a few MB at most. */
const EXTENSION_CACHE = 24

async function getJson<T>(url: string, timeoutMs = SEARCH_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Open VSX answered ${response.status}`)
  return (await response.json()) as T
}

function manifest(url: string): Promise<Manifest | null> {
  let pending = manifests.get(url)
  if (!pending) {
    pending = getJson<Manifest>(url).catch(() => {
      manifests.delete(url)
      return null
    })
    manifests.set(url, pending)
  }
  return pending
}

/** A manifest label may be a `%key%` into `package.nls.json`. */
function labelOf(label: string | undefined, path: string | undefined, nls: Record<string, string>): string {
  const key = label && /^%(.+)%$/.exec(label)?.[1]
  const resolved = key ? nls[key] : label
  if (resolved && resolved.trim()) return resolved.trim()
  return posix.basename(path ?? 'Theme', '.json').replace(/[-_]?color-?theme$/i, '').replace(/[-_]/g, ' ')
}

interface SearchHit {
  namespace: string
  name: string
  version: string
  displayName?: string
  description?: string
  downloadCount?: number
  verified?: boolean
  deprecated?: boolean
  files?: { download?: string; manifest?: string; icon?: string }
}

/**
 * Open VSX's relevance puts a fork with the query in its description above the
 * original it forked ("Dracula Colorful" over Dracula Official). Hits *named*
 * for the query come first, most-downloaded first — which is the original
 * nearly every time — and the rest keep the registry's order behind them.
 */
function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const named = (hit: SearchHit): boolean =>
    `${hit.displayName ?? ''} ${hit.name}`.toLowerCase().replace(/\s+/g, '').includes(q)
  const first = hits.filter(named).sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0))
  return [...first, ...hits.filter((hit) => !named(hit))].slice(0, 18)
}

/**
 * Extensions in the Themes category matching `query`, keeping only those whose
 * manifest contributes a *color* theme — the category also holds icon themes,
 * which have nothing to import.
 */
export async function searchThemeExtensions(query: string): Promise<ThemeExtension[]> {
  const q = query.trim()
  if (!q) return []
  const params = new URLSearchParams({ query: q, category: 'Themes', size: '24' })
  const { extensions = [] } = await getJson<{ extensions?: SearchHit[] }>(`${API}/-/search?${params}`)
  const rows = await Promise.all(
    rankHits(extensions, q)
      .filter((hit) => !hit.deprecated && hit.files?.download)
      .map(async (hit): Promise<ThemeExtension | null> => {
        // Search hits carry no manifest link; the versioned file path is stable.
        const url =
          hit.files?.manifest ??
          `${API}/${encodeURIComponent(hit.namespace)}/${encodeURIComponent(hit.name)}/${encodeURIComponent(hit.version)}/file/package.json`
        const themes = (await manifest(url))?.contributes?.themes
        if (!Array.isArray(themes) || themes.length === 0) return null
        const id = `${hit.namespace}.${hit.name}`
        downloads.set(id, hit.files!.download!)
        return {
          id,
          namespace: hit.namespace,
          name: hit.name,
          version: hit.version,
          displayName: hit.displayName || hit.name,
          description: hit.description ?? '',
          downloads: hit.downloadCount ?? 0,
          verified: hit.verified === true,
          iconUrl: hit.files?.icon,
          themes: themes.map((theme) => ({
            label: labelOf(theme.label, theme.path, {}),
            appearance: appearanceFromVsCode(theme.uiTheme)
          }))
        }
      })
  )
  return rows.filter((row): row is ThemeExtension => row !== null)
}

/**
 * Every color theme an extension contributes, each with its `include` chain
 * already folded in so the renderer converts one self-contained document.
 */
export function fetchExtensionThemes(id: string): Promise<ThemeExtensionFile[]> {
  // Shared by every caller asking for the same extension, in flight or done:
  // each search downloads its top hits, and the next keystroke's search
  // usually lists the same ones. A failure is not cached, so Retry retries.
  let pending = extensionThemes.get(id)
  if (!pending) {
    pending = downloadExtensionThemes(id)
    pending.catch(() => extensionThemes.delete(id))
    extensionThemes.set(id, pending)
    while (extensionThemes.size > EXTENSION_CACHE) {
      extensionThemes.delete(extensionThemes.keys().next().value!)
    }
  }
  return pending
}

async function downloadExtensionThemes(id: string): Promise<ThemeExtensionFile[]> {
  let url = downloads.get(id)
  if (!url) {
    const [namespace, ...rest] = id.split('.')
    const meta = await getJson<SearchHit>(`${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(rest.join('.'))}`)
    url = meta.files?.download
    if (!url) throw new Error('Open VSX has no download for that extension')
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Open VSX answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_VSIX_BYTES || !response.body) {
    throw new Error('That extension is too large to download')
  }
  // Streamed against the cap: a chunked response declares no length, and
  // `arrayBuffer()` would read all of it before anything could check.
  const chunks: Buffer[] = []
  let received = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_VSIX_BYTES) {
      await reader.cancel()
      throw new Error('That extension is too large to download')
    }
    chunks.push(Buffer.from(value))
  }
  const zip = Buffer.concat(chunks)

  const archive = openZip(zip)
  const read = (path: string): unknown => {
    const buf = archive.read(path)
    if (!buf) return undefined
    try {
      return parseJsonc(buf.toString('utf8'))
    } catch {
      return undefined
    }
  }
  const pkg = read('extension/package.json') as Manifest | undefined
  const nls = (read('extension/package.nls.json') ?? {}) as Record<string, string>
  const themes = pkg?.contributes?.themes ?? []

  const resolve = (path: string, seen: Set<string>): Record<string, unknown> | undefined => {
    if (seen.has(path)) return undefined
    seen.add(path)
    const json = read(path)
    if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
    let theme = json as Record<string, unknown>
    const dir = posix.dirname(path)
    // `tokenColors` may name a file instead of listing rules. A JSON one reads
    // like any other; a `.tmTheme` plist is skipped and the syntax keeps
    // Carbon's own colors.
    if (typeof theme.tokenColors === 'string') {
      const target = posix.join(dir, theme.tokenColors)
      const rules = read(target)
      const list = Array.isArray(rules)
        ? rules
        : rules && typeof rules === 'object' && Array.isArray((rules as { tokenColors?: unknown }).tokenColors)
          ? (rules as { tokenColors: unknown[] }).tokenColors
          : undefined
      theme = { ...theme, tokenColors: list }
    }
    if (typeof theme.include === 'string') {
      const base = resolve(posix.join(dir, theme.include), seen)
      theme = base ? mergeVsCodeThemes(base, theme) : { ...theme, include: undefined }
    }
    return theme
  }

  const out: ThemeExtensionFile[] = []
  for (const entry of themes) {
    if (!entry.path) continue
    const path = posix.join('extension', posix.normalize(entry.path))
    const json = resolve(path, new Set())
    if (!json) continue
    out.push({
      label: labelOf(entry.label, entry.path, nls),
      appearance: appearanceFromVsCode(entry.uiTheme),
      json
    })
  }
  if (out.length === 0) throw new Error('No color themes could be read from that extension')
  return out
}

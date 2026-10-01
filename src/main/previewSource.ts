import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import {
  inlineSourceMap,
  originalPosition,
  sourceMappingUrl,
  sourcePathCandidates,
  type RawSourceMap,
  type StackFrame
} from './sourceMap.ts'

/**
 * A served-module stack frame from the preview, resolved to the file the user
 * edits. See `sourceMap.ts` for why the picker needs this at all (React 19).
 *
 * Only loopback origins are fetched: the frame comes from whatever page the
 * preview shows, and main should not be talked into requesting an arbitrary
 * URL on its behalf. A dev server is the only thing that serves the maps
 * anyway — a production bundle's frame is reported as itself.
 */

export interface ResolvedSource {
  /** Relative to the project when it lives inside it, absolute otherwise. */
  file: string
  line?: number
  column?: number
}

const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.localhost)(:\d+)?\//i

export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK.test(url)
}

type FetchText = (url: string) => Promise<string | null>

/** A source map can be large (a bundle's); anything past this is not one worth reading. */
const MAX_FETCH_BYTES = 32 * 1024 * 1024

/**
 * GETs a loopback URL as text. Redirects are refused rather than followed: the
 * loopback check is made on the URL asked for, and a dev server — or whatever
 * is listening on a local port — redirecting elsewhere would otherwise have
 * main request a LAN or internet address on a page's say-so.
 */
async function defaultFetchText(url: string): Promise<string | null> {
  if (!isLoopbackUrl(url)) return null
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_FETCH_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return null
  }
}

/** Maps are reused across picks of one page; small, and keyed by script URL. */
const mapCache = new Map<string, { at: number; map: { map: RawSourceMap; base: string } | null }>()
const MAP_TTL_MS = 5000

/**
 * The script's map, and the URL its relative `sources` resolve against — the
 * map's own URL, or the script's for an inline map. Vite names a module's
 * source `App.jsx` beside a script served at `/src/App.jsx`, which is only a
 * path once it is resolved there.
 */
async function mapFor(scriptUrl: string, fetchText: FetchText): Promise<{ map: RawSourceMap; base: string } | null> {
  const hit = mapCache.get(scriptUrl)
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return hit.map
  let map: { map: RawSourceMap; base: string } | null = null
  const code = await fetchText(scriptUrl)
  const ref = code ? sourceMappingUrl(code) : null
  if (ref) {
    const inline = inlineSourceMap(ref)
    if (inline) map = { map: inline, base: scriptUrl }
    else {
      let mapUrl: string | null = null
      try {
        mapUrl = new URL(ref, scriptUrl).toString()
      } catch {
        mapUrl = null
      }
      if (mapUrl && isLoopbackUrl(mapUrl)) {
        const text = await fetchText(mapUrl)
        try {
          map = text ? { map: JSON.parse(text) as RawSourceMap, base: mapUrl } : null
        } catch {
          map = null
        }
      }
    }
  }
  mapCache.set(scriptUrl, { at: Date.now(), map })
  if (mapCache.size > 64) mapCache.delete(mapCache.keys().next().value as string)
  return map
}

/** A relative `source` as the URL it names; anything absolute or schemed is left alone. */
function resolveSource(source: string, base: string): string {
  if (source.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(source)) return source
  try {
    return new URL(source, base).toString()
  } catch {
    return source
  }
}

function onDisk(source: string, cwd: string, exists: (p: string) => boolean): string | null {
  for (const candidate of sourcePathCandidates(source, cwd)) {
    if (exists(candidate)) return candidate
  }
  return null
}

function present(abs: string, cwd: string): string {
  const rel = relative(cwd, abs)
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : abs
}

/**
 * Resolves through the script's source map when it has one; otherwise reads
 * the path off the URL and keeps the served line, which is right for an
 * untransformed module and close for a transformed one. Null when nothing on
 * disk matches — a frame in a dependency, or a page from somewhere else.
 */
export async function resolveFrame(
  frame: StackFrame,
  cwd: string,
  deps: { fetchText?: FetchText; exists?: (p: string) => boolean } = {}
): Promise<ResolvedSource | null> {
  const fetchText = deps.fetchText ?? defaultFetchText
  const exists = deps.exists ?? existsSync
  if (isLoopbackUrl(frame.url)) {
    const found = await mapFor(frame.url, fetchText)
    const pos = found ? originalPosition(found.map, frame.line, frame.column) : null
    if (pos) {
      const file = onDisk(resolveSource(pos.source, found!.base), cwd, exists) ?? onDisk(pos.source, cwd, exists)
      if (file) return { file: present(file, cwd), line: pos.line, column: pos.column }
    }
  }
  const file = onDisk(frame.url, cwd, exists)
  if (file) return { file: present(file, cwd), line: frame.line, column: frame.column }
  return null
}

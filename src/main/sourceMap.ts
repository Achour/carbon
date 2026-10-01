/**
 * Just enough source-map reading to turn a stack frame from the preview into
 * the file and line the user wrote.
 *
 * **Why this exists.** The element picker used to read `fiber._debugSource`,
 * which React 19 removed: the JSX transform still passes `fileName` /
 * `lineNumber` to `jsxDEV`, and React drops them on the floor. What a React 19
 * dev fiber carries instead is `_debugStack` — an `Error` captured where the
 * element was created — whose frames point at the *served* module
 * (`http://localhost:5173/src/App.tsx?t=…:7:26`), a line or so off the source
 * after the transform. Every dev server that serves transformed code also
 * serves the map back to the source, so the honest answer is to read it.
 *
 * Handles plain maps and index maps (`sections`, which Turbopack emits).
 * Dependency-free on purpose — `node --test` runs it straight off the `.ts`.
 */

export interface RawSourceMap {
  version?: number
  sources?: (string | null)[]
  sourceRoot?: string
  mappings?: string
  names?: string[]
  sections?: { offset: { line: number; column: number }; map: RawSourceMap }[]
}

export interface OriginalPosition {
  source: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** Decodes one segment's base64 VLQ fields. */
export function decodeVlq(segment: string): number[] {
  const out: number[] = []
  let value = 0
  let shift = 0
  for (const ch of segment) {
    const digit = B64_INDEX.get(ch)
    if (digit === undefined) return out
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return out
}

/**
 * The original position for a 0-based generated line and column in a plain
 * (section-less) map: the last mapping on that line at or before the column,
 * which is how every consumer resolves a column that falls inside a token.
 */
function lookupPlain(map: RawSourceMap, line: number, column: number): OriginalPosition | null {
  const mappings = map.mappings ?? ''
  const sources = map.sources ?? []
  let srcIndex = 0
  let srcLine = 0
  let srcCol = 0
  let genLine = 0
  let best: OriginalPosition | null = null
  // Fields 1–3 are deltas that run on across lines, so every line before the
  // target still has to be decoded; only the target line is searched.
  for (const lineText of mappings.split(';')) {
    if (genLine > line) break
    let genCol = 0
    for (const seg of lineText.split(',')) {
      if (!seg) continue
      const f = decodeVlq(seg)
      genCol += f[0] ?? 0
      // A one-field segment starts an unmapped run: past it, the earlier
      // mapping no longer applies.
      if (f.length === 1 && genLine === line && genCol <= column) best = null
      if (f.length >= 4) {
        srcIndex += f[1]
        srcLine += f[2]
        srcCol += f[3]
        if (genLine === line && genCol <= column) {
          const source = sources[srcIndex]
          if (source != null) best = { source, line: srcLine + 1, column: srcCol + 1 }
        }
      }
    }
    if (genLine === line) break
    genLine++
  }
  if (best && map.sourceRoot && !/^[a-z][a-z0-9+.-]*:/i.test(best.source) && !best.source.startsWith('/')) {
    best = { ...best, source: map.sourceRoot.replace(/\/?$/, '/') + best.source }
  }
  return best
}

/**
 * Original position for a 1-based generated line/column — the convention a V8
 * stack frame uses.
 */
export function originalPosition(map: RawSourceMap, line: number, column: number): OriginalPosition | null {
  const l = line - 1
  const c = Math.max(0, column - 1)
  if (map.sections?.length) {
    let chosen: (typeof map.sections)[number] | undefined
    for (const s of map.sections) {
      const o = s.offset
      if (o.line < l || (o.line === l && o.column <= c)) chosen = s
      else break
    }
    if (!chosen) return null
    const dl = l - chosen.offset.line
    const dc = dl === 0 ? c - chosen.offset.column : c
    return originalPosition(chosen.map, dl + 1, dc + 1)
  }
  return lookupPlain(map, l, c)
}

/**
 * The `sourceMappingURL` a script names — the *last* one, since a bundle can
 * contain the comment inside a string earlier on.
 */
export function sourceMappingUrl(code: string): string | null {
  const re = /\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)/g
  let last: string | null = null
  for (let m = re.exec(code); m; m = re.exec(code)) last = m[1]
  return last
}

/** A `data:` source map decoded, or null if it isn't one. */
export function inlineSourceMap(url: string): RawSourceMap | null {
  const m = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(url)
  if (!m) return null
  try {
    const text = m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2])
    return JSON.parse(text) as RawSourceMap
  } catch {
    return null
  }
}

/** One frame of a V8 stack: `at fn (url:line:col)` or `at url:line:col`. */
export interface StackFrame {
  fn?: string
  url: string
  line: number
  column: number
}

export function parseStackFrame(line: string): StackFrame | null {
  const m = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line)
  if (!m) return null
  return { fn: m[1] || undefined, url: m[2], line: Number(m[3]), column: Number(m[4]) }
}

/**
 * Frames that are React, the bundler or a dependency rather than the user's
 * own code. The first frame of a `_debugStack` that is none of these is where
 * the JSX was written.
 */
export function isLibraryFrame(url: string): boolean {
  return (
    /node_modules|\/\.vite\/deps\/|jsx-dev-runtime|jsx-runtime|react-dom|react-refresh|@react-refresh|\/@vite\/|webpack\/bootstrap|next\/dist|\[turbopack\]|turbopack\/|react-server-dom/i.test(
      url
    ) || !/^(https?|webpack-internal|webpack|file):/i.test(url)
  )
}

/**
 * Where a source-map `source` (or a served module URL) might live on disk,
 * most specific first. Bundlers spell it every way there is —
 * `/abs/path/src/App.tsx`, `webpack://app/./src/App.tsx`,
 * `turbopack:///[project]/src/app/page.tsx`, `http://localhost:5173/src/App.tsx?t=1` —
 * and the reliable common ground is a path *suffix* that exists under the
 * project. The caller checks each candidate against the disk.
 */
export function sourcePathCandidates(source: string, cwd: string): string[] {
  const out: string[] = []
  const root = cwd.replace(/\/+$/, '')
  let s = source.replace(/[?#].*$/, '')
  try {
    s = decodeURI(s)
  } catch {
    // keep it as written
  }
  if (s.startsWith('/') && !s.startsWith('//')) out.push(s)
  if (s.startsWith('file://')) out.push(s.slice('file://'.length))
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') // scheme + host (http://localhost:5173, webpack://app)
    .replace(/^[a-z][a-z0-9+.-]*:/i, '') // a bare scheme (webpack-internal:)
    .replace(/^\/+/, '')
    .replace(/^\([^)]*\)\//, '') // webpack layer: (app-pages-browser)/
    .replace(/^\[project\]\//, '')
    .replace(/^(\.\/)+/, '')
  if (!s) return out
  const segments = s.split('/').filter((p) => p && p !== '.')
  // Down to a directory plus a file name and no further: a bare `index.ts`
  // would match whichever one happens to sit at the project root.
  const last = segments.length === 1 ? 1 : segments.length - 1
  for (let i = 0; i < last; i++) {
    out.push(`${root}/${segments.slice(i).join('/')}`)
  }
  return [...new Set(out)]
}

import * as React from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { Check, Code2, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { nextReveal, revealLimit } from '@/lib/streamReveal'
import { useApp } from '@/store'
import { getImageEpoch, readImageOnce, subscribeImageEpoch } from '@/lib/imageCache'
import {
  HLJS_LANGUAGES,
  highlightCode,
  isMermaidFence,
  languageFromFenceInfo,
  remarkHighlightLang
} from '@/lib/highlight'
import { splitHighlightedLines } from '@/lib/highlightLines'
import { FileIcon } from '@/lib/fileIcon'
import { fileLinkPath, isBareFileLineRef } from '@/lib/fileLink'
import { needsWholeParse, splitMarkdownStream, type OpenFence } from '@/lib/markdownStream'
import {
  explicitMarkdownImageTargets,
  normalizeMarkdownImageTarget
} from '@/lib/markdownImages'

/** Project folder used to resolve relative file paths in inline code. */
const MarkdownCwd = React.createContext<string | null>(null)
/** Explicit `![…](path)` destinations in the whole message, for link dedupe. */
const EMPTY_MARKDOWN_IMAGES: ReadonlySet<string> = new Set()
const ExplicitMarkdownImages = React.createContext<ReadonlySet<string>>(EMPTY_MARKDOWN_IMAGES)

/** Flattens a React node tree to its raw text (for fenced-block source). */
function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (React.isValidElement(node))
    return nodeText((node.props as { children?: React.ReactNode }).children)
  return ''
}

// ---- Mermaid diagrams ----

/**
 * Mermaid is loaded on the first diagram, not at startup.
 *
 * It is ~900 KB with its own dependencies (dompurify, marked, roughjs, a
 * handful of d3 packages) and it was a top-level import in this file, which
 * every message in the transcript renders through — so the parse and evaluation
 * of a diagram engine sat in front of the first paint of every session,
 * including the great majority that never show a diagram. Its *renderers* were
 * already split out (`flowDiagram-…`, `sequenceDiagram-…`); only the core was
 * eager, which is the half that costs.
 *
 * The load rides a path that was already asynchronous and already has a
 * fallback: the effect below debounces 120 ms, and until a diagram parses the
 * block shows its raw source. So a diagram now arrives a chunk-fetch later than
 * it used to, in a state the component already renders correctly, and
 * `preloadMermaid` means that fetch has normally happened long before.
 */
let mermaidModule: Promise<typeof import('mermaid')> | null = null

/** Warm the chunk off the critical path — see `lib/preloadHeavy.ts`. */
export function preloadMermaid(): Promise<typeof import('mermaid')> {
  mermaidModule ??= import('mermaid')
  return mermaidModule
}

async function renderMermaid(id: string, code: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await preloadMermaid()
  // Re-initialized per render, as it was when the import was static: the theme
  // follows the app's appearance, and `initialize` is how mermaid is told.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit'
  })
  const { svg } = await mermaid.render(`${id}-svg`, code)
  return svg
}

const clampScale = (s: number): number => Math.min(6, Math.max(0.2, s))

function LightboxButton({
  onClick,
  label,
  children
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className="rounded-md border border-border bg-popover/90 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** Full-screen, zoom + pan viewer for a rendered diagram, Cursor-style. */
function DiagramLightbox({ svg, onClose }: { svg: string; onClose: () => void }): React.JSX.Element {
  const [scale, setScale] = React.useState(1)
  const [pos, setPos] = React.useState({ x: 0, y: 0 })
  const drag = React.useRef<{ x: number; y: number } | null>(null)
  // Tracks the pointer-down origin so a plain click (no real drag) on the
  // full-screen stage dismisses, while a drag pans instead.
  const down = React.useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reset = (): void => {
    setScale(1)
    setPos({ x: 0, y: 0 })
  }

  const endDrag = (): void => {
    drag.current = null
    down.current = null
    setDragging(false)
  }

  return createPortal(
    <div className="animate-enter fixed inset-0 z-[100] bg-background/85 backdrop-blur-sm">
      {/* Controls sit ABOVE the pan surface (higher z) and outside its pointer
          flow, so they're always clickable — never dragged or intercepted. */}
      <div className="absolute top-4 right-4 z-20 flex gap-1">
        <LightboxButton onClick={() => setScale((s) => clampScale(s + 0.25))} label="Zoom in">
          <ZoomIn className="size-4" />
        </LightboxButton>
        <LightboxButton onClick={() => setScale((s) => clampScale(s - 0.25))} label="Zoom out">
          <ZoomOut className="size-4" />
        </LightboxButton>
        <LightboxButton onClick={reset} label="Reset view">
          <RotateCcw className="size-4" />
        </LightboxButton>
        <LightboxButton onClick={onClose} label="Close  (Esc)">
          <X className="size-4" />
        </LightboxButton>
      </div>
      {/* Pan / zoom surface: fills the screen and stays put (only the diagram
          inside transforms), so it can't drift over the controls. A plain click
          dismisses; a drag pans. */}
      <div
        className={cn(
          'absolute inset-0 flex touch-none items-center justify-center overflow-hidden',
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onWheel={(e) => setScale((s) => clampScale(s - e.deltaY * 0.0015))}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
          down.current = { x: e.clientX, y: e.clientY, moved: false }
          setDragging(true)
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // no active pointer (rare) — dragging still works via the surface
          }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          if (down.current && (Math.abs(e.clientX - down.current.x) > 4 || Math.abs(e.clientY - down.current.y) > 4)) {
            down.current.moved = true
          }
          setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onPointerUp={() => {
          const wasClick = down.current != null && !down.current.moved
          endDrag()
          if (wasClick) onClose()
        }}
        onPointerCancel={endDrag}
      >
        {/* Only this inner element transforms (pan/zoom). The svg fills the box;
            mermaid's viewBox + preserveAspectRatio fit the diagram inside it, and
            max-*-none overrides its inline max-width so it fills the space. Same
            markup as the inline diagram — duplicate ids resolve fine. */}
        <div
          className="h-[88vh] w-[92vw] [&>svg]:!block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-h-none [&>svg]:!max-w-none"
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform 0.12s ease-out'
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body
  )
}

/**
 * Renders a ```mermaid fence as an SVG diagram. While the message is still
 * streaming the source is incomplete and won't parse, so we keep showing the
 * raw code (the pre-existing behavior) until it renders cleanly — no flashing
 * parse errors, and worst case is exactly what we showed before.
 */
function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const isDark = useApp((s) => s.resolvedAppearance === 'dark')
  const rawId = React.useId()
  const id = React.useMemo(() => 'mmd' + rawId.replace(/[^a-zA-Z0-9]/g, ''), [rawId])
  const [svg, setSvg] = React.useState<string | null>(null)
  const [showSource, setShowSource] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    const trimmed = code.trim()
    if (!trimmed) {
      setSvg(null)
      return undefined
    }
    let alive = true
    // Debounce so streaming re-renders don't thrash the (async) mermaid parse.
    const t = setTimeout(() => {
      renderMermaid(id, trimmed, isDark)
        .then((svg) => {
          if (alive) setSvg(svg)
        })
        .catch(() => {
          if (alive) setSvg(null)
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code, isDark, id])

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const viewingSource = showSource || !svg

  return (
    <div className="group relative my-2">
      {viewingSource ? (
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : (
        <div
          className="flex cursor-zoom-in justify-center overflow-auto rounded-lg border border-border bg-card/40 p-3"
          onClick={() => setExpanded(true)}
          title="Click to enlarge"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg && expanded && <DiagramLightbox svg={svg} onClose={() => setExpanded(false)} />}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {svg && !showSource && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-md border border-border bg-popover/90 p-1.5 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
            aria-label="Enlarge diagram"
            title="Enlarge diagram"
          >
            <Maximize2 className="size-3.5" />
          </button>
        )}
        {svg && (
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="rounded-md border border-border bg-popover/90 p-1.5 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
            aria-label={showSource ? 'Show diagram' : 'Show source'}
            title={showSource ? 'Show diagram' : 'Show source'}
          >
            <Code2 className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-border bg-popover/90 p-1.5 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
          aria-label="Copy diagram source"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}

/** A fenced code block with a hover copy button (the non-mermaid path). */
function PreBlock({
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  const [copied, setCopied] = React.useState(false)

  const copy = (): void => {
    const text = ref.current?.textContent ?? ''
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group relative">
      <pre ref={ref} {...props}>
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 rounded-md border border-border bg-popover/90 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

// A `<pre>`'s language flips from non-mermaid to "mermaid" as the info string
// streams in char-by-char, so mermaid vs. non-mermaid MUST be two distinct
// component types (React remounts on type change) — calling hooks after an
// early `return` here would change the hook count mid-stream and crash the
// whole message ("rendered fewer hooks than expected"). Keep CodeBlock
// hook-free: it only picks which child component renders.
function CodeBlock({
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  const child = React.isValidElement(children)
    ? (children as React.ReactElement<{ className?: string }>)
    : null
  const lang = child?.props.className?.match(/language-(\w+)/)?.[1]
  if (isMermaidFence(lang)) {
    return <MermaidBlock code={nodeText(children).replace(/\n+$/, '')} />
  }
  return <PreBlock {...props}>{children}</PreBlock>
}

// ---- Clickable file paths in inline code ----

// Something like `src/routes/_app/index.tsx`, `./a b` excluded: no spaces,
// must end in an extension, may carry a :line(:col) suffix.
const PATHISH = /^\.{0,2}[\w@$][\w.@$/-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

const statCache = new Map<string, Promise<'file' | 'dir' | null>>()
function statOnce(path: string): Promise<'file' | 'dir' | null> {
  let pending = statCache.get(path)
  if (!pending) {
    pending = window.api.statPath(path).catch(() => null)
    statCache.set(path, pending)
  }
  return pending
}

/**
 * Agents usually name a file by its basename alone (`Sidebar.tsx`), which doesn't
 * exist at `<cwd>/Sidebar.tsx`. Fall back to the project file index and link only
 * when exactly one file carries that name — opening the wrong `index.ts` is worse
 * than leaving it unlinked. Cached like `statOnce`, so a transcript repeating a
 * filename costs one round trip rather than one per span.
 */
const lookupCache = new Map<string, Promise<string | null>>()
function lookupOnce(cwd: string, name: string): Promise<string | null> {
  const key = `${cwd}\0${name}`
  let pending = lookupCache.get(key)
  if (!pending) {
    pending = window.api
      .searchFiles(cwd, name)
      .then((res) => {
        const exact = res.filter((r) => r.rel.slice(r.rel.lastIndexOf('/') + 1) === name)
        return exact.length === 1 ? exact[0].path : null
      })
      .catch(() => null)
    lookupCache.set(key, pending)
  }
  return pending
}

/**
 * The **settled** answer for one `cwd` + path pair, as opposed to the caches
 * above, which hold the round trip.
 *
 * Those already spend one request per path, but the hook still resolved through
 * an effect and a microtask, so a chip mounted for the hundredth time drew
 * unresolved for a frame and then became resolved. That was invisible while
 * resolution only changed a cursor and a title; it is a visible jump now that it
 * puts a mark in front of the text — and "Load earlier messages" mounts dozens
 * of already-known chips in one go. Answered during render, so anything asked
 * before paints marked immediately.
 */
const resolvedFiles = new Map<string, string | null>()
const resolvedKey = (cwd: string | null, clean: string): string => `${cwd ?? ''}\0${clean}`

/**
 * A path named in a message, resolved to a file in the project — or null while
 * it is being looked up, and for good if it names nothing.
 *
 * `clean` is a path with any `:line` suffix and leading `./` already off, which
 * is what both callers have: inline code (`counter.ts`) and a Markdown link
 * (`[counter.ts](/abs/counter.ts:1)`, which is how Codex cites a file — see
 * `lib/fileLink.ts`). Sharing the resolution is what makes the two click the
 * same, and the caches above are module-level, so a transcript naming one file
 * both ways still costs one round trip.
 */
function useResolvedFile(clean: string | null): string | null {
  const cwd = React.useContext(MarkdownCwd)
  const key = clean ? resolvedKey(cwd, clean) : null
  const [target, setTarget] = React.useState<string | null>(null)

  React.useEffect(() => {
    setTarget(null)
    if (!key || !clean || resolvedFiles.has(key)) return undefined
    const abs = clean.startsWith('/') ? clean : cwd ? `${cwd}/${clean}` : null
    if (!abs) {
      resolvedFiles.set(key, null)
      return undefined
    }
    let alive = true
    void statOnce(abs)
      .then((kind) => {
        if (kind === 'file') return abs
        // A bare basename that isn't at the project root — search for it.
        if (kind === null && cwd && !clean.includes('/')) return lookupOnce(cwd, clean)
        return null
      })
      .then((found) => {
        resolvedFiles.set(key, found)
        if (alive && found) setTarget(found)
      })
    return () => {
      alive = false
    }
  }, [key, clean, cwd])

  const settled = key ? resolvedFiles.get(key) : null
  return settled !== undefined ? settled : target
}

/**
 * A small mark drawn immediately before the text it labels — a file's language
 * icon inside a resolved `<code>` chip, a site's favicon inside an external
 * link. Both marks say the same thing ("this one goes somewhere"), so they are
 * mounted the same way, and two details are load-bearing rather than cosmetic:
 *
 * - **Tailwind's preflight makes `svg` and `img` block-level.** A mark left at
 *   that default takes a line of its own in the middle of a paragraph, so each
 *   one is put back inline and nudged off the baseline at its call site. Its
 *   height is in `em`, so it tracks the type it sits in rather than a fixed px
 *   that only looks right at one zoom.
 * - **U+2060 WORD JOINER is what keeps the mark glued to the first character.**
 *   An atomic inline is a UAX#14 *contingent break* (LB20 allows a break either
 *   side of it), so without the joiner a chip that lands near the column edge
 *   can leave its icon stranded at the end of the line above with the name
 *   below it. LB11 prohibits a break on either side of a joiner and outranks
 *   LB20, which is why one invisible character does the whole job — where
 *   `white-space: nowrap` would also stop a long path from wrapping at all,
 *   the thing `overflow-wrap: anywhere` on the base `code` rule exists to allow.
 *   `select-none` keeps that character out of what the reader copies: a
 *   filename pasted into a shell has to be the filename.
 */
function LeadingMark({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="select-none">
      {children}
      {'\u2060'}
    </span>
  )
}

function InlineCode({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  const text =
    typeof children === 'string'
      ? children
      : Array.isArray(children) && children.every((c) => typeof c === 'string')
        ? children.join('')
        : null
  // Fenced blocks carry a language class and multi-line text — skip those.
  const candidate =
    text && !className?.includes('language-') && !text.includes('\n') && text.length < 240 && PATHISH.test(text)
      ? text
      : null

  const target = useResolvedFile(
    React.useMemo(
      () => (candidate ? candidate.replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '') : null),
      [candidate]
    )
  )

  if (target) {
    return (
      <code
        {...props}
        className={cn(className, 'cursor-pointer underline-offset-2 hover:text-primary hover:underline')}
        title={`Open ${target}`}
        onClick={() => void useApp.getState().openFile(target, { preview: true })}
      >
        {/* Only on a *resolved* path: the mark is what says this opens, and one
            on a name that resolves to nothing promises a click that does
            nothing. Drawn from `target` rather than the span's text, so a bare
            basename found through the file index is marked by the file it
            actually opens. */}
        <LeadingMark>
          <FileIcon
            path={target}
            className="mr-[0.3em] inline-block size-[1.15em] align-[-0.22em]"
          />
        </LeadingMark>
        {children}
      </code>
    )
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

// ---- Inline images from local file paths ----

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

// The cache/epoch primitive lives in a dependency-free lib (unit-tested, and
// importable by the store without a cycle). Here we bind it to the IPC reader.
const readLocalImage = (abs: string): Promise<string | null> =>
  readImageOnce(abs, (p) => window.api.readFile(p).then((c) => (c.kind === 'image' ? c.dataUri : null)))

function resolveLocalPath(src: string, cwd: string | null): string | null {
  let p = src.trim()
  if (/^(https?:|data:)/i.test(p)) return null
  if (p.startsWith('file://')) p = p.slice('file://'.length)
  try {
    p = decodeURIComponent(p)
  } catch {
    // keep the raw path
  }
  if (p.startsWith('/')) return p
  return cwd ? `${cwd}/${p.replace(/^\.\//, '')}` : null
}

/**
 * An image an agent referenced by a local file path in its markdown — e.g. one
 * Codex's image-generation skill just saved (it reports `[name](/abs/path.png)`,
 * the image never comes through the event stream as data). The renderer can't
 * load a bare filesystem path, so resolve it to a data URI over IPC and show it
 * inline; click to open it full-size. Falls back to the original link/text if it
 * isn't a readable image.
 */
function LocalImage({
  src,
  alt,
  fallback
}: {
  src: string
  alt?: string
  fallback: React.ReactNode
}): React.JSX.Element {
  const cwd = React.useContext(MarkdownCwd)
  const abs = React.useMemo(() => resolveLocalPath(src, cwd), [src, cwd])
  const epoch = React.useSyncExternalStore(subscribeImageEpoch, getImageEpoch)
  const [uri, setUri] = React.useState<string | null>(null)

  // Blank immediately when the *path* changes (show nothing for the new src until
  // it loads). An epoch bump (a turn rewrote files) refreshes in place below
  // without first blanking the current image, so there's no flash on every turn.
  React.useEffect(() => {
    setUri(null)
  }, [abs])

  React.useEffect(() => {
    if (!abs) return undefined
    let alive = true
    void readLocalImage(abs).then((u) => {
      if (alive) setUri(u)
    })
    return () => {
      alive = false
    }
  }, [abs, epoch])

  if (!uri) return <>{fallback}</>
  return (
    <img
      src={uri}
      alt={alt ?? ''}
      title={abs ?? undefined}
      // Full-window, not a tab: the tab is the narrowest column on screen and
      // had no zoom, so "show me that bigger" produced something smaller.
      onClick={() => abs && useApp.getState().openLightbox({ kind: 'file', path: abs })}
      className="my-2 max-h-96 cursor-zoom-in rounded-lg border border-border object-contain"
    />
  )
}

// ---- Site marks on external links ----

/**
 * The favicon for an external link, cached per **origin** — a transcript citing
 * github.com eight times must cost one round trip, not eight. Same shape as
 * `statOnce` / `lookupOnce` above, nulls included: a site with no mark we could
 * fetch is the ordinary case rather than a miss worth retrying, and re-asking
 * per link would turn a single mention into one request per citation.
 *
 * The fetch itself lives in main (`main/favicons.ts`) and answers a `data:`
 * URI, so nothing here touches the network and the site learns nothing about
 * the reader's window. A `data:` image draws in this renderer for free —
 * there is no CSP anywhere in the app (no `<meta>`, no `onHeadersReceived`),
 * which is what `LocalImage` above has always relied on.
 */
const faviconCache = new Map<string, Promise<string | null>>()
/** The settled answers, so a re-mounted link draws its mark in the first paint. */
const faviconSettled = new Map<string, string | null>()
function faviconOnce(origin: string): Promise<string | null> {
  let pending = faviconCache.get(origin)
  if (!pending) {
    pending = window.api.favicon(origin).catch(() => null)
    faviconCache.set(origin, pending)
    void pending.then((uri) => faviconSettled.set(origin, uri))
  }
  return pending
}

/**
 * The origin of an `http(s)` destination, and null for everything else — a
 * `mailto:`, a local path that resolved to nothing, a destination the sanitizer
 * blanked. Keying on the origin rather than the href is the whole point of the
 * cache: eight links into one site are one lookup.
 */
function externalOrigin(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null
  try {
    return new URL(href).origin
  } catch {
    return null
  }
}

/**
 * Origins whose mark is a dark monochrome glyph on transparency.
 *
 * **A favicon is drawn for the site's own background, not for ours.** GitHub's
 * `/favicon.ico` is a black Octocat on a transparent field — correct on their
 * white page, and on Carbon's dark one an invisible mark leaving a gap in the
 * sentence where a mark should be. It is not a rare shape either: a
 * single-colour glyph on transparency is the house style for developer sites,
 * which is most of what an agent cites.
 *
 * So the mark is *measured* rather than trusted, once per origin, and inverted
 * only in dark mode and only when all three hold: it is essentially unsaturated
 * (inverting a colour would be vandalism), it is dark on average, and it has
 * real transparency. That last one is what keeps a filled black tile — a logo
 * whose square *is* the design — from being turned into a white one; it stays
 * as drawn, which is the site's own answer even if it reads quietly here.
 *
 * The alternative was to prefer the `<link rel="icon">` the page declares,
 * which for GitHub is an SVG that answers `prefers-color-scheme`. It costs an
 * HTML fetch per origin — `main/faviconCache.ts` asks for `/favicon.ico` first
 * precisely so most sites cost one request — and it only helps sites that
 * bothered to publish a dark variant. Measuring what we already hold costs one
 * 16×16 decode and covers every site.
 */
const faviconInkDark = new Map<string, boolean>()

function classifyInk(origin: string, uri: string): Promise<boolean> {
  const known = faviconInkDark.get(origin)
  if (known !== undefined) return Promise.resolve(known)
  return new Promise<boolean>((resolve) => {
    const done = (dark: boolean): void => {
      faviconInkDark.set(origin, dark)
      resolve(dark)
    }
    const img = new Image()
    img.onload = () => {
      try {
        const n = 16
        const canvas = document.createElement('canvas')
        canvas.width = n
        canvas.height = n
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return done(false)
        ctx.drawImage(img, 0, 0, n, n)
        // A `data:` URI is same-origin, so this never taints the canvas.
        const { data } = ctx.getImageData(0, 0, n, n)
        let visible = 0
        let clear = 0
        let luma = 0
        let saturation = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 32) {
            clear++
            continue
          }
          visible++
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          luma += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          // **Mean, not max.** The peak saturation of a black glyph is not
          // zero: antialiasing along a curve leaves a handful of faintly
          // coloured pixels, and GitHub's Octocat measures 0.21 that way — so
          // a max-based test called the blackest icon on the web "coloured"
          // and left it invisible. Averaged over what is actually drawn, the
          // same mark is ~0.01 and a genuinely coloured one stays far above.
          saturation += max === 0 ? 0 : (max - min) / max
        }
        done(
          visible > 0 &&
            clear / (n * n) > 0.15 &&
            saturation / visible < 0.12 &&
            luma / visible < 0.35
        )
      } catch {
        done(false)
      }
    }
    img.onerror = () => done(false)
    img.src = uri
  })
}

/**
 * The site's mark — null while it loads, and for good if the site has none —
 * and whether it needs inverting to be visible on a dark ground.
 * A known origin is answered during render (see `resolvedFiles` above for why
 * one frame matters once resolution draws something).
 */
function useFavicon(origin: string | null): { uri: string | null; inkDark: boolean } {
  const [uri, setUri] = React.useState<string | null>(null)
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    setUri(null)
    if (!origin) return undefined
    let alive = true
    void faviconOnce(origin).then((u) => {
      if (!alive) return
      if (!faviconSettled.has(origin)) setUri(u)
      // Measured after the fetch settles rather than at draw time: the verdict
      // decides how the mark is painted, so a link mounting later must have it
      // in hand for its first paint rather than flashing the wrong one.
      if (u && faviconInkDark.get(origin) === undefined) {
        void classifyInk(origin, u).then(() => {
          if (alive) bump()
        })
      }
    })
    return () => {
      alive = false
    }
  }, [origin])
  const settled = origin ? faviconSettled.get(origin) : null
  return {
    uri: settled !== undefined ? settled : uri,
    inkDark: !!origin && faviconInkDark.get(origin) === true
  }
}

const components = {
  pre: CodeBlock,
  code: InlineCode,
  // The wrapper is the table's frame *and* its scroller, and it has to be both.
  // `display: block` + `overflow-x: auto` on the <table> itself is the usual
  // trick and it is what squeezed the columns: a block box takes the
  // container's width, so the table layout had no room to size a column to its
  // content and pushed the overflow down into the cells instead — which is
  // where the mid-path breaks came from. A border on that element would then
  // scroll away with the content it is meant to contain. Wrapped, the table
  // stays a table and the border stays put. See `.markdown table` in index.css.
  table: ({ children }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const s = typeof src === 'string' ? src : ''
    const a = typeof alt === 'string' ? alt : ''
    if (/^(https?:|data:)/i.test(s)) {
      // No file behind this one, so the lightbox gets the src itself. Named by
      // the alt text where there is one, since a `data:` URI has no file name
      // and a remote one's last segment is often a hash.
      const fromUrl = /^data:/i.test(s) ? '' : (s.split(/[?#]/)[0].split('/').pop() ?? '')
      const name = a || fromUrl || 'Image'
      return (
        <img
          src={s}
          alt={a}
          onClick={() => useApp.getState().openLightbox({ kind: 'data', src: s, name })}
          className="my-2 max-h-96 cursor-zoom-in rounded-lg border border-border object-contain"
        />
      )
    }
    return <LocalImage src={s} alt={a || undefined} fallback={a || null} />
  },
  a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const h = href ?? ''
    const explicitImages = React.useContext(ExplicitMarkdownImages)
    // A link whose target is a local image file (Codex writes `[file](path.png)`)
    // renders as the image itself, with the link kept as the fallback. If an
    // explicit image already displays this exact file, keep this as a normal
    // link — upgrading both is how one screenshot became two identical rows.
    const isImage =
      !!h &&
      !/^https?:\/\//i.test(h) &&
      IMAGE_EXT.test(h.split(/[?#]/)[0]) &&
      !explicitImages.has(normalizeMarkdownImageTarget(h))
    // Every other local-file destination opens the file, the way the same path
    // does in inline code. This is how a Codex citation becomes clickable.
    const target = useResolvedFile(
      React.useMemo(() => (isImage ? null : fileLinkPath(h)), [h, isImage])
    )
    // The site's mark, for the plain external branch at the bottom only — a
    // local file opens a tab rather than a destination, and there is no site to
    // name. Both hooks run before every return: a link that turns out to be an
    // image still has to call them, in this order. A link whose whole content
    // is an image (`[![shot](x.png)](https://…)`) is skipped too — "before the
    // link text" presumes there is text.
    const { uri: favicon, inkDark } = useFavicon(
      nodeText(children).trim() ? externalOrigin(h) : null
    )
    // The *URI* that failed to decode, not a flag: a reconciled instance
    // pointing at another site must not stay blank because the last one did.
    const [badFavicon, setBadFavicon] = React.useState<string | null>(null)
    if (isImage) {
      return (
        <LocalImage
          src={h}
          alt={nodeText(children)}
          fallback={
            <a {...props} href={h} target="_blank" rel="noreferrer">
              {children}
            </a>
          }
        />
      )
    }
    if (target) {
      // Deliberately no `href`: it is a tab in this window, not a destination.
      // A path left in `href` navigates the whole renderer away on a middle
      // click — the app replaced by a file — and `preventDefault` on `onClick`
      // never sees that gesture.
      return (
        <a
          {...props}
          className={cn(props.className, 'cursor-pointer')}
          title={`Open ${target}`}
          onClick={() => void useApp.getState().openFile(target, { preview: true })}
        >
          {children}
        </a>
      )
    }
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {/* Nothing at all while it loads, when the site has none, and when the
            bytes don't decode — an unmarked link is what a link already looks
            like, so there is no placeholder to leave behind and no gap to
            close. */}
        {favicon && favicon !== badFavicon ? (
          <LeadingMark>
            <img
              src={favicon}
              alt=""
              aria-hidden
              onError={() => setBadFavicon(favicon)}
              className={cn(
                'mr-[0.3em] inline-block size-[1.05em] rounded-[2px] object-contain align-[-0.18em]',
                // Dark mode only: on a light ground the mark is already right,
                // and it is the site's own drawing wherever it can be.
                inkDark && 'dark:invert'
              )}
            />
          </LeadingMark>
        ) : null}
        {children}
      </a>
    )
  }
}

// Stable plugin arrays — hoisted so they aren't re-created on every render.
// Typed via ReactMarkdown's own prop types to stay exactly compatible.
const REMARK_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  remarkHighlightLang
]
// A user's typed newlines are meaningful — they wrote the prompt in a box, not
// as a document — so their messages parse with hard breaks on. Assistant output
// is authored markdown and keeps the standard collapsing behaviour.
const REMARK_PLUGINS_BREAKS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  ...(REMARK_PLUGINS ?? []),
  remarkBreaks
]
// `languages` is passed explicitly so the finished parse and the streaming
// fence share one grammar set (see HLJS_LANGUAGES). Left to its default this
// is lowlight's `common`, which is *almost* the same list — and "almost" is
// the failure: `dockerfile` would highlight while streaming and go plain the
// moment the turn ended.
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { ignoreMissing: true, detect: false, languages: HLJS_LANGUAGES }]
]

/**
 * The default sanitizer, plus the one destination it blanks that names a file:
 * a root-level `counter.ts:12` reads as the scheme `counter.ts` to it. See
 * `isBareFileLineRef` — nothing else is added back.
 */
const URL_TRANSFORM: React.ComponentProps<typeof ReactMarkdown>['urlTransform'] = (url) =>
  defaultUrlTransform(url) || (isBareFileLineRef(url) ? url : '')

/** One parsed markdown fragment, no wrapper — chunks share a single wrapper div. */
const MarkdownBody = React.memo(function MarkdownBody({
  text,
  breaks = false
}: {
  text: string
  breaks?: boolean
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? REMARK_PLUGINS_BREAKS : REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={URL_TRANSFORM}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

export const Markdown = React.memo(function Markdown({
  text,
  cwd = null,
  className,
  breaks = false
}: {
  text: string
  cwd?: string | null
  className?: string
  /** Treat single newlines as line breaks. See `REMARK_PLUGINS_BREAKS`. */
  breaks?: boolean
}): React.JSX.Element {
  const explicitImages = React.useMemo(() => explicitMarkdownImageTargets(text), [text])
  return (
    <div className={cn('markdown text-[14px] leading-[1.6]', className)}>
      <MarkdownCwd.Provider value={cwd}>
        <ExplicitMarkdownImages.Provider value={explicitImages}>
          <MarkdownBody text={text} breaks={breaks} />
        </ExplicitMarkdownImages.Provider>
      </MarkdownCwd.Provider>
    </div>
  )
})

/**
 * Once the text has been still for this long the stream is idle — a lull between
 * deltas, or the turn ending — so the trailing word stops being held back.
 */
const IDLE_MS = 400

/**
 * Paces a streaming string onto the screen, revealing it a word at a time across
 * animation frames rather than jumping to the latest value on a timer.
 *
 * The throttle this replaced committed at most every 120ms, and each commit
 * showed everything that had arrived since — so at a normal generation rate the
 * reader got five or six words at once, eight times a second, however smoothly
 * the model was actually producing them. See `lib/streamReveal.ts` for the
 * drain, the word-atomic step and why both are shaped that way.
 *
 * **The frame loop stops when it is caught up.** It is re-armed by the next
 * `text` change rather than spinning at 60fps over an empty backlog, which is
 * what a lull between deltas mostly is. Re-renders therefore land at roughly the
 * rate words arrive, not the frame rate: the step runs forward to a word
 * boundary, so a frame that advances is a frame with a word to show.
 *
 * It starts fully revealed, so a block that mounts mid-turn — a chat reopened,
 * a remount — shows what is already there instead of replaying it as a
 * typewriter. Only growth from that point on is paced.
 */
export function useStreamText(text: string, streaming: boolean): string {
  const latestRef = React.useRef(text)
  const shownLenRef = React.useRef(text.length)
  const grownAtRef = React.useRef(0)
  const frameRef = React.useRef<number | null>(null)
  const lastFrameRef = React.useRef(0)
  const [shown, setShown] = React.useState(text)
  if (text !== latestRef.current) {
    latestRef.current = text
    grownAtRef.current = performance.now()
  }

  const tick = React.useCallback((now: number) => {
    frameRef.current = null
    const latest = latestRef.current
    // A part is not only appended to: `reconcileAssistant` replaces it wholesale
    // when the final message lands, and a shorter replacement would otherwise
    // leave the cursor past the end.
    const shownLen = Math.min(shownLenRef.current, latest.length)
    const hold = now - grownAtRef.current < IDLE_MS
    const limit = revealLimit(latest, hold)
    // Clamp the delta: a backgrounded window fires its first frame minutes
    // later, and an unclamped elapsed would reveal the backlog in one jump —
    // the exact behaviour this replaced.
    const elapsed = Math.min(now - lastFrameRef.current, 64)
    lastFrameRef.current = now
    const next = nextReveal(latest, shownLen, limit, elapsed)
    if (next !== shownLenRef.current) {
      shownLenRef.current = next
      setShown(latest.slice(0, next))
    }
    // Keep going only while there is something to show — including the case
    // where `hold` is about to expire and free the trailing word.
    if (next < latest.length) frameRef.current = requestAnimationFrame(tick)
  }, [])

  React.useEffect(() => {
    if (!streaming) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      shownLenRef.current = text.length
      setShown(text)
      return
    }
    if (frameRef.current === null && shownLenRef.current < text.length) {
      lastFrameRef.current = performance.now()
      frameRef.current = requestAnimationFrame(tick)
    }
  }, [text, streaming, tick])

  React.useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  return streaming ? shown : text
}

const NO_CHUNKS: string[] = []

/**
 * An assistant's prose, streaming or settled — **one component, and one tree,
 * for both states.**
 *
 * While the text streams, the sealed prefix (blocks that can no longer change)
 * renders through memoized `MarkdownBody` chunks so each commit re-parses only
 * the small live tail, and an open code fence skips the markdown parse
 * entirely (`StreamingCode`). Everything renders into one `.markdown` wrapper,
 * so block margins behave exactly as a single parse would.
 *
 * It used to be two components — this one while streaming and plain
 * `<Markdown>` once settled — and the swap was the last visible seam in a
 * reply. A different component type is a different React subtree, so the
 * moment a text stopped being live its whole DOM was torn down and rebuilt: a
 * full re-parse and re-highlight of everything it held, a diagram blanked to
 * its source for a beat, an image back to its fallback until the cache
 * answered. On Claude that fired when the *next* message opened; on Codex,
 * whose turn is one accumulating message, it fired every time a tool call
 * landed after a paragraph — mid-turn, several times a reply. Keeping the
 * chunked tree for settled text makes the settle a no-op for React: the chunk
 * strings are the same strings, so every memoized body is skipped.
 *
 * What that gives up is the single whole-text parse that resolved a link or
 * footnote *reference* against a definition in another chunk, so a settled
 * text that carries one falls back to the whole parse (`needsWholeParse`) —
 * the old behaviour, for the one case that needs it.
 */
export const AssistantMarkdown = React.memo(function AssistantMarkdown({
  text,
  cwd = null,
  className,
  streaming
}: {
  text: string
  cwd?: string | null
  className?: string
  /** Still receiving deltas: pace the reveal and hold the arriving word. */
  streaming: boolean
}): React.JSX.Element {
  const shown = useStreamText(text, streaming)
  // Streaming markdown is deliberately parsed in stable chunks so a new word
  // never rescans a long answer. Preserve that property here: duplicate-link
  // cleanup matters once the answer settles, not while its syntax is incomplete.
  const explicitImages = React.useMemo(
    () => (streaming ? EMPTY_MARKDOWN_IMAGES : explicitMarkdownImageTargets(shown)),
    [shown, streaming]
  )
  const { chunks, tail, code } = React.useMemo(() => {
    if (!streaming && needsWholeParse(shown)) return { chunks: NO_CHUNKS, tail: shown, code: null }
    const split = splitMarkdownStream(shown)
    // A `mermaid` fence is a diagram, not code: `MermaidBlock` renders the last
    // source that parsed and keeps it while the rest streams in, so it has to
    // go on being the markdown parse's problem. Its sources are a few lines,
    // which is why handing it back costs nothing.
    if (split.code && isMermaidFence(split.code.info)) {
      return { ...split, tail: split.tail + split.code.open + split.code.body, code: null }
    }
    return split
  }, [shown, streaming])
  return (
    <div className={cn('markdown text-[14px] leading-[1.6]', className)}>
      <MarkdownCwd.Provider value={cwd}>
        <ExplicitMarkdownImages.Provider value={explicitImages}>
          {chunks.map((chunk, i) => (
            <MarkdownBody key={i} text={chunk} />
          ))}
          <MarkdownBody text={tail} />
          {code && <StreamingCode fence={code} />}
        </ExplicitMarkdownImages.Provider>
      </MarkdownCwd.Provider>
    </div>
  )
})

/** One line of a streaming code block: a stable string, so React skips it. */
const CodeLine = React.memo(function CodeLine({ html }: { html: string }): React.JSX.Element {
  return <span dangerouslySetInnerHTML={{ __html: html }} />
})

/**
 * The live, still-open fenced code block at the end of a streaming message —
 * and, once the message settles, a fence the model never closed, which
 * CommonMark also runs to the end of the document.
 *
 * An open fence can never seal (nothing inside one is a block boundary), so
 * left to the markdown path it is the whole tail: remark re-parses it,
 * rehype-highlight re-tokenizes it and React rebuilds every token span on each
 * commit — measured at 400 lines, that is the worst freeze in a streaming turn
 * by a wide margin. Here the body skips the markdown parse entirely (a fence's
 * content is opaque text by definition) and is drawn as one memoized row per
 * line, so a commit touches the line being typed and the one above it rather
 * than the whole block.
 *
 * It renders through `PreBlock`, the same wrapper the closed fence gets from
 * rehype-highlight, so the handover when the closing fence finally arrives is
 * invisible *structurally* rather than by two copies of the chrome being kept
 * in step by hand. Both sides resolve the language through
 * `languageFromFenceInfo`, for the same reason.
 */
function StreamingCode({ fence }: { fence: OpenFence }): React.JSX.Element {
  const lang = languageFromFenceInfo(fence.info)
  const rows = React.useMemo(() => {
    const lines = splitHighlightedLines(highlightCode(fence.body, lang))
    // The body's trailing newline leaves an empty last line — that is where the
    // next characters will land, not a line of the file, and drawing it makes
    // the block jump a row taller between every line and the next.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    // The break lives in the row's own text so a copy reproduces it; the last
    // row has none, which is what keeps the block exactly as tall as the code.
    for (let i = 0; i < lines.length - 1; i++) lines[i] += '\n'
    return lines
  }, [fence.body, lang])

  return (
    <PreBlock>
      <code className={cn('hljs', lang && `language-${lang}`)}>
        {rows.map((html, i) => (
          <CodeLine key={i} html={html} />
        ))}
      </code>
    </PreBlock>
  )
}

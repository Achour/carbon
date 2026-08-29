import * as React from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
import { Check, Code2, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { getImageEpoch, readImageOnce, subscribeImageEpoch } from '@/lib/imageCache'
import {
  highlightCode,
  isMermaidFence,
  languageFromFenceInfo,
  remarkHighlightLang
} from '@/lib/highlight'
import { splitHighlightedLines } from '@/lib/highlightLines'
import { splitMarkdownStream, type OpenFence } from '@/lib/markdownStream'

/** Project folder used to resolve relative file paths in inline code. */
const MarkdownCwd = React.createContext<string | null>(null)

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

function initMermaid(dark: boolean): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit'
  })
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
      initMermaid(isDark)
      mermaid
        .render(`${id}-svg`, trimmed)
        .then(({ svg }) => {
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

function InlineCode({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  const cwd = React.useContext(MarkdownCwd)
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

  const [target, setTarget] = React.useState<string | null>(null)

  React.useEffect(() => {
    setTarget(null)
    if (!candidate) return undefined
    const clean = candidate.replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '')
    const abs = clean.startsWith('/') ? clean : cwd ? `${cwd}/${clean}` : null
    if (!abs) return undefined
    let alive = true
    void statOnce(abs)
      .then((kind) => {
        if (kind === 'file') return abs
        // A bare basename that isn't at the project root — search for it.
        if (kind === null && cwd && !clean.includes('/')) return lookupOnce(cwd, clean)
        return null
      })
      .then((found) => {
        if (alive && found) setTarget(found)
      })
    return () => {
      alive = false
    }
  }, [candidate, cwd])

  if (target) {
    return (
      <code
        {...props}
        className={cn(className, 'cursor-pointer underline-offset-2 hover:text-primary hover:underline')}
        title={`Open ${target}`}
        onClick={() => void useApp.getState().openFile(target, { preview: true })}
      >
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
      onClick={() => abs && useApp.getState().openLightbox(abs)}
      className="my-2 max-h-96 cursor-zoom-in rounded-lg border border-border object-contain"
    />
  )
}

const components = {
  pre: CodeBlock,
  code: InlineCode,
  img: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const s = typeof src === 'string' ? src : ''
    const a = typeof alt === 'string' ? alt : ''
    if (/^(https?:|data:)/i.test(s)) {
      return (
        <img
          src={s}
          alt={a}
          className="my-2 max-h-96 rounded-lg border border-border object-contain"
        />
      )
    }
    return <LocalImage src={s} alt={a || undefined} fallback={a || null} />
  },
  a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const h = href ?? ''
    // A link whose target is a local image file (Codex writes `[file](path.png)`)
    // renders as the image itself, with the link kept as the fallback.
    if (h && !/^https?:\/\//i.test(h) && IMAGE_EXT.test(h.split(/[?#]/)[0])) {
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
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer">
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
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { ignoreMissing: true, detect: false }]
]

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
  return (
    <div className={cn('markdown text-[14px] leading-[1.6]', className)}>
      <MarkdownCwd.Provider value={cwd}>
        <MarkdownBody text={text} breaks={breaks} />
      </MarkdownCwd.Provider>
    </div>
  )
})

const STREAM_RENDER_MS = 120

/**
 * Commit-throttles a streaming string: re-renders at most every
 * STREAM_RENDER_MS while `streaming`, and passes the latest text straight
 * through (cancelling any pending commit) once it ends.
 */
export function useStreamText(text: string, streaming: boolean): string {
  const latestRef = React.useRef(text)
  const lastCommitRef = React.useRef(performance.now())
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shown, setShown] = React.useState(text)
  latestRef.current = text

  React.useEffect(() => {
    if (!streaming) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setShown(text)
      return
    }
    const elapsed = performance.now() - lastCommitRef.current
    if (elapsed >= STREAM_RENDER_MS) {
      lastCommitRef.current = performance.now()
      setShown(text)
      return
    }
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        lastCommitRef.current = performance.now()
        setShown(latestRef.current)
      }, STREAM_RENDER_MS - elapsed)
    }
  }, [text, streaming])

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    []
  )

  return streaming ? shown : text
}

/**
 * Markdown parsing and syntax highlighting are intentionally capped while text
 * streams, and the sealed prefix of the message (blocks that can no longer
 * change) renders through memoized MarkdownBody chunks so each commit only
 * re-parses the small live tail instead of the whole accumulated message.
 * Everything renders into one `.markdown` wrapper, so block margins behave
 * exactly as a single parse. The turn's end swaps in plain <Markdown> (see
 * AssistantBlock), whose single full-text parse also resolves any link or
 * footnote references that spanned a chunk boundary while streaming.
 */
export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  text,
  cwd = null,
  className
}: {
  text: string
  cwd?: string | null
  className?: string
}): React.JSX.Element {
  const shown = useStreamText(text, true)
  const { chunks, tail, code } = React.useMemo(() => {
    const split = splitMarkdownStream(shown)
    // A `mermaid` fence is a diagram, not code: `MermaidBlock` renders the last
    // source that parsed and keeps it while the rest streams in, so it has to
    // go on being the markdown parse's problem. Its sources are a few lines,
    // which is why handing it back costs nothing.
    if (split.code && isMermaidFence(split.code.info)) {
      return { ...split, tail: split.tail + split.code.open + split.code.body, code: null }
    }
    return split
  }, [shown])
  return (
    <div className={cn('markdown text-[14px] leading-[1.6]', className)}>
      <MarkdownCwd.Provider value={cwd}>
        {chunks.map((chunk, i) => (
          <MarkdownBody key={i} text={chunk} />
        ))}
        <MarkdownBody text={tail} />
        {code && <StreamingCode fence={code} />}
      </MarkdownCwd.Provider>
    </div>
  )
})

/** One line of a streaming code block: a stable string, so React skips it. */
const CodeLine = React.memo(function CodeLine({ html }: { html: string }): React.JSX.Element {
  return <span dangerouslySetInnerHTML={{ __html: html }} />
})

/**
 * The live, still-open fenced code block at the end of a streaming message.
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

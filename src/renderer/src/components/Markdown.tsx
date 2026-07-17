import * as React from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
import { Check, Code2, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { getImageEpoch, readImageOnce, subscribeImageEpoch } from '@/lib/imageCache'

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
  if (lang === 'mermaid') {
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
    void statOnce(abs).then((kind) => {
      if (alive && kind === 'file') setTarget(abs)
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
      onClick={() => abs && void useApp.getState().openFile(abs, { preview: true })}
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

export const Markdown = React.memo(function Markdown({
  text,
  cwd = null,
  className
}: {
  text: string
  cwd?: string | null
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('markdown text-[14px] leading-[1.6]', className)}>
      <MarkdownCwd.Provider value={cwd}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: false }]]}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </MarkdownCwd.Provider>
    </div>
  )
})

const STREAM_RENDER_MS = 120

/**
 * Markdown parsing and syntax highlighting are intentionally capped while text
 * streams. The latest text is always shown immediately when streaming ends.
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
  const latestRef = React.useRef(text)
  const lastCommitRef = React.useRef(performance.now())
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shown, setShown] = React.useState(text)
  latestRef.current = text

  React.useEffect(() => {
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
  }, [text])

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    []
  )

  return <Markdown text={shown} cwd={cwd} className={className} />
})

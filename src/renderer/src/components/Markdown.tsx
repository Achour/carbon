import * as React from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
import { Check, Code2, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { THEMES } from '@/lib/themes'

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

  return createPortal(
    <div
      className="animate-enter fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 z-10 flex gap-1" onClick={(e) => e.stopPropagation()}>
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
      <div
        className={cn(
          // A definite box the svg fills; mermaid's viewBox + preserveAspectRatio
          // then fits the diagram inside it (a `w-fit` box + `w-auto` svg gave a
          // width="100%" svg nothing to resolve against, so it collapsed to 0).
          // max-*-none overrides mermaid's inline `max-width` so it fills the box.
          'flex h-[88vh] w-[92vw] items-center justify-center [&>svg]:!block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-h-none [&>svg]:!max-w-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        )}
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transition: dragging ? 'none' : 'transform 0.12s ease-out'
        }}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => setScale((s) => clampScale(s - e.deltaY * 0.0015))}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
          down.current = { x: e.clientX, y: e.clientY, moved: false }
          setDragging(true)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          if (down.current && (Math.abs(e.clientX - down.current.x) > 4 || Math.abs(e.clientY - down.current.y) > 4)) {
            down.current.moved = true
          }
          setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onPointerUp={() => {
          drag.current = null
          setDragging(false)
          // A plain click on the full-screen stage dismisses (like a backdrop);
          // a drag just panned, so leave it open.
          if (down.current && !down.current.moved) onClose()
          down.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
          down.current = null
          setDragging(false)
        }}
        // Same markup as the inline diagram — duplicate ids are fine here (markers,
        // clip-paths and mermaid's scoped `<style>#id…` all still resolve), and
        // rewriting the id would orphan those internal style selectors.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
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
  const theme = useApp((s) => s.theme)
  const isDark = React.useMemo(
    () => THEMES.find((t) => t.id === theme)?.appearance !== 'light',
    [theme]
  )
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

const components = {
  pre: CodeBlock,
  code: InlineCode,
  a: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
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

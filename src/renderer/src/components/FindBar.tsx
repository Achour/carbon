import * as React from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'

// Names for the two Custom Highlights we register on the document: every match,
// plus the currently-focused one on top.
const ALL = 'kb-find'
const ACTIVE = 'kb-find-active'
const MAX_MATCHES = 2000

// The CSS Custom Highlight API isn't in every TS lib.dom; reach it defensively.
type HighlightRegistry = {
  set(name: string, hl: object): void
  delete(name: string): void
}
type HighlightCtor = new (...ranges: Range[]) => object
const registry = (): HighlightRegistry | undefined =>
  (CSS as unknown as { highlights?: HighlightRegistry }).highlights
const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight

/** The editor content region (file/diff viewer) that ⌘F is scoped to. */
const scopeEl = (): HTMLElement | null => document.getElementById('editor-find-scope')

function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  if (!q) return []
  // Flatten every text node into one string so a match can span adjacent nodes.
  // Syntax highlighting splits code into many <span>s, so a query crossing a
  // token boundary (e.g. "functionFoo") lives in two sibling text nodes and a
  // per-node indexOf would never find it.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = [] // global offset where each node's text begins
  let full = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue ?? ''
    if (!v) continue
    starts.push(full.length)
    nodes.push(n as Text)
    full += v
  }
  const hay = full.toLowerCase()
  // Map a global offset to [node, localOffset]: the last node whose start ≤ off.
  const locate = (off: number): [Text, number] => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return [nodes[lo], off - starts[lo]]
  }
  const ranges: Range[] = []
  let at = hay.indexOf(q)
  while (at !== -1 && ranges.length < MAX_MATCHES) {
    const [sNode, sOff] = locate(at)
    const [eNode, eOff] = locate(at + q.length)
    const r = document.createRange()
    r.setStart(sNode, sOff)
    r.setEnd(eNode, eOff)
    ranges.push(r)
    at = hay.indexOf(q, at + q.length)
  }
  return ranges
}

function clearHighlights(): void {
  const reg = registry()
  reg?.delete(ALL)
  reg?.delete(ACTIVE)
}

/** A VS Code-style find widget (⌘F), scoped to the file/diff viewer pane. */
export function FindBar(): React.JSX.Element | null {
  const open = useApp((s) => s.findOpen)
  const setOpen = useApp((s) => s.setFindOpen)
  const [q, setQ] = React.useState('')
  const [info, setInfo] = React.useState<{ active: number; total: number }>({ active: 0, total: 0 })
  const inputRef = React.useRef<HTMLInputElement>(null)
  const rangesRef = React.useRef<Range[]>([])
  const activeRef = React.useRef(0)

  const focusMatch = React.useCallback((i: number): void => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const idx = ((i % ranges.length) + ranges.length) % ranges.length
    activeRef.current = idx
    const reg = registry()
    if (reg && Highlight) reg.set(ACTIVE, new Highlight(ranges[idx]))
    const anchor = ranges[idx].startContainer.parentElement
    anchor?.scrollIntoView({ block: 'nearest' })
    setInfo({ active: idx + 1, total: ranges.length })
  }, [])

  const run = React.useCallback(
    (query: string): void => {
      const reg = registry()
      const root = scopeEl()
      if (!reg || !Highlight || !root || !query) {
        rangesRef.current = []
        clearHighlights()
        setInfo({ active: 0, total: 0 })
        return
      }
      const ranges = collectRanges(root, query)
      rangesRef.current = ranges
      if (ranges.length === 0) {
        clearHighlights()
        setInfo({ active: 0, total: 0 })
        return
      }
      reg.set(ALL, new Highlight(...ranges))
      // Keep the caret near where it was when the results shift under us.
      focusMatch(Math.min(activeRef.current, ranges.length - 1))
    },
    [focusMatch]
  )

  // Focus the input when opened; clear everything when closed.
  React.useEffect(() => {
    if (!open) {
      clearHighlights()
      rangesRef.current = []
      activeRef.current = 0
      setInfo({ active: 0, total: 0 })
      return
    }
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 20)
    return () => clearTimeout(t)
  }, [open])

  // Re-run as the viewer's content changes (diff loads, tab switches) so the
  // highlights follow, since the ranges point at now-stale DOM.
  React.useEffect(() => {
    if (!open || !q) return
    const root = scopeEl()
    if (!root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const obs = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => run(q), 150)
    })
    obs.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      obs.disconnect()
      clearTimeout(timer)
    }
  }, [open, q, run])

  React.useEffect(() => () => clearHighlights(), [])

  if (!open) return null

  return (
    <div className="no-drag fixed top-14 right-6 z-50 flex items-center gap-1 rounded-lg border border-border bg-popover px-1.5 py-1 shadow-xl">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          activeRef.current = 0
          run(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            focusMatch(activeRef.current + (e.shiftKey ? -1 : 1))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
        placeholder="Find in file"
        spellCheck={false}
        className="h-6 w-44 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60"
      />
      <span className="min-w-[52px] shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
        {q ? `${info.total ? info.active : 0}/${info.total}` : ''}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Previous match"
        onClick={() => focusMatch(activeRef.current - 1)}
      >
        <ArrowUp />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Next match"
        onClick={() => focusMatch(activeRef.current + 1)}
      >
        <ArrowDown />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Close find"
        onClick={() => setOpen(false)}
      >
        <X />
      </Button>
    </div>
  )
}

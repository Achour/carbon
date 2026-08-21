import * as React from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { SELECTION_MAX_CHARS, type Attachment } from '@shared/types'
import { useApp } from '@/store'
import {
  lineSelection,
  offsetsInNode,
  selectionLabel,
  type LineSelection
} from '@/lib/codeSelection'

/** Where the pill sits, in the scroller's *content* coordinates. */
interface Anchor {
  top: number
  left: number
  sel: LineSelection
}

const PILL_HEIGHT = 28
const GAP = 6

/**
 * "Add to chat" for a run of lines in the file viewer.
 *
 * Positions are content coordinates rather than viewport ones, so the pill is
 * laid out inside the scroller and travels with the code when it scrolls —
 * the alternative is a fixed-position element that detaches from the lines it
 * names the moment the wheel moves.
 */
export function CodeSelectionLayer({
  codeRef,
  scrollRef,
  text,
  path,
  name,
  cwd,
  language
}: {
  /** The `<pre>` holding the file's text; selections outside it are ignored. */
  codeRef: React.RefObject<HTMLElement | null>
  /** The scrolling container the pill is positioned within. */
  scrollRef: React.RefObject<HTMLElement | null>
  text: string
  path?: string
  name?: string
  cwd?: string | null
  language?: string
}): React.JSX.Element | null {
  const [anchor, setAnchor] = React.useState<Anchor | null>(null)

  const measure = React.useCallback((): void => {
    const code = codeRef.current
    const scroller = scrollRef.current
    if (!code || !scroller) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setAnchor(null)
      return
    }
    const range = selection.getRangeAt(0)
    const offsets = offsetsInNode(code, range)
    if (!offsets) {
      setAnchor(null)
      return
    }
    const sel = lineSelection(text, offsets.from, offsets.to, SELECTION_MAX_CHARS)
    if (!sel) {
      setAnchor(null)
      return
    }
    // The last client rect is the end of the drag, which is both where the
    // pointer already is and, for a multi-line selection, the only edge whose
    // position says anything — the union box's left edge is column 0 of the
    // longest line, which is nowhere the user looked.
    const rects = range.getClientRects()
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
    const host = scroller.getBoundingClientRect()
    const top = rect.top - host.top + scroller.scrollTop
    const above = top - PILL_HEIGHT - GAP
    setAnchor({
      // Above the selection where there is room, below its last line where the
      // selection starts at the very top of the scroller.
      top: above >= scroller.scrollTop ? above : rect.bottom - host.top + scroller.scrollTop + GAP,
      left: Math.max(0, rect.left - host.left + scroller.scrollLeft),
      sel
    })
  }, [codeRef, scrollRef, text])

  const add = React.useCallback((): void => {
    const sel = anchor?.sel
    if (!sel || !path) return
    const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : undefined
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      kind: 'selection',
      name: selectionLabel(name ?? rel ?? path, sel.startLine, sel.endLine),
      selection: {
        path,
        ...(rel ? { rel } : {}),
        startLine: sel.startLine,
        endLine: sel.endLine,
        text: sel.text,
        ...(language ? { language } : {}),
        ...(sel.truncated ? { truncated: true } : {})
      }
    }
    useApp.getState().addAttachment(attachment)
    // The lines are in the composer now; leaving them highlighted (and the pill
    // over them) reads as though the click did nothing.
    window.getSelection()?.removeAllRanges()
    setAnchor(null)
  }, [anchor, path, name, cwd, language])

  React.useEffect(() => {
    const code = codeRef.current
    if (!code) return
    // Measured on gesture *end* rather than on `selectionchange`: resolving an
    // offset walks the text before it, so recomputing on every event of a drag
    // through a large file is a string copy per frame. `selectionchange` is
    // still watched, but only for the collapse — which is a flag read.
    const onDone = (): void => measure()
    const onCollapse = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setAnchor(null)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setAnchor(null)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && anchor) {
        e.preventDefault()
        add()
      }
    }
    code.addEventListener('mouseup', onDone)
    code.addEventListener('keyup', onDone)
    code.addEventListener('dblclick', onDone)
    document.addEventListener('selectionchange', onCollapse)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      code.removeEventListener('mouseup', onDone)
      code.removeEventListener('keyup', onDone)
      code.removeEventListener('dblclick', onDone)
      document.removeEventListener('selectionchange', onCollapse)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [codeRef, measure, add, anchor])

  // A new file in the same tab slot keeps the component mounted; a pill left
  // over would name lines from the file that just closed.
  React.useEffect(() => setAnchor(null), [text, path])

  if (!anchor || !path) return null
  const { startLine, endLine } = anchor.sel
  return (
    <button
      type="button"
      // mousedown would collapse the selection before the click resolves.
      onMouseDown={(e) => e.preventDefault()}
      onClick={add}
      style={{ top: anchor.top, left: anchor.left, height: PILL_HEIGHT }}
      className="absolute z-20 flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 text-xs whitespace-nowrap text-popover-foreground shadow-md hover:bg-accent"
    >
      <MessageSquarePlus className="size-3.5 text-primary" />
      Add to chat
      <span className="text-[10.5px] text-muted-foreground">
        {startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`}
      </span>
      <kbd className="ml-0.5 rounded border border-border/70 px-1 font-mono text-[10px] text-muted-foreground">
        ⌘L
      </kbd>
    </button>
  )
}

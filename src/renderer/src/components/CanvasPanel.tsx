import React from 'react'
import { List, PenLine, Plus, Shapes, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'

/**
 * One row of the canvas list — the same row wherever the list appears.
 *
 * Deleting always asks (`confirmCanvasDelete`, answered by `CanvasDeleteDialog`
 * from `App`). A canvas is a row in Carbon's own database, so unlike a deleted
 * file there is no Trash to fetch it back out of; that is precisely why it can
 * never be a single unguarded click.
 */
function CanvasRow({
  id,
  title,
  updatedAt,
  active = false,
  compact = false
}: {
  id: string
  title: string
  updatedAt: number
  active?: boolean
  compact?: boolean
}): React.JSX.Element {
  const openCanvas = useApp((s) => s.openCanvas)
  const confirmCanvasDelete = useApp((s) => s.confirmCanvasDelete)
  const canvas = useApp((s) => s.canvases.find((c) => c.id === id))

  return (
    <li className="group/row flex items-center">
      <button
        type="button"
        onClick={() => void openCanvas(id)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left',
          'transition-colors hover:bg-accent/50',
          active && 'bg-accent/60'
        )}
      >
        <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
        {!compact && (
          <span className="shrink-0 text-[13px] text-muted-foreground">
            {relativeTime(updatedAt)}
          </span>
        )}
      </button>
      {/* Space reserved rather than conditionally rendered: a control that
          appears on hover and reflows the row makes the list flinch away from
          the pointer. */}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Delete ${title}`}
        className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
        onClick={() => canvas && confirmCanvasDelete(canvas)}
      >
        <Trash2 />
      </Button>
    </li>
  )
}

/** The inline name row for a new canvas — the file tree's idiom, for its reason:
 *  the name is decided in place, not in a modal that takes the list off screen. */
function NewCanvasRow({ onDone }: { onDone: () => void }): React.JSX.Element {
  const createCanvas = useApp((s) => s.createCanvas)
  const [value, setValue] = React.useState('')
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => ref.current?.focus(), [])

  const commit = (): void => {
    const title = value.trim()
    onDone()
    if (title) void createCanvas(title)
  }

  return (
    <li className="flex items-center gap-2 px-1.5 py-1">
      <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={ref}
        value={value}
        placeholder="Canvas name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') onDone()
        }}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
    </li>
  )
}

/** The list itself, shared by the Canvas tab and the in-canvas sidebar. */
function CanvasList({
  activeId,
  compact = false
}: {
  activeId?: string
  compact?: boolean
}): React.JSX.Element {
  const canvases = useApp((s) => s.canvases)
  const [creating, setCreating] = React.useState(false)

  return (
    <ul className="flex flex-col">
      {canvases.map((canvas) => (
        <CanvasRow
          key={canvas.id}
          id={canvas.id}
          title={canvas.title}
          updatedAt={canvas.updatedAt}
          active={canvas.id === activeId}
          compact={compact}
        />
      ))}
      {creating ? (
        <NewCanvasRow onDone={() => setCreating(false)} />
      ) : (
        <li>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="truncate">Create new canvas</span>
          </button>
        </li>
      )}
    </ul>
  )
}

/**
 * One canvas, rendered, with the project's other canvases beside it.
 *
 * `sandbox` **without** `allow-same-origin` is the whole security model, and
 * the two flags are only safe apart: together they would let an agent-authored
 * document reach out of its frame into the app that framed it. Alone,
 * `allow-scripts` gives the page a unique opaque origin — its script runs, and
 * it can touch no cookie, no storage and nothing of Carbon's.
 *
 * That the script runs at all is a fact about this app specifically: Carbon
 * ships no CSP, and `about:srcdoc` inherits the embedder's policy container —
 * so adding one later would render every interactive canvas silently inert,
 * with no error anywhere to say why.
 */
export function CanvasDoc({ id }: { id: string }): React.JSX.Element {
  const html = useApp((s) => s.canvasHtml[id])
  const title = useApp((s) => s.canvases.find((c) => c.id === id)?.title)
  const dark = useApp((s) => s.resolvedAppearance) === 'dark'
  // **Closed by default, and persisted.** The document is what this panel is
  // for; a list that opens itself takes a fifth of an already narrow pane away
  // from the thing the reader came to read, every single time. The toggle is a
  // real button in the header rather than a chevron inside the list, because a
  // control that only exists once the panel is open cannot be how the panel is
  // opened — which is what made the first version read as "always open".
  const [listOpen, setListOpen] = React.useState(
    () => localStorage.getItem('canvasListOpen') === '1'
  )
  const toggleList = (): void => {
    setListOpen((open) => {
      localStorage.setItem('canvasListOpen', open ? '0' : '1')
      return !open
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[13px]">{title ?? 'Canvas'}</span>
        <WithTooltip label={listOpen ? 'Hide canvases' : 'Show canvases'}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={listOpen ? 'Hide canvases' : 'Show canvases'}
            aria-pressed={listOpen}
            className={cn('shrink-0', listOpen && 'bg-accent text-foreground')}
            onClick={toggleList}
          >
            <List />
          </Button>
        </WithTooltip>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {html == null ? (
            <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              Loading…
            </div>
          ) : (
            <iframe
              key={id}
              title={title ?? 'Canvas'}
              srcDoc={html}
              sandbox="allow-scripts"
              // Not a theme: a hint, so a document that styles nothing gets the
              // app's own light/dark defaults instead of white in a dark window.
              style={{ colorScheme: dark ? 'dark' : 'light' }}
              className="h-full w-full border-0 bg-background"
            />
          )}
        </div>
        {listOpen && (
          <div className="flex w-48 shrink-0 flex-col overflow-y-auto border-l border-border p-2">
            <div className="px-1.5 pb-1 text-[13px] text-muted-foreground">Recent</div>
            <CanvasList activeId={id} compact />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The project's canvases — the Canvas tab's own body.
 *
 * Project-scoped rather than chat-scoped: every chat in a folder is working on
 * the same thing, and a document written in one of them is exactly what you
 * want in front of you in the next.
 */
export function CanvasPanel(): React.JSX.Element {
  const empty = useApp((s) => s.canvases.length === 0)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-2">
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Shapes className="size-6 text-muted-foreground/60" />
          <p className="max-w-[38ch] text-[13px] text-muted-foreground">
            Nothing here yet. Ask the agent for a comparison, a report or a diagram and it will
            save one — canvases live in the app, never in your repository.
          </p>
          <div className="w-56">
            <CanvasList />
          </div>
        </div>
      ) : (
        <>
          <div className="px-1.5 pb-1 text-[13px] text-muted-foreground">Recents</div>
          <CanvasList />
        </>
      )}
    </div>
  )
}

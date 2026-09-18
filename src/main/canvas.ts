import type { Canvas, CanvasSummary, ChatEvent } from '@shared/types'
import type { CanvasStore } from './canvasStore.ts'
import type { CanvasToolHost } from './canvasTools.ts'

/**
 * The canvas surface: the tool host the agents write through, and the MCP
 * wiring that gives each provider those tools.
 *
 * It implements `CanvasToolHost` by delegating to the store and emitting a
 * `canvas` event on every write — which is what keeps the Recents list live
 * while a turn is running, without opening the panel. Opening is the user's
 * click, for the reason the agents panel is never auto-selected: a canvas
 * arriving mid-read would take the file they are looking at off screen.
 *
 * The bridge belongs to `PreviewManager`, which starts it and is handed this
 * object as its second tool host: there is one `carbon` MCP server carrying
 * both tool tables, so the canvas needs no wiring of its own — `canvas_write`
 * arrives on the same connection as `preview_screenshot`.
 */
export class CanvasManager implements CanvasToolHost {
  // Explicit fields, not parameter properties — `node --test` strips types
  // without transforming, and the shorthand is a syntax error there.
  private store: CanvasStore
  private emit: (ev: ChatEvent) => void

  constructor(store: CanvasStore, emit: (ev: ChatEvent) => void) {
    this.store = store
    this.emit = emit
  }

  list(project: string): CanvasSummary[] {
    return this.store.list(project)
  }

  get(id: string): Canvas | null {
    return this.store.get(id)
  }

  save(input: {
    id?: string
    project: string
    chatId?: string | null
    title: string
    html: string
  }): CanvasSummary {
    const saved = this.store.save(input)
    if (saved.chatId) {
      this.emit({ type: 'canvas', chatId: saved.chatId, project: saved.project, canvas: saved })
    }
    return saved
  }

  delete(id: string): void {
    this.store.delete(id)
  }
}

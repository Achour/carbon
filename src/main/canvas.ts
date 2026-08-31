import type { Canvas, CanvasSummary, ChatEvent } from '@shared/types'
import type { CanvasStore } from './canvasStore.ts'
import type { CanvasToolHost } from './canvasTools.ts'
import type { PreviewBridgeHandle } from './previewBridge.ts'
import {
  carbonCanvasCodexMcp,
  carbonCanvasMcpServers,
  type StdioMcpServer
} from './previewMcpConfig.ts'

/** Where a canvas belongs and which chat wrote it. Fixed at session start. */
export interface CanvasContext {
  cwd: string
  project: string
  chatId: string
}

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
 * The loopback bridge belongs to `PreviewManager`, which starts it and is
 * handed this object as its second tool host. There is exactly one bridge and
 * one child script for both servers.
 */
export class CanvasManager implements CanvasToolHost {
  // Explicit fields, not parameter properties — `node --test` strips types
  // without transforming, and the shorthand is a syntax error there.
  private store: CanvasStore
  private emit: (ev: ChatEvent) => void
  private bridge: () => Promise<PreviewBridgeHandle | null>

  constructor(
    store: CanvasStore,
    emit: (ev: ChatEvent) => void,
    bridge: () => Promise<PreviewBridgeHandle | null>
  ) {
    this.store = store
    this.emit = emit
    this.bridge = bridge
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

  /** ACP `mcpServers` entry that gives this chat's canvas tools to Grok. */
  async mcpServers(ctx: CanvasContext): Promise<StdioMcpServer[]> {
    const bridge = await this.bridge()
    if (!bridge || !ctx.project) return []
    return carbonCanvasMcpServers(ctx, bridge)
  }

  /** Codex `config.mcp_servers.canvas` overlay for this chat. */
  async mcpCodexConfig(ctx: CanvasContext): Promise<Record<string, unknown> | undefined> {
    const bridge = await this.bridge()
    if (!bridge || !ctx.project) return undefined
    return carbonCanvasCodexMcp(ctx, bridge)
  }
}

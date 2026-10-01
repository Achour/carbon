import type { PreviewViewport, PreviewViewportPatch } from '@shared/previewDevices'

/**
 * Live browser-preview panes register an imperative handle here so the
 * preview-command controller (driven by the agent, in main) can find the pane
 * for a given project folder. Main does the page work itself over CDP; what a
 * handle answers for is only what the renderer owns — which pane, its tab, its
 * pixels and its viewport.
 */
export interface PreviewHandle {
  cwd: string
  /** On screen right now: the selected tab of an open panel. */
  isVisible(): boolean
  /** When the user last had this pane selected, for picking among several. */
  lastActive(): number
  /** Resolves true once main holds this pane's guest (see `previewGuestAttach`). */
  attached(): Promise<boolean>
  loadURL(url: string): void
  /** Base64 PNG of the visible viewport, or null if capture failed. Never switches tabs. */
  capture(): Promise<string | null>
  /**
   * Puts a hidden pane on screen, over whatever the panel shows, for a capture
   * only a painted guest can give (CDP's full-page shot); `conceal` undoes it.
   */
  reveal(): Promise<void>
  conceal(): void
  /** Applies a viewport change and resolves with the result once the guest has it. */
  setViewport(patch: PreviewViewportPatch): Promise<PreviewViewport>
  getURL(): string
}

const registry = new Map<string, PreviewHandle>()

/**
 * Canonicalize a project path for matching. The agent's folder (`chat.cwd`) and
 * a pane's `cwd` originate from the same value, but a stray trailing slash or
 * duplicate separator would make an exact `===` miss and the command silently
 * no-op ("No preview open"). Strip both so matching is robust.
 */
export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

export function registerPreview(id: string, handle: PreviewHandle): void {
  registry.set(id, handle)
}

export function unregisterPreview(id: string, handle?: PreviewHandle): void {
  if (!handle || registry.get(id) === handle) registry.delete(id)
}

export function previewHandle(id: string): PreviewHandle | undefined {
  return registry.get(id)
}

/**
 * The mounted pane for a project: the one on screen if there is one, else the
 * one the user had selected most recently. Every preview tab is mounted while
 * the panel is open, so a project's pane is found even behind a file tab —
 * the old registry held only the selected pane, and an agent command arriving
 * while a file was in front opened a duplicate preview.
 */
export function previewForCwd(cwd: string): { id: string; handle: PreviewHandle } | null {
  const target = normalizeCwd(cwd)
  let best: { id: string; handle: PreviewHandle } | null = null
  for (const [id, handle] of registry) {
    if (normalizeCwd(handle.cwd) !== target) continue
    if (handle.isVisible()) return { id, handle }
    if (!best || handle.lastActive() > best.handle.lastActive()) best = { id, handle }
  }
  return best
}

import type { PreviewViewport, PreviewViewportPatch } from '@shared/previewDevices'
import { normalizeCwd, pickPreviewPane } from '@shared/previewPane'

export { normalizeCwd }

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
  /** Gives the guest keyboard focus (see `PreviewCommand`'s `focus`)… */
  focus(): void
  /** …and hands it back to whatever had it before. */
  unfocus(): void
}

const registry = new Map<string, PreviewHandle>()

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
 * The mounted pane `owner` should act on in `cwd` (see `pickPreviewPane`):
 * its own, else an unowned one it may claim. Every preview tab is mounted
 * while the panel is open, so a pane is found even behind a file tab — the old
 * registry held only the selected pane, and an agent command arriving while a
 * file was in front opened a duplicate preview.
 */
export function previewFor(
  cwd: string,
  owner: string | undefined,
  ownerOf: (paneId: string) => string | undefined,
  isLive: (chatId: string) => boolean
): { id: string; handle: PreviewHandle; claim: boolean } | null {
  const picked = pickPreviewPane(
    [...registry].map(([id, h]) => ({
      id,
      cwd: h.cwd,
      owner: ownerOf(id),
      visible: h.isVisible(),
      lastActive: h.lastActive()
    })),
    cwd,
    owner,
    isLive
  )
  const handle = picked && registry.get(picked.id)
  return picked && handle ? { ...picked, handle } : null
}

/** Any mounted pane for a project, ownership aside — for the e2e probes. */
export function previewForCwd(cwd: string): { id: string; handle: PreviewHandle } | null {
  return previewFor(cwd, undefined, () => undefined, () => false)
}

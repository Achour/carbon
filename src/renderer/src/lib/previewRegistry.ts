/**
 * Live browser-preview panes register an imperative handle here so the
 * preview-command controller (driven by the agent, in main) can find the pane
 * for a given project folder and act on its <webview>.
 */
export interface PreviewHandle {
  cwd: string
  loadURL(url: string): void
  /** Base64 PNG of the current page, or null if capture failed. */
  capture(): Promise<string | null>
  getURL(): string
  /** Bring this preview's tab to the front (needed before a valid capture). */
  activate(): void
}

const registry = new Map<string, PreviewHandle>()

export function registerPreview(id: string, handle: PreviewHandle): void {
  registry.set(id, handle)
}

export function unregisterPreview(id: string): void {
  registry.delete(id)
}

export function previewForCwd(cwd: string): { id: string; handle: PreviewHandle } | null {
  for (const [id, handle] of registry) {
    if (handle.cwd === cwd) return { id, handle }
  }
  return null
}

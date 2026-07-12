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

/**
 * Canonicalize a project path for matching. The agent's folder (`chat.cwd`) and
 * a pane's `cwd` originate from the same value, but a stray trailing slash or
 * duplicate separator would make an exact `===` miss and the command silently
 * no-op ("No preview open"). Strip both so matching is robust.
 */
function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

export function registerPreview(id: string, handle: PreviewHandle): void {
  registry.set(id, handle)
}

export function unregisterPreview(id: string): void {
  registry.delete(id)
}

export function previewForCwd(cwd: string): { id: string; handle: PreviewHandle } | null {
  const target = normalizeCwd(cwd)
  for (const [id, handle] of registry) {
    if (normalizeCwd(handle.cwd) === target) return { id, handle }
  }
  return null
}

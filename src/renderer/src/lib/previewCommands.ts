import type { PreviewCommand, PreviewCommandResult } from '@shared/types'
import { useApp } from '@/store'
import { normalizeCwd, previewForCwd, previewHandle, type PreviewHandle } from '@/lib/previewRegistry'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll the registry until a preview pane for `cwd` has mounted, or time out. */
async function waitForPreview(cwd: string, ms: number): Promise<ReturnType<typeof previewForCwd>> {
  const deadline = Date.now() + ms
  let p = previewForCwd(cwd)
  while (!p && Date.now() < deadline) {
    await tick(100)
    p = previewForCwd(cwd)
  }
  return p
}

/**
 * This project's pane, mounted and attached in main — showing or opening one
 * only when it has to.
 *
 * In order: a mounted pane (every preview tab is mounted while the panel is
 * open, so one behind a file tab is found and used *where it is*); a tab that
 * exists but is unmounted because the panel is closed (opened, not
 * duplicated); and only then a new tab, and only when main gave a URL to open
 * it at. The old controller knew only the selected pane, so an agent command
 * arriving while a file was in front opened a second "Preview" tab every time.
 */
async function ensure(cwd: string, url: string | undefined): Promise<{ id: string; handle: PreviewHandle } | { error: string }> {
  let p = previewForCwd(cwd)
  let opened = false
  if (!p) {
    const s = useApp.getState()
    const tab = s.previews.find((t) => normalizeCwd(t.cwd) === normalizeCwd(cwd))
    if (tab) {
      s.setActiveTab(tab.id)
      if (!s.panelOpen) s.togglePanel()
    } else if (url) {
      s.openPreview(url, cwd)
      opened = true
    } else {
      return { error: 'No preview open' }
    }
    p = await waitForPreview(cwd, 4000)
    if (!p) return { error: opened ? 'The preview did not open.' : 'No preview open' }
  }
  const attached = await Promise.race([p.handle.attached(), tick(10_000).then(() => false)])
  if (!attached) return { error: 'The preview page did not finish loading.' }
  return p
}

async function handle(cmd: PreviewCommand): Promise<Omit<PreviewCommandResult, 'id'>> {
  switch (cmd.kind) {
    case 'ensure': {
      const p = await ensure(cmd.cwd, cmd.url)
      return 'error' in p ? { ok: false, error: p.error } : { ok: true, paneId: p.id }
    }
    case 'navigate': {
      if (!cmd.url) return { ok: false, error: 'No URL.' }
      const existing = previewForCwd(cmd.cwd)
      const p = await ensure(cmd.cwd, cmd.url)
      if ('error' in p) return { ok: false, error: p.error }
      // A pane just opened at this URL is already loading it.
      if (existing || p.handle.getURL() !== cmd.url) p.handle.loadURL(cmd.url)
      return { ok: true, paneId: p.id }
    }
  }
  const pane = cmd.paneId ? previewHandle(cmd.paneId) : undefined
  if (!pane) return { ok: false, error: 'The preview was closed.' }
  switch (cmd.kind) {
    case 'screenshot': {
      const data = await pane.capture()
      return data ? { ok: true, data } : { ok: false, error: 'Capture failed.' }
    }
    case 'reveal':
      await pane.reveal()
      return { ok: true }
    case 'conceal':
      pane.conceal()
      return { ok: true }
    case 'viewport': {
      if (!cmd.viewport) return { ok: false, error: 'No viewport.' }
      return { ok: true, viewport: await pane.setViewport(cmd.viewport) }
    }
  }
  return { ok: false, error: 'Unknown command' }
}

/** Answers main's preview commands for as long as the returned unsubscribe is not called. */
export function installPreviewCommands(): () => void {
  return window.api.onPreviewCommand(async (cmd) => {
    try {
      window.api.previewCommandResult({ id: cmd.id, ...(await handle(cmd)) })
    } catch (err) {
      window.api.previewCommandResult({ id: cmd.id, ok: false, error: String(err) })
    }
  })
}

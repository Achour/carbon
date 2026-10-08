import type { PreviewCommand, PreviewCommandResult } from '@shared/types'
import { useApp } from '@/store'
import { pickPreviewPane } from '@shared/previewPane'
import { previewFor, previewHandle, type PreviewHandle } from '@/lib/previewRegistry'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `owner`'s pane in `cwd` among the mounted ones, claiming a free one at once. */
function mountedPane(cwd: string, owner: string | undefined): { id: string; handle: PreviewHandle } | null {
  const s = useApp.getState()
  const p = previewFor(
    cwd,
    owner,
    (id) => s.previews.find((t) => t.id === id)?.owner,
    (id) => s.chats.some((c) => c.id === id)
  )
  if (!p) return null
  // Claimed in the same tick it was picked: two agents asking at once must not
  // both take the user's pane.
  if (p.claim && owner) s.setPreviewOwner(p.id, owner)
  return p
}

/** Poll the registry until pane `id` has mounted, or time out. */
async function waitForPane(id: string, ms: number): Promise<{ id: string; handle: PreviewHandle } | null> {
  const deadline = Date.now() + ms
  let h = previewHandle(id)
  while (!h && Date.now() < deadline) {
    await tick(100)
    h = previewHandle(id)
  }
  return h ? { id, handle: h } : null
}

/**
 * `owner`'s pane for this project, mounted and attached in main — showing or
 * opening one only when it has to.
 *
 * In order: a mounted pane (every preview tab is mounted while the panel is
 * open, so one behind a file tab is found and used *where it is*); a tab that
 * exists but is unmounted because the panel is closed (the panel opened, the
 * tab not duplicated); and only then a new tab, and only when main gave a URL
 * to open it at. Each step takes the chat's own pane or a free one, never
 * another chat's (`pickPreviewPane`). A new tab is opened *behind* whatever
 * the panel shows: with several agents testing at once, each one's tab coming
 * to the front would flip the user's panel under them every time.
 */
async function ensure(
  cwd: string,
  url: string | undefined,
  owner: string | undefined
): Promise<{ id: string; handle: PreviewHandle; opened: boolean } | { error: string }> {
  let p = mountedPane(cwd, owner)
  let opened = false
  if (!p) {
    const s = useApp.getState()
    const picked = pickPreviewPane(s.previews, cwd, owner, (id) => s.chats.some((c) => c.id === id))
    let id: string
    if (picked) {
      id = picked.id
      if (picked.claim && owner) s.setPreviewOwner(id, owner)
      if (!s.panelOpen) s.togglePanel()
      if (!s.activeTab) s.setActiveTab(id)
    } else if (url) {
      id = s.openPreview(url, cwd, { owner, activate: false })
      opened = true
    } else {
      return { error: 'No preview open' }
    }
    p = await waitForPane(id, 4000)
    if (!p) return { error: opened ? 'The preview did not open.' : 'No preview open' }
  }
  const attached = await Promise.race([p.handle.attached(), tick(10_000).then(() => false)])
  if (!attached) return { error: 'The preview page did not finish loading.' }
  return { ...p, opened }
}

async function handle(cmd: PreviewCommand): Promise<Omit<PreviewCommandResult, 'id'>> {
  switch (cmd.kind) {
    case 'ensure': {
      const p = await ensure(cmd.cwd, cmd.url, cmd.owner)
      return 'error' in p ? { ok: false, error: p.error } : { ok: true, paneId: p.id }
    }
    case 'navigate': {
      if (!cmd.url) return { ok: false, error: 'No URL.' }
      const p = await ensure(cmd.cwd, cmd.url, cmd.owner)
      if ('error' in p) return { ok: false, error: p.error }
      // A pane just opened at this URL is already loading it.
      if (!p.opened || p.handle.getURL() !== cmd.url) p.handle.loadURL(cmd.url)
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
    case 'focus':
      pane.focus()
      return { ok: true }
    case 'unfocus':
      pane.unfocus()
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

import * as React from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/Sidebar'
import { ChatView } from '@/components/ChatView'
import { NewChat } from '@/components/NewChat'
import { RightPanel } from '@/components/RightPanel'
import { FileSearchDialog } from '@/components/FileSearchDialog'
import { FindBar } from '@/components/FindBar'
import { Settings } from '@/components/Settings'
import { useApp } from '@/store'
import { previewForCwd } from '@/lib/previewRegistry'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll the registry until a preview pane for `cwd` has mounted, or time out. */
async function waitForPreview(
  cwd: string,
  ms: number
): Promise<ReturnType<typeof previewForCwd>> {
  const deadline = Date.now() + ms
  let p = previewForCwd(cwd)
  while (!p && Date.now() < deadline) {
    await tick(100)
    p = previewForCwd(cwd)
  }
  return p
}

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const applyEvent = useApp((s) => s.applyEvent)
  const openChat = useApp((s) => s.openChat)
  const chats = useApp((s) => s.chats)
  const activeId = useApp((s) => s.activeId)
  const loading = useApp((s) => s.loading)

  React.useEffect(() => {
    void init()
    const offEvents = window.api.onChatEvent(applyEvent)
    const offNewChat = window.api.onNewChat(() => void openChat(null))
    const offPreview = window.api.onPreviewEvent((ev) => {
      if (ev.type === 'state') useApp.getState().applyPreviewState(ev.state)
    })
    // The agent (via main) asks the renderer to drive the live <webview>:
    // navigate it, or capture a screenshot to see what it built.
    const offPreviewCmd = window.api.onPreviewCommand(async (cmd) => {
      try {
        if (cmd.kind === 'navigate' && cmd.url) {
          let p = previewForCwd(cmd.cwd)
          if (!p) {
            useApp.getState().openPreview(cmd.url, cmd.cwd)
            p = await waitForPreview(cmd.cwd, 2500)
          }
          p?.handle.loadURL(cmd.url)
          window.api.previewCommandResult({
            id: cmd.id,
            ok: !!p,
            error: p ? undefined : 'No preview open'
          })
          return
        }
        if (cmd.kind === 'screenshot') {
          let p = previewForCwd(cmd.cwd)
          if (!p && cmd.url) {
            useApp.getState().openPreview(cmd.url, cmd.cwd)
            p = await waitForPreview(cmd.cwd, 2500)
          }
          if (!p) {
            window.api.previewCommandResult({ id: cmd.id, ok: false, error: 'No preview open' })
            return
          }
          // Bring the pane to the front, then capture — capture() waits for the
          // guest to be ready and painted and retries blank frames on its own.
          p.handle.activate()
          const data = await p.handle.capture()
          window.api.previewCommandResult({
            id: cmd.id,
            ok: !!data,
            data: data ?? undefined,
            error: data ? undefined : 'Capture failed'
          })
          return
        }
        window.api.previewCommandResult({ id: cmd.id, ok: false, error: 'Unknown command' })
      } catch (err) {
        window.api.previewCommandResult({ id: cmd.id, ok: false, error: String(err) })
      }
    })
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        void openChat(null)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        useApp.getState().toggleSidebar()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        useApp.getState().setSearchOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        useApp.getState().setFileSearchOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        useApp.getState().setFindOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        useApp.getState().toggleTerminal()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        const s = useApp.getState()
        if (s.settingsOpen) s.closeSettings()
        else s.openSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    // Files dropped outside the composer must not navigate the window.
    const preventNav = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', preventNav)
    window.addEventListener('drop', preventNav)
    return () => {
      offEvents()
      offNewChat()
      offPreview()
      offPreviewCmd()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', preventNav)
      window.removeEventListener('drop', preventNav)
    }
  }, [init, applyEvent, openChat])

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  const settingsOpen = useApp((s) => s.settingsOpen)
  const panelFullscreen = useApp((s) => s.panelOpen && s.panelMaximized)

  return (
    <TooltipProvider delay={500}>
      <div className="flex h-full">
        <Sidebar />
        <ErrorBoundary>
          {settingsOpen ? (
            <Settings />
          ) : panelFullscreen ? null : loading ? (
            <div className="flex flex-1 items-center justify-center">
              <span className="shimmer-text text-sm font-medium">Loading…</span>
            </div>
          ) : activeChat ? (
            <ChatView key={activeChat.id} chat={activeChat} />
          ) : (
            <NewChat />
          )}
          {!settingsOpen && <RightPanel />}
        </ErrorBoundary>
      </div>
      <FileSearchDialog />
      <FindBar />
    </TooltipProvider>
  )
}

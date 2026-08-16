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
import { UsageStats } from '@/components/UsageStats'
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
    const offNewChat = window.api.onNewChat(() => useApp.getState().startNewChat())
    const offOpenChat = window.api.onOpenChat((id) => void openChat(id))
    const offPreview = window.api.onPreviewEvent((ev) => {
      if (ev.type === 'state') useApp.getState().applyPreviewState(ev.state)
    })
    // Subscribed here rather than in TerminalPanel: the activity dot has to keep
    // updating for tabs whose terminal is hidden or unmounted — that is the case
    // it exists for.
    const offTerminal = window.api.onTerminalEvent((ev) => {
      if (ev.type === 'busy') useApp.getState().setTerminalBusy(ev.id, ev.command)
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
        // Same as the sidebar row: asks which project, unless the sidebar is
        // already filtered to one (that pick is on screen).
        useApp.getState().startNewChat()
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
      offOpenChat()
      offPreview()
      offTerminal()
      offPreviewCmd()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', preventNav)
      window.removeEventListener('drop', preventNav)
    }
  }, [init, applyEvent, openChat])

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  // Keyed by the folder, like `ChatView` is by its chat: the home screen's whole
  // state — the prompt, the pickers, the worktree target — belongs to one
  // project, and the draft for the folder you switch to has to be seeded at
  // mount. Also what makes the outgoing folder's draft flush before the next
  // one is read.
  const homeCwd = useApp((s) => s.selectedCwd)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const usageOpen = useApp((s) => s.usageOpen)
  const panelFullscreen = useApp((s) => s.panelOpen && s.panelMaximized)
  // Both are full-window pages that stand in for the chat, and both hide the
  // right panel — a diff or file tab belongs to a chat, and neither page has one.
  const pageOpen = settingsOpen || usageOpen

  return (
    <TooltipProvider delay={500}>
      <div className="flex h-full">
        <Sidebar />
        <ErrorBoundary>
          {/* Opaque layer: the translucent-sidebar effect makes the window base
              transparent, so everything except the sidebar sits on its own
              solid background and never shows the frosted-glass material. */}
          <div className="flex min-w-0 flex-1 bg-background">
            {settingsOpen ? (
              <Settings />
            ) : usageOpen ? (
              <UsageStats />
            ) : panelFullscreen ? null : loading ? (
              <div className="flex flex-1 items-center justify-center">
                <span className="shimmer-text text-sm font-medium">Loading…</span>
              </div>
            ) : activeChat ? (
              <ChatView key={activeChat.id} chat={activeChat} />
            ) : (
              <NewChat key={homeCwd ?? ''} />
            )}
            {!pageOpen && <RightPanel />}
          </div>
        </ErrorBoundary>
      </div>
      <FileSearchDialog />
      <FindBar />
    </TooltipProvider>
  )
}

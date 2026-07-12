import * as React from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/Sidebar'
import { ChatView } from '@/components/ChatView'
import { NewChat } from '@/components/NewChat'
import { RightPanel } from '@/components/RightPanel'
import { Settings } from '@/components/Settings'
import { useApp } from '@/store'

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
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        void openChat(null)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        useApp.getState().toggleSidebar()
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
    </TooltipProvider>
  )
}

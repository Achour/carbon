import * as React from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/Sidebar'
import { ChatView } from '@/components/ChatView'
import { NewChat } from '@/components/NewChat'
import { RightPanel } from '@/components/RightPanel'
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
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offEvents()
      offNewChat()
      window.removeEventListener('keydown', onKey)
    }
  }, [init, applyEvent, openChat])

  const activeChat = chats.find((c) => c.id === activeId) ?? null

  return (
    <TooltipProvider delay={500}>
      <div className="flex h-full">
        <Sidebar />
        <ErrorBoundary>
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <span className="shimmer-text text-sm font-medium">Loading…</span>
            </div>
          ) : activeChat ? (
            <ChatView key={activeChat.id} chat={activeChat} />
          ) : (
            <NewChat />
          )}
          <RightPanel />
        </ErrorBoundary>
      </div>
    </TooltipProvider>
  )
}

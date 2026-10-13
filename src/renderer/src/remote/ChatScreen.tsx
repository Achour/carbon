import * as React from 'react'
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Loader2, Wrench } from 'lucide-react'
import type {
  AssistantPart,
  ChatMessage,
  EventMessage,
  ToolPart,
  UserMessage
} from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { useRemote } from './state'
import { ConnectionStrip, navigate } from './App'
import { chatTitle, isBusy, projectName, toolLine } from './format'
import { RemoteMarkdown } from './Markdown'
import { Composer } from './Composer'
import { PermissionCard } from './PermissionCard'

export function ChatScreen({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useRemote((s) => s.chats.find((c) => c.id === chatId))
  const open = useRemote((s) => (s.open?.id === chatId ? s.open : null))
  const status = useRemote((s) => s.statuses[chatId])
  const requests = useRemote((s) => s.permissions[chatId])
  const queued = useRemote((s) => s.queued[chatId]?.length ?? 0)
  const loadOlder = useRemote((s) => s.loadOlder)
  const busy = isBusy(status)

  const scroller = React.useRef<HTMLDivElement>(null)
  // Follow the bottom while the reader is there; leave them be once they scroll up.
  const pinned = React.useRef(true)
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  React.useEffect(() => {
    pinned.current = true
  }, [chatId])

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => navigate('#/')}>
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <div className="title">{chat ? chatTitle(chat) : 'Chat'}</div>
          {chat && (
            <div className="subtitle">
              {projectName(chat)} · {PROVIDER_SHORT_LABELS[chat.provider]}
              {chat.model ? ` · ${chat.model}` : ''}
            </div>
          )}
        </div>
      </header>
      <ConnectionStrip />
      <div className="scroll transcript" ref={scroller} onScroll={onScroll}>
        {open && open.hiddenBefore > 0 && (
          <button type="button" className="btn ghost wide" disabled={open.loading} onClick={() => void loadOlder()}>
            {open.loading ? 'Loading…' : 'Load earlier messages'}
          </button>
        )}
        {!open || (open.loading && open.messages.length === 0) ? (
          <div className="empty muted">Loading…</div>
        ) : (
          open.messages.map((m) => <Message key={m.id} message={m} />)
        )}
        {busy && (
          <div className="working">
            <Loader2 className="spin" /> {status === 'waiting-permission' ? 'Waiting for you' : 'Working…'}
          </div>
        )}
      </div>
      {requests?.map((r) => <PermissionCard key={r.id} chatId={chatId} request={r} provider={chat?.provider ?? 'claude'} />)}
      <Composer chatId={chatId} busy={busy} queued={queued} />
    </div>
  )
}

const Message = React.memo(function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <UserBubble message={message} />
  if (message.role === 'event') return <EventLine message={message} />
  return (
    <div className="assistant">
      {message.parts.map((p, i) => (p ? <Part key={i} part={p} /> : null))}
    </div>
  )
})

function UserBubble({ message }: { message: UserMessage }): React.JSX.Element {
  const images = message.attachments?.filter((a) => a.kind === 'image' && a.data) ?? []
  const others = message.attachments?.filter((a) => a.kind !== 'image') ?? []
  return (
    <div className="user">
      {images.length > 0 && (
        <div className="user-images">
          {images.map((a) => (
            <img key={a.id} src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} />
          ))}
        </div>
      )}
      {(message.label || message.text) && <div className="bubble">{message.label ?? message.text}</div>}
      {others.length > 0 && <div className="user-files">{others.map((a) => a.name).join(', ')}</div>}
    </div>
  )
}

function EventLine({ message }: { message: EventMessage }): React.JSX.Element | null {
  if (message.kind === 'turn') {
    const s = message.stats
    if (!s) return null
    const secs = Math.round(s.durationMs / 1000)
    const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
    return (
      <div className="event muted">
        Done · {time}
        {s.costUsd > 0 ? ` · $${s.costUsd.toFixed(2)}` : ''}
      </div>
    )
  }
  return <div className={`event ${message.kind === 'error' ? 'error' : 'muted'}`}>{message.text}</div>
}

function Part({ part }: { part: AssistantPart }): React.JSX.Element | null {
  if (part.type === 'text') return part.text.trim() ? <RemoteMarkdown text={part.text} /> : null
  if (part.type === 'thinking') {
    // A withheld thought has no text; like the desktop, it draws nothing.
    if (!part.text.trim()) return null
    return (
      <details className="thinking">
        <summary>Thought</summary>
        <div className="thinking-body">{part.text}</div>
      </details>
    )
  }
  return <ToolRow part={part} />
}

function ToolRow({ part }: { part: ToolPart }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const { label, detail } = toolLine(part)
  const running = part.status === 'running' || part.status === 'pending'
  const Icon = running ? Loader2 : part.status === 'error' ? CircleAlert : part.denied ? CircleAlert : CircleCheck
  const children = part.children?.filter((c) => c.type === 'tool') as ToolPart[] | undefined
  const hasBody = !!part.output || !!children?.length
  return (
    <div className={`tool ${part.status}`}>
      <button type="button" className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <Icon className={running ? 'spin' : ''} />
        <span className="tool-label">{label}</span>
        {detail && <span className="tool-detail">{detail}</span>}
        {hasBody && <ChevronRight className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <div className="tool-body">
          {children?.length ? (
            <div className="tool-children">
              {children.map((c) => (
                <div key={c.toolUseId} className="tool-child">
                  <Wrench /> {toolLine(c).label}
                  {toolLine(c).detail ? ` · ${toolLine(c).detail}` : ''}
                </div>
              ))}
            </div>
          ) : null}
          {part.output && <pre>{part.output.length > 6000 ? `${part.output.slice(0, 6000)}\n…` : part.output}</pre>}
        </div>
      )}
    </div>
  )
}

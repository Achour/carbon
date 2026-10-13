import * as React from 'react'
import { Pin, Plus, Search } from 'lucide-react'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { useRemote } from './state'
import { ConnectionStrip, navigate } from './App'
import { ago, chatTitle, listedChats, projectName } from './format'
import { StatusDot } from './StatusDot'

export function ChatList(): React.JSX.Element {
  const chats = useRemote((s) => s.chats)
  const permissions = useRemote((s) => s.permissions)
  const hostname = useRemote((s) => s.hostname)
  const [query, setQuery] = React.useState('')

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = listedChats(chats)
    return q
      ? all.filter((c) => `${c.title} ${projectName(c)}`.toLowerCase().includes(q))
      : all
  }, [chats, query])

  // Anything waiting on an answer floats to a section of its own: on a phone
  // that is usually the reason the app was opened.
  const waiting = rows.filter((c) => (permissions[c.id]?.length ?? 0) > 0)
  const rest = rows.filter((c) => !(permissions[c.id]?.length ?? 0))

  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-title">
          <div className="title">Chats</div>
          {hostname && <div className="subtitle">on {hostname}</div>}
        </div>
        <button type="button" className="icon-btn" aria-label="New chat" onClick={() => navigate('#/new')}>
          <Plus />
        </button>
      </header>
      <ConnectionStrip />
      <div className="scroll">
        <label className="search">
          <Search />
          <input
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {waiting.length > 0 && <div className="section-label">Needs you</div>}
        {waiting.map((c) => (
          <Row key={c.id} id={c.id} />
        ))}
        {waiting.length > 0 && rest.length > 0 && <div className="section-label">Chats</div>}
        {rest.map((c) => (
          <Row key={c.id} id={c.id} />
        ))}
        {rows.length === 0 && (
          <div className="empty muted">{query ? 'No chats match.' : 'No chats yet. Tap + to start one.'}</div>
        )}
      </div>
    </div>
  )
}

const Row = React.memo(function Row({ id }: { id: string }) {
  const chat = useRemote((s) => s.chats.find((c) => c.id === id))
  const status = useRemote((s) => s.statuses[id])
  const asking = useRemote((s) => (s.permissions[id]?.length ?? 0) > 0)
  if (!chat) return null
  return (
    <button type="button" className="row" onClick={() => navigate(`#/c/${encodeURIComponent(id)}`)}>
      <StatusDot status={status} asking={asking} />
      <div className="row-main">
        <div className="row-title">
          {chat.pinnedAt && <Pin className="pin" />}
          {chatTitle(chat)}
        </div>
        <div className="row-sub">
          {projectName(chat)}
          {chat.worktree ? ` · ${chat.worktree.branch}` : ''} · {PROVIDER_SHORT_LABELS[chat.provider]}
        </div>
      </div>
      <div className="row-time">
        {asking ? <span className="badge warn">Approve</span> : ago(chat.updatedAt)}
      </div>
    </button>
  )
})

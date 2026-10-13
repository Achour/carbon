import * as React from 'react'
import { ChevronLeft, Folder } from 'lucide-react'
import { projectRoot } from '@shared/types'
import { useRemote } from './state'
import { ConnectionStrip, navigate } from './App'
import { baseName } from './format'
import { Composer } from './Composer'

/**
 * Start a chat in one of the Mac's projects. The list is the Mac's recent
 * folders, then every project a chat already lives in — a phone has no folder
 * picker that can see the Mac's disk, so these are the projects on offer.
 */
export function NewChatScreen(): React.JSX.Element {
  const defaults = useRemote((s) => s.defaults)
  const chats = useRemote((s) => s.chats)
  const createChat = useRemote((s) => s.createChat)

  const projects = React.useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (dir: string): void => {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
    for (const dir of defaults?.recentDirs ?? []) add(dir)
    for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.ephemeral && c.surface !== 'terminal') add(projectRoot(c))
    }
    return out
  }, [defaults, chats])

  const [cwd, setCwd] = React.useState<string | null>(null)
  const selected = cwd ?? projects[0] ?? null

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => navigate('#/')}>
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <div className="title">New chat</div>
          {defaults?.model && <div className="subtitle">{defaults.model}</div>}
        </div>
      </header>
      <ConnectionStrip />
      <div className="scroll">
        <div className="section-label">Project</div>
        {projects.length === 0 && (
          <div className="empty muted">Open a project in Carbon on your Mac first; it will appear here.</div>
        )}
        {projects.map((dir) => (
          <button
            type="button"
            key={dir}
            className={`row project ${dir === selected ? 'on' : ''}`}
            onClick={() => setCwd(dir)}
          >
            <Folder />
            <div className="row-main">
              <div className="row-title">{baseName(dir)}</div>
              <div className="row-sub">{dir}</div>
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <Composer
          placeholder={`Ask about ${baseName(selected)}…`}
          onSubmit={async (text, attachments) => {
            const id = await createChat(selected, text, attachments)
            navigate(`#/c/${encodeURIComponent(id)}`)
          }}
        />
      )}
    </div>
  )
}

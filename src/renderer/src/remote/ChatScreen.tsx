import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { CanvasSummary, ChatMeta, PermissionRequestPayload } from '@shared/types'
import { PROVIDER_LABELS, modelDisplayName, projectRoot } from '@shared/types'
import { useApp } from '@/store'
import { useTranscript } from '@/components/Transcript'
import { Markdown } from '@/components/Markdown'
import { StreamingIndicator } from '@/components/messages/Parts'
import { TranscriptChat } from '@/components/messages/AgentRows'
import { TranscriptSurfaceContext, type TranscriptSurface } from '@/components/messages/surface'
import { useRemote } from './state'
import { Header, navigate } from './App'
import { invoke } from './api'
import { AgentView, CanvasView } from './Viewers'
import { chatTitle, isBusy, projectName } from './format'
import { Composer } from './Composer'
import { OptionChips } from './OptionChips'
import { useAllModels, type OptionValues } from './options'
import { PermissionCard } from './PermissionCard'
import { Sheet } from './Sheet'

const NO_REQUESTS: PermissionRequestPayload[] = []

export function ChatScreen({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useRemote((s) => s.chats.find((c) => c.id === chatId))
  const open = useRemote((s) => (s.open?.id === chatId ? s.open : null))
  const status = useRemote((s) => s.statuses[chatId])
  const requests = useRemote((s) => s.permissions[chatId])
  const queued = useRemote((s) => s.queued[chatId]?.length ?? 0)
  const loadOlder = useRemote((s) => s.loadOlder)
  const setOptions = useRemote((s) => s.setOptions)
  const busy = isBusy(status)
  const expandedTurns = useApp((s) => s.expandedTurns)
  const toggleTurnExpanded = useApp((s) => s.toggleTurnExpanded)
  const [plan, setPlan] = React.useState<string | null>(null)
  const onOpenPlan = React.useCallback((text: string) => setPlan(text), [])
  const transcriptChat = React.useMemo(
    () => (chat ? { chatId: chat.id, provider: chat.provider } : null),
    [chat?.id, chat?.provider]
  )
  const [view, setView] = React.useState<
    { kind: 'canvas'; id: string } | { kind: 'agent'; toolUseId: string } | null
  >(null)
  const surface = React.useMemo<TranscriptSurface>(
    () => ({
      panels: false,
      openChat: (id) => navigate(`#/c/${encodeURIComponent(id)}`),
      openAgent: (_parent, toolUseId) => setView({ kind: 'agent', toolUseId }),
      openCanvas: (id) => setView({ kind: 'canvas', id })
    }),
    []
  )
  React.useEffect(() => setView(null), [chatId])

  // The project's canvases, which the transcript names a written one by —
  // refreshed as a turn ends, since that is when a new one can have appeared.
  const project = chat ? projectRoot(chat) : null
  React.useEffect(() => {
    if (!project || busy) return
    let alive = true
    invoke<CanvasSummary[]>('canvas:list', project)
      .then((canvases) => alive && useApp.setState({ canvases }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [project, busy])

  const scroller = React.useRef<HTMLDivElement>(null)
  // Follow the bottom while the reader is there; leave them be once they scroll up.
  const pinned = React.useRef(true)
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 400 && open && open.hiddenBefore > 0 && !open.loading) {
      // Earlier messages, anchored on the distance from the bottom so the
      // prepend does not move what is being read.
      const fromBottom = el.scrollHeight - el.scrollTop
      void loadOlder().then(() =>
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - fromBottom
        })
      )
    }
  }
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  // …and as the column grows with no render of this component: a diagram or
  // a Mermaid block lays out after it mounts, a code block highlights late, a
  // streamed reply reveals between deltas.
  const column = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = scroller.current
    const col = column.current
    if (!el || !col) return
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(col)
    return () => ro.disconnect()
  }, [open !== null])

  const values: OptionValues | null = chat
    ? {
        provider: chat.pendingProvider ?? chat.provider,
        model: chat.pendingModel ?? chat.model ?? '',
        effort: chat.effort ?? '',
        serviceTier: chat.serviceTier ?? 'standard',
        permissionMode: chat.permissionMode ?? 'default'
      }
    : null

  return (
    <div className="flex h-full flex-col">
      <Header
        title={chat ? chatTitle(chat) : 'Chat'}
        subtitle={chat ? `${projectName(chat)}${chat.worktree ? ` · ${chat.worktree.branch}` : ''}` : undefined}
      />
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-3 pb-4">
        <div ref={column}>
        {open && open.hiddenBefore > 0 && (
          <div className="flex justify-center py-2 text-muted-foreground">
            {open.loading ? <Loader2 className="size-4 animate-spin" /> : <span className="text-[13px]">Scroll up for earlier messages</span>}
          </div>
        )}
        {!open || (open.loading && open.messages.length === 0) ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : open.messages.length === 0 && !busy ? (
          <div className="py-16 text-center text-[15px] text-muted-foreground">No messages yet.</div>
        ) : (
          chat &&
          transcriptChat && (
            <TranscriptSurfaceContext.Provider value={surface}>
            <TranscriptChat.Provider value={transcriptChat}>
              <Transcript
                chat={chat}
                busy={busy}
                requests={requests ?? NO_REQUESTS}
                expandedTurns={expandedTurns}
                onToggleTurn={toggleTurnExpanded}
                onOpenPlan={onOpenPlan}
              />
            </TranscriptChat.Provider>
            </TranscriptSurfaceContext.Provider>
          )
        )}
        </div>
      </div>
      {requests?.length ? (
        <div className="flex max-h-[60dvh] shrink-0 flex-col gap-2 overflow-y-auto px-3 pt-1">
          {requests.map((r) => (
            <PermissionCard key={r.id} chatId={chatId} request={r} provider={chat?.provider ?? 'claude'} />
          ))}
        </div>
      ) : null}
      {view?.kind === 'canvas' && <CanvasView id={view.id} onClose={() => setView(null)} />}
      {view?.kind === 'agent' && chat && (
        <AgentView
          parentId={chat.id}
          toolUseId={view.toolUseId}
          cwd={chat.cwd}
          onClose={() => setView(null)}
        />
      )}
      <Sheet open={plan !== null} onClose={() => setPlan(null)} title="Plan">
        <div className="max-h-[70dvh] overflow-y-auto px-4 pb-6">{plan && <Markdown text={plan} />}</div>
      </Sheet>
      <Composer
        chatId={chatId}
        busy={busy}
        queued={queued}
        above={chat?.pendingModel !== undefined && chat.pendingProvider ? <PendingSwitch chat={chat} /> : null}
        tools={
          values && (
            <OptionChips
              values={values}
              onChange={(patch, remember) =>
                void setOptions(chatId, {
                  ...(patch.model !== undefined ? { model: patch.model, modelProvider: patch.provider } : {}),
                  ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
                  ...(patch.serviceTier !== undefined ? { serviceTier: patch.serviceTier } : {}),
                  ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
                  remember
                })
              }
            />
          )
        }
      />
    </div>
  )
}

/** A cross-provider pick is armed, not applied — say so, and offer the way back. */
function PendingSwitch({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const all = useAllModels()
  const setOptions = useRemote((s) => s.setOptions)
  const to = chat.pendingProvider!
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-[13px] text-muted-foreground">
      <span className="min-w-0 flex-1">
        Switches to <span className="text-foreground">{modelDisplayName(chat.pendingModel, to, all)}</span> (
        {PROVIDER_LABELS[to]}) when you send — the conversation is handed over.
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-foreground"
        onClick={() =>
          void setOptions(chat.id, { model: chat.model ?? '', modelProvider: chat.provider, remember: false })
        }
      >
        Undo
      </button>
    </div>
  )
}

/**
 * The desktop's transcript (`useTranscript`), in the phone's scroller — every
 * block the desktop draws, grouped and folded the way it groups and folds
 * them. Its own component so a streamed token re-renders this and not the
 * composer and pickers around it.
 */
function Transcript({
  chat,
  busy,
  requests,
  expandedTurns,
  onToggleTurn,
  onOpenPlan
}: {
  chat: ChatMeta
  busy: boolean
  requests: PermissionRequestPayload[]
  expandedTurns: ReadonlySet<string>
  onToggleTurn: (userMessageId: string) => void
  onOpenPlan: (plan: string) => void
}): React.JSX.Element {
  const messages = useRemote((s) => (s.open?.id === chat.id ? s.open.messages : NO_MESSAGES))
  const { nodes, showActivity, activityLabel, showActivityLabel } = useTranscript({
    chat,
    messages,
    busy,
    permissions: requests,
    expandedTurns,
    onToggleTurn,
    onOpenPlan
  })
  return (
    <div className="flex flex-col gap-4">
      {nodes}
      {showActivity && (
        <div className="min-h-7">
          <StreamingIndicator label={activityLabel} visible={showActivityLabel} />
        </div>
      )}
    </div>
  )
}

const NO_MESSAGES: never[] = []

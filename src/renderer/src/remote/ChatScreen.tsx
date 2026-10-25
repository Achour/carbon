import * as React from 'react'
import { ArrowDown, Loader2 } from 'lucide-react'
import type { CanvasSummary, ChatMeta, PermissionRequestPayload } from '@shared/types'
import { PROVIDER_LABELS, modelDisplayName, projectRoot } from '@shared/types'
import { useApp } from '@/store'
import { cn } from '@/lib/utils'
import { useTranscript } from '@/components/Transcript'
import { Markdown } from '@/components/Markdown'
import { StreamingIndicator } from '@/components/messages/Parts'
import { TranscriptChat } from '@/components/messages/AgentRows'
import { TranscriptSurfaceContext, type TranscriptSurface } from '@/components/messages/surface'
import { useRemote } from './state'
import { Header, navigate } from './App'
import { invoke } from './api'
import { AgentView, CanvasView, ChangesScreen, DiffScreen } from './Viewers'
import { ChatMenu } from './ChatMenu'
import { chatTitle, isBusy, projectName } from './format'
import { Composer } from './Composer'
import { OptionChips } from './OptionChips'
import { useAllModels, type OptionValues } from './options'
import { PermissionCard } from './PermissionCard'
import { Sheet } from './Sheet'
import { chatDraftKey } from './drafts'
import { CodexReviewMenu } from '@/components/CodexReviewDialog'
import { isNative, notifyApp, useNativeCommand } from './native'

const NO_REQUESTS: PermissionRequestPayload[] = []

export function ChatScreen({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useRemote((s) => s.chats.find((c) => c.id === chatId))
  const open = useRemote((s) => (s.open?.id === chatId ? s.open : null))
  const status = useRemote((s) => s.statuses[chatId])
  const requests = useRemote((s) => s.permissions[chatId])
  const loadOlder = useRemote((s) => s.loadOlder)
  const connection = useRemote((s) => s.connection)
  const setOptions = useRemote((s) => s.setOptions)
  const busy = isBusy(status)
  const expandedTurns = useApp((s) => s.expandedTurns)
  const toggleTurnExpanded = useApp((s) => s.toggleTurnExpanded)
  const [plan, setPlan] = React.useState<string | null>(null)
  // Inside the iOS app the plan, a diff and a canvas open as the app's own
  // screens; only a sub-agent's transcript is still drawn here.
  const onOpenPlan = React.useCallback(
    (text: string) => (isNative ? notifyApp('open', { kind: 'plan', text }) : setPlan(text)),
    []
  )
  const transcriptChat = React.useMemo(
    () => (chat ? { chatId: chat.id, provider: chat.provider } : null),
    [chat?.id, chat?.provider]
  )
  const [view, setView] = React.useState<
    | { kind: 'canvas'; id: string }
    | { kind: 'agent'; toolUseId: string }
    | { kind: 'diff'; path: string }
    | { kind: 'changes' }
    | null
  >(null)
  const surface = React.useMemo<TranscriptSurface>(
    () => ({
      panels: false,
      openChat: (id) => navigate(`#/c/${encodeURIComponent(id)}`),
      openAgent: (_parent, toolUseId) => setView({ kind: 'agent', toolUseId }),
      openCanvas: (id) => (isNative ? notifyApp('open', { kind: 'canvas', id }) : setView({ kind: 'canvas', id })),
      openDiff: (path) =>
        isNative ? notifyApp('open', { kind: 'diff', chatId, path }) : setView({ kind: 'diff', path })
    }),
    [chatId]
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
  // Two bits of chrome that answer the scroll position — the header's hairline
  // and the jump-to-latest button — kept as state that flips only when the
  // answer does, so scrolling does not render the screen per frame.
  const [underHeader, setUnderHeader] = React.useState(false)
  const [awayFromEnd, setAwayFromEnd] = React.useState(false)
  const header = React.useRef<HTMLElement>(null)
  const [headerHeight, setHeaderHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = header.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight))
    ro.observe(el)
    setHeaderHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [])
  const toEnd = (): void => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  const toTop = (): void => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight
    pinned.current = fromEnd < 80
    const away = fromEnd > el.clientHeight * 0.6
    if (away !== awayFromEnd) setAwayFromEnd(away)
    const under = el.scrollTop > 2
    if (under !== underHeader) setUnderHeader(under)
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
    // The scroller itself resizes too, when the keyboard opens or closes:
    // the bottom edge holds, so what was just above the composer still is.
    let height = el.clientHeight
    const ro = new ResizeObserver(() => {
      const delta = height - el.clientHeight
      height = el.clientHeight
      if (pinned.current) el.scrollTop = el.scrollHeight
      else if (delta) el.scrollTop += delta
    })
    ro.observe(col)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open !== null])

  const [reviewOpen, setReviewOpen] = React.useState(false)
  // Inside the iOS app the header and the composer are the app's; it asks
  // for what their taps did here, and steps aside for what opens over the page.
  useNativeCommand('scrollTop', toTop)
  // The app's composer moved (the keyboard): the transcript's padding under
  // it changed by `delta`, so hold the bottom edge where the reader had it.
  React.useEffect(() => {
    if (!isNative) return undefined
    const on = (e: Event): void => {
      const el = scroller.current
      if (!el) return
      if (pinned.current) el.scrollTop = el.scrollHeight
      else el.scrollTop += (e as CustomEvent<number>).detail
    }
    window.addEventListener('carbon-native-insets', on)
    return () => window.removeEventListener('carbon-native-insets', on)
  }, [])
  // Dragging the transcript puts the app's keyboard away, once per drag.
  const dragging = React.useRef(false)
  const dragged = (): void => {
    if (dragging.current) return
    dragging.current = true
    notifyApp('drag')
  }
  const released = (): void => {
    dragging.current = false
  }
  const branch = useRemote((s) => (chat ? (s.branches[chat.cwd] ?? undefined) : undefined))
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
      <div className="relative min-h-0 flex-1">
      {!isNative && <Header
        ref={header}
        floating
        scrolled={underHeader}
        onTitleTap={toTop}
        actions={chat ? <ChatMenu chat={chat} onViewChanges={() => setView({ kind: 'changes' })} /> : undefined}
        title={chat ? chatTitle(chat) : 'Chat'}
        subtitle={chat ? `${projectName(chat)}${chat.worktree ? ` · ${chat.worktree.branch}` : ''}` : undefined}
      />}
      <div
        ref={scroller}
        onScroll={onScroll}
        onTouchMove={isNative ? dragged : undefined}
        onTouchEnd={isNative ? released : undefined}
        // The header floats over the top, measured, so the first line and
        // the earlier-messages hint start below it rather than under the blur.
        // Inside the iOS app the transcript runs under the app's glass bars,
        // top and bottom (the prompts waiting on an answer are the app's
        // too, over its composer), and pads itself clear of them.
        style={
          isNative
            ? { paddingTop: 'calc(var(--native-top, 0px) + 12px)', paddingBottom: 'calc(var(--native-bottom, 0px) + 16px)' }
            : { paddingTop: headerHeight + 12 }
        }
        className="h-full overflow-y-auto overscroll-contain px-6 pb-6"
      >
        <div ref={column} className="reading-zoom">
        {open && open.hiddenBefore > 0 && (
          <div className="flex justify-center py-2 text-muted-foreground">
            {open.loading ? <Loader2 className="size-4 animate-spin" /> : <span className="text-[13px]">Scroll up for earlier messages</span>}
          </div>
        )}
        {!open && !chat && connection === 'live' ? (
          // Deleted on the Mac, or a stale link: nothing is on its way, so a
          // skeleton would breathe forever.
          <div className="py-16 text-center text-[15px] text-muted-foreground">This chat no longer exists.</div>
        ) : !open || (open.loading && open.messages.length === 0) ? (
          // Still loading, or waiting on a reconnect, which the header's
          // connection strip names; the resync refetches the open chat.
          <TranscriptSkeleton />
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
      {/* The last lines fade into the composer instead of meeting a hard edge.
          An overlay rather than a mask on the scroller: a masked scroller is
          composited whole on every frame, and transcripts get long. */}
      {!isNative && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-background to-transparent" />
      )}
      <button
        type="button"
        aria-label="Jump to latest"
        tabIndex={awayFromEnd ? 0 : -1}
        onClick={toEnd}
        style={isNative ? { bottom: 'calc(var(--native-bottom, 0px) + 12px)' } : undefined}
        className={cn(
          'absolute bottom-3 left-1/2 z-10 flex size-10 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover/90 text-foreground shadow-lg backdrop-blur-md transition-[opacity,transform] duration-200 active:scale-90',
          awayFromEnd ? 'opacity-100' : 'pointer-events-none translate-y-2 scale-90 opacity-0'
        )}
      >
        <ArrowDown className="size-[18px]" />
        {/* The reader is up the page while the agent keeps going. */}
        {busy && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background" />}
      </button>
      </div>
      {!isNative && requests?.length ? (
        <div
          className="flex max-h-[60dvh] shrink-0 flex-col gap-2 overflow-y-auto px-3 pt-1"
        >
          {requests.map((r) => (
            <PermissionCard key={r.id} chatId={chatId} request={r} provider={chat?.provider ?? 'claude'} />
          ))}
        </div>
      ) : null}
      {view?.kind === 'canvas' && <CanvasView id={view.id} onClose={() => setView(null)} />}
      {view?.kind === 'diff' && <DiffScreen chatId={chatId} path={view.path} onClose={() => setView(null)} />}
      {view?.kind === 'changes' && <ChangesScreen chatId={chatId} onClose={() => setView(null)} />}
      {view?.kind === 'agent' && chat && (
        <AgentView
          parentId={chat.id}
          toolUseId={view.toolUseId}
          cwd={chat.cwd}
          onClose={() => setView(null)}
        />
      )}
      <Sheet open={plan !== null} onClose={() => setPlan(null)} title="Plan">
        <div className="max-h-[70dvh] overflow-y-auto px-4 pb-6">
          <div className="reading-zoom">{plan && <Markdown text={plan} />}</div>
        </div>
      </Sheet>
      <Composer
        chatId={chatId}
        cwd={chat?.cwd}
        provider={values?.provider}
        draftKey={chatDraftKey(chatId)}
        onCommand={(text) => {
          // Codex's `/review` opens its presets, as the desktop's composer does.
          if (values?.provider !== 'codex' || text.toLowerCase() !== '/review') return false
          setReviewOpen(true)
          return true
        }}
        context={
          chat?.contextTokens
            ? {
                used: chat.contextTokens,
                window: chat.contextWindow ?? 200_000,
                provider: chat.provider,
                chatId
              }
            : undefined
        }
        busy={busy}
        // Inside the iOS app the pending switch is the app's, over its composer.
        above={!isNative && chat?.pendingModel !== undefined && chat.pendingProvider ? <PendingSwitch chat={chat} /> : null}
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
      {chat && (
        <Sheet open={reviewOpen} onClose={() => setReviewOpen(false)}>
          <CodexReviewMenu
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            cwd={chat.cwd}
            currentBranch={chat.worktree?.branch ?? branch}
            onStart={(target) => invoke('chat:review', chatId, target)}
          />
        </Sheet>
      )}
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
        <div className="-mt-2 min-h-7">
          <StreamingIndicator label={activityLabel} visible={showActivityLabel} />
        </div>
      )}
    </div>
  )
}

const NO_MESSAGES: never[] = []

/**
 * What a chat looks like while its messages are on their way: a prompt and a
 * reply's lines, breathing, in the places they will land — so opening a chat
 * reads as the chat arriving rather than a spinner in an empty page.
 */
function TranscriptSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="flex animate-in flex-col gap-5 pt-2 duration-300 fade-in">
      <div className="ml-auto h-16 w-[72%] animate-pulse-soft rounded-[20px] bg-muted" />
      <div className="flex flex-col gap-2.5">
        <div className="h-3.5 w-[92%] animate-pulse-soft rounded-full bg-muted" />
        <div className="h-3.5 w-[84%] animate-pulse-soft rounded-full bg-muted" />
        <div className="h-3.5 w-[64%] animate-pulse-soft rounded-full bg-muted" />
      </div>
      <div className="h-24 w-full animate-pulse-soft rounded-2xl bg-muted/70" />
      <div className="flex flex-col gap-2.5">
        <div className="h-3.5 w-[88%] animate-pulse-soft rounded-full bg-muted" />
        <div className="h-3.5 w-[46%] animate-pulse-soft rounded-full bg-muted" />
      </div>
    </div>
  )
}

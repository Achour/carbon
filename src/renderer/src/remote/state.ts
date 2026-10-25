import { create } from 'zustand'
import type {
  AppDefaults,
  AssistantMessage,
  BackgroundJob,
  Attachment,
  ChatEvent,
  ChatMessage,
  ChatMeta,
  ChatOptionsPatch,
  ChatStatus,
  ContextUsage,
  EffortId,
  ModelOption,
  PermissionModeId,
  Provider,
  ServiceTier,
  ChatView,
  CodexReviewTarget,
  OlderMessages,
  PermissionDecision,
  PermissionRequestPayload,
  RemoteUnseen,
  UsageOverview,
  UsageReport,
  WorktreeTarget
} from '@shared/types'
import { USAGE_DEFAULT_DAYS } from '@shared/types'
import { randomId } from '@/lib/insecureContext'
import * as api from './api'
import { usePrefs } from './prefs'
import { clearCache, loadChat, loadSnapshot, saveChat, saveSnapshot } from './cache'

/**
 * The phone's whole state. Deliberately not the desktop store: that one is
 * five thousand lines about threads, panels, editors and previews, and
 * reaches for `window.api` at every turn. What a phone needs is the chat
 * list, one open transcript, and the prompts waiting on an answer — and the
 * reducer for those is the part of `applyEvent` that is small.
 */

/** What the New-chat screen's pickers hold. */
export interface NewChatOptions {
  cwd: string
  provider: Provider
  model: string
  effort: EffortId | ''
  serviceTier: ServiceTier
  permissionMode: PermissionModeId
  /** Where it runs; the main checkout when absent. */
  worktree?: WorktreeTarget
}

export type Connection = 'connecting' | 'live' | 'down' | 'unpaired'

export interface OpenChat {
  id: string
  messages: ChatMessage[]
  hiddenBefore: number
  loading: boolean
  /** The context ring's breakdown; it only ever arrives as an event. */
  contextUsage?: ContextUsage
}

interface RemoteState {
  connection: Connection
  hostname: string
  chats: ChatMeta[]
  statuses: Record<string, ChatStatus>
  /** The provider's guess at each idle chat's next message (`suggestion`). */
  suggestions: Record<string, string>
  permissions: Record<string, PermissionRequestPayload[]>
  /** What each chat left running in the background: a dev server, a shell. */
  jobs: Record<string, BackgroundJob[]>
  /** The folders that hold the Mac's projects: where a new one may go. */
  projectParents: string[]
  /** Turns that ended while this phone was not looking — the home screen's Done (`board.ts`). */
  unseen: Record<string, RemoteUnseen>
  defaults: AppDefaults | null
  /** The model picker's inputs — see `RemoteSnapshot.models`. */
  models: ModelOption[]
  codexConfigModel: string | null
  available: Provider[]
  /** Project marks by root (`/api/icons`); a missing entry draws initials. */
  icons: Record<string, string | null>
  /** The Mac's home folder (`RemoteSnapshot.home`). */
  home: string
  /** Each chat folder's branch, read only while the sidebar is detailed. */
  branches: Record<string, string | null>
  /** The plan's headroom (`usage:overview`); null until the first read lands. */
  usage: UsageOverview | null
  /** The Usage screen's history (`usage:report`), for `usageDays`. */
  usageReport: UsageReport | null
  usageDays: number
  usageReportLoading: boolean
  /** The sidebar drawer. */
  drawer: boolean
  open: OpenChat | null
  /** Typed while a turn ran; sent, oldest first, as the chat goes idle. */
  queued: Record<string, QueuedMessage[]>
  error: string | null

  start(): void
  openChat(id: string | null): Promise<void>
  loadOlder(): Promise<void>
  send(chatId: string, text: string, attachments?: Attachment[]): Promise<void>
  interrupt(chatId: string): Promise<void>
  /**
   * A new, empty project folder on the Mac (`projects:create`), listed among
   * the recent projects at once so the New-chat screen can pick it.
   */
  createProject(parent: string, name: string, git: boolean): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Force a queued message through now: interrupt the running turn and send it. */
  sendQueuedNow(chatId: string, id: string): Promise<void>
  removeQueued(chatId: string, id: string): void
  respond(chatId: string, requestId: string, decision: PermissionDecision): Promise<void>
  setOptions(chatId: string, patch: ChatOptionsPatch): Promise<void>
  /** Starts with `text`, or with Codex's native reviewer when `review` is given. */
  createChat(
    options: NewChatOptions,
    text: string,
    attachments?: Attachment[],
    review?: CodexReviewTarget
  ): Promise<string>
  /** Take everything off the home screen's Done. */
  clearDone(): Promise<void>
  setError(error: string | null): void
  setDrawer(open: boolean): void
  refreshBranches(): Promise<void>
  refreshUsage(force?: boolean): Promise<void>
  loadUsageReport(days?: number, refresh?: boolean): Promise<void>
}

export interface QueuedMessage {
  id: string
  text: string
  attachments?: Attachment[]
}

let conn: string | null = null
const visible = (): boolean => document.visibilityState === 'visible'
let closeEvents: (() => void) | null = null

/** The last launch's chat list, drawn while this one connects (`cache.ts`). */
const cached = loadSnapshot()

export const useRemote = create<RemoteState>((set, get) => {
  // What the next launch draws first: the list as it stands, and the chat on screen.
  const persist = (): void => {
    const s = get()
    if (s.connection !== 'live' || !s.defaults) return
    saveSnapshot({
      hostname: s.hostname,
      home: s.home,
      chats: s.chats,
      unseen: s.unseen,
      defaults: s.defaults,
      models: s.models,
      codexConfigModel: s.codexConfigModel,
      available: s.available,
      icons: s.icons
    })
    if (s.open && !s.open.loading) saveChat(s.open.id, s.open.messages, s.open.hiddenBefore)
  }

  const resync = async (): Promise<void> => {
    try {
      const snap = await api.snapshot()
      set({
        hostname: snap.hostname,
        home: snap.home ?? '',
        projectParents: snap.projectParents ?? [],
        chats: snap.chats,
        statuses: snap.statuses,
        suggestions: snap.suggestions ?? {},
        permissions: snap.permissions,
        jobs: snap.jobs ?? {},
        unseen: snap.unseen ?? {},
        defaults: snap.defaults,
        models: snap.models ?? [],
        codexConfigModel: snap.codexConfigModel ?? null,
        available: snap.available ?? [],
        connection: 'live'
      })
      persist()
      // Marks are a walk of the project folders on the Mac — cached there, but
      // never worth holding the first screen for.
      void api
        .icons()
        .then((icons) => {
          set({ icons })
          persist()
        })
        .catch(() => {})
      void get().refreshBranches()
      void get().refreshUsage()
      // A queue only drains on a live "idle" event, and a phone that was
      // locked when the turn ended never heard one: send what is waiting
      // behind any chat the snapshot says has finished.
      for (const chatId of Object.keys(get().queued)) {
        if ((snap.statuses[chatId] ?? 'idle') === 'idle') void drainQueue(chatId)
      }
      // Whatever streamed while the phone was away is in the database now;
      // refetching is simpler and surer than replaying.
      const open = get().open
      if (open) await fetchOpen(open.id)
    } catch (err) {
      if (err instanceof api.RemoteError && err.status === 401) {
        clearCache()
        set({ connection: 'unpaired' })
      } else set({ connection: 'down' })
    }
  }

  const fetchOpen = async (id: string): Promise<void> => {
    const view = await api.invoke<ChatView | null>('chats:get', id)
    if (get().open?.id !== id) return
    if (!view) {
      set({ open: null })
      return
    }
    set((s) => ({
      open: {
        id,
        messages: view.chat.messages,
        hiddenBefore: view.hiddenBefore,
        loading: false,
        contextUsage: s.open?.id === id ? s.open.contextUsage : undefined
      },
      chats: s.chats.some((c) => c.id === id)
        ? s.chats.map((c) => (c.id === id ? stripMessages(view.chat) : c))
        : [...s.chats, stripMessages(view.chat)]
    }))
    saveChat(id, view.chat.messages, view.hiddenBefore)
  }

  const connect = (): void => {
    closeEvents?.()
    set({ connection: 'connecting' })
    closeEvents = api.connectEvents({
      onHello: (id) => {
        conn = id
        void api.watch(id, get().open?.id ?? null, visible()).catch(() => {})
        void resync()
      },
      onEvent: (ev) => {
        set((s) => reduce(s, ev))
        if (ev.type === 'status' && ev.status === 'idle') {
          void drainQueue(ev.chatId)
          // A turn can have switched branch; the desktop rereads at the same moment.
          void get().refreshBranches()
          // A turn just drew the plan down; main's cache throttles the read.
          void get().refreshUsage()
        }
      },
      onUnseen: (unseen) => set({ unseen }),
      onDown: (closed) => {
        conn = null
        // A revoked cookie is final. Anything else is the network: EventSource
        // retries on its own unless the answer was an error status, and then
        // the retry is ours.
        void api
          .paired()
          .then((ok) => {
            if (!ok) {
              closeEvents?.()
              set({ connection: 'unpaired' })
              return
            }
            set({ connection: 'down' })
            if (closed) setTimeout(connect, 3000)
          })
          .catch(() => {
            set({ connection: 'down' })
            if (closed) setTimeout(connect, 3000)
          })
      }
    })
  }

  const drainQueue = async (chatId: string): Promise<void> => {
    const [next, ...rest] = get().queued[chatId] ?? []
    if (!next) return
    set((s) => ({ queued: { ...s.queued, [chatId]: rest } }))
    await get().send(chatId, next.text, next.attachments)
  }

  return {
    connection: 'connecting',
    hostname: cached?.hostname ?? '',
    chats: cached?.chats ?? [],
    statuses: {},
    suggestions: {},
    permissions: {},
    jobs: {},
    projectParents: [],
    unseen: cached?.unseen ?? {},
    defaults: cached?.defaults ?? null,
    models: cached?.models ?? [],
    codexConfigModel: cached?.codexConfigModel ?? null,
    available: cached?.available ?? [],
    icons: cached?.icons ?? {},
    home: cached?.home ?? '',
    branches: {},
    usage: null,
    usageReport: null,
    usageDays: USAGE_DEFAULT_DAYS,
    usageReportLoading: false,
    drawer: false,
    open: null,
    queued: {},
    error: null,

    start() {
      connect()
      // iOS freezes a backgrounded page's sockets without telling it. Coming
      // back, a stream that is not live is reopened rather than waited on.
      document.addEventListener('visibilitychange', () => {
        // Going away: tell the Mac first, so a turn that finishes while the
        // stream is still half-open notifies instead of assuming it was seen.
        if (!visible() && conn) void api.watch(conn, get().open?.id ?? null, false).catch(() => {})
        // Leaving is the last moment to keep what streamed since the last save.
        if (!visible()) persist()
        if (document.visibilityState === 'visible' && get().connection !== 'unpaired') {
          if (get().connection !== 'live' || !conn) connect()
          else {
            // Back on screen: undo the hidden report, or the Mac goes on
            // notifying about the chat being read, and marking it unseen.
            void api.watch(conn, get().open?.id ?? null, true).catch(() => {})
            void resync()
          }
        }
      })
    },

    async openChat(id) {
      if (get().open?.id === id) return
      // Off Done at once; the Mac clears its mark on the watch below and says so.
      // The transcript as this phone last saw it, at once, while the Mac's
      // copy is fetched to replace it.
      const seen = id ? loadChat(id) : null
      set((s) => ({
        open: id ? { id, messages: seen?.messages ?? [], hiddenBefore: seen?.hiddenBefore ?? 0, loading: true } : null,
        ...(id && id in s.unseen ? { unseen: omit(s.unseen, id) } : {})
      }))
      if (conn) void api.watch(conn, id, visible()).catch(() => {})
      if (id) {
        try {
          await fetchOpen(id)
        } catch (err) {
          // The Mac unreachable is the connection strip's to say, over the
          // cached transcript; only an answer that is an error is news.
          if (err instanceof api.RemoteError) set({ error: message(err) })
          else set((s) => (s.open?.id === id ? { open: { ...s.open, loading: false } } : {}))
        }
      }
    },

    async loadOlder() {
      const open = get().open
      if (!open || open.hiddenBefore === 0 || open.loading) return
      set({ open: { ...open, loading: true } })
      try {
        const older = await api.invoke<OlderMessages>('chats:load-older', open.id, open.hiddenBefore)
        set((s) =>
          s.open?.id === open.id
            ? {
                open: {
                  ...s.open,
                  messages: [...older.messages, ...s.open.messages],
                  hiddenBefore: older.from,
                  loading: false
                }
              }
            : {}
        )
      } catch (err) {
        set({ error: message(err), open: { ...open, loading: false } })
      }
    },

    async send(chatId, text, attachments) {
      const status = get().statuses[chatId] ?? 'idle'
      if (status !== 'idle') {
        set((s) => ({
          queued: { ...s.queued, [chatId]: [...(s.queued[chatId] ?? []), { id: randomId(), text, attachments }] }
        }))
        return
      }
      try {
        await api.invoke('chat:send', chatId, text, attachments?.length ? attachments : undefined)
      } catch (err) {
        set({ error: message(err) })
      }
    },

    async createProject(parent, name, git) {
      try {
        const made = await api.invoke<{ ok: true; path: string } | { ok: false; error: string }>(
          'projects:create',
          parent,
          name,
          git
        )
        if (made.ok) {
          // The Mac put it first among its recent folders; so does this copy,
          // until the next snapshot says the same.
          set((s) => ({
            defaults: s.defaults
              ? { ...s.defaults, recentDirs: [made.path, ...s.defaults.recentDirs.filter((d) => d !== made.path)] }
              : s.defaults
          }))
        }
        return made
      } catch (err) {
        return { ok: false, error: message(err) }
      }
    },

    async interrupt(chatId) {
      // Stopping also means "don't send what I queued behind it".
      set((s) => ({ queued: { ...s.queued, [chatId]: [] } }))
      await api.invoke('chat:interrupt', chatId).catch((err) => set({ error: message(err) }))
    },

    async sendQueuedNow(chatId, id) {
      const item = get().queued[chatId]?.find((q) => q.id === id)
      if (!item) return
      const rest = (get().queued[chatId] ?? []).filter((q) => q.id !== id)
      if ((get().statuses[chatId] ?? 'idle') !== 'idle') {
        // To the front, so the idle drain sends this one first, then interrupt
        // so that idle comes now rather than at turn end. Not `interrupt()`:
        // that one empties the queue.
        set((s) => ({ queued: { ...s.queued, [chatId]: [item, ...rest] } }))
        await api.invoke('chat:interrupt', chatId).catch((err) => set({ error: message(err) }))
        return
      }
      set((s) => ({ queued: { ...s.queued, [chatId]: rest } }))
      await get().send(chatId, item.text, item.attachments)
    },

    removeQueued(chatId, id) {
      set((s) => ({
        queued: { ...s.queued, [chatId]: (s.queued[chatId] ?? []).filter((q) => q.id !== id) }
      }))
    },

    async respond(chatId, requestId, decision) {
      // Dropped at once: the resolved event follows, and a stale request
      // (answered on the Mac meanwhile) is a no-op in main either way.
      set((s) => ({
        permissions: {
          ...s.permissions,
          [chatId]: (s.permissions[chatId] ?? []).filter((r) => r.id !== requestId)
        }
      }))
      await api
        .invoke('chat:respond-permission', chatId, requestId, decision)
        .catch((err) => set({ error: message(err) }))
    },

    async setOptions(chatId, patch) {
      // Drawn at once; main's `meta` event follows with what actually applied
      // (a cross-provider model arms `pendingModel` rather than `model`).
      const { model: _model, modelProvider: _provider, remember: _remember, effort, ...now } = patch
      const drawn: Partial<ChatMeta> = { ...now, ...(effort !== undefined ? { effort: effort || undefined } : {}) }
      set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...drawn } : c)) }))
      await api.invoke('chat:set-options', chatId, patch).catch((err) => set({ error: message(err) }))
    },

    async createChat(options, text, attachments, review) {
      const target = options.worktree?.kind === 'local' ? undefined : options.worktree
      // Everything explicit, as the desktop's New-chat screen sends it:
      // `chats:create` remembers what it is given as the next chat's defaults.
      // An existing worktree is created against its repository, so recents and
      // the sidebar's grouping follow the project, not the worktree.
      const meta = await api.invoke<ChatMeta>('chats:create', {
        cwd: target?.kind === 'existing' ? target.repoRoot : options.cwd,
        provider: options.provider,
        model: options.model,
        effort: options.effort || undefined,
        serviceTier: options.serviceTier,
        permissionMode: options.permissionMode,
        worktree: target
      })
      set((s) => ({ chats: s.chats.some((c) => c.id === meta.id) ? s.chats : [...s.chats, meta] }))
      await get().openChat(meta.id)
      if (review) await api.invoke('chat:review', meta.id, review)
      else await get().send(meta.id, text, attachments)
      return meta.id
    },

    async clearDone() {
      const before = get().unseen
      set({ unseen: {} })
      await api.markSeen().catch((err) => set({ error: message(err), unseen: before }))
    },

    setError(error) {
      set({ error })
    },

    setDrawer(drawer) {
      set({ drawer })
    },

    async refreshBranches() {
      // Compact rows never show a branch, so the read is pure cost there —
      // the desktop's guard (`refreshChatBranches`), for the same reason.
      if (usePrefs.getState().sidebarDensity !== 'detailed' || get().connection !== 'live') return
      try {
        set({ branches: await api.branches() })
      } catch {
        // A row without a branch falls back to its folder.
      }
    },

    async refreshUsage(force = false) {
      if (get().connection !== 'live') return
      try {
        set({ usage: await api.invoke<UsageOverview>('usage:overview', force || undefined) })
      } catch {
        // Keep the last good numbers: a stale percentage beats none.
      }
    },

    // The desktop's loader (`loadUsageReport` in the desktop store), over the relay.
    async loadUsageReport(days, refresh = false) {
      const want = days ?? get().usageDays
      // The range buttons are the loading surface: commit the choice first.
      set({ usageDays: want, usageReportLoading: true })
      try {
        const report = await api.invoke<UsageReport>('usage:report', want, refresh || undefined)
        // A range switched mid-scan wins: the report that lands is stale.
        if (get().usageDays === want) set({ usageReport: report })
      } catch (err) {
        set({ error: message(err) })
      } finally {
        if (get().usageDays === want) set({ usageReportLoading: false })
      }
    }
  }
})

// Switching to detailed rows wants the branches now, not at the next turn's end.
usePrefs.subscribe((s, prev) => {
  if (s.sidebarDensity !== prev.sidebarDensity) void useRemote.getState().refreshBranches()
})

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = record
  return rest
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stripMessages(chat: ChatView['chat']): ChatMeta {
  const { messages: _messages, ...meta } = chat
  return meta
}

function updateAssistant(
  messages: ChatMessage[],
  id: string,
  fn: (m: AssistantMessage) => AssistantMessage
): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === id)
  const m = messages[i]
  if (!m || m.role !== 'assistant') return messages
  const next = messages.slice()
  next[i] = fn(m)
  return next
}

/** The slice of the desktop's `applyEvent` a phone needs. */
export function reduce(s: RemoteState, ev: ChatEvent): Partial<RemoteState> {
  const open = s.open && s.open.id === ev.chatId ? s.open : null
  const patchOpen = (fn: (msgs: ChatMessage[]) => ChatMessage[]): Partial<RemoteState> =>
    open ? { open: { ...open, messages: fn(open.messages) } } : {}

  switch (ev.type) {
    case 'message': {
      const chats = s.chats.map((c) => (c.id === ev.chatId ? { ...c, updatedAt: Date.now() } : c))
      return {
        chats,
        ...patchOpen((msgs) => {
          const i = msgs.findIndex((m) => m.id === ev.message.id)
          if (i < 0) return [...msgs, ev.message]
          const next = msgs.slice()
          next[i] = ev.message
          return next
        })
      }
    }
    case 'part':
      return patchOpen((msgs) =>
        updateAssistant(msgs, ev.messageId, (m) => {
          const parts = m.parts.slice()
          parts[ev.partIndex] = ev.part
          return { ...m, parts }
        })
      )
    case 'part-delta':
      return patchOpen((msgs) =>
        updateAssistant(msgs, ev.messageId, (m) => {
          const parts = m.parts.slice()
          const part = parts[ev.partIndex]
          if (part && (part.type === 'text' || part.type === 'thinking'))
            parts[ev.partIndex] = { ...part, text: part.text + ev.delta }
          return { ...m, parts }
        })
      )
    case 'tool-update':
      return patchOpen((msgs) =>
        updateAssistant(msgs, ev.messageId, (m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p && p.type === 'tool' && p.toolUseId === ev.toolUseId ? { ...p, ...ev.patch } : p
          )
        }))
      )
    case 'context-usage':
      return open ? { open: { ...open, contextUsage: ev.usage } } : {}
    case 'truncate':
      return open
        ? {
            open: {
              ...open,
              messages: open.messages.slice(0, Math.max(0, ev.keep - open.hiddenBefore))
            }
          }
        : {}
    case 'meta': {
      // A cleared field crosses the wire as `null` (`wire` in remoteAccess.ts).
      const patch = Object.fromEntries(
        Object.entries(ev.patch).map(([k, v]) => [k, v === null ? undefined : v])
      ) as typeof ev.patch
      return { chats: s.chats.map((c) => (c.id === ev.chatId ? { ...c, ...patch } : c)) }
    }
    case 'status': {
      // A turn starting withdraws the last one's suggested reply.
      if (ev.status === 'idle' || !s.suggestions[ev.chatId]) {
        return { statuses: { ...s.statuses, [ev.chatId]: ev.status } }
      }
      const { [ev.chatId]: _gone, ...suggestions } = s.suggestions
      return { statuses: { ...s.statuses, [ev.chatId]: ev.status }, suggestions }
    }
    case 'suggestion': {
      const { [ev.chatId]: _prior, ...rest } = s.suggestions
      return { suggestions: ev.text ? { ...rest, [ev.chatId]: ev.text } : rest }
    }
    case 'background-jobs': {
      const { [ev.chatId]: _prior, ...rest } = s.jobs
      return { jobs: ev.jobs.length ? { ...rest, [ev.chatId]: ev.jobs } : rest }
    }
    case 'permission-request':
      return {
        permissions: {
          ...s.permissions,
          [ev.chatId]: [
            ...(s.permissions[ev.chatId] ?? []).filter((r) => r.id !== ev.request.id),
            ev.request
          ]
        }
      }
    case 'permission-resolved':
      return {
        permissions: {
          ...s.permissions,
          [ev.chatId]: (s.permissions[ev.chatId] ?? []).filter((r) => r.id !== ev.requestId)
        }
      }
    case 'chat-added':
      return s.chats.some((c) => c.id === ev.meta.id) ? {} : { chats: [...s.chats, ev.meta] }
    default:
      return {}
  }
}

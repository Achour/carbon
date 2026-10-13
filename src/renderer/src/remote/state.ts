import { create } from 'zustand'
import type {
  AppDefaults,
  AssistantMessage,
  Attachment,
  ChatEvent,
  ChatMessage,
  ChatMeta,
  ChatOptionsPatch,
  ChatStatus,
  EffortId,
  ModelOption,
  PermissionModeId,
  Provider,
  ServiceTier,
  ChatView,
  OlderMessages,
  PermissionDecision,
  PermissionRequestPayload
} from '@shared/types'
import * as api from './api'

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
}

export type Connection = 'connecting' | 'live' | 'down' | 'unpaired'

export interface OpenChat {
  id: string
  messages: ChatMessage[]
  hiddenBefore: number
  loading: boolean
}

interface RemoteState {
  connection: Connection
  hostname: string
  chats: ChatMeta[]
  statuses: Record<string, ChatStatus>
  permissions: Record<string, PermissionRequestPayload[]>
  defaults: AppDefaults | null
  /** The model picker's inputs — see `RemoteSnapshot.models`. */
  models: ModelOption[]
  codexConfigModel: string | null
  available: Provider[]
  /** Project marks by root (`/api/icons`); a missing entry draws initials. */
  icons: Record<string, string | null>
  /** The sidebar drawer. */
  drawer: boolean
  open: OpenChat | null
  /** Typed while a turn ran; sent, oldest first, as the chat goes idle. */
  queued: Record<string, { text: string; attachments?: Attachment[] }[]>
  error: string | null

  start(): void
  openChat(id: string | null): Promise<void>
  loadOlder(): Promise<void>
  send(chatId: string, text: string, attachments?: Attachment[]): Promise<void>
  interrupt(chatId: string): Promise<void>
  respond(chatId: string, requestId: string, decision: PermissionDecision): Promise<void>
  setOptions(chatId: string, patch: ChatOptionsPatch): Promise<void>
  createChat(
    options: NewChatOptions,
    text: string,
    attachments?: Attachment[]
  ): Promise<string>
  setError(error: string | null): void
  setDrawer(open: boolean): void
}

let conn: string | null = null
let closeEvents: (() => void) | null = null

export const useRemote = create<RemoteState>((set, get) => {
  const resync = async (): Promise<void> => {
    try {
      const snap = await api.snapshot()
      set({
        hostname: snap.hostname,
        chats: snap.chats,
        statuses: snap.statuses,
        permissions: snap.permissions,
        defaults: snap.defaults,
        models: snap.models ?? [],
        codexConfigModel: snap.codexConfigModel ?? null,
        available: snap.available ?? [],
        connection: 'live'
      })
      // Marks are a walk of the project folders on the Mac — cached there, but
      // never worth holding the first screen for.
      void api
        .icons()
        .then((icons) => set({ icons }))
        .catch(() => {})
      // Whatever streamed while the phone was away is in the database now;
      // refetching is simpler and surer than replaying.
      const open = get().open
      if (open) await fetchOpen(open.id)
    } catch (err) {
      if (err instanceof api.RemoteError && err.status === 401) set({ connection: 'unpaired' })
      else set({ connection: 'down' })
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
      open: { id, messages: view.chat.messages, hiddenBefore: view.hiddenBefore, loading: false },
      chats: s.chats.some((c) => c.id === id)
        ? s.chats.map((c) => (c.id === id ? stripMessages(view.chat) : c))
        : [...s.chats, stripMessages(view.chat)]
    }))
  }

  const connect = (): void => {
    closeEvents?.()
    set({ connection: 'connecting' })
    closeEvents = api.connectEvents({
      onHello: (id) => {
        conn = id
        void api.watch(id, get().open?.id ?? null).catch(() => {})
        void resync()
      },
      onEvent: (ev) => {
        set((s) => reduce(s, ev))
        if (ev.type === 'status' && ev.status === 'idle') void drainQueue(ev.chatId)
      },
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
    hostname: '',
    chats: [],
    statuses: {},
    permissions: {},
    defaults: null,
    models: [],
    codexConfigModel: null,
    available: [],
    icons: {},
    drawer: false,
    open: null,
    queued: {},
    error: null,

    start() {
      connect()
      // iOS freezes a backgrounded page's sockets without telling it. Coming
      // back, a stream that is not live is reopened rather than waited on.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && get().connection !== 'unpaired') {
          if (get().connection !== 'live' || !conn) connect()
          else void resync()
        }
      })
    },

    async openChat(id) {
      if (get().open?.id === id) return
      set({ open: id ? { id, messages: [], hiddenBefore: 0, loading: true } : null })
      if (conn) void api.watch(conn, id).catch(() => {})
      if (id) {
        try {
          await fetchOpen(id)
        } catch (err) {
          set({ error: message(err) })
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
          queued: { ...s.queued, [chatId]: [...(s.queued[chatId] ?? []), { text, attachments }] }
        }))
        return
      }
      try {
        await api.invoke('chat:send', chatId, text, attachments?.length ? attachments : undefined)
      } catch (err) {
        set({ error: message(err) })
      }
    },

    async interrupt(chatId) {
      // Stopping also means "don't send what I queued behind it".
      set((s) => ({ queued: { ...s.queued, [chatId]: [] } }))
      await api.invoke('chat:interrupt', chatId).catch((err) => set({ error: message(err) }))
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

    async createChat(options, text, attachments) {
      // Everything explicit, as the desktop's New-chat screen sends it:
      // `chats:create` remembers what it is given as the next chat's defaults.
      const meta = await api.invoke<ChatMeta>('chats:create', {
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
        effort: options.effort || undefined,
        serviceTier: options.serviceTier,
        permissionMode: options.permissionMode
      })
      set((s) => ({ chats: s.chats.some((c) => c.id === meta.id) ? s.chats : [...s.chats, meta] }))
      await get().openChat(meta.id)
      await get().send(meta.id, text, attachments)
      return meta.id
    },

    setError(error) {
      set({ error })
    },

    setDrawer(drawer) {
      set({ drawer })
    }
  }
})

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
    case 'status':
      return { statuses: { ...s.statuses, [ev.chatId]: ev.status } }
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

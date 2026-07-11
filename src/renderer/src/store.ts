import { create } from 'zustand'
import type {
  AppDefaults,
  AssistantMessage,
  ChatEvent,
  ChatMessage,
  ChatMeta,
  ChatStatus,
  EffortId,
  FileContent,
  FileEntry,
  PermissionDecision,
  PermissionRequestPayload
} from '@shared/types'

export interface PlanPanelState {
  chatId: string
  plan: string
  /** Set while an ExitPlanMode permission request is pending; null = read-only view. */
  requestId: string | null
}

interface AppState {
  chats: ChatMeta[]
  activeId: string | null
  /** Project folder new chats start in; follows the active chat. */
  selectedCwd: string | null
  /** Messages of the active chat. */
  messages: ChatMessage[]
  statuses: Record<string, ChatStatus>
  /** Pending permission requests, keyed by chat id. */
  permissions: Record<string, PermissionRequestPayload[]>
  planPanel: PlanPanelState | null
  defaults: AppDefaults | null
  loading: boolean
  sidebarOpen: boolean
  toggleSidebar(): void

  // ---- Files ----
  /** Whether the right-side workspace panel (tabs + file tree) is open. */
  panelOpen: boolean
  /** Directory listing cache, keyed by absolute dir path. */
  filesByDir: Record<string, FileEntry[]>
  expandedDirs: Record<string, boolean>
  openFiles: { path: string; name: string }[]
  fileContents: Record<string, FileContent>
  /** 'plan' or an open file path. */
  activeTab: string | null

  togglePanel(): void
  loadDir(dir: string): Promise<void>
  toggleDir(dir: string): void
  openFile(path: string): Promise<void>
  closeFile(path: string): void
  setActiveTab(tab: string): void
  refreshFiles(): Promise<void>

  init(): Promise<void>
  setSelectedCwd(cwd: string | null): void
  openPlanPanel(panel: PlanPanelState): void
  closePlanPanel(): void
  openChat(id: string | null): Promise<void>
  newChat(
    cwd: string,
    firstMessage: string,
    opts?: { model?: string; effort?: EffortId; permissionMode?: ChatMeta['permissionMode'] }
  ): Promise<void>
  sendMessage(text: string): Promise<void>
  interrupt(): Promise<void>
  deleteChat(id: string): Promise<void>
  renameChat(id: string, title: string): Promise<void>
  setChatOptions(patch: {
    model?: string
    effort?: EffortId | ''
    permissionMode?: ChatMeta['permissionMode']
  }): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  applyEvent(ev: ChatEvent): void
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx === -1) return [...messages, message]
  const next = messages.slice()
  next[idx] = message
  return next
}

export const useApp = create<AppState>((set, get) => ({
  chats: [],
  activeId: null,
  selectedCwd: null,
  messages: [],
  statuses: {},
  permissions: {},
  planPanel: null,
  defaults: null,
  loading: true,
  sidebarOpen: localStorage.getItem('sidebarOpen') !== 'false',

  toggleSidebar() {
    set((s) => {
      const open = !s.sidebarOpen
      localStorage.setItem('sidebarOpen', String(open))
      return { sidebarOpen: open }
    })
  },

  async init() {
    const [chats, defaults] = await Promise.all([window.api.listChats(), window.api.getDefaults()])
    set({
      chats,
      defaults,
      loading: false,
      selectedCwd: chats[0]?.cwd ?? defaults.recentDirs[0] ?? null
    })
  },

  setSelectedCwd(cwd) {
    set({ selectedCwd: cwd })
  },

  openPlanPanel(panel) {
    set({ planPanel: panel, activeTab: 'plan', panelOpen: true })
  },

  closePlanPanel() {
    set((s) => ({
      planPanel: null,
      activeTab: s.activeTab === 'plan' ? (s.openFiles[0]?.path ?? null) : s.activeTab
    }))
  },

  // ---- Files ----

  panelOpen: false,
  filesByDir: {},
  expandedDirs: {},
  openFiles: [],
  fileContents: {},
  activeTab: null,

  togglePanel() {
    const opening = !get().panelOpen
    set({ panelOpen: opening })
    if (opening) {
      const cwd = get().selectedCwd
      if (cwd && !get().filesByDir[cwd]) void get().loadDir(cwd)
    }
  },

  async loadDir(dir) {
    try {
      const entries = await window.api.listDir(dir)
      set((s) => ({ filesByDir: { ...s.filesByDir, [dir]: entries } }))
    } catch {
      set((s) => ({ filesByDir: { ...s.filesByDir, [dir]: [] } }))
    }
  },

  toggleDir(dir) {
    const expanded = !get().expandedDirs[dir]
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [dir]: expanded } }))
    if (expanded && !get().filesByDir[dir]) void get().loadDir(dir)
  },

  async openFile(path) {
    const name = path.split('/').pop() ?? path
    set((s) => ({
      openFiles: s.openFiles.some((f) => f.path === path)
        ? s.openFiles
        : [...s.openFiles, { path, name }],
      activeTab: path,
      panelOpen: true
    }))
    const content = await window.api.readFile(path)
    set((s) => ({ fileContents: { ...s.fileContents, [path]: content } }))
  },

  closeFile(path) {
    set((s) => {
      const openFiles = s.openFiles.filter((f) => f.path !== path)
      const fileContents = { ...s.fileContents }
      delete fileContents[path]
      let activeTab = s.activeTab
      if (activeTab === path) {
        activeTab = openFiles[openFiles.length - 1]?.path ?? (s.planPanel ? 'plan' : null)
      }
      return { openFiles, fileContents, activeTab }
    })
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
  },

  async refreshFiles() {
    const s = get()
    const dirs = [
      ...(s.selectedCwd ? [s.selectedCwd] : []),
      ...Object.keys(s.expandedDirs).filter((d) => s.expandedDirs[d] && s.filesByDir[d])
    ]
    await Promise.all(dirs.map((d) => s.loadDir(d)))
    await Promise.all(
      s.openFiles.map(async (f) => {
        const content = await window.api.readFile(f.path)
        set((st) => ({ fileContents: { ...st.fileContents, [f.path]: content } }))
      })
    )
  },

  async openChat(id) {
    if (id === null) {
      set({ activeId: null, messages: [], planPanel: null })
      return
    }
    set({ activeId: id, messages: [], planPanel: null })
    const chat = await window.api.getChat(id)
    // Guard against a chat switch happening while we awaited.
    if (get().activeId === id && chat) set({ messages: chat.messages, selectedCwd: chat.cwd })
  },

  async newChat(cwd, firstMessage, opts) {
    const meta = await window.api.createChat({ cwd, ...opts })
    set((s) => ({
      chats: [meta, ...s.chats],
      activeId: meta.id,
      selectedCwd: cwd,
      messages: [],
      planPanel: null,
      defaults: s.defaults
        ? { ...s.defaults, recentDirs: [cwd, ...s.defaults.recentDirs.filter((d) => d !== cwd)].slice(0, 8) }
        : s.defaults
    }))
    await window.api.send(meta.id, firstMessage)
  },

  async sendMessage(text) {
    const id = get().activeId
    if (!id) return
    await window.api.send(id, text)
  },

  async interrupt() {
    const id = get().activeId
    if (!id) return
    await window.api.interrupt(id)
  },

  async deleteChat(id) {
    await window.api.deleteChat(id)
    set((s) => ({
      chats: s.chats.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
      messages: s.activeId === id ? [] : s.messages
    }))
  },

  async renameChat(id, title) {
    await window.api.renameChat(id, title)
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)) }))
  },

  async setChatOptions(patch) {
    const id = get().activeId
    if (!id) return
    await window.api.setChatOptions(id, patch)
  },

  async respondPermission(requestId, decision) {
    const id = get().activeId
    if (!id) return
    await window.api.respondPermission(id, requestId, decision)
  },

  applyEvent(ev) {
    const s = get()
    switch (ev.type) {
      case 'message': {
        if (ev.chatId === s.activeId) {
          set({ messages: upsertMessage(s.messages, ev.message) })
        }
        // Keep sidebar ordering fresh.
        set((st) => ({
          chats: st.chats
            .map((c) => (c.id === ev.chatId ? { ...c, updatedAt: Date.now() } : c))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        break
      }

      case 'part': {
        if (ev.chatId !== s.activeId) break
        set({
          messages: s.messages.map((m) => {
            if (m.id !== ev.messageId || m.role !== 'assistant') return m
            const parts = m.parts.slice()
            parts[ev.partIndex] = ev.part
            return { ...m, parts }
          })
        })
        break
      }

      case 'part-delta': {
        if (ev.chatId !== s.activeId) break
        set({
          messages: s.messages.map((m) => {
            if (m.id !== ev.messageId || m.role !== 'assistant') return m
            const parts = m.parts.slice()
            const part = parts[ev.partIndex]
            if (part && (part.type === 'text' || part.type === 'thinking')) {
              parts[ev.partIndex] = { ...part, text: part.text + ev.delta }
            }
            return { ...m, parts }
          })
        })
        break
      }

      case 'tool-update': {
        if (ev.chatId !== s.activeId) break
        set({
          messages: s.messages.map((m) => {
            if (m.id !== ev.messageId || m.role !== 'assistant') return m
            const am = m as AssistantMessage
            const parts = am.parts.map((p) =>
              p.type === 'tool' && p.toolUseId === ev.toolUseId ? { ...p, ...ev.patch } : p
            )
            return { ...am, parts }
          })
        })
        break
      }

      case 'meta': {
        set((st) => ({
          chats: st.chats
            .map((c) => (c.id === ev.chatId ? { ...c, ...ev.patch } : c))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        break
      }

      case 'status': {
        set((st) => ({ statuses: { ...st.statuses, [ev.chatId]: ev.status } }))
        // Refresh the tree and open files after a turn so Claude's edits show up.
        if (ev.status === 'idle' && ev.chatId === s.activeId) {
          if (s.panelOpen || s.openFiles.length > 0) void get().refreshFiles()
        }
        break
      }

      case 'permission-request': {
        set((st) => ({
          permissions: {
            ...st.permissions,
            [ev.chatId]: [...(st.permissions[ev.chatId] ?? []), ev.request]
          }
        }))
        // A plan approval request opens the plan side panel automatically.
        if (ev.request.toolName === 'ExitPlanMode' && ev.chatId === s.activeId) {
          const plan = (ev.request.input as { plan?: string } | null)?.plan
          if (typeof plan === 'string' && plan) {
            set({ planPanel: { chatId: ev.chatId, plan, requestId: ev.request.id } })
          }
        }
        break
      }

      case 'permission-resolved': {
        set((st) => ({
          permissions: {
            ...st.permissions,
            [ev.chatId]: (st.permissions[ev.chatId] ?? []).filter((r) => r.id !== ev.requestId)
          },
          planPanel: st.planPanel?.requestId === ev.requestId ? null : st.planPanel
        }))
        break
      }
    }
  }
}))

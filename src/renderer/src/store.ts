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
  GitFileChange,
  GitStatus,
  PermissionDecision,
  PermissionRequestPayload
} from '@shared/types'

export interface PlanPanelState {
  chatId: string
  plan: string
  /** Set while an ExitPlanMode permission request is pending; null = read-only view. */
  requestId: string | null
}

export interface DiffTabMeta {
  cwd: string
  /** Repo-relative file path. */
  file: string
  staged: boolean
  untracked: boolean
}

export interface OpenTab {
  /** Absolute file path, or a `diff:` id for diff tabs. */
  path: string
  name: string
  diff?: DiffTabMeta
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
  openFiles: OpenTab[]
  fileContents: Record<string, FileContent>
  /** 'plan', an open file path, or a diff tab id. */
  activeTab: string | null
  /** Saved tab sets per project, restored when switching back. */
  workspaces: Record<string, { openFiles: OpenTab[]; activeTab: string | null }>

  togglePanel(): void
  loadDir(dir: string): Promise<void>
  toggleDir(dir: string): void
  openFile(path: string): Promise<void>
  closeFile(path: string): void
  setActiveTab(tab: string): void
  refreshFiles(): Promise<void>

  // ---- Git ----
  /** Which view the right-panel dock column shows. */
  rightView: 'files' | 'git'
  git: GitStatus | null
  /** True while a push is in flight. */
  gitBusy: boolean
  gitError: string | null
  /** Diff text per diff tab id. */
  diffContents: Record<string, string>

  setRightView(view: 'files' | 'git'): void
  refreshGit(): Promise<void>
  stagePaths(paths: string[]): Promise<void>
  unstagePaths(paths: string[]): Promise<void>
  commitChanges(): Promise<void>
  pushChanges(): Promise<void>
  initRepo(): Promise<void>
  openDiff(change: GitFileChange): Promise<void>

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
  /** Deletes every chat in the project and drops it from recent folders. */
  removeProject(cwd: string): Promise<void>
  renameChat(id: string, title: string): Promise<void>
  setChatOptions(patch: {
    model?: string
    effort?: EffortId | ''
    permissionMode?: ChatMeta['permissionMode']
  }): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  applyEvent(ev: ChatEvent): void
}

/**
 * Tabs belong to a project. Switching projects stashes the current tab set
 * and restores whatever was open in the target project last time.
 */
function projectSwitchPatch(
  s: Pick<AppState, 'selectedCwd' | 'openFiles' | 'activeTab' | 'workspaces'>,
  nextCwd: string | null
): Partial<AppState> {
  if (s.selectedCwd === nextCwd) return { selectedCwd: nextCwd }
  const workspaces = { ...s.workspaces }
  if (s.selectedCwd) {
    workspaces[s.selectedCwd] = { openFiles: s.openFiles, activeTab: s.activeTab }
  }
  const restored = (nextCwd ? workspaces[nextCwd] : null) ?? { openFiles: [], activeTab: null }
  return {
    workspaces,
    selectedCwd: nextCwd,
    openFiles: restored.openFiles,
    activeTab: restored.activeTab
  }
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
    set((s) => projectSwitchPatch(s, cwd))
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
  workspaces: {},

  togglePanel() {
    const opening = !get().panelOpen
    set({ panelOpen: opening })
    if (opening) {
      const cwd = get().selectedCwd
      if (cwd && !get().filesByDir[cwd]) void get().loadDir(cwd)
      void get().refreshGit()
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
      const diffContents = { ...s.diffContents }
      delete diffContents[path]
      let activeTab = s.activeTab
      if (activeTab === path) {
        activeTab = openFiles[openFiles.length - 1]?.path ?? (s.planPanel ? 'plan' : null)
      }
      return { openFiles, fileContents, diffContents, activeTab }
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
      s.openFiles
        .filter((f) => !f.diff)
        .map(async (f) => {
          const content = await window.api.readFile(f.path)
          set((st) => ({ fileContents: { ...st.fileContents, [f.path]: content } }))
        })
    )
  },

  // ---- Git ----

  rightView: 'files',
  git: null,
  gitBusy: false,
  gitError: null,
  diffContents: {},

  setRightView(view) {
    set({ rightView: view })
    if (view === 'git') void get().refreshGit()
  },

  async refreshGit() {
    const cwd = get().selectedCwd
    if (!cwd) {
      set({ git: null })
      return
    }
    try {
      const git = await window.api.gitStatus(cwd)
      // Guard against a project switch happening while we awaited.
      if (get().selectedCwd === cwd) set({ git })
    } catch {
      set({ git: null })
    }
    // Keep open diff tabs for this project in sync with the working tree.
    const { openFiles, git } = get()
    await Promise.all(
      openFiles
        .filter((f) => f.diff && f.diff.cwd === cwd)
        .map(async (f) => {
          const d = f.diff!
          const untracked =
            git?.changes.some((c) => c.path === d.file && !c.staged && c.status === '?') ??
            d.untracked
          const text = await window.api.gitDiff(cwd, { path: d.file, staged: d.staged, untracked })
          set((st) => ({ diffContents: { ...st.diffContents, [f.path]: text } }))
        })
    )
  },

  async stagePaths(paths) {
    const cwd = get().selectedCwd
    if (!cwd) return
    set({ gitError: null })
    const res = await window.api.gitStage(cwd, paths)
    if (!res.ok) set({ gitError: res.error })
    await get().refreshGit()
  },

  async unstagePaths(paths) {
    const cwd = get().selectedCwd
    if (!cwd) return
    set({ gitError: null })
    const res = await window.api.gitUnstage(cwd, paths)
    if (!res.ok) set({ gitError: res.error })
    await get().refreshGit()
  },

  async commitChanges() {
    // Committing goes through the chat: we prompt Claude Code and it runs
    // git itself, so the commit shows up in the conversation.
    const cwd = get().selectedCwd
    const git = get().git
    if (!cwd || !git || git.changes.length === 0) return
    const hasStaged = git.changes.some((c) => c.staged)
    const scope = hasStaged
      ? 'Commit the currently staged changes (leave everything else unstaged).'
      : 'Stage all current changes and commit them.'
    const prompt = `${scope} Review the diff first and write a clear, well-formed commit message.`
    set({ gitError: null })
    if (get().activeId) await get().sendMessage(prompt)
    else await get().newChat(cwd, prompt)
  },

  async pushChanges() {
    const cwd = get().selectedCwd
    if (!cwd || get().gitBusy) return
    set({ gitBusy: true, gitError: null })
    try {
      const res = await window.api.gitPush(cwd)
      if (!res.ok) set({ gitError: res.error })
    } finally {
      set({ gitBusy: false })
      await get().refreshGit()
    }
  },

  async initRepo() {
    const cwd = get().selectedCwd
    if (!cwd) return
    set({ gitError: null })
    const res = await window.api.gitInit(cwd)
    if (!res.ok) set({ gitError: res.error })
    await get().refreshGit()
  },

  async openDiff(change) {
    const cwd = get().selectedCwd
    if (!cwd) return
    const id = `diff:${change.staged ? 's' : 'w'}:${cwd}:${change.path}`
    const name = change.path.split('/').pop() ?? change.path
    const meta: DiffTabMeta = {
      cwd,
      file: change.path,
      staged: change.staged,
      untracked: change.status === '?'
    }
    set((s) => ({
      openFiles: s.openFiles.some((f) => f.path === id)
        ? s.openFiles
        : [
            ...s.openFiles,
            { path: id, name: change.staged ? `${name} (staged)` : `${name} (diff)`, diff: meta }
          ],
      activeTab: id,
      panelOpen: true
    }))
    const text = await window.api.gitDiff(cwd, {
      path: change.path,
      staged: change.staged,
      untracked: meta.untracked
    })
    set((s) => ({ diffContents: { ...s.diffContents, [id]: text } }))
  },

  async openChat(id) {
    if (id === null) {
      set({ activeId: null, messages: [], planPanel: null })
      return
    }
    set({ activeId: id, messages: [], planPanel: null })
    const chat = await window.api.getChat(id)
    // Guard against a chat switch happening while we awaited.
    if (get().activeId === id && chat) {
      const cwdChanged = get().selectedCwd !== chat.cwd
      set((s) => ({ messages: chat.messages, ...projectSwitchPatch(s, chat.cwd) }))
      if (cwdChanged && get().panelOpen) {
        void get().refreshGit()
        if (!get().filesByDir[chat.cwd]) void get().loadDir(chat.cwd)
      }
    }
  },

  async newChat(cwd, firstMessage, opts) {
    const meta = await window.api.createChat({ cwd, ...opts })
    set((s) => ({
      ...projectSwitchPatch(s, cwd),
      chats: [meta, ...s.chats],
      activeId: meta.id,
      messages: [],
      planPanel: null,
      defaults: s.defaults
        ? {
            ...s.defaults,
            model: opts?.model,
            effort: opts?.effort,
            permissionMode: opts?.permissionMode ?? s.defaults.permissionMode,
            recentDirs: [cwd, ...s.defaults.recentDirs.filter((d) => d !== cwd)].slice(0, 8)
          }
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

  async removeProject(cwd) {
    const ids = get()
      .chats.filter((c) => c.cwd === cwd)
      .map((c) => c.id)
    await Promise.all(ids.map((id) => window.api.deleteChat(id)))
    await window.api.forgetDir(cwd)
    set((s) => {
      const chats = s.chats.filter((c) => c.cwd !== cwd)
      const wasActive = s.activeId !== null && ids.includes(s.activeId)
      const recentDirs = s.defaults?.recentDirs.filter((d) => d !== cwd) ?? []
      const patch =
        s.selectedCwd === cwd
          ? projectSwitchPatch(s, chats[0]?.cwd ?? recentDirs[0] ?? null)
          : {}
      delete patch.workspaces?.[cwd]
      return {
        ...patch,
        chats,
        activeId: wasActive ? null : s.activeId,
        messages: wasActive ? [] : s.messages,
        planPanel: wasActive ? null : s.planPanel,
        defaults: s.defaults ? { ...s.defaults, recentDirs } : s.defaults
      }
    })
  },

  async renameChat(id, title) {
    await window.api.renameChat(id, title)
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)) }))
  },

  async setChatOptions(patch) {
    const id = get().activeId
    if (!id) return
    await window.api.setChatOptions(id, patch)
    // Mirror the new defaults locally so the next New-chat screen uses them.
    set((s) => ({
      defaults: s.defaults
        ? {
            ...s.defaults,
            ...(patch.model !== undefined ? { model: patch.model || undefined } : {}),
            ...(patch.effort !== undefined ? { effort: patch.effort || undefined } : {}),
            ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {})
          }
        : s.defaults
    }))
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
        // Refresh the tree, open files and git status after a turn so
        // Claude's edits show up.
        if (ev.status === 'idle' && ev.chatId === s.activeId) {
          if (s.panelOpen || s.openFiles.length > 0) {
            void get().refreshFiles()
            void get().refreshGit()
          }
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

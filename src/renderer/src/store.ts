import { create } from 'zustand'
import {
  applyCodeFontSize,
  applyTheme,
  CODE_FONT_MAX,
  CODE_FONT_MIN,
  storedCodeFontSize,
  storedTheme
} from '@/lib/themes'
import { loadNotifyPrefs, notify, playChime, saveNotifyPrefs, type NotifyPrefs } from '@/lib/notify'
import { formatCost, formatDuration } from '@/lib/format'
import type {
  AppDefaults,
  AssistantMessage,
  Attachment,
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
  PermissionRequestPayload,
  PreviewState,
  SlashCommand
} from '@shared/types'

/** Bounds for the sidebar "recent chats per project" setting. */
export const CHATS_PER_PROJECT_MIN = 3
export const CHATS_PER_PROJECT_MAX = 20
export const CHATS_PER_PROJECT_DEFAULT = 6

export interface QueuedMessage {
  id: string
  text: string
  attachments?: Attachment[]
}

export interface TerminalTab {
  /** Tab id and pty session id, e.g. `terminal:3`. */
  id: string
  /** Stable ordinal for the "Terminal N" label. */
  n: number
}

export interface PreviewTab {
  /** Tab id, e.g. `preview:2`. */
  id: string
  /** Stable ordinal for the "Preview N" label. */
  n: number
  /** Currently loaded URL. */
  url: string
  /** Project folder this preview belongs to (drives dev-server + agent tools). */
  cwd: string
}

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
  /** Preview tabs (single click) are reused by the next preview; double-click pins. */
  preview?: boolean
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
  /** Messages typed while a turn was running, sent when the chat goes idle. */
  queued: Record<string, QueuedMessage[]>
  planPanel: PlanPanelState | null
  defaults: AppDefaults | null
  loading: boolean
  sidebarOpen: boolean
  toggleSidebar(): void

  // ---- Terminal ----
  /** Open terminal tabs in the right panel; each has its own shell session. */
  terminals: TerminalTab[]
  /** Monotonic counter for stable "Terminal N" labels. */
  terminalSeq: number
  /** Opens a new terminal tab and focuses it. */
  openTerminal(): void
  closeTerminal(id: string): void
  toggleTerminal(): void

  // ---- Browser preview ----
  /** Open browser-preview tabs in the right panel. */
  previews: PreviewTab[]
  /** Monotonic counter for stable "Preview N" labels. */
  previewSeq: number
  /** Opens a new browser-preview tab (optionally at a URL/project) and focuses it. */
  openPreview(url?: string, cwd?: string): void
  closePreview(id: string): void
  /** Records the URL a preview navigated to, so it restores on tab switch. */
  setPreviewUrl(id: string, url: string): void
  /** Dev-server state per project folder, keyed by cwd. */
  previewStates: Record<string, PreviewState>
  applyPreviewState(state: PreviewState): void
  startPreview(cwd?: string): Promise<void>
  stopPreview(cwd?: string): Promise<void>

  // ---- Composer inbox ----
  /** Attachments handed to the composer from elsewhere (e.g. picked elements). */
  attachmentInbox: Attachment[]
  addAttachment(att: Attachment): void
  clearAttachmentInbox(): void

  // ---- Slash commands ----
  /** Slash commands for the active project, powering the composer's / menu. */
  commands: SlashCommand[]
  loadCommands(cwd: string | null): void

  // ---- Settings ----
  /** When true the main area shows the settings page instead of a chat. */
  settingsOpen: boolean
  theme: string
  codeFontSize: number
  notifyPrefs: NotifyPrefs
  openSettings(): void
  closeSettings(): void
  setTheme(id: string): void
  setCodeFontSize(px: number): void
  setNotifyPrefs(patch: Partial<NotifyPrefs>): void
  /** How many recent chats each project shows in the sidebar before search. */
  chatsPerProject: number
  setChatsPerProject(n: number): void

  // ---- Files ----
  /** Whether the right-side workspace panel (tabs + file tree) is open. */
  panelOpen: boolean
  /** Panel expanded over the chat column to fill the window. */
  panelMaximized: boolean
  togglePanelMaximized(): void
  /** Directory listing cache, keyed by absolute dir path. */
  filesByDir: Record<string, FileEntry[]>
  expandedDirs: Record<string, boolean>
  openFiles: OpenTab[]
  fileContents: Record<string, FileContent>
  /** 'plan', an open file path, or a diff tab id. */
  activeTab: string | null
  /** Saved tab sets per project, restored when switching back. */
  workspaces: Record<string, { openFiles: OpenTab[]; activeTab: string | null }>
  /** Panel visibility remembered per chat. */
  panelOpenByChat: Record<string, boolean>

  togglePanel(): void
  loadDir(dir: string): Promise<void>
  toggleDir(dir: string): void
  openFile(path: string, opts?: { preview?: boolean }): Promise<void>
  closeFile(path: string): void
  /** Pins a preview tab so the next preview doesn't replace it. */
  promoteTab(path: string): void
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
  /** The file-tree / source-control dock on the right edge of the panel. */
  explorerOpen: boolean
  setExplorerOpen(open: boolean): void
  toggleExplorer(): void
  /** Reveal the in-app file explorer in a file context (Cursor-style). */
  browseFiles(): void
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
    opts?: {
      model?: string
      effort?: EffortId
      permissionMode?: ChatMeta['permissionMode']
      attachments?: Attachment[]
    }
  ): Promise<void>
  sendMessage(text: string, attachments?: Attachment[]): Promise<void>
  removeQueued(chatId: string, id: string): void
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

/** Sets panel visibility and remembers it for the active chat. */
function panelPatch(
  s: Pick<AppState, 'activeId' | 'panelOpenByChat'>,
  open: boolean
): Partial<AppState> {
  if (!s.activeId) return { panelOpen: open }
  const panelOpenByChat = { ...s.panelOpenByChat, [s.activeId]: open }
  localStorage.setItem('panelOpenByChat', JSON.stringify(panelOpenByChat))
  return { panelOpen: open, panelOpenByChat }
}

function prunePanelState(
  s: Pick<AppState, 'panelOpenByChat'>,
  ids: string[]
): Record<string, boolean> {
  const panelOpenByChat = { ...s.panelOpenByChat }
  for (const id of ids) delete panelOpenByChat[id]
  localStorage.setItem('panelOpenByChat', JSON.stringify(panelOpenByChat))
  return panelOpenByChat
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
  queued: {},
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

  // ---- Terminal ----

  // Not persisted: terminals start empty each launch so a new one always spawns
  // in the active project's folder (the store's cwd is known by the time the
  // user opens it), never racing a fresh-load init.
  terminals: [],
  terminalSeq: 0,

  openTerminal() {
    set((s) => {
      const n = s.terminalSeq + 1
      const id = `terminal:${n}`
      return {
        terminals: [...s.terminals, { id, n }],
        terminalSeq: n,
        activeTab: id,
        ...panelPatch(s, true)
      }
    })
  },

  closeTerminal(id) {
    // Unmounting the tab kills its pty; fall back to another tab if it was active.
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      let activeTab = s.activeTab
      if (activeTab === id) {
        activeTab =
          terminals[terminals.length - 1]?.id ??
          s.openFiles[s.openFiles.length - 1]?.path ??
          (s.planPanel ? 'plan' : null)
      }
      return { terminals, activeTab }
    })
  },

  toggleTerminal() {
    const s = get()
    if (s.terminals.length === 0) {
      get().openTerminal()
      return
    }
    const last = s.terminals[s.terminals.length - 1].id
    // Showing the most recent terminal already → hide the panel; else focus it.
    if (s.activeTab === last && s.panelOpen) set(panelPatch(s, false))
    else set({ activeTab: last, ...panelPatch(s, true) })
  },

  // ---- Browser preview ----

  // Not persisted across launches (like terminals); the last URL is remembered
  // in localStorage so a new preview reopens where the last one was pointed.
  previews: [],
  previewSeq: 0,

  openPreview(url, cwd) {
    set((s) => {
      const n = s.previewSeq + 1
      const id = `preview:${n}`
      const target = url || localStorage.getItem('previewUrl') || 'http://localhost:3000'
      const folder = cwd ?? s.selectedCwd ?? ''
      return {
        previews: [...s.previews, { id, n, url: target, cwd: folder }],
        previewSeq: n,
        activeTab: id,
        ...panelPatch(s, true)
      }
    })
  },

  previewStates: {},

  applyPreviewState(state) {
    set((s) => ({ previewStates: { ...s.previewStates, [state.cwd]: state } }))
    // When the dev server comes up in the active project, surface a preview
    // pointed at it (reuse an existing one, else open one).
    if (state.status === 'running' && state.url && get().selectedCwd === state.cwd) {
      const existing = get().previews.find((p) => p.cwd === state.cwd)
      if (!existing) get().openPreview(state.url, state.cwd)
    }
  },

  async startPreview(cwd) {
    const folder = cwd ?? get().selectedCwd
    if (!folder) return
    const state = await window.api.previewStart(folder)
    get().applyPreviewState(state)
  },

  async stopPreview(cwd) {
    const folder = cwd ?? get().selectedCwd
    if (!folder) return
    const state = await window.api.previewStop(folder)
    get().applyPreviewState(state)
  },

  closePreview(id) {
    set((s) => {
      const previews = s.previews.filter((p) => p.id !== id)
      let activeTab = s.activeTab
      if (activeTab === id) {
        activeTab =
          previews[previews.length - 1]?.id ??
          s.openFiles[s.openFiles.length - 1]?.path ??
          s.terminals[s.terminals.length - 1]?.id ??
          (s.planPanel ? 'plan' : null)
      }
      return { previews, activeTab }
    })
  },

  setPreviewUrl(id, url) {
    localStorage.setItem('previewUrl', url)
    set((s) => ({
      previews: s.previews.map((p) => (p.id === id ? { ...p, url } : p))
    }))
  },

  // ---- Composer inbox ----

  attachmentInbox: [],

  addAttachment(att) {
    set((s) => ({ attachmentInbox: [...s.attachmentInbox, att] }))
  },

  clearAttachmentInbox() {
    set({ attachmentInbox: [] })
  },

  // ---- Slash commands ----

  commands: [],

  loadCommands(cwd) {
    if (!cwd) {
      set({ commands: [] })
      return
    }
    void window.api.getCommands(cwd).then((commands) => {
      // Ignore a stale response if the project changed while awaiting.
      if (get().selectedCwd === cwd) set({ commands })
    })
  },

  // ---- Settings ----

  settingsOpen: false,
  theme: storedTheme(),

  openSettings() {
    set({ settingsOpen: true })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  setTheme(id) {
    applyTheme(id)
    set({ theme: id })
  },

  codeFontSize: storedCodeFontSize(),

  setCodeFontSize(px) {
    const size = Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, Math.round(px)))
    applyCodeFontSize(size)
    localStorage.setItem('codeFontSize', String(size))
    set({ codeFontSize: size })
  },

  notifyPrefs: loadNotifyPrefs(),

  setNotifyPrefs(patch) {
    set((s) => {
      const notifyPrefs = { ...s.notifyPrefs, ...patch }
      saveNotifyPrefs(notifyPrefs)
      return { notifyPrefs }
    })
  },

  chatsPerProject: (() => {
    const v = Number(localStorage.getItem('chatsPerProject'))
    return Number.isFinite(v) && v >= CHATS_PER_PROJECT_MIN && v <= CHATS_PER_PROJECT_MAX
      ? v
      : CHATS_PER_PROJECT_DEFAULT
  })(),

  setChatsPerProject(n) {
    const v = Math.min(CHATS_PER_PROJECT_MAX, Math.max(CHATS_PER_PROJECT_MIN, Math.round(n)))
    localStorage.setItem('chatsPerProject', String(v))
    set({ chatsPerProject: v })
  },

  async init() {
    const [chats, defaults] = await Promise.all([window.api.listChats(), window.api.getDefaults()])
    set({
      chats,
      defaults,
      loading: false,
      selectedCwd: chats[0]?.cwd ?? defaults.recentDirs[0] ?? null
    })
    const cwd = get().selectedCwd
    if (cwd) void get().refreshGit()
    get().loadCommands(cwd)
  },

  setSelectedCwd(cwd) {
    set((s) => projectSwitchPatch(s, cwd))
    get().loadCommands(cwd)
    if (cwd) {
      void get().refreshGit()
      if (get().panelOpen && !get().filesByDir[cwd]) void get().loadDir(cwd)
    }
  },

  openPlanPanel(panel) {
    set((s) => ({ planPanel: panel, activeTab: 'plan', ...panelPatch(s, true) }))
  },

  closePlanPanel() {
    set((s) => ({
      planPanel: null,
      activeTab: s.activeTab === 'plan' ? (s.openFiles[0]?.path ?? null) : s.activeTab
    }))
  },

  // ---- Files ----

  panelOpen: false,
  panelMaximized: false,
  filesByDir: {},
  expandedDirs: {},
  openFiles: [],
  fileContents: {},
  activeTab: null,
  workspaces: {},
  panelOpenByChat: (() => {
    try {
      return JSON.parse(localStorage.getItem('panelOpenByChat') ?? '{}') as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })(),

  togglePanelMaximized() {
    set((s) => ({ panelMaximized: !s.panelMaximized }))
  },

  togglePanel() {
    const opening = !get().panelOpen
    set((s) => ({ ...panelPatch(s, opening), ...(opening ? {} : { panelMaximized: false }) }))
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

  async openFile(path, opts) {
    const preview = opts?.preview ?? false
    const name = path.split('/').pop() ?? path
    set((s) => {
      const existing = s.openFiles.find((f) => f.path === path)
      let openFiles = s.openFiles
      if (existing) {
        // Re-opening a preview tab explicitly (double click) pins it.
        if (!preview && existing.preview) {
          openFiles = openFiles.map((f) => (f.path === path ? { ...f, preview: false } : f))
        }
      } else if (preview) {
        // A single-clicked file reuses the current preview slot, like Cursor.
        const slot = openFiles.findIndex((f) => f.preview)
        const tab: OpenTab = { path, name, preview: true }
        openFiles =
          slot === -1 ? [...openFiles, tab] : openFiles.map((f, i) => (i === slot ? tab : f))
      } else {
        openFiles = [...openFiles, { path, name }]
      }
      return { openFiles, activeTab: path, ...panelPatch(s, true) }
    })
    const content = await window.api.readFile(path)
    set((s) => ({ fileContents: { ...s.fileContents, [path]: content } }))
  },

  promoteTab(path) {
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, preview: false } : f))
    }))
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
  explorerOpen: localStorage.getItem('rightDockOpen') === 'true',
  git: null,
  gitBusy: false,
  gitError: null,
  diffContents: {},

  setRightView(view) {
    set({ rightView: view })
    if (view === 'git') void get().refreshGit()
  },

  setExplorerOpen(open) {
    localStorage.setItem('rightDockOpen', String(open))
    set({ explorerOpen: open })
    if (open) {
      const s = get()
      if (s.selectedCwd && !s.filesByDir[s.selectedCwd]) void s.loadDir(s.selectedCwd)
      void s.refreshGit()
    }
  },

  toggleExplorer() {
    get().setExplorerOpen(!get().explorerOpen)
  },

  browseFiles() {
    const s = get()
    // The dock only shows over the file/editor area, not the browser/terminal.
    // If we're on one of those (or nothing), switch to an editor tab — the last
    // open file if any, else an empty files view — so the tree is visible.
    const onEditor =
      s.activeTab != null &&
      s.activeTab !== 'files' &&
      !s.previews.some((p) => p.id === s.activeTab) &&
      !s.terminals.some((t) => t.id === s.activeTab)
    const activeTab = onEditor ? s.activeTab : (s.openFiles[s.openFiles.length - 1]?.path ?? 'files')
    set((st) => ({ rightView: 'files', activeTab, ...panelPatch(st, true) }))
    s.setExplorerOpen(true)
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
    set({ gitError: null })
    const prompt = `${scope} Commit directly with a clear one-line message — do not review diffs, run tests, or verify anything. At most glance at the changed file names for the message.`
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
      ...panelPatch(s, true)
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
      set({
        activeId: null,
        messages: [],
        planPanel: null,
        settingsOpen: false,
        panelMaximized: false,
        // The right panel is per chat; a fresh/draft chat starts collapsed.
        panelOpen: false
      })
      return
    }
    set((s) => ({
      activeId: id,
      messages: [],
      planPanel: null,
      settingsOpen: false,
      panelMaximized: false,
      // Panel visibility is per chat; unvisited chats start closed.
      panelOpen: s.panelOpenByChat[id] ?? false
    }))
    const chat = await window.api.getChat(id)
    // Guard against a chat switch happening while we awaited.
    if (get().activeId === id && chat) {
      const cwdChanged = get().selectedCwd !== chat.cwd
      set((s) => ({ messages: chat.messages, ...projectSwitchPatch(s, chat.cwd) }))
      if (cwdChanged) get().loadCommands(chat.cwd)
      if (cwdChanged || !get().git) void get().refreshGit()
      if (cwdChanged && get().panelOpen && !get().filesByDir[chat.cwd]) {
        void get().loadDir(chat.cwd)
      }
      // A plan still waiting for review comes straight back up.
      const pendingPlan = get().permissions[id]?.find((r) => r.toolName === 'ExitPlanMode')
      const plan = (pendingPlan?.input as { plan?: string } | null)?.plan
      if (pendingPlan && typeof plan === 'string' && plan) {
        get().openPlanPanel({ chatId: id, plan, requestId: pendingPlan.id })
      }
    }
  },

  async newChat(cwd, firstMessage, opts) {
    const { attachments, ...createOpts } = opts ?? {}
    const meta = await window.api.createChat({ cwd, ...createOpts })
    set((s) => ({
      ...projectSwitchPatch(s, cwd),
      chats: [meta, ...s.chats],
      activeId: meta.id,
      messages: [],
      planPanel: null,
      settingsOpen: false,
      panelMaximized: false,
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
    // The new chat keeps whatever panel state was showing when it was created.
    set((s) => panelPatch(s, s.panelOpen))
    get().loadCommands(cwd)
    void get().refreshGit()
    if (get().panelOpen && !get().filesByDir[cwd]) void get().loadDir(cwd)
    await window.api.send(meta.id, firstMessage, attachments)
  },

  async sendMessage(text, attachments) {
    const id = get().activeId
    if (!id) return
    // Mid-turn sends wait in a queue until the chat goes idle, like Cursor.
    if ((get().statuses[id] ?? 'idle') !== 'idle') {
      const item: QueuedMessage = { id: crypto.randomUUID(), text, attachments }
      set((s) => ({ queued: { ...s.queued, [id]: [...(s.queued[id] ?? []), item] } }))
      return
    }
    await window.api.send(id, text, attachments)
  },

  removeQueued(chatId, id) {
    set((s) => ({
      queued: { ...s.queued, [chatId]: (s.queued[chatId] ?? []).filter((q) => q.id !== id) }
    }))
  },

  async interrupt() {
    const id = get().activeId
    if (!id) return
    await window.api.interrupt(id)
  },

  async deleteChat(id) {
    await window.api.deleteChat(id)
    set((s) => {
      const queued = { ...s.queued }
      delete queued[id]
      return {
        chats: s.chats.filter((c) => c.id !== id),
        activeId: s.activeId === id ? null : s.activeId,
        messages: s.activeId === id ? [] : s.messages,
        queued,
        panelOpenByChat: prunePanelState(s, [id])
      }
    })
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
        panelOpenByChat: prunePanelState(s, ids),
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
        // Turn finished: chime + background notification.
        if (ev.message.role === 'event' && (ev.message.kind === 'turn' || ev.message.kind === 'error')) {
          const prefs = s.notifyPrefs
          const failed = ev.message.kind === 'error'
          if (prefs.sound && !failed) playChime()
          if (prefs.finish && !document.hasFocus()) {
            const title = s.chats.find((c) => c.id === ev.chatId)?.title || 'Claude'
            const stats = ev.message.stats
            notify(
              title,
              failed
                ? 'The turn failed'
                : stats
                  ? `Finished in ${formatDuration(stats.durationMs)} · ${formatCost(stats.costUsd)}`
                  : 'Finished',
              {
                onClick: () => {
                  void window.api.focusWindow()
                  void get().openChat(ev.chatId)
                }
              }
            )
          }
        }
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
              // Streamed parts arrays can be sparse — guard the holes.
              p && p.type === 'tool' && p.toolUseId === ev.toolUseId ? { ...p, ...ev.patch } : p
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
        if (ev.status === 'idle') {
          // A queued message goes out as soon as the chat is free again.
          const next = get().queued[ev.chatId]?.[0]
          if (next) {
            set((st) => ({
              queued: { ...st.queued, [ev.chatId]: st.queued[ev.chatId].slice(1) }
            }))
            void window.api.send(ev.chatId, next.text, next.attachments)
          }
          // Refresh the tree, open files and git status after a turn so
          // Claude's edits show up.
          if (ev.chatId === s.activeId) {
            void get().refreshGit()
            if (s.panelOpen || s.openFiles.length > 0) void get().refreshFiles()
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
        // Waiting on the user: always chime, and notify if the app is in the
        // background (the notification stays silent — the chime is the sound).
        if (s.notifyPrefs.sound) playChime()
        if (s.notifyPrefs.permission && !document.hasFocus()) {
          const title = s.chats.find((c) => c.id === ev.chatId)?.title || 'Claude'
          const what =
            ev.request.toolName === 'ExitPlanMode'
              ? 'has a plan ready for review'
              : `wants to use ${ev.request.displayName ?? ev.request.toolName}`
          notify(title, `Claude ${what}`, {
            onClick: () => {
              void window.api.focusWindow()
              void get().openChat(ev.chatId)
            }
          })
        }
        // A plan approval request opens the plan side panel automatically.
        if (ev.request.toolName === 'ExitPlanMode' && ev.chatId === s.activeId) {
          const plan = (ev.request.input as { plan?: string } | null)?.plan
          if (typeof plan === 'string' && plan) {
            get().openPlanPanel({ chatId: ev.chatId, plan, requestId: ev.request.id })
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

      case 'commands': {
        // Update the composer's command list if this is the active project.
        if (ev.cwd === get().selectedCwd) set({ commands: ev.commands })
        break
      }
    }
  }
}))

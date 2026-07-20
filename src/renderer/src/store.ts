import { create } from 'zustand'
import {
  applyCodeFontSize,
  applyTheme,
  applyTranslucent,
  CODE_FONT_MAX,
  CODE_FONT_MIN,
  resolveAppearance,
  storedCodeFontSize,
  storedTheme,
  storedThemeMode,
  storedTranslucent
} from '@/lib/themes'
import type { ResolvedAppearance, ThemeMode } from '@/lib/themes'
import { loadNotifyPrefs, notify, playChime, saveNotifyPrefs, type NotifyPrefs } from '@/lib/notify'
import { formatCost, formatDuration } from '@/lib/format'
import { invalidateLocalImages } from '@/lib/imageCache'
import { gitAction, gitActionPrompt, type GitActionId } from '@/lib/gitActions'
import { changedPathsFromParts } from '@/lib/turnChanges'
import { projectRoot, providerForModel } from '@shared/types'
import type {
  AppDefaults,
  AssistantMessage,
  Attachment,
  BranchChanges,
  ChatEvent,
  ChatMessage,
  ChatMeta,
  ChatStatus,
  BackgroundJob,
  EffortId,
  FileContent,
  FileEntry,
  GitFileChange,
  GitHubState,
  GitStatus,
  ModelOption,
  OpResult,
  PermissionDecision,
  PermissionRequestPayload,
  PersistedPlanReview,
  PreviewState,
  Provider,
  RateLimitState,
  RewindResult,
  SlashCommand,
  WorktreeDisposition,
  WorktreeInfo,
  WorktreeTarget
} from '@shared/types'

/** Bounds for the sidebar "recent chats per project" setting. */
export const CHATS_PER_PROJECT_MIN = 3
export const CHATS_PER_PROJECT_MAX = 20
export const CHATS_PER_PROJECT_DEFAULT = 6

export interface QueuedMessage {
  id: string
  text: string
  attachments?: Attachment[]
  /** Display label for an app-initiated action (e.g. "Commit"); see UserMessage.label. */
  label?: string
}

function persistedPlanRequest(
  chatId: string,
  review: PersistedPlanReview
): PermissionRequestPayload {
  return {
    id: review.requestId,
    chatId,
    toolUseId: `codex-plan-${review.requestId}`,
    toolName: 'ExitPlanMode',
    input: { plan: review.plan },
    title: 'Review plan',
    displayName: 'Codex plan',
    description: 'Approve this plan to implement it, or request a revision.',
    hasSuggestions: false
  }
}

export interface TerminalTab {
  /** Tab id and pty session id, e.g. `terminal:3`. */
  id: string
  /** Stable ordinal for the "Terminal N" label. */
  n: number
  /** Overrides the chat's cwd for this tab's shell. */
  cwd?: string
  /** One-shot command to run instead of an interactive shell (worktree setup). */
  command?: string
  /** Tab label override, e.g. "Setup". */
  label?: string
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
  /** Branch scope: diff against this base sha (base → working tree). */
  base?: string
}

/**
 * Which changes the source-control panel shows and commits, Codex/Cursor-style:
 * - `last-turn`   — only the files the active chat's last turn edited
 * - `uncommitted` — the whole working tree (default)
 * - `branch`      — everything on the branch vs its base (committed + uncommitted)
 */
export type ChangeScope = 'last-turn' | 'uncommitted' | 'branch'

export interface OpenTab {
  /** Absolute file path, a `diff:` id for diff tabs, or an `untitled:N` id. */
  path: string
  name: string
  diff?: DiffTabMeta
  /** Preview tabs (single click) are reused by the next preview; double-click pins. */
  preview?: boolean
  /** A blank "open a file" placeholder tab; replaced in place once a file is picked. */
  untitled?: boolean
}

interface AppState {
  chats: ChatMeta[]
  activeId: string | null
  /** Project folder new chats start in; follows the active chat. */
  selectedCwd: string | null
  /** Messages of the active chat. */
  messages: ChatMessage[]
  statuses: Record<string, ChatStatus>
  /** Chats whose AI title is being generated right now (sidebar shimmers them). */
  titling: Record<string, boolean>
  /** Live background tasks per chat (SDK reports the full set on each change). */
  backgroundJobs: Record<string, BackgroundJob[]>
  /** Latest plan rate-limit signal per chat (from `rate_limit_event`). */
  rateLimits: Record<string, RateLimitState>
  /** Models reported by the live session; empty until loaded (falls back to the static list). */
  models: ModelOption[]
  /** Fetches the session's model list once and caches it (feeds the composer picker). */
  loadModels(chatId?: string): Promise<void>
  /** Revert the working tree to a user message's checkpoint (dryRun previews only). */
  rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult>
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
  /** Opens a terminal tab; `command` runs one-shot instead of an interactive shell. */
  openTerminal(opts?: { cwd?: string; command?: string; label?: string }): void
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
  /**
   * `${cwd}::${provider}` the current `commands` belong to. Guards async command
   * results and pushed `commands` events so a slow Claude response can't repopulate
   * the menu after the active provider/project changed (e.g. switched to Codex).
   */
  commandsKey: string | null
  loadCommands(cwd: string | null, provider?: Provider): void

  // ---- Search ----
  /** When true the "search chats across projects" dialog is open (⌘K). */
  searchOpen: boolean
  setSearchOpen(open: boolean): void
  /** When true the file quick-open dialog is open (⌘P). */
  fileSearchOpen: boolean
  setFileSearchOpen(open: boolean): void
  /** When true the find-in-page bar is open (⌘F). */
  findOpen: boolean
  setFindOpen(open: boolean): void

  // ---- Settings ----
  /** When true the main area shows the settings page instead of a chat. */
  settingsOpen: boolean
  theme: string
  themeMode: ThemeMode
  resolvedAppearance: ResolvedAppearance
  /** macOS-only: blur the desktop behind a translucent sidebar (native vibrancy). */
  translucentSidebar: boolean
  setTranslucentSidebar(on: boolean): void
  codeFontSize: number
  notifyPrefs: NotifyPrefs
  openSettings(): void
  closeSettings(): void
  setTheme(id: string): void
  setThemeMode(mode: ThemeMode): void
  /** Re-resolve System mode after an OS appearance change. */
  syncSystemAppearance(): void
  setCodeFontSize(px: number): void
  setNotifyPrefs(patch: Partial<NotifyPrefs>): void
  /** How many recent chats each project shows in the sidebar before search. */
  chatsPerProject: number
  setChatsPerProject(n: number): void
  /**
   * Projects the user hid from the sidebar (keyed by cwd). Their chats are kept;
   * re-selecting the folder un-hides it (see `setSelectedCwd`). Persisted.
   */
  hiddenProjects: Record<string, boolean>
  setProjectHidden(cwd: string, hidden: boolean): void
  /**
   * Custom display names for projects (keyed by cwd). A project with no entry
   * falls back to its folder basename. An empty/blank name clears the override.
   * Persisted.
   */
  projectNames: Record<string, string>
  setProjectName(cwd: string, name: string): void

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
  /** Monotonic counter for Untitled placeholder tab ids. */
  untitledSeq: number
  fileContents: Record<string, FileContent>
  /** 'plan', an open file path, or a diff tab id. */
  activeTab: string | null
  /** Saved tab set per chat (keyed by chat id), restored when switching back. */
  tabsByChat: Record<string, { openFiles: OpenTab[]; activeTab: string | null }>
  /** Panel visibility remembered per chat. */
  panelOpenByChat: Record<string, boolean>

  togglePanel(): void
  loadDir(dir: string): Promise<void>
  toggleDir(dir: string): void
  openFile(path: string, opts?: { preview?: boolean; replace?: string }): Promise<void>
  /** Open a blank "Untitled" placeholder tab (a file picker until one is chosen). */
  openUntitled(): void
  closeFile(path: string): void
  /** Pins a preview tab so the next preview doesn't replace it. */
  promoteTab(path: string): void
  setActiveTab(tab: string): void
  refreshFiles(options?: { invalidateImages?: boolean }): Promise<void>

  // ---- Git ----
  git: GitStatus | null
  /** True while a push is in flight. */
  gitBusy: boolean
  gitError: string | null
  /** GitHub state (PR + checks) for the selected project; null until first fetch. */
  github: GitHubState | null
  /** True while a gh state fetch is in flight (guards against overlap). */
  githubBusy: boolean
  /** Which changes the source-control panel shows and commits (persisted). */
  changeScope: ChangeScope
  /** Branch-scope change set (branch vs base); fetched lazily for 'branch' scope. */
  branchChanges: BranchChanges | null
  /** Diff text per diff tab id. */
  diffContents: Record<string, string>

  /** The file-tree / source-control dock on the right edge of the panel. */
  explorerOpen: boolean
  setExplorerOpen(open: boolean): void
  toggleExplorer(): void
  /** Reveal the in-app file explorer in a file context (Cursor-style). */
  browseFiles(): void
  refreshGit(): Promise<void>
  stagePaths(paths: string[]): Promise<void>
  unstagePaths(paths: string[]): Promise<void>
  pushChanges(): Promise<void>
  pullChanges(): Promise<void>
  /** git fetch, then refresh, so ahead/behind reflects the live remote. */
  fetchRemote(): Promise<void>
  initRepo(): Promise<void>
  /** Run one rung of the source-control ladder (agent-delegated, or direct push/pull). */
  runGitAction(id: GitActionId): Promise<void>
  /** Sticky default for the split button (persisted); the dropdown sets it. */
  preferredGitAction: GitActionId | null
  setPreferredGitAction(id: GitActionId): void
  /** Re-read GitHub state (PR + checks) for the selected project. */
  refreshGithub(): Promise<void>
  /** Switch the change scope (Last Turn / Uncommitted / Branch); fetches for branch. */
  setChangeScope(scope: ChangeScope): void
  /** Re-read the branch-vs-base change set (used by the Branch scope). */
  refreshBranchChanges(): Promise<void>
  /** Open the current branch's PR in the browser. */
  openPr(): Promise<void>
  /** Open a file's diff. Single click previews (ephemeral); double click pins it. */
  openDiff(change: GitFileChange, opts?: { preview?: boolean }): Promise<void>
  /** Open the single "Changes" tab (all files stacked); optionally scroll to one. */
  openChanges(target?: { path: string; staged: boolean }): void
  /** Signal to the Changes view to scroll to a file: key `w:path`/`s:path` + nonce. */
  changesScroll: { key: string; n: number } | null
  /** Open the right panel on the source-control view and the stacked changes. */
  reviewChanges(): Promise<void>

  init(): Promise<void>
  setSelectedCwd(cwd: string | null): void
  openPlanPanel(panel: PlanPanelState): void
  closePlanPanel(): void
  openChat(id: string | null): Promise<void>
  newChat(
    cwd: string,
    firstMessage: string,
    opts?: {
      provider?: Provider
      model?: string
      effort?: EffortId
      permissionMode?: ChatMeta['permissionMode']
      attachments?: Attachment[]
      /** Display label for an app-initiated first message (e.g. "Commit"). */
      label?: string
      /** Where the chat runs; omitted or `local` means `cwd` itself. */
      worktree?: WorktreeTarget
    }
  ): Promise<void>
  sendMessage(text: string, attachments?: Attachment[], label?: string): Promise<void>
  /** Force a queued message through now: interrupt the running turn and send it. */
  sendQueuedNow(chatId: string, id: string): Promise<void>
  removeQueued(chatId: string, id: string): void
  interrupt(): Promise<void>
  stopBackgroundJob(taskId: string): void
  /**
   * `worktree` decides the fate of a worktree chat's directory; default 'keep'.
   * Returns git's refusal when cleanup fails, so the caller can show it where
   * the user acted — the chat row is always removed either way.
   */
  deleteChat(id: string, worktree?: WorktreeDisposition): Promise<OpResult>
  /** Opens a terminal tab running the project's worktree setup script, if any. */
  runWorktreeSetup(chatId: string): Promise<void>
  /**
   * Move the active chat out of its worktree and into the main checkout, with
   * its branch checked out there. Returns git's refusal when it can't.
   */
  handOffToLocal(chatId: string): Promise<OpResult>
  /**
   * Drop to the new-chat composer with an existing worktree preselected, so the
   * next chat joins it. The composer's model picker still chooses the provider —
   * this is how a Codex chat picks up a worktree a Claude chat created.
   */
  startInWorktree(path: string, worktree: WorktreeInfo): Promise<void>
  /**
   * Target the next new chat should adopt. NewChat isn't mounted when the
   * sidebar picks a worktree, so the selection waits here until it is.
   */
  pendingTarget: WorktreeTarget | null
  clearPendingTarget(): void
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
  /** Replay stream events parked while the window was hidden (see applyEvent). */
  flushHiddenEvents(): void
}

// ---- Hidden-window stream parking ----
// While the window is hidden (minimized, fully covered, or on another Space)
// nothing can be seen, but streaming IPC events keep arriving and each one
// costs a React commit — Chromium's background throttling can't help because
// the work is event-driven, not timer-driven. Streamed message events for the
// active chat are parked here and replayed in one batch (a single React
// commit) when the window becomes visible again.
type ParkedEvent = Extract<ChatEvent, { type: 'message' | 'part' | 'part-delta' | 'tool-update' }>
const hiddenStream: ParkedEvent[] = []
let replayingHidden = false

function parkHiddenEvent(ev: ParkedEvent): void {
  if (ev.type === 'part-delta') {
    // Coalesce consecutive deltas to the same part, so an hours-long hidden
    // stream parks a handful of entries, not thousands.
    const last = hiddenStream[hiddenStream.length - 1]
    if (
      last?.type === 'part-delta' &&
      last.chatId === ev.chatId &&
      last.messageId === ev.messageId &&
      last.partIndex === ev.partIndex
    ) {
      last.delta += ev.delta
      return
    }
  } else if (ev.type === 'message') {
    // A full message upserts wholesale, superseding everything parked for it.
    for (let i = hiddenStream.length - 1; i >= 0; i--) {
      const p = hiddenStream[i]
      if ((p.type === 'message' ? p.message.id : p.messageId) === ev.message.id) {
        hiddenStream.splice(i, 1)
      }
    }
  }
  hiddenStream.push(ev)
}

/** Turn-finished chime + notification. Side effects only — no state writes. */
function notifyTurnDone(
  s: Pick<AppState, 'notifyPrefs' | 'chats'>,
  ev: Extract<ChatEvent, { type: 'message' }>,
  openChat: (id: string) => Promise<void>
): void {
  if (ev.message.role !== 'event' || (ev.message.kind !== 'turn' && ev.message.kind !== 'error')) {
    return
  }
  const prefs = s.notifyPrefs
  const failed = ev.message.kind === 'error'
  if (prefs.sound && !failed) playChime()
  if (prefs.finish && !document.hasFocus()) {
    const chat = s.chats.find((c) => c.id === ev.chatId)
    const title = chat?.title || (chat?.provider === 'codex' ? 'Codex' : 'Claude')
    const stats = ev.message.stats
    notify(
      title,
      failed
        ? 'The turn failed'
        : stats
          ? `Finished in ${formatDuration(stats.durationMs)}${stats.costUsd > 0 ? ` · ${formatCost(stats.costUsd)}` : ''}`
          : 'Finished',
      {
        onClick: () => {
          void window.api.focusWindow()
          void openChat(ev.chatId)
        }
      }
    )
  }
}

/**
 * Tabs belong to a chat. Switching chats stashes the current tab set under the
 * outgoing chat and restores whatever the target chat had open — empty for a
 * fresh or never-visited chat, and for the draft/home state (`nextId` null).
 * Does not touch `selectedCwd`; callers set the folder separately.
 */
function chatSwitchPatch(
  s: Pick<AppState, 'activeId' | 'openFiles' | 'activeTab' | 'tabsByChat'>,
  nextId: string | null
): Partial<AppState> {
  const tabsByChat = { ...s.tabsByChat }
  if (s.activeId) {
    tabsByChat[s.activeId] = { openFiles: s.openFiles, activeTab: s.activeTab }
  }
  const restored = (nextId ? tabsByChat[nextId] : null) ?? { openFiles: [], activeTab: null }
  return { tabsByChat, openFiles: restored.openFiles, activeTab: restored.activeTab }
}

/** Drop saved tab sets for deleted chats. */
function pruneTabsByChat(
  s: Pick<AppState, 'tabsByChat'>,
  ids: string[]
): AppState['tabsByChat'] {
  const tabsByChat = { ...s.tabsByChat }
  for (const id of ids) delete tabsByChat[id]
  return tabsByChat
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

function updateAssistant(
  messages: ChatMessage[],
  id: string,
  update: (message: AssistantMessage) => AssistantMessage
): ChatMessage[] {
  const idx = messages.findIndex((message) => message.id === id && message.role === 'assistant')
  if (idx === -1) return messages
  const next = messages.slice()
  next[idx] = update(messages[idx] as AssistantMessage)
  return next
}

/** Shallow copy of a per-chat map with the given ids removed. */
function omit<T>(map: Record<string, T>, ids: string[]): Record<string, T> {
  const next = { ...map }
  for (const id of ids) delete next[id]
  return next
}

/**
 * Repo-relative files the active chat's *last turn* edited (everything after the
 * last user message). Powers the "Last Turn" scope. Empty when no active chat
 * matches this cwd. Intersects with the dirty set so already-reverted edits drop
 * out, but falls back to the raw set if none intersect (e.g. repo-root mismatch).
 */
function lastTurnEditedPaths(
  s: Pick<AppState, 'activeId' | 'chats' | 'messages' | 'git'>,
  cwd: string
): string[] {
  const chat = s.chats.find((c) => c.id === s.activeId)
  if (!chat || chat.cwd !== cwd) return []
  let lastUser = -1
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser === -1) return []
  const edited = new Set<string>()
  for (let i = lastUser + 1; i < s.messages.length; i++) {
    const m = s.messages[i]
    if (m.role === 'assistant') for (const p of changedPathsFromParts(m.parts, cwd)) edited.add(p)
  }
  if (edited.size === 0) return []
  const dirty = new Set((s.git?.changes ?? []).map((c) => c.path))
  const scoped = [...edited].filter((p) => dirty.has(p))
  return scoped.length > 0 ? scoped : [...edited]
}

/**
 * The change list shown/committed for the current scope selector. Pure, so
 * components compute it inside a useMemo over their selected inputs (a selector
 * returning a fresh array would thrash zustand's snapshot).
 */
export function scopedChanges(
  s: Pick<AppState, 'changeScope' | 'git' | 'branchChanges' | 'activeId' | 'chats' | 'messages'>,
  cwd: string
): GitFileChange[] {
  if (s.changeScope === 'branch') return s.branchChanges?.changes ?? []
  const changes = s.git?.changes ?? []
  if (s.changeScope === 'last-turn') {
    const paths = new Set(lastTurnEditedPaths(s, cwd))
    return changes.filter((c) => paths.has(c.path))
  }
  return changes
}

const initialThemeMode = storedThemeMode()

export const useApp = create<AppState>((set, get) => ({
  chats: [],
  activeId: null,
  selectedCwd: null,
  messages: [],
  statuses: {},
  titling: {},
  backgroundJobs: {},
  rateLimits: {},
  models: [],
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

  openTerminal(opts) {
    set((s) => {
      const n = s.terminalSeq + 1
      const id = `terminal:${n}`
      return {
        terminals: [...s.terminals, { id, n, ...opts }],
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
  commandsKey: null,

  loadCommands(cwd, provider) {
    // Commands are provider-specific. Claude discovers its SDK command list;
    // Codex gets the subset Carbon can execute through the non-interactive SDK.
    const s = get()
    const prov =
      provider ??
      s.chats.find((c) => c.id === s.activeId)?.provider ??
      (s.defaults?.model ? providerForModel(s.defaults.model) : 'claude')
    const key = cwd ? `${cwd}::${prov}` : null
    // Already loaded (or loading) for this exact provider+project — nothing to do.
    if (s.commandsKey === key) return
    if (!cwd) {
      set({ commands: [], commandsKey: key })
      return
    }
    set({ commands: [], commandsKey: key })
    void window.api.getCommands(cwd, prov).then((commands) => {
      // Ignore a stale response if the project or provider changed while awaiting.
      if (get().commandsKey === key) set({ commands })
    })
  },

  // ---- Search ----

  searchOpen: false,
  setSearchOpen(open) {
    set({ searchOpen: open })
  },
  fileSearchOpen: false,
  setFileSearchOpen(open) {
    set({ fileSearchOpen: open })
  },
  findOpen: false,
  setFindOpen(open) {
    set({ findOpen: open })
  },

  // ---- Settings ----

  settingsOpen: false,
  theme: storedTheme(),
  themeMode: initialThemeMode,
  resolvedAppearance: resolveAppearance(initialThemeMode),

  openSettings() {
    set({ settingsOpen: true })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  setTheme(id) {
    const appearance = applyTheme(id, get().themeMode)
    set({ theme: id, resolvedAppearance: appearance })
    void window.api.setWindowAppearance(get().themeMode, appearance === 'dark')
  },

  setThemeMode(mode) {
    const appearance = applyTheme(get().theme, mode)
    set({ themeMode: mode, resolvedAppearance: appearance })
    void window.api.setWindowAppearance(mode, appearance === 'dark')
  },

  syncSystemAppearance() {
    if (get().themeMode !== 'system') return
    const appearance = applyTheme(get().theme, 'system')
    set({ resolvedAppearance: appearance })
    void window.api.setWindowAppearance('system', appearance === 'dark')
  },

  translucentSidebar: storedTranslucent(),

  setTranslucentSidebar(on) {
    applyTranslucent(on)
    localStorage.setItem('translucentSidebar', String(on))
    // Reveal/hide the constructor-created active native material alongside CSS.
    void window.api.setWindowTranslucent(on)
    set({ translucentSidebar: on })
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

  hiddenProjects: (() => {
    try {
      return JSON.parse(localStorage.getItem('hiddenProjects') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })(),

  setProjectHidden(cwd, hidden) {
    set((s) => {
      const hiddenProjects = { ...s.hiddenProjects }
      if (hidden) hiddenProjects[cwd] = true
      else delete hiddenProjects[cwd]
      localStorage.setItem('hiddenProjects', JSON.stringify(hiddenProjects))
      return { hiddenProjects }
    })
  },

  projectNames: (() => {
    try {
      return JSON.parse(localStorage.getItem('projectNames') ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  })(),

  setProjectName(cwd, name) {
    set((s) => {
      const projectNames = { ...s.projectNames }
      const trimmed = name.trim()
      if (trimmed) projectNames[cwd] = trimmed
      else delete projectNames[cwd]
      localStorage.setItem('projectNames', JSON.stringify(projectNames))
      return { projectNames }
    })
  },

  async init() {
    // Sync the native window vibrancy with the stored appearance preference
    // (the CSS flag was already applied pre-paint in main.tsx).
    void window.api.setWindowAppearance(get().themeMode, get().resolvedAppearance === 'dark')
    // The native material already exists in a stable active state; reveal it at
    // boot only when the user's translucency setting is on.
    void window.api.setWindowTranslucent(get().translucentSidebar)
    const [chats, defaults] = await Promise.all([window.api.listChats(), window.api.getDefaults()])
    set({
      chats,
      defaults,
      loading: false,
      selectedCwd: chats[0]?.cwd ?? defaults.recentDirs[0] ?? null
    })
    const cwd = get().selectedCwd
    if (cwd) {
      void get().refreshGit()
      void get().refreshGithub()
    }
    // No active chat yet on boot — derive the provider from the saved default
    // model so a Codex default never warms a Claude command session.
    get().loadCommands(cwd, defaults?.model ? providerForModel(defaults.model) : 'claude')
  },

  setSelectedCwd(cwd) {
    // Tabs follow the active chat, not the folder — picking a folder only sets
    // the cwd (the draft flows that call this then open a fresh chat, which
    // clears the tab set via chatSwitchPatch).
    set((s) => {
      // Explicitly picking a folder brings a hidden project back into the sidebar.
      if (cwd && s.hiddenProjects[cwd]) {
        const hiddenProjects = { ...s.hiddenProjects }
        delete hiddenProjects[cwd]
        localStorage.setItem('hiddenProjects', JSON.stringify(hiddenProjects))
        return { selectedCwd: cwd, hiddenProjects }
      }
      return { selectedCwd: cwd }
    })
    get().loadCommands(cwd)
    if (cwd) {
      void get().refreshGit()
      void get().refreshGithub()
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
  untitledSeq: 0,
  fileContents: {},
  activeTab: null,
  tabsByChat: {},
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
    // `replace` swaps a placeholder (e.g. an Untitled tab) for the chosen file
    // in the same slot, so picking a file doesn't leave the blank tab behind.
    const replace = opts?.replace
    const name = path.split('/').pop() ?? path
    set((s) => {
      const existing = s.openFiles.find((f) => f.path === path)
      let openFiles = s.openFiles
      if (existing) {
        // Re-opening a preview tab explicitly (double click) pins it.
        if (!preview && existing.preview) {
          openFiles = openFiles.map((f) => (f.path === path ? { ...f, preview: false } : f))
        }
        // The file was already open — drop the placeholder we opened it from.
        if (replace && replace !== path) openFiles = openFiles.filter((f) => f.path !== replace)
      } else if (replace && s.openFiles.some((f) => f.path === replace)) {
        openFiles = s.openFiles.map((f) => (f.path === replace ? { path, name } : f))
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

  openUntitled() {
    set((s) => {
      const path = `untitled:${s.untitledSeq + 1}`
      return {
        openFiles: [...s.openFiles, { path, name: 'Untitled', untitled: true }],
        untitledSeq: s.untitledSeq + 1,
        activeTab: path,
        ...panelPatch(s, true)
      }
    })
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

  async refreshFiles(options) {
    const s = get()
    // Files on disk are being re-synced (after a turn, a manual refresh, or a
    // terminal/external edit) — a displayed local image may have changed, so drop
    // the path-keyed image cache too.
    if (options?.invalidateImages !== false) invalidateLocalImages()
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

  explorerOpen: localStorage.getItem('rightDockOpen') === 'true',
  git: null,
  gitBusy: false,
  gitError: null,
  github: null,
  githubBusy: false,
  changeScope: (localStorage.getItem('changeScope') as ChangeScope | null) ?? 'uncommitted',
  branchChanges: null,
  preferredGitAction: (localStorage.getItem('preferredGitAction') as GitActionId | null) ?? null,
  diffContents: {},

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
    // The file tree shows when the active tab is a file editor — not the Working
    // Tree (changes) view, a browser or a terminal. If it isn't, switch to a file
    // tab (the last open file, else an empty files view) so the tree is visible.
    const onFileEditor =
      typeof s.activeTab === 'string' &&
      s.activeTab !== 'files' &&
      !s.activeTab.startsWith('changes:') &&
      !s.previews.some((p) => p.id === s.activeTab) &&
      !s.terminals.some((t) => t.id === s.activeTab) &&
      s.openFiles.some((f) => f.path === s.activeTab)
    const lastFile = [...s.openFiles].reverse().find((f) => !f.path.startsWith('changes:'))
    const activeTab = onFileEditor ? s.activeTab : (lastFile?.path ?? 'files')
    set((st) => ({ activeTab, ...panelPatch(st, true) }))
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
    // The Branch scope compares against committed history too, so keep it fresh.
    if (get().changeScope === 'branch') void get().refreshBranchChanges()
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
          const text = await window.api.gitDiff(cwd, {
            path: d.file,
            staged: d.staged,
            untracked,
            base: d.base
          })
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

  async runGitAction(id) {
    // The source-control split button funnels every rung here. `push` is
    // mechanical (run it directly); everything else is delegated to the chat's
    // agent so branch names / commit messages / PR bodies are authored well and
    // the work lands in the conversation — the same pattern Cursor 3.0 uses.
    const cwd = get().selectedCwd
    if (!cwd) return
    if (id === 'push') {
      await get().pushChanges()
      return
    }
    if (id === 'pull') {
      await get().pullChanges()
      return
    }
    const git = get().git
    const hasStaged = git?.changes.some((c) => c.staged) ?? false
    // `commitScope` is spliced into the commit-bearing prompts and follows the
    // scope selector. Priority:
    //   1. explicit staging always wins (commit exactly what's staged);
    //   2. "Last Turn" scope → just this chat's last turn's files;
    //   3. "Uncommitted"/"Branch" → the whole working tree (branch's committed
    //      part is already committed, so there's nothing extra to commit).
    let commitScope: string
    if (hasStaged) {
      commitScope = 'Commit the currently staged changes (leave everything else unstaged)'
    } else if (get().changeScope === 'last-turn') {
      const paths = lastTurnEditedPaths(get(), cwd)
      commitScope =
        paths.length > 0
          ? `Stage and commit only the files this session's last turn changed (${paths.join(', ')}), leaving any other working-tree changes unstaged`
          : 'Stage all current changes and commit them'
    } else {
      commitScope = 'Stage all current changes and commit them'
    }
    set({ gitError: null })
    const prompt = gitActionPrompt(id, { commitScope })
    // Show the action as a compact chip in the chat, not the verbose prompt.
    const label = gitAction(id).label
    if (get().activeId) await get().sendMessage(prompt, undefined, label)
    else await get().newChat(cwd, prompt, { label })
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

  async pullChanges() {
    const cwd = get().selectedCwd
    if (!cwd || get().gitBusy) return
    set({ gitBusy: true, gitError: null })
    try {
      const res = await window.api.gitPull(cwd)
      if (!res.ok) set({ gitError: res.error })
    } finally {
      set({ gitBusy: false })
      await get().refreshGit()
      // A pull can land the PR merge / new commits — refresh GitHub too.
      void get().refreshGithub()
    }
  },

  async fetchRemote() {
    // Updates remote-tracking refs so refreshGit sees a truthful ahead/behind.
    // Best-effort: a no-remote/offline repo just leaves the counts as they were.
    const cwd = get().selectedCwd
    if (!cwd) return
    await window.api.gitFetch(cwd)
    if (get().selectedCwd === cwd) {
      await get().refreshGit()
      void get().refreshGithub()
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

  async refreshGithub() {
    const cwd = get().selectedCwd
    if (!cwd) {
      set({ github: null })
      return
    }
    // gh calls hit the network — don't stack overlapping fetches.
    if (get().githubBusy) return
    set({ githubBusy: true })
    try {
      const github = await window.api.githubState(cwd)
      // Guard against a project switch happening while we awaited.
      if (get().selectedCwd === cwd) set({ github })
    } catch {
      if (get().selectedCwd === cwd) set({ github: null })
    } finally {
      set({ githubBusy: false })
    }
  },

  setChangeScope(scope) {
    localStorage.setItem('changeScope', scope)
    set({ changeScope: scope })
    if (scope === 'branch') void get().refreshBranchChanges()
  },

  async refreshBranchChanges() {
    const cwd = get().selectedCwd
    if (!cwd) {
      set({ branchChanges: null })
      return
    }
    try {
      const branchChanges = await window.api.gitBranchChanges(cwd, get().github?.defaultBranch)
      if (get().selectedCwd === cwd) set({ branchChanges })
    } catch {
      if (get().selectedCwd === cwd) set({ branchChanges: null })
    }
  },

  async openPr() {
    const cwd = get().selectedCwd
    if (!cwd || !get().github?.pr) return
    const res = await window.api.githubOpenPr(cwd)
    if (!res.ok) set({ gitError: res.error })
  },

  setPreferredGitAction(id) {
    localStorage.setItem('preferredGitAction', id)
    set({ preferredGitAction: id })
  },

  async openDiff(change, opts) {
    const cwd = get().selectedCwd
    if (!cwd) return
    const preview = opts?.preview ?? false
    const untracked = change.status === '?'
    // Branch scope: diff the whole branch delta (base → working tree) for this
    // file — except untracked files, which have no base blob and use --no-index.
    const base =
      !untracked && get().changeScope === 'branch'
        ? (get().branchChanges?.base ?? undefined)
        : undefined
    const kind = base ? 'b' : change.staged ? 's' : 'w'
    const id = `diff:${kind}:${cwd}:${change.path}`
    const name = change.path.split('/').pop() ?? change.path
    const label = base
      ? `${name} (branch)`
      : change.staged
        ? `${name} (staged)`
        : `${name} (diff)`
    const meta: DiffTabMeta = {
      cwd,
      file: change.path,
      staged: change.staged,
      untracked,
      base
    }
    set((s) => {
      const existing = s.openFiles.find((f) => f.path === id)
      let openFiles = s.openFiles
      if (existing) {
        // Re-opening a preview diff explicitly (double click) pins it.
        if (!preview && existing.preview) {
          openFiles = openFiles.map((f) => (f.path === id ? { ...f, preview: false } : f))
        }
      } else if (preview) {
        // A single-clicked diff reuses the current preview slot, like a file.
        const slot = openFiles.findIndex((f) => f.preview)
        const tab: OpenTab = { path: id, name: label, diff: meta, preview: true }
        openFiles =
          slot === -1 ? [...openFiles, tab] : openFiles.map((f, i) => (i === slot ? tab : f))
      } else {
        openFiles = [...openFiles, { path: id, name: label, diff: meta }]
      }
      return { openFiles, activeTab: id, ...panelPatch(s, true) }
    })
    const text = await window.api.gitDiff(cwd, {
      path: change.path,
      staged: change.staged,
      untracked: meta.untracked,
      base: meta.base
    })
    set((s) => ({ diffContents: { ...s.diffContents, [id]: text } }))
  },

  changesScroll: null,

  openChanges(target) {
    const cwd = get().selectedCwd
    if (!cwd) return
    const id = `changes:${cwd}`
    set((s) => ({
      openFiles: s.openFiles.some((f) => f.path === id)
        ? s.openFiles
        : [...s.openFiles, { path: id, name: 'Working Tree' }],
      activeTab: id,
      changesScroll: target
        ? { key: `${target.staged ? 's' : 'w'}:${target.path}`, n: (s.changesScroll?.n ?? 0) + 1 }
        : s.changesScroll,
      ...panelPatch(s, true)
    }))
    void get().refreshGit()
  },

  async reviewChanges() {
    if (!get().selectedCwd) return
    // Open the Working Tree tab (all diffs stacked); the dock follows it and
    // shows the changes tree. setExplorerOpen ensures that dock is visible.
    get().setExplorerOpen(true) // also refreshes git
    get().openChanges()
  },

  async openChat(id) {
    // Parked hidden-stream events are superseded: the target chat refetches
    // from main below, and events for the outgoing chat no longer apply.
    hiddenStream.length = 0
    if (id === null) {
      set((s) => ({
        // Stash the outgoing chat's tabs; the draft/home state opens no tabs.
        ...chatSwitchPatch(s, null),
        activeId: null,
        messages: [],
        planPanel: null,
        settingsOpen: false,
        panelMaximized: false,
        // The right panel is per chat; a fresh/draft chat starts collapsed.
        panelOpen: false
      }))
      return
    }
    set((s) => ({
      // Restore this chat's own tab set (empty if never visited); stash the
      // outgoing chat's. Done synchronously so tabs swap on click, not after
      // the getChat round-trip below.
      ...chatSwitchPatch(s, id),
      activeId: id,
      messages: [],
      planPanel: null,
      settingsOpen: false,
      panelMaximized: false,
      // Panel visibility is per chat; unvisited chats start closed.
      panelOpen: s.panelOpenByChat[id] ?? false
    }))
    // Drop cached local images so this chat's inline pictures re-read from disk —
    // it may have been overwritten (by a background turn or externally) since it
    // was last shown.
    invalidateLocalImages()
    const chat = await window.api.getChat(id)
    // Guard against a chat switch happening while we awaited.
    if (get().activeId === id && chat) {
      const cwdChanged = get().selectedCwd !== chat.cwd
      set((s) => {
        // Events that streamed in for this chat *during* the getChat round-trip
        // were applied to `messages` (it's the active chat now). The snapshot
        // from disk can be up to a debounce behind, so layer the live-streamed
        // messages over it (upsert by id) rather than clobbering them back to a
        // stale state.
        const messages = s.messages.reduce(upsertMessage, chat.messages)
        // Tabs were already restored synchronously above; only the folder is
        // deferred until now (it needs the chat's cwd from disk).
        const review = chat.pendingPlanReview
        const permissions = review
          ? {
              ...s.permissions,
              [id]: [
                ...(s.permissions[id] ?? []).filter((request) => request.id !== review.requestId),
                persistedPlanRequest(id, review)
              ]
            }
          : s.permissions
        return {
          messages,
          selectedCwd: chat.cwd,
          permissions,
          statuses: review ? { ...s.statuses, [id]: 'waiting-permission' } : s.statuses
        }
      })
      // Keyed by provider too: switching Claude→Codex in the same folder must
      // clear Claude's commands (and Codex→Claude must restore them).
      get().loadCommands(chat.cwd, chat.provider)
      if (cwdChanged || !get().git) void get().refreshGit()
      if (cwdChanged || !get().github) void get().refreshGithub()
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
    const { attachments, label, ...createOpts } = opts ?? {}
    const meta = await window.api.createChat({ cwd, ...createOpts })
    // A worktree chat's cwd is the worktree, not the picked project folder —
    // the panel, git status and file tree all follow it.
    const chatCwd = meta.cwd
    // Starting a chat in a hidden project brings it back into the sidebar.
    if (get().hiddenProjects[cwd]) get().setProjectHidden(cwd, false)
    set((s) => ({
      // A brand-new chat has no saved tabs, so this stashes the outgoing chat's
      // and opens an empty tab set.
      ...chatSwitchPatch(s, meta.id),
      selectedCwd: chatCwd,
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
    get().loadCommands(chatCwd, meta.provider)
    void get().refreshGit()
    if (get().panelOpen && !get().filesByDir[chatCwd]) void get().loadDir(chatCwd)
    // A fresh worktree has no gitignored files — no node_modules, no .env — so
    // run the project's setup script in a visible terminal tab. Deliberately not
    // awaited: the agent starts now and the install races alongside it.
    if (meta.worktree) void get().runWorktreeSetup(meta.id)
    await window.api.send(meta.id, firstMessage, attachments, label)
  },

  pendingTarget: null,

  clearPendingTarget() {
    set({ pendingTarget: null })
  },

  async startInWorktree(path, { repoRoot, branch }) {
    set({ pendingTarget: { kind: 'existing', path, branch, repoRoot } })
    // The composer works against the worktree itself (@-mentions, file tree),
    // not the project root it branched from.
    get().setSelectedCwd(path)
    await get().openChat(null)
  },

  async handOffToLocal(chatId) {
    const res = await window.api.worktreeHandoff(chatId)
    // Main emits a `meta` patch with the new cwd, which applyEvent folds into
    // the chat list — but the panel follows selectedCwd, so move that too.
    const moved = get().chats.find((c) => c.id === chatId)
    if (moved && !moved.worktree && get().activeId === chatId) {
      get().setSelectedCwd(moved.cwd)
      void get().refreshGit()
    }
    return res
  },

  async runWorktreeSetup(chatId) {
    const command = await window.api.worktreeSetupCommand(chatId)
    if (!command) return
    const chat = get().chats.find((c) => c.id === chatId)
    if (chat) get().openTerminal({ cwd: chat.cwd, command, label: 'Setup' })
  },

  async sendMessage(text, attachments, label) {
    const id = get().activeId
    if (!id) return
    // Mid-turn sends wait in a queue until the chat goes idle, like Cursor.
    if ((get().statuses[id] ?? 'idle') !== 'idle') {
      const item: QueuedMessage = { id: crypto.randomUUID(), text, attachments, label }
      set((s) => ({ queued: { ...s.queued, [id]: [...(s.queued[id] ?? []), item] } }))
      return
    }
    await window.api.send(id, text, attachments, label)
  },

  async sendQueuedNow(chatId, id) {
    const item = get().queued[chatId]?.find((q) => q.id === id)
    if (item == null) return
    if ((get().statuses[chatId] ?? 'idle') !== 'idle') {
      // Promote it to the front so the idle drain fires this one first, then
      // interrupt the running turn so "idle" comes now instead of at turn end.
      set((s) => ({
        queued: {
          ...s.queued,
          [chatId]: [item, ...(s.queued[chatId] ?? []).filter((q) => q.id !== id)]
        }
      }))
      await window.api.interrupt(chatId)
      return
    }
    // Already idle (e.g. the turn just ended) — send it straight away.
    set((s) => ({
      queued: { ...s.queued, [chatId]: (s.queued[chatId] ?? []).filter((q) => q.id !== id) }
    }))
    await window.api.send(chatId, item.text, item.attachments, item.label)
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

  stopBackgroundJob(taskId) {
    const id = get().activeId
    if (!id) return
    void window.api.stopBackgroundJob(id, taskId)
  },

  async loadModels(chatId) {
    if (get().models.length) return // the list is stable per app run (account-level)
    const id = chatId ?? get().activeId
    if (!id) return
    const models = await window.api.listModels(id)
    if (models.length) set({ models })
  },

  async rewindFiles(userMessageId, dryRun) {
    const id = get().activeId
    if (!id) return { canRewind: false, error: 'No active chat.' }
    const res = await window.api.rewindFiles(id, userMessageId, dryRun)
    // A real rewind changes files on disk — refresh the tree, open files and git.
    if (!dryRun && res.canRewind) {
      void get().refreshGit()
      if (get().panelOpen || get().openFiles.length > 0) void get().refreshFiles()
    }
    return res
  },

  async deleteChat(id, worktree) {
    // The chat row always goes; a worktree we failed to clean up stays on disk
    // and is handed back so the caller can surface it (gitError would only show
    // inside GitPanel, which the user may not have open).
    const res = await window.api.deleteChat(id, worktree)
    set((s) => {
      const wasActive = s.activeId === id
      return {
        chats: s.chats.filter((c) => c.id !== id),
        activeId: wasActive ? null : s.activeId,
        messages: wasActive ? [] : s.messages,
        // Deleting the active chat drops to the draft/home state — clear its tabs.
        planPanel: wasActive ? null : s.planPanel,
        openFiles: wasActive ? [] : s.openFiles,
        activeTab: wasActive ? null : s.activeTab,
        queued: omit(s.queued, [id]),
        statuses: omit(s.statuses, [id]),
        titling: omit(s.titling, [id]),
        permissions: omit(s.permissions, [id]),
        backgroundJobs: omit(s.backgroundJobs, [id]),
        rateLimits: omit(s.rateLimits, [id]),
        panelOpenByChat: prunePanelState(s, [id]),
        tabsByChat: pruneTabsByChat(s, [id])
      }
    })
    return res
  },

  async removeProject(cwd) {
    const inProject = (c: ChatMeta): boolean => projectRoot(c) === cwd
    const ids = get().chats.filter(inProject).map((c) => c.id)
    // 'remove' never forces: a worktree with uncommitted work survives the
    // project being dropped from the sidebar rather than being destroyed.
    await Promise.all(ids.map((id) => window.api.deleteChat(id, 'remove')))
    await window.api.forgetDir(cwd)
    set((s) => {
      const chats = s.chats.filter((c) => !inProject(c))
      const wasActive = s.activeId !== null && ids.includes(s.activeId)
      const recentDirs = s.defaults?.recentDirs.filter((d) => d !== cwd) ?? []
      // Drop any stale hidden flag so re-adding the folder later isn't hidden.
      let hiddenProjects = s.hiddenProjects
      if (hiddenProjects[cwd]) {
        hiddenProjects = { ...hiddenProjects }
        delete hiddenProjects[cwd]
        localStorage.setItem('hiddenProjects', JSON.stringify(hiddenProjects))
      }
      return {
        // If the removed folder was selected, fall back to another one.
        selectedCwd:
          s.selectedCwd === cwd ? (chats[0]?.cwd ?? recentDirs[0] ?? null) : s.selectedCwd,
        chats,
        hiddenProjects,
        activeId: wasActive ? null : s.activeId,
        messages: wasActive ? [] : s.messages,
        planPanel: wasActive ? null : s.planPanel,
        // Removing the active chat's project drops to the draft state — clear tabs.
        openFiles: wasActive ? [] : s.openFiles,
        activeTab: wasActive ? null : s.activeTab,
        queued: omit(s.queued, ids),
        statuses: omit(s.statuses, ids),
        titling: omit(s.titling, ids),
        permissions: omit(s.permissions, ids),
        backgroundJobs: omit(s.backgroundJobs, ids),
        rateLimits: omit(s.rateLimits, ids),
        panelOpenByChat: prunePanelState(s, ids),
        tabsByChat: pruneTabsByChat(s, ids),
        defaults: s.defaults ? { ...s.defaults, recentDirs } : s.defaults
      }
    })
  },

  async renameChat(id, title) {
    await window.api.renameChat(id, title)
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, title, titleManual: true } : c))
    }))
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

  flushHiddenEvents() {
    if (hiddenStream.length === 0) return
    const parked = hiddenStream.splice(0, hiddenStream.length)
    // Replay through the normal reducer in one synchronous batch — React
    // coalesces the set() calls into a single commit. The flag suppresses
    // re-parking and duplicate notifications.
    replayingHidden = true
    try {
      for (const p of parked) get().applyEvent(p)
    } finally {
      replayingHidden = false
    }
  },

  applyEvent(ev) {
    // A stale parked stream must replay before any live event applies, or
    // deltas would land out of order (the visibilitychange listener usually
    // flushes first; this is the fallback).
    if (!replayingHidden && hiddenStream.length > 0 && document.visibilityState !== 'hidden') {
      get().flushHiddenEvents()
    }
    const s = get()
    if (
      !replayingHidden &&
      document.visibilityState === 'hidden' &&
      (ev.type === 'message' ||
        ev.type === 'part' ||
        ev.type === 'part-delta' ||
        ev.type === 'tool-update') &&
      ev.chatId === s.activeId
    ) {
      parkHiddenEvent(ev)
      // The turn-finished chime/notification still fires in real time — a
      // hidden window is exactly when the user needs it.
      if (ev.type === 'message') notifyTurnDone(s, ev, (id) => get().openChat(id))
      return
    }
    switch (ev.type) {
      case 'message': {
        // Single state update per message: upsert the active chat's messages
        // (when this event is for it) and keep sidebar ordering fresh, in one
        // set() so each message causes one render pass instead of two.
        set((st) => ({
          ...(ev.chatId === st.activeId
            ? { messages: upsertMessage(st.messages, ev.message) }
            : {}),
          chats: st.chats
            .map((c) => (c.id === ev.chatId ? { ...c, updatedAt: Date.now() } : c))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        // Turn finished: chime + background notification (already fired at
        // park time when this is a replay).
        if (!replayingHidden) notifyTurnDone(s, ev, (id) => get().openChat(id))
        break
      }

      case 'part': {
        if (ev.chatId !== s.activeId) break
        set({
          messages: updateAssistant(s.messages, ev.messageId, (m) => {
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
          messages: updateAssistant(s.messages, ev.messageId, (m) => {
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
          messages: updateAssistant(s.messages, ev.messageId, (m) => {
            const parts = m.parts.map((p) =>
              // Streamed parts arrays can be sparse — guard the holes.
              p && p.type === 'tool' && p.toolUseId === ev.toolUseId ? { ...p, ...ev.patch } : p
            )
            return { ...m, parts }
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

      case 'background-jobs': {
        set((st) => ({
          backgroundJobs: { ...st.backgroundJobs, [ev.chatId]: ev.jobs }
        }))
        break
      }

      case 'rate-limit': {
        set((st) => ({ rateLimits: { ...st.rateLimits, [ev.chatId]: ev.state } }))
        break
      }

      case 'title-pending': {
        set((st) => ({ titling: { ...st.titling, [ev.chatId]: ev.pending } }))
        break
      }

      case 'status': {
        set((st) => ({ statuses: { ...st.statuses, [ev.chatId]: ev.status } }))
        // Any non-idle status means a live session (a new chat's first turn is
        // 'starting', not 'streaming') — load the SDK model list (once, cached)
        // so the picker shows the real "1M context" descriptions rather than the
        // static fallback. loadModels waits for init internally.
        if (ev.status !== 'idle') void get().loadModels(ev.chatId)
        // main dedups consecutive statuses, so an `idle` here is a real
        // transition (the interrupt()+result double-`idle` is collapsed there).
        if (ev.status === 'idle') {
          // A queued message goes out as soon as the chat is free again.
          const next = get().queued[ev.chatId]?.[0]
          if (next) {
            set((st) => ({
              queued: { ...st.queued, [ev.chatId]: st.queued[ev.chatId].slice(1) }
            }))
            void window.api.send(ev.chatId, next.text, next.attachments, next.label)
          }
          // Refresh the tree, open files and git status for the active chat so
          // the agent's edits show up.
          if (ev.chatId === s.activeId) {
            // Invalidate once for the visible chat. Background turns are handled
            // when that chat is opened, avoiding needless multi-megabyte image
            // re-reads in an unrelated foreground conversation.
            invalidateLocalImages()
            void get().refreshGit()
            // The agent may have pushed or opened a PR — pick up the new state.
            void get().refreshGithub()
            if (s.panelOpen || s.openFiles.length > 0) {
              void get().refreshFiles({ invalidateImages: false })
            }
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
          const chat = s.chats.find((c) => c.id === ev.chatId)
          const agent = chat?.provider === 'codex' ? 'Codex' : 'Claude'
          const title = chat?.title || agent
          const what =
            ev.request.toolName === 'ExitPlanMode'
              ? 'has a plan ready for review'
              : `wants to use ${ev.request.displayName ?? ev.request.toolName}`
          notify(title, `${agent} ${what}`, {
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
        // Pushed by a Claude session's command watcher — only apply it if the
        // active project is still on Claude (not switched to Codex in the same
        // folder), so it can't repopulate the menu for a Codex chat.
        if (get().commandsKey === `${ev.cwd}::claude`) set({ commands: ev.commands })
        break
      }
    }
  }
}))

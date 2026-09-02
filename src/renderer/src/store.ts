import { create } from 'zustand'
import {
  applyCodeFontSize,
  applyTheme,
  applyTranslucent,
  CODE_FONT_MAX,
  CODE_FONT_MIN,
  currentDockIconPalette,
  resolveAppearance,
  storedCodeFontSize,
  storedTheme,
  storedThemeMode,
  storedTranslucent
} from '@/lib/themes'
import type { ResolvedAppearance, ThemeMode } from '@/lib/themes'
import { loadNotifyPrefs, notify, saveNotifyPrefs, type NotifyPrefs } from '@/lib/notify'
import { playCue } from '@/lib/sounds'
import { formatCost, formatDuration, sameDisplayedTime } from '@/lib/format'
import { invalidateLocalImages } from '@/lib/imageCache'
import { gitAction, gitActionPrompt, type GitActionId } from '@/lib/gitActions'
import { changedPathsFromParts } from '@/lib/turnChanges'
import { basename } from '@/lib/format'
import {
  adoptDisk,
  bufferMtime,
  bufferText,
  dropBuffer,
  getBuffer,
  isDirty,
  markSaved,
  rebaseTo,
  renameBuffer,
  setDirtyListener
} from '@/lib/editorBuffers'
import { notifyWatchedChanges } from '@/lib/lspBridge'
import {
  availableProviders,
  hasCompleteModelCatalog,
  mergeModelCatalogs
} from '@/lib/modelCatalog'
import {
  isEmptyDraft,
  loadDrafts,
  pruneChatDrafts,
  sameDraft,
  sameOptions,
  saveDrafts
} from '@/lib/drafts'
import type { ComposerDraft, ProjectDraft, ProjectDraftOptions } from '@/lib/drafts'
import { moveItem } from '@/lib/tabOrder'
import {
  CANVAS_ATTACH_MAX_CHARS,
  PROVIDER_SHORT_LABELS,
  USAGE_DEFAULT_DAYS,
  knownProviderForModel,
  projectRoot,
  providerForRememberedModel
} from '@shared/types'
import { canvasText } from '@shared/canvasText'
import type {
  CanvasSummary,
  AppDefaults,
  AssistantMessage,
  Attachment,
  BranchChanges,
  ChatEvent,
  ChatMessage,
  ContextUsage,
  ChatMeta,
  ChatStatus,
  CodexGoal,
  CodexGoalStatus,
  CodexReviewTarget,
  BackgroundJob,
  EffortId,
  FastModeStatus,
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
  PublishOpts,
  PublishResult,
  ChatOptionsPatch,
  Provider,
  ProviderCli,
  ProviderCliConfig,
  RateLimitState,
  EditMessageResult,
  RewindResult,
  ServiceTier,
  SlashCommand,
  UpdateInfo,
  UsageOverview,
  UsageReport,
  WorktreeDisposition,
  WorktreeInfo,
  WorktreeTarget
} from '@shared/types'

/** Bounds for the sidebar "recent chats per project" setting. */
export const CHATS_PER_PROJECT_MIN = 3
export const CHATS_PER_PROJECT_MAX = 20
export const CHATS_PER_PROJECT_DEFAULT = 10

/**
 * How much a sidebar chat row says.
 *
 * `compact` is one line — the title, and the time or what the chat is doing.
 * `detailed` adds the things you'd otherwise have to open the chat to learn:
 * which backend is answering, and which branch (or folder, outside a repo) it
 * is answering in. The distinction earns its keep because the two facts it adds
 * are exactly the ones that differ between chats that *look* identical — two
 * chats on one project, one on a worktree branch and one on main.
 */
export type SidebarDensity = 'compact' | 'detailed'

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
  /**
   * Chat this tab was opened from. Tabs stay visible from every chat — this is
   * only so deleting that chat can reap the shell (and drop the tab with it).
   */
  chatId?: string
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

/**
 * Whether a tab names a real file on disk — the only kind that can be read,
 * buffered, saved or conflict-checked. The tab strip carries four other kinds
 * (`diff:` ids, the `changes:` working-tree view, Untitled placeholders,
 * terminals and previews) that are all shaped like `{ path, name }` and would
 * otherwise be indistinguishable from a file.
 *
 * One predicate rather than a repeated prefix test: what it guards used to be
 * cosmetic and is now a buffer, so the next tab kind added has to be caught
 * here rather than remembered at each site.
 */
export function isFileTab(tab: OpenTab): boolean {
  return !tab.diff && !tab.untitled && !tab.path.startsWith('changes:')
}

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
  /** Messages of the active chat — the loaded window, not necessarily all of them. */
  messages: ChatMessage[]
  /**
   * The active chat's live context breakdown, from the last assistant message.
   * Null until a turn reports one — an older CLI never does. Renderer-only and
   * per-session by design: see `ContextUsage`.
   */
  contextUsage: ContextUsage | null
  /**
   * How many older messages of the active chat are still in the database and
   * not in `messages`. Zero means the whole chat is here. See `ChatView`.
   */
  hiddenBefore: number
  /** A loadOlderMessages round-trip is in flight. */
  loadingOlder: boolean
  statuses: Record<string, ChatStatus>
  /** Chats another Carbon instance owns; edits here are not being saved. */
  lockedChats: Record<string, true>
  /** Chats whose AI title is being generated right now (sidebar shimmers them). */
  titling: Record<string, boolean>
  /** Live background tasks per chat (SDK reports the full set on each change). */
  backgroundJobs: Record<string, BackgroundJob[]>
  /** Latest plan rate-limit signal per chat (from `rate_limit_event`). */
  rateLimits: Record<string, RateLimitState>
  /**
   * Account-level plan limits for both providers, behind the sidebar's Usage
   * chip. App-global rather than per-chat: it's a property of the logins, and
   * every chat's turns draw down the same windows.
   */
  usage: UsageOverview | null
  /**
   * Re-reads both providers' plan limits. Unforced calls are cheap — main
   * answers from its cache unless it has gone stale — so callers don't throttle
   * themselves; the one TTL over there is what caps real reads. `force` is the
   * panel's explicit refresh and always spends a real read.
   */
  refreshUsage(force?: boolean): Promise<void>
  /**
   * Whether the provider is honouring each chat's Fast selection. Absent means
   * not reported yet (a chat with no live session, or a Codex chat — the Codex
   * SDK exposes nothing equivalent), which the composer treats as "don't know"
   * rather than "fine".
   */
  fastMode: Record<string, FastModeStatus>
  /** Native persisted Codex goal per chat; absent until App Server has answered. */
  codexGoals: Partial<Record<string, CodexGoal | null>>
  loadCodexGoal(chatId: string): Promise<void>
  setCodexGoal(
    chatId: string,
    patch: { objective?: string; status?: CodexGoalStatus; tokenBudget?: number | null }
  ): Promise<CodexGoal>
  clearCodexGoal(chatId: string): Promise<boolean>
  /** Models reported by both provider control APIs; empty until loaded. */
  models: ModelOption[]
  /** Fetches the session's model list once and caches it (feeds the composer picker). */
  loadModels(chatId?: string, cwd?: string): Promise<void>
  /** User-level Codex default, kept separate from Claude's dynamic model rows. */
  codexConfigModel: string | null | undefined
  loadCodexConfigModel(): Promise<void>
  /**
   * Each provider's CLI as main resolved it. Carbon runs the user's own
   * installs, so this is what decides which providers the pickers offer — not a
   * static list — and what Settings → Providers renders.
   */
  providerClis: ProviderCli[]
  /** `refresh` re-probes the disk, for the Providers section's Recheck. */
  loadProviderClis(refresh?: boolean): Promise<void>
  /** Toggle a provider or pin its binary; refetches the model catalog after. */
  setProviderCli(provider: Provider, patch: ProviderCliConfig): Promise<void>
  /** Revert the working tree to a user message's checkpoint (dryRun previews only). */
  rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult>
  /**
   * Reword a user message and run it again, dropping everything after it. The
   * transcript is trimmed by the `truncate` event main sends back, not here —
   * the rewind has to land on disk before the UI claims it happened.
   */
  editMessage(messageId: string, text: string): Promise<EditMessageResult>
  /** Pending permission requests, keyed by chat id. */
  permissions: Record<string, PermissionRequestPayload[]>
  /** Messages typed while a turn was running, sent when the chat goes idle. */
  queued: Record<string, QueuedMessage[]>
  planPanel: PlanPanelState | null
  /**
   * Canvases for the active chat's *project*, newest first. Summaries only —
   * the body is fetched when one is opened, because a project's canvases are a
   * list of titles far more often than they are a document being read.
   */
  canvases: CanvasSummary[]
  /**
   * Ids of the canvases open as their own tabs, in the order they were opened.
   *
   * A canvas gets a *tab*, not a mode of one shared tab: two of them are read
   * side by side — that is most of the point of a document panel — and a single
   * slot with a back button makes comparing two a round trip through a list.
   * They are deliberately not `openFiles` entries, though: a canvas has no
   * path, no dirty state, no preview slot and nothing to save, so it would have
   * meant teaching every one of those rules a case that never applies.
   */
  canvasTabs: string[]
  /**
   * Open canvas tabs of every project that is not the current one, keyed by
   * project root — `tabsByChat`'s shape one level up. Leaving a project
   * stashes its tabs here and returning restores them, so a document open in
   * one project survives a visit to another chat's project.
   */
  canvasTabsByProject: Record<string, string[]>
  /** Canvas awaiting a delete confirmation, or null. */
  pendingCanvasDelete: CanvasSummary | null
  /** Body per open canvas; `null` while its read is in flight. */
  canvasHtml: Record<string, string | null>
  defaults: AppDefaults | null
  loading: boolean
  sidebarOpen: boolean
  toggleSidebar(): void

  // ---- Updates ----
  /** A release newer than this build, or null. Set by the periodic check. */
  update: UpdateInfo | null
  /** Version the user dismissed; suppresses the banner until a newer one ships. */
  updateDismissed: string | null
  checkForUpdate(): Promise<void>
  dismissUpdate(): void

  // ---- Terminal ----
  /** Open terminal tabs in the right panel; each has its own shell session. */
  terminals: TerminalTab[]
  /** Monotonic counter for stable "Terminal N" labels. */
  terminalSeq: number
  /**
   * Foreground process per terminal id, for tabs running something (a dev
   * server, a build). Absent/undefined means an idle shell. Tracked in the store
   * rather than in TerminalPanel because the tab strip and the panel toggle show
   * it while the terminal itself is unmounted or hidden.
   */
  terminalBusy: Record<string, string>
  /** Opens a new terminal tab and focuses it. */
  /** Opens a terminal tab; `command` runs one-shot instead of an interactive shell. */
  openTerminal(opts?: { cwd?: string; command?: string; label?: string }): void
  closeTerminal(id: string): void
  /** Records a terminal's foreground process; null clears it back to idle. */
  setTerminalBusy(id: string, command: string | null): void
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

  // ---- Drafts ----
  /**
   * Unsent composer text, keyed by chat id. `ChatView` is keyed by chat id, so
   * every switch remounts the composer — without this the box is emptied by
   * simply looking at another chat.
   */
  chatDrafts: Record<string, ComposerDraft>
  /**
   * Unsent home-screen prompts, one per project folder — the sidebar's Drafts
   * section. Not chats: see `lib/drafts.ts` for why a draft must stay
   * pre-creation state.
   */
  projectDrafts: Record<string, ProjectDraft>
  saveChatDraft(chatId: string, draft: ComposerDraft): void
  /** Writes (or, when empty, clears) a project's draft plus the pickers' state. */
  saveProjectDraft(cwd: string, draft: ComposerDraft, options: ProjectDraftOptions): void
  /** Updates an *existing* draft's launch options; the pickers alone aren't a draft. */
  patchProjectDraft(cwd: string, options: ProjectDraftOptions): void
  discardProjectDraft(cwd: string): void
  /**
   * Bumped per project by `discardProjectDraft`. The composer keeps its text in
   * local state, so deleting the store entry alone would be undone by the next
   * debounce — this is how a discard reaches the box that is still holding it.
   * A counter rather than a flag: two discards in a row must both land.
   */
  draftDiscards: Record<string, number>
  /** Sidebar Drafts row: the home screen in that project, with the draft restored. */
  openDraft(cwd: string): void

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
  /**
   * The "which project?" chooser that ⌘N and the sidebar's New chat row open.
   * State rather than a local `useState` for the same reason `searchOpen` is:
   * the shortcut is bound in `App`, the dialog lives in `Sidebar`.
   */
  newChatOpen: boolean
  setNewChatOpen(open: boolean): void
  /**
   * New chat (⌘N / sidebar row / menu). If the sidebar is already filtered to
   * one project, that is an explicit pick — skip the chooser and start there.
   * Otherwise open the project palette.
   */
  startNewChat(): void
  /** When true the file quick-open dialog is open (⌘P). */
  fileSearchOpen: boolean
  setFileSearchOpen(open: boolean): void
  /** When true the find-in-page bar is open (⌘F). */
  findOpen: boolean
  setFindOpen(open: boolean): void

  // ---- Usage page ----
  /**
   * When true the main area shows the usage page. Mutually exclusive with
   * `settingsOpen` — both are full-window pages that replace the chat.
   */
  usageOpen: boolean
  /** Window the page is showing, in days (see `USAGE_RANGES`). */
  usageDays: number
  usageReport: UsageReport | null
  usageReportLoading: boolean
  openUsage(): void
  closeUsage(): void
  /** `refresh` re-reads every session log instead of trusting the file cache. */
  loadUsageReport(days?: number, refresh?: boolean): Promise<void>

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
  /** Interface text size as a percent — everything that is not code. */
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
  /** How much each sidebar chat row says — see `SidebarDensity`. Persisted. */
  sidebarDensity: SidebarDensity
  setSidebarDensity(density: SidebarDensity): void
  /**
   * Project (by cwd) the detailed sidebar's flat list is scoped to; null is all
   * of them. Detailed mode trades project *grouping* for a self-describing row,
   * so this is what gets you back to one project's chats when you want them.
   * Persisted, and ignored when the project is gone.
   */
  sidebarProject: string | null
  setSidebarProject(cwd: string | null): void
  /**
   * Branch checked out in each chat's cwd (null outside a repo), keyed by cwd —
   * what the detailed sidebar rows label themselves with. Only populated in
   * detailed mode; `refreshChatBranches` is a no-op otherwise.
   */
  chatBranches: Record<string, string | null>
  refreshChatBranches(): Promise<void>
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
  /**
   * The inline "name it" row in the file tree, if one is open. Lives in the
   * store rather than in `TreeNode` because the row can be opened from three
   * places — the header buttons and either kind of context menu — and
   * `TreeNode` recurses, so a prop would have to be threaded through every
   * level to reach the one folder that wants it.
   */
  pendingCreate: { parent: string; kind: 'file' | 'dir'; error?: string } | null
  /**
   * The delete the tree is asking about. Deleting is the one thing in the tree
   * that touches work the user cannot get back from the app, so it is always a
   * question — never a menu click that acts.
   */
  pendingDelete: { path: string; kind: 'dir' | 'file'; error?: string } | null
  /** The inline rename row, if one is open. Same shape and reasons as `pendingCreate`. */
  pendingRename: { path: string; kind: 'dir' | 'file'; error?: string } | null
  /**
   * Paths with unsaved edits. Only the *transition* is stored here — the text
   * itself lives in the CodeMirror buffer (`lib/editorBuffers.ts`), because
   * routing keystrokes through zustand re-renders every subscriber.
   */
  dirtyFiles: Record<string, boolean>
  /**
   * Files whose disk copy moved under a buffer that has unsaved edits — the
   * agent and the user editing the same file. The value is the mtime found on
   * disk; the tab shows a bar offering Reload or Overwrite.
   */
  fileConflicts: Record<string, number>

  togglePanel(): void
  loadDir(dir: string): Promise<void>
  toggleDir(dir: string): void
  openFile(path: string, opts?: { preview?: boolean; replace?: string }): Promise<void>
  /** Open a blank "Untitled" placeholder tab (a file picker until one is chosen). */
  openUntitled(): void
  closeFile(path: string): void
  /** Pins a preview tab so the next preview doesn't replace it. */
  promoteTab(path: string): void
  setActiveTab(tab: string | null): void
  /**
   * ⌘W. A counter rather than an action that closes something, because what
   * the active tab *is* — and the unsaved-edits question a file tab may have
   * to ask first — both live in `RightPanel`, which resolves `activeTab` against
   * what is actually open. The panel observes the tick and does the closing.
   */
  closeTabTick: number
  closeActiveTab(): void
  /**
   * Drop `id` beside `target` in the tab strip. Each kind of tab lives in its
   * own array — files, canvases, terminals, previews — and the strip draws them
   * in that fixed sequence, so a tab moves only within its own kind; a drop on
   * a tab of another kind is a no-op rather than a move to the kind's edge,
   * which would look like the drop had been ignored anyway.
   */
  reorderTab(id: string, target: string, side: 'before' | 'after'): void
  refreshCanvases(): Promise<void>
  /** Open one canvas as its own tab, or `null` for the Recents list. */
  openCanvas(id: string | null): Promise<void>
  closeCanvas(id: string): void
  /** Ask before deleting; `null` dismisses. `deleteCanvas` is the answer. */
  confirmCanvasDelete(canvas: CanvasSummary | null): void
  deleteCanvas(id: string): Promise<void>
  /**
   * Put a canvas in the composer as context. Resolves the body and extracts its
   * readable text here, so every provider's prompt builder is one line.
   */
  attachCanvas(id: string): Promise<void>
  /** An empty canvas with a name, for the agent to fill. Returns its id. */
  createCanvas(title: string): Promise<string | null>
  refreshFiles(options?: { invalidateImages?: boolean }): Promise<void>
  /** Open the delete confirmation for a tree row. */
  confirmDelete(target: { path: string; kind: 'dir' | 'file' } | null): void
  /**
   * Move a file or folder to the Trash and clean up after it: any tab showing
   * it — or anything inside it — is closed, and its buffer released.
   */
  deletePath(path: string): Promise<boolean>
  /** Replace a tree row with an editable name. */
  beginRename(target: { path: string; kind: 'dir' | 'file' }): void
  cancelRename(): void
  /** Apply it. Returns false and leaves the row open with an error on failure. */
  commitRename(name: string): Promise<boolean>
  /** Open the inline naming row inside `parent` (expanding it if collapsed). */
  beginCreate(parent: string, kind: 'file' | 'dir'): void
  cancelCreate(): void
  /** Create it. Returns false and leaves the row open with an error on failure. */
  commitCreate(name: string): Promise<boolean>
  /** Write the buffer back. No-op when clean, read-only, or already saving. */
  saveFile(path: string): Promise<void>
  /** Answer the conflict bar: take disk, or overwrite it with the buffer. */
  resolveConflict(path: string, choice: 'reload' | 'overwrite'): Promise<void>

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

  /**
   * Soft-wrap diff lines instead of scrolling them horizontally. Off by
   * default — a review reads as code, and a wrapped line breaks mid-token —
   * but the panel is narrow enough that some files are unreadable otherwise.
   */
  diffWrap: boolean
  toggleDiffWrap(): void
  /**
   * Which files in the stacked review are collapsed, keyed `w:path`/`s:path`.
   * It lives here rather than in `MultiDiffView` because the review's bar spans
   * the whole panel and is rendered by `RightPanel`, above both columns — so
   * "collapse all" is pressed outside the component holding the sections.
   */
  diffCollapsed: Record<string, boolean>
  setDiffCollapsed(next: Record<string, boolean>): void
  toggleDiffFile(key: string): void

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
  /** The publish dialog is open (the `publish-github` rung opens it). */
  publishOpen: boolean
  setPublishOpen(open: boolean): void
  /** Create the GitHub repo and push to it; refreshes git + GitHub on success. */
  publishRepo(opts: PublishOpts): Promise<PublishResult>
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
  /** Absolute path of the image shown full-window, or null. See ImageLightbox. */
  lightbox: string | null
  openLightbox(path: string): void
  closeLightbox(): void
  /** Reveal the sub-agent roster in the right panel (see AgentsPanel). */
  openAgentsPanel(): void
  openChat(id: string | null): Promise<void>
  /** Prepend the next window of older messages to the active chat. */
  loadOlderMessages(): Promise<void>
  newChat(
    cwd: string,
    firstMessage: string,
    opts?: {
      provider?: Provider
      model?: string
      effort?: EffortId
      serviceTier?: ServiceTier
      permissionMode?: ChatMeta['permissionMode']
      attachments?: Attachment[]
      /** Start a native Codex review instead of sending a first prompt. */
      reviewTarget?: CodexReviewTarget
      /** Display label for an app-initiated first message (e.g. "Commit"). */
      label?: string
      /** Where the chat runs; omitted or `local` means `cwd` itself. */
      worktree?: WorktreeTarget
    }
  ): Promise<void>
  sendMessage(text: string, attachments?: Attachment[], label?: string): Promise<void>
  /** Start Codex's native App Server reviewer; unlike messages, reviews are never queued. */
  startCodexReview(target: CodexReviewTarget): Promise<void>
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
   * The one thing a chat's fresh worktree has to say for itself, and which
   * chat it is about. Held only until dismissed: these are creation-time
   * notices, and nagging about them every time the chat is reopened would be
   * worse than the silence they replace.
   *
   * `empty-base` outranks `setup-missing` when both are true — missing
   * dependencies do not matter in a checkout that has no code in it.
   */
  worktreeNotice: { chatId: string; kind: 'setup-missing' | 'empty-base' } | null
  dismissWorktreeNotice(): void
  /**
   * The three ways a chat leaves its worktree: check the branch out locally and
   * keep working (`handoff`), land it in the default branch (`merge`), or retire
   * a worktree whose work already landed via a PR (`finish`). Main owns the
   * guards; this just runs the operation and follows the chat to its new cwd.
   */
  exitWorktree(chatId: string, op: 'handoff' | 'merge' | 'finish'): Promise<OpResult>
  /**
   * The same landing for a chat that isn't in a worktree: merge the checked-out
   * branch into the default branch in place. Rewrites the chat's own directory,
   * so callers only offer it on an idle chat.
   */
  mergeBranchInPlace(): Promise<OpResult>
  /** Point the panel at a chat's new cwd after it leaves its worktree. */
  followRelocation(chatId: string): void
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
  /** Pin/unpin a chat; pinned chats leave their project group for the Pinned section. */
  setChatPinned(id: string, pinned: boolean): Promise<void>
  setChatOptions(patch: ChatOptionsPatch): Promise<void>
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
  // A turn the user stopped never reaches here as an error — every adapter
  // suppresses the event on an intentional interrupt — so the failure cue only
  // ever fires on a failure the user didn't ask for.
  if (prefs.sound) playCue(failed ? 'error' : 'complete', prefs.pack)
  if (prefs.finish && !document.hasFocus()) {
    const chat = s.chats.find((c) => c.id === ev.chatId)
    const title = chat?.title || PROVIDER_SHORT_LABELS[chat?.provider ?? 'claude']
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
 * Move one chat to the front of the list, leaving every other row where it is.
 *
 * `chats` is stored in *sidebar order*, not re-sorted on read: it arrives from
 * `listChats` newest-first and is then only ever mutated at moments the user can
 * attribute — a chat created (prepended), deleted (removed), or starting a turn
 * (this). Sorting by `updatedAt` on every incoming message is what it replaces,
 * and that read as constant churn in detailed mode, where one flat list means a
 * bump crosses the *whole* sidebar rather than shuffling within one project.
 * `updatedAt` is still kept current — it is what a row's timestamp shows and how
 * the next launch seeds the order — it just no longer drives position live.
 */
function hoistChat(chats: ChatMeta[], id: string): ChatMeta[] {
  const i = chats.findIndex((c) => c.id === id)
  if (i === -1) return chats
  const next = chats.slice()
  const [chat] = next.splice(i, 1)
  // Position and timestamp move together, so the row can never sit above a
  // newer one carrying an older date — which is what the date buckets in
  // detailed mode read off. A turn that dies before its first message would
  // otherwise leave a stale date at the top of the list.
  next.unshift({ ...chat, updatedAt: Date.now() })
  return next
}

/**
 * With no chat open, `selectedCwd` means the *project* — it's what the home
 * screen labels and where the next chat starts. A chat may run in a worktree,
 * so falling back to one's raw `cwd` would offer a worktree as if it were a
 * project; every such fallback goes through here.
 */
function homeCwd(chats: ChatMeta[], recentDirs: string[]): string | null {
  return chats[0] ? projectRoot(chats[0]) : (recentDirs[0] ?? null)
}

/**
 * The folder the home screen should show after leaving `outgoing`. Same rule as
 * `homeCwd`: a worktree is not a project, so normalize the outgoing chat's cwd
 * to its repo root. But callers that mean to *move* — "New chat" on another
 * project, "New chat in this worktree" — set `selectedCwd` before leaving, and
 * that pick has to survive, so only rewrite while the selection is still the
 * outgoing chat's own cwd.
 */
/**
 * What a hand-made canvas holds until an agent writes it.
 *
 * `color-scheme: light dark` and no page background of its own, which is the
 * same rule the session prompt asks the agents for — the panel is usually dark,
 * and a placeholder that hardcoded white would be the exact defect it is
 * standing in for.
 */
const EMPTY_CANVAS_HTML = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:light dark}
body{margin:0;display:grid;place-items:center;height:100vh;font:13px -apple-system,system-ui,sans-serif;opacity:.6;text-align:center;padding:24px}
</style><p>Empty canvas.<br>Ask the agent to fill it in — it can find this one by name.</p>`

/**
 * The project a canvas belongs to.
 *
 * The repo root, **not** the chat's cwd: a worktree chat runs in a directory
 * `finishWorktree` deletes, and a canvas has to outlive the branch it was
 * written on. Falls back to `selectedCwd` so the panel still answers on the
 * home screen, where no chat is active.
 */
function canvasProject(s: Pick<AppState, 'activeId' | 'chats' | 'selectedCwd'>): string | null {
  const chat = s.chats.find((c) => c.id === s.activeId)
  return chat ? projectRoot(chat) : s.selectedCwd
}

/**
 * Canvas state follows the **project**, not the chat.
 *
 * Both halves of that are bugs this replaces. Clearing on every chat switch
 * closed the documents you had open when you moved between two chats in the
 * same folder — a canvas is a property of the project, which is what the
 * RightPanel tab comment has said all along. And *not* clearing on the paths
 * that leave a chat (`openChat(null)`, then picking another folder) left the
 * previous project's open canvas tabs standing over the new one, with their
 * titles resolving to a bare "Canvas" because the id was no longer in the list:
 * project X's document, open and readable, while you work on project Y.
 *
 * So the answer is one rule at every seam where the project can change — and
 * what it does there is **stash and restore**, not clear. Clearing was the
 * first version, and it meant a canvas open in project X was gone the moment
 * you looked at a chat in project Y and back: the chat's `activeTab` came back
 * as `canvas:<id>` (tabs are stashed per chat) but the id was no longer in
 * `canvasTabs`, so the panel fell through to the next real tab and the
 * document had to be reopened from the list every time. The outgoing project's
 * tabs go under its root in `canvasTabsByProject`; the incoming one's come
 * back out, empty for a project never visited. `canvasHtml` is left alone —
 * it is a cache keyed by id, and keeping it is what lets a restored document
 * paint at once rather than after a round trip. The list itself is refetched
 * by every caller, and the pending delete is dropped: a question about
 * another project's document must not survive into this one.
 *
 * A stale `activeTab` of `canvas:<id>` needs no handling: `RightPanel` already
 * falls through to the next real tab when `canvasTabs` does not hold it.
 */
function canvasScopePatch(
  s: Pick<AppState, 'activeId' | 'chats' | 'selectedCwd' | 'canvasTabs' | 'canvasTabsByProject'>,
  next: Pick<AppState, 'activeId' | 'chats' | 'selectedCwd'>
): Partial<AppState> {
  const from = canvasProject(s)
  const to = canvasProject(next)
  if (from === to) return {}
  const canvasTabsByProject = { ...s.canvasTabsByProject }
  if (from) {
    if (s.canvasTabs.length) canvasTabsByProject[from] = s.canvasTabs
    else delete canvasTabsByProject[from]
  }
  const canvasTabs = (to ? canvasTabsByProject[to] : undefined) ?? []
  if (to) delete canvasTabsByProject[to]
  return {
    canvases: [],
    canvasTabs,
    canvasTabsByProject,
    pendingCanvasDelete: null
  }
}

function homeCwdLeaving(outgoing: ChatMeta | undefined, selectedCwd: string | null): string | null {
  if (!outgoing) return selectedCwd
  return selectedCwd === outgoing.cwd ? projectRoot(outgoing) : selectedCwd
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

/**
 * Drop terminal tabs belonging to deleted chats. Main has already reaped their
 * shells; this removes the tabs so none can respawn one on remount, and clears
 * the active tab if it was one of them.
 */
function pruneTerminals(
  s: Pick<AppState, 'terminals' | 'terminalBusy' | 'activeTab' | 'openFiles' | 'planPanel'>,
  ids: string[]
): Partial<AppState> {
  const doomed = s.terminals.filter((t) => t.chatId && ids.includes(t.chatId))
  if (doomed.length === 0) return {}
  const gone = doomed.map((t) => t.id)
  const terminals = s.terminals.filter((t) => !gone.includes(t.id))
  const patch: Partial<AppState> = {
    terminals,
    terminalBusy: omit(s.terminalBusy, gone)
  }
  if (s.activeTab && gone.includes(s.activeTab)) {
    patch.activeTab =
      terminals[terminals.length - 1]?.id ??
      s.openFiles[s.openFiles.length - 1]?.path ??
      (s.planPanel ? 'plan' : null)
  }
  return patch
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
  // From the tail: the message being updated is the one streaming, which is
  // the last one or within a few of it, and this runs once per streamed event.
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.id === id && message.role === 'assistant') {
      idx = i
      break
    }
  }
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
 * Drops the drafts belonging to deleted chats/projects and writes the result
 * through to storage. Sits beside the other `omit` cleanups in the deletion
 * paths so a draft can't outlive the thing it was typed into.
 */
function dropDrafts(
  s: Pick<AppState, 'chatDrafts' | 'projectDrafts'>,
  chatIds: string[],
  cwds: string[] = []
): Pick<AppState, 'chatDrafts' | 'projectDrafts'> {
  const hit = chatIds.some((id) => id in s.chatDrafts) || cwds.some((cwd) => cwd in s.projectDrafts)
  if (!hit) return { chatDrafts: s.chatDrafts, projectDrafts: s.projectDrafts }
  const next = { chats: omit(s.chatDrafts, chatIds), projects: omit(s.projectDrafts, cwds) }
  saveDrafts(next)
  return { chatDrafts: next.chats, projectDrafts: next.projects }
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
// Read once at module load, like the other persisted UI state. Chat drafts for
// chats that no longer exist are dropped in `init`, once the chat list is known.
const initialDrafts = loadDrafts()
let codexConfigModelLoad: Promise<string | null> | null = null
// Model-list probes are shared while in flight. A partial result is retried
// after a cooldown: permanent provider failures must not spawn a process on
// every composer mount, but a transient failure must not freeze the fallback
// catalog until the whole app restarts.
let modelsLoad: Promise<ModelOption[]> | null = null
let modelsRetryAt = 0
const MODELS_RETRY_MS = 30_000
// GitHub reads are deduped per project, not globally. A request for project A
// must not suppress the refresh kicked off when the user switches to project B.
const githubRequests = new Map<string, Promise<GitHubState>>()

function githubStateFor(cwd: string): Promise<GitHubState> {
  const existing = githubRequests.get(cwd)
  if (existing) return existing
  const request = window.api.githubState(cwd).finally(() => {
    if (githubRequests.get(cwd) === request) githubRequests.delete(cwd)
  })
  githubRequests.set(cwd, request)
  return request
}

function syncDockIcon(): void {
  if (window.api.platform !== 'darwin') return
  void window.api.setDockIcon(currentDockIconPalette())
}

export const useApp = create<AppState>((set, get) => ({
  chats: [],
  activeId: null,
  selectedCwd: null,
  messages: [],
  contextUsage: null,
  hiddenBefore: 0,
  loadingOlder: false,
  statuses: {},
  lockedChats: {},
  titling: {},
  backgroundJobs: {},
  rateLimits: {},
  usage: null,
  fastMode: {},
  codexGoals: {},
  models: [],
  codexConfigModel: undefined,
  providerClis: [],
  permissions: {},
  queued: {},
  planPanel: null,
  canvases: [],
  canvasTabs: [],
  canvasTabsByProject: {},
  canvasHtml: {},
  pendingCanvasDelete: null,
  defaults: null,
  loading: true,
  sidebarOpen: localStorage.getItem('sidebarOpen') !== 'false',

  update: null,
  updateDismissed: localStorage.getItem('updateDismissed'),

  async checkForUpdate() {
    const update = await window.api.checkForUpdate()
    // Clearing a stale dismissal here, rather than filtering at render time,
    // is what lets a second (newer) release re-open a banner the user closed.
    const dismissed = get().updateDismissed
    if (update && dismissed && dismissed !== update.version) {
      localStorage.removeItem('updateDismissed')
      set({ update, updateDismissed: null })
      return
    }
    set({ update })
  },

  dismissUpdate() {
    const version = get().update?.version
    if (!version) return
    localStorage.setItem('updateDismissed', version)
    set({ updateDismissed: version })
  },

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
  terminalBusy: {},

  openTerminal(opts) {
    set((s) => {
      const n = s.terminalSeq + 1
      const id = `terminal:${n}`
      return {
        terminals: [...s.terminals, { id, n, chatId: s.activeId ?? undefined, ...opts }],
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
      return { terminals, activeTab, terminalBusy: omit(s.terminalBusy, [id]) }
    })
  },

  setTerminalBusy(id, command) {
    set((s) => {
      if ((s.terminalBusy[id] ?? null) === command) return s
      if (command === null) return { terminalBusy: omit(s.terminalBusy, [id]) }
      return { terminalBusy: { ...s.terminalBusy, [id]: command } }
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

  // ---- Drafts ----

  chatDrafts: initialDrafts.chats,
  projectDrafts: initialDrafts.projects,

  saveChatDraft(chatId, draft) {
    set((s) => {
      if (sameDraft(s.chatDrafts[chatId], draft)) return {}
      const chatDrafts = { ...s.chatDrafts }
      if (isEmptyDraft(draft)) delete chatDrafts[chatId]
      else chatDrafts[chatId] = draft
      saveDrafts({ chats: chatDrafts, projects: s.projectDrafts })
      return { chatDrafts }
    })
  },

  saveProjectDraft(cwd, draft, options) {
    set((s) => {
      const current = s.projectDrafts[cwd]
      const projectDrafts = { ...s.projectDrafts }
      if (isEmptyDraft(draft)) {
        if (!current) return {}
        delete projectDrafts[cwd]
      } else {
        if (current && sameDraft(current, draft) && sameOptions(current, options)) return {}
        // `updatedAt` tracks the text, which is what the Drafts section orders
        // on — see `patchProjectDraft`, which deliberately leaves it alone.
        projectDrafts[cwd] = { ...options, ...draft, cwd, updatedAt: Date.now() }
      }
      saveDrafts({ chats: s.chatDrafts, projects: projectDrafts })
      return { projectDrafts }
    })
  },

  patchProjectDraft(cwd, options) {
    set((s) => {
      const current = s.projectDrafts[cwd]
      // Changing the model with an empty composer creates nothing: a draft is
      // text you'd lose, and the pickers already persist as `AppDefaults`.
      if (!current || sameOptions(current, options)) return {}
      const projectDrafts = { ...s.projectDrafts, [cwd]: { ...current, ...options } }
      saveDrafts({ chats: s.chatDrafts, projects: projectDrafts })
      return { projectDrafts }
    })
  },

  draftDiscards: {},

  discardProjectDraft(cwd) {
    set((s) => {
      if (!s.projectDrafts[cwd]) return {}
      const projectDrafts = { ...s.projectDrafts }
      delete projectDrafts[cwd]
      saveDrafts({ chats: s.chatDrafts, projects: projectDrafts })
      return {
        projectDrafts,
        draftDiscards: { ...s.draftDiscards, [cwd]: (s.draftDiscards[cwd] ?? 0) + 1 }
      }
    })
  },

  openDraft(cwd) {
    // Deliberately not awaited: `openChat(null)` is synchronous on its null
    // branch, so both updates land in one tick and React renders the home
    // screen once. Awaiting would yield between them and mount `NewChat` twice,
    // the first time against whatever folder the outgoing chat left behind.
    void get().openChat(null)
    if (get().selectedCwd !== cwd) get().setSelectedCwd(cwd)
  },

  // ---- Slash commands ----

  commands: [],
  commandsKey: null,

  loadCommands(cwd, provider) {
    // Commands are provider-specific. Claude discovers its SDK command list;
    // Codex gets only commands backed by native Codex APIs (never prompt shims).
    const s = get()
    const prov =
      provider ??
      s.chats.find((c) => c.id === s.activeId)?.provider ??
      providerForRememberedModel(s.defaults?.model, s.defaults?.modelProvider, s.models)
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

  newChatOpen: false,
  setNewChatOpen(open) {
    set({ newChatOpen: open })
  },
  startNewChat() {
    const s = get()
    // The filter chip names the project on screen — same class of explicit pick
    // as compact's per-project ＋. A persisted filter naming a hidden or vanished
    // project is ignored the same way the sidebar itself ignores it.
    const cwd = s.sidebarProject
    const known =
      !!cwd && !s.hiddenProjects[cwd] && s.chats.some((c) => projectRoot(c) === cwd)
    if (known && cwd) {
      if (s.selectedCwd !== cwd) s.setSelectedCwd(cwd)
      void s.openChat(null)
      if (s.newChatOpen) set({ newChatOpen: false })
      return
    }
    set({ newChatOpen: true })
  },

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

  // ---- Usage page ----

  usageOpen: false,
  usageDays: USAGE_DEFAULT_DAYS,
  usageReport: null,
  usageReportLoading: false,

  openUsage() {
    set({ usageOpen: true, settingsOpen: false })
    void get().loadUsageReport()
  },

  closeUsage() {
    set({ usageOpen: false })
  },

  async loadUsageReport(days, refresh = false) {
    const want = days ?? get().usageDays
    // The range buttons are also the loading surface, so commit the choice
    // before the await — otherwise the pressed button doesn't look pressed
    // until a cold scan finishes seconds later.
    set({ usageDays: want, usageReportLoading: true })
    try {
      const report = await window.api.usageReport(want, refresh)
      // A range switched mid-scan wins: the report that lands is stale.
      if (get().usageDays !== want) return
      set({ usageReport: report })
    } catch (err) {
      console.error('usage report failed:', err)
    } finally {
      if (get().usageDays === want) set({ usageReportLoading: false })
    }
  },

  // ---- Settings ----

  settingsOpen: false,
  theme: storedTheme(),
  themeMode: initialThemeMode,
  resolvedAppearance: resolveAppearance(initialThemeMode),

  openSettings() {
    set({ settingsOpen: true, usageOpen: false })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  setTheme(id) {
    const appearance = applyTheme(id, get().themeMode)
    set({ theme: id, resolvedAppearance: appearance })
    void window.api.setWindowAppearance(get().themeMode, appearance === 'dark')
    syncDockIcon()
  },

  setThemeMode(mode) {
    const appearance = applyTheme(get().theme, mode)
    set({ themeMode: mode, resolvedAppearance: appearance })
    void window.api.setWindowAppearance(mode, appearance === 'dark')
    syncDockIcon()
  },

  syncSystemAppearance() {
    if (get().themeMode !== 'system') return
    const appearance = applyTheme(get().theme, 'system')
    set({ resolvedAppearance: appearance })
    void window.api.setWindowAppearance('system', appearance === 'dark')
    syncDockIcon()
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

  sidebarDensity: localStorage.getItem('sidebarDensity') === 'detailed' ? 'detailed' : 'compact',

  setSidebarDensity(density) {
    localStorage.setItem('sidebarDensity', density)
    set({ sidebarDensity: density })
    // Switching *into* detailed is the one moment the branch labels are asked
    // for and not yet known; the Sidebar's own effect covers a cold start.
    if (density === 'detailed') void get().refreshChatBranches()
  },

  sidebarProject: localStorage.getItem('sidebarProject') || null,

  setSidebarProject(cwd) {
    if (cwd) localStorage.setItem('sidebarProject', cwd)
    else localStorage.removeItem('sidebarProject')
    set({ sidebarProject: cwd })
  },

  chatBranches: {},

  async refreshChatBranches() {
    // Compact rows never show a branch, so the read is pure cost there. Every
    // caller (chat list changes, a turn ending, a worktree operation) goes
    // through this guard rather than repeating it.
    if (get().sidebarDensity !== 'detailed') return
    const cwds = [...new Set(get().chats.map((c) => c.cwd))]
    if (cwds.length === 0) {
      set({ chatBranches: {} })
      return
    }
    try {
      set({ chatBranches: await window.api.gitBranches(cwds) })
    } catch {
      // A row without a branch falls back to its folder — no worse than before.
    }
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
    syncDockIcon()
    // The native material already exists in a stable active state; reveal it at
    // boot only when the user's translucency setting is on.
    void window.api.setWindowTranslucent(get().translucentSidebar)
    // Awaited with the rest of boot rather than fired off: every model picker
    // reads from it, and a list that arrives late would render the composer's
    // chip empty for a beat, or — worse — offer a provider that isn't there.
    const [chats, defaults, providerClis] = await Promise.all([
      window.api.listChats(),
      window.api.getDefaults(),
      window.api.providerClis().catch(() => [])
    ])
    // A chat deleted in another window (the database is shared) leaves its draft
    // behind; this is the first moment we can tell. Project drafts are NOT
    // pruned against this list — a draft is often the very first thing in a
    // folder that has no chats yet.
    const chatDrafts = pruneChatDrafts(get().chatDrafts, chats.map((c) => c.id))
    if (Object.keys(chatDrafts).length !== Object.keys(get().chatDrafts).length) {
      saveDrafts({ chats: chatDrafts, projects: get().projectDrafts })
    }
    set({
      chats,
      chatDrafts,
      defaults,
      providerClis,
      loading: false,
      selectedCwd: homeCwd(chats, defaults.recentDirs)
    })
    // Fire-and-forget: an update check must never gate the first paint, and it
    // resolves to null when offline. Re-checked every 6h so a long-running
    // window still learns about a release.
    void get().checkForUpdate()
    setInterval(() => void get().checkForUpdate(), 6 * 60 * 60 * 1000)
    const cwd = get().selectedCwd
    if (cwd) {
      void get().refreshGit()
      void get().refreshGithub()
      void get().refreshCanvases()
    }
    // No active chat yet on boot — derive the provider from the saved default
    // model so a Codex default never warms a Claude command session.
    get().loadCommands(
      cwd,
      providerForRememberedModel(defaults?.model, defaults?.modelProvider, get().models)
    )
  },

  setSelectedCwd(cwd) {
    // Tabs follow the active chat, not the folder — picking a folder only sets
    // the cwd (the draft flows that call this then open a fresh chat, which
    // clears the tab set via chatSwitchPatch).
    set((s) => {
      // Canvases follow the project, and on the home screen the folder *is* the
      // project — so a pick that changes it closes the previous one's documents.
      const canvas = canvasScopePatch(s, { ...s, selectedCwd: cwd })
      // Explicitly picking a folder brings a hidden project back into the sidebar.
      if (cwd && s.hiddenProjects[cwd]) {
        const hiddenProjects = { ...s.hiddenProjects }
        delete hiddenProjects[cwd]
        localStorage.setItem('hiddenProjects', JSON.stringify(hiddenProjects))
        return { ...canvas, selectedCwd: cwd, hiddenProjects }
      }
      return { ...canvas, selectedCwd: cwd }
    })
    get().loadCommands(cwd)
    if (cwd) {
      void get().refreshGit()
      void get().refreshGithub()
      // Canvases are per *project*, so picking another folder on the home screen
      // changes the answer exactly as git's does — without this the list stays
      // the previous project's until a chat is opened.
      void get().refreshCanvases()
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

  lightbox: null,
  openLightbox(path) {
    set({ lightbox: path })
  },
  closeLightbox() {
    // Guarded so closing an already-closed lightbox doesn't notify subscribers.
    set((s) => (s.lightbox === null ? s : { lightbox: null }))
  },

  // The tab itself is derived from the active chat's runs (RightPanel), so this
  // only has to select it and make sure the panel is showing.
  openAgentsPanel() {
    set((s) => ({ activeTab: 'agents', ...panelPatch(s, true) }))
  },

  // ---- Files ----

  panelOpen: false,
  panelMaximized: false,
  filesByDir: {},
  expandedDirs: {},
  openFiles: [],
  pendingCreate: null,
  pendingDelete: null,
  pendingRename: null,
  dirtyFiles: {},
  fileConflicts: {},
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
    const before = get().openFiles.map((f) => f.path)
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
        // A single-clicked file reuses the current preview slot, like Cursor —
        // but a preview tab the user has typed into is no longer disposable.
        // Pin it instead of replacing it: the alternative is unsaved edits
        // vanishing on a single click somewhere else in the tree.
        const slot = openFiles.findIndex((f) => f.preview && !isDirty(f.path))
        const tab: OpenTab = { path, name, preview: true }
        if (slot === -1) {
          openFiles = [...openFiles.map((f) => (f.preview ? { ...f, preview: false } : f)), tab]
        } else {
          openFiles = openFiles.map((f, i) => (i === slot ? tab : f))
        }
      } else {
        openFiles = [...openFiles, { path, name }]
      }
      return { openFiles, activeTab: path, ...panelPatch(s, true) }
    })
    // Any tab the set above dropped (a replaced preview slot, a consumed
    // placeholder) takes its buffer with it — otherwise every previewed file
    // stays resident for the session with its full undo history.
    const stillOpen = new Set(get().openFiles.map((f) => f.path))
    for (const gone of before) {
      if (!stillOpen.has(gone)) dropBuffer(gone)
    }

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
    // The buffer outlives the component (it survives tab switches), so closing
    // the tab is the one place it has to be released — otherwise every file ever
    // opened stays in memory with its full undo history for the session.
    dropBuffer(path)
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
      return {
        openFiles,
        fileContents,
        diffContents,
        activeTab,
        // `dropBuffer` above fires the clean transition that clears
        // `dirtyFiles`; nothing else clears `fileConflicts`.
        fileConflicts: omit(s.fileConflicts, [path])
      }
    })
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
  },
  closeTabTick: 0,
  closeActiveTab() {
    set((s) => ({ closeTabTick: s.closeTabTick + 1 }))
  },
  reorderTab(id, target, side) {
    if (id === target) return
    set((s) => {
      const files = s.openFiles.map((f) => f.path)
      const f = files.indexOf(id)
      if (f !== -1) {
        const t = files.indexOf(target)
        if (t === -1) return s
        const next = moveItem(s.openFiles, f, t, side)
        return next === s.openFiles ? s : { openFiles: next as OpenTab[] }
      }
      const c = s.canvasTabs.indexOf(id)
      if (c !== -1) {
        const t = s.canvasTabs.indexOf(target)
        if (t === -1) return s
        const next = moveItem(s.canvasTabs, c, t, side)
        return next === s.canvasTabs ? s : { canvasTabs: next as string[] }
      }
      const term = s.terminals.findIndex((x) => x.id === id)
      if (term !== -1) {
        const t = s.terminals.findIndex((x) => x.id === target)
        if (t === -1) return s
        const next = moveItem(s.terminals, term, t, side)
        return next === s.terminals ? s : { terminals: next as TerminalTab[] }
      }
      const prev = s.previews.findIndex((x) => x.id === id)
      if (prev !== -1) {
        const t = s.previews.findIndex((x) => x.id === target)
        if (t === -1) return s
        const next = moveItem(s.previews, prev, t, side)
        return next === s.previews ? s : { previews: next as PreviewTab[] }
      }
      return s
    })
  },
  async refreshCanvases() {
    const project = canvasProject(get())
    if (!project) {
      set({ canvases: [] })
      return
    }
    const rows = await window.api.canvasList(project)
    // Guard against a chat switch that landed while the query was in flight —
    // otherwise the previous project's list paints over the new one's.
    set((s) => (canvasProject(s) === project ? { canvases: rows } : {}))
  },
  async openCanvas(id) {
    if (!id) {
      set((st) => ({ activeTab: 'canvas', ...panelPatch(st, true) }))
      return
    }
    set((st) => ({
      canvasTabs: st.canvasTabs.includes(id) ? st.canvasTabs : [...st.canvasTabs, id],
      // `null` rather than leaving the previous body: a slow read must never
      // show one canvas's document under another's title.
      canvasHtml: id in st.canvasHtml ? st.canvasHtml : { ...st.canvasHtml, [id]: null },
      activeTab: `canvas:${id}`,
      ...panelPatch(st, true)
    }))
    const canvas = await window.api.canvasGet(id)
    set((st) =>
      st.canvasTabs.includes(id)
        ? { canvasHtml: { ...st.canvasHtml, [id]: canvas?.html ?? '' } }
        : {}
    )
  },

  closeCanvas(id) {
    set((st) => {
      const canvasTabs = st.canvasTabs.filter((c) => c !== id)
      const canvasHtml = { ...st.canvasHtml }
      delete canvasHtml[id]
      // Falling back to the neighbour rather than to nothing: closing the last
      // of several documents should leave you in the panel, not staring at the
      // launcher.
      const activeTab =
        st.activeTab === `canvas:${id}`
          ? canvasTabs.length
            ? `canvas:${canvasTabs[canvasTabs.length - 1]}`
            : 'canvas'
          : st.activeTab
      return { canvasTabs, canvasHtml, activeTab }
    })
  },

  confirmCanvasDelete(canvas) {
    set({ pendingCanvasDelete: canvas })
  },

  async deleteCanvas(id) {
    await window.api.canvasDelete(id)
    get().closeCanvas(id)
    set((st) => ({
      canvases: st.canvases.filter((c) => c.id !== id),
      // A canvas belongs to one project, and it is deleted from that project's
      // own list — so the stash should never hold it. Scrubbed anyway: a
      // stale id there would restore as a tab with no document behind it.
      canvasTabsByProject: Object.fromEntries(
        Object.entries(st.canvasTabsByProject).map(([k, v]) => [k, v.filter((c) => c !== id)])
      ),
      pendingCanvasDelete: st.pendingCanvasDelete?.id === id ? null : st.pendingCanvasDelete
    }))
  },

  async attachCanvas(id) {
    const summary = get().canvases.find((c) => c.id === id)
    // Straight from the store rather than from `canvasHtml`: a canvas can be
    // attached from the Recents list without ever having been opened, so the
    // cached body is only ever an optimization that is usually absent.
    const canvas = await window.api.canvasGet(id)
    if (!canvas) return
    const { text, truncated } = canvasText(canvas.html, CANVAS_ATTACH_MAX_CHARS)
    get().addAttachment({
      id: crypto.randomUUID(),
      kind: 'canvas',
      name: canvas.title || summary?.title || 'Canvas',
      canvas: {
        id: canvas.id,
        title: canvas.title || 'Canvas',
        text,
        ...(truncated ? { truncated } : {})
      }
    })
  },

  async createCanvas(title) {
    const project = canvasProject(get())
    if (!project) return null
    // An empty canvas is a *named target*, which is the only thing a user can
    // usefully make without an HTML editor: the agent finds it by title through
    // `canvas list` and fills it in. The placeholder says so, because a blank
    // white pane reads as a canvas that failed to load.
    const saved = await window.api.canvasSave({
      project,
      chatId: get().activeId,
      title,
      html: EMPTY_CANVAS_HTML
    })
    set((st) => ({ canvases: [saved, ...st.canvases.filter((c) => c.id !== saved.id)] }))
    await get().openCanvas(saved.id)
    return saved.id
  },

  beginRename(target) {
    set({ pendingRename: target, pendingCreate: null })
  },

  cancelRename() {
    set({ pendingRename: null })
  },

  async commitRename(name) {
    const pending = get().pendingRename
    if (!pending) return false
    const from = pending.path
    const result = await window.api.renamePath(from, name)
    if (!result.ok) {
      set((s) => (s.pendingRename ? { pendingRename: { ...pending, error: result.message } } : {}))
      return false
    }
    const to = result.path
    set({ pendingRename: null })
    if (to !== from) {
      // Everything keyed by the old path follows it. A renamed *folder* takes
      // its descendants, so the rewrite is a prefix substitution — carrying the
      // separator, so renaming `src` cannot also rewrite a sibling `src-old`.
      const moved = (p: string): string | null =>
        p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null
      for (const tab of get().openFiles) {
        const next = moved(tab.path)
        if (next) renameBuffer(tab.path, next)
      }
      set((s) => ({
        openFiles: s.openFiles.map((f) => {
          const next = moved(f.path)
          return next ? { ...f, path: next, name: basename(next) } : f
        }),
        activeTab: (s.activeTab && moved(s.activeTab)) ?? s.activeTab,
        fileContents: Object.fromEntries(
          Object.entries(s.fileContents).map(([p, c]) => [moved(p) ?? p, c])
        ),
        dirtyFiles: Object.fromEntries(
          Object.entries(s.dirtyFiles).map(([p, d]) => [moved(p) ?? p, d])
        ),
        expandedDirs: Object.fromEntries(
          Object.entries(s.expandedDirs).map(([d, v]) => [moved(d) ?? d, v])
        ),
        // The listings are re-read below; dropping the stale ones keeps a
        // folder that no longer exists from lingering in the tree.
        filesByDir: Object.fromEntries(
          Object.entries(s.filesByDir).filter(([d]) => !moved(d))
        )
      }))
    }
    const parent = from.slice(0, from.lastIndexOf('/'))
    await get().loadDir(parent)
    const newParent = to.slice(0, to.lastIndexOf('/'))
    if (newParent !== parent) await get().loadDir(newParent)
    void get().refreshGit()
    return true
  },

  confirmDelete(target) {
    set({ pendingDelete: target })
  },

  async deletePath(path) {
    const result = await window.api.deletePath(path)
    if (!result.ok) {
      // Reported on the dialog rather than through `gitError`: the question is
      // still on screen, and this is the answer to it. A locked file or a
      // permission problem is also something the user may be able to fix and
      // retry without reopening the menu.
      set((s) => (s.pendingDelete ? { pendingDelete: { ...s.pendingDelete, error: result.message } } : {}))
      return false
    }
    // A folder takes its contents with it, so every tab *under* it goes too —
    // matching on the path prefix with a separator, so deleting `src` cannot
    // also close a tab in a sibling called `src-old`.
    const inside = (p: string): boolean => p === path || p.startsWith(`${path}/`)
    for (const tab of get().openFiles.filter((f) => inside(f.path))) get().closeFile(tab.path)
    set((s) => ({
      // Collapsed/expanded state and the cached listing for a folder that no
      // longer exists would otherwise keep it alive in the tree.
      expandedDirs: Object.fromEntries(Object.entries(s.expandedDirs).filter(([d]) => !inside(d))),
      filesByDir: Object.fromEntries(Object.entries(s.filesByDir).filter(([d]) => !inside(d)))
    }))
    const parent = path.slice(0, path.lastIndexOf('/'))
    await get().loadDir(parent)
    void get().refreshGit()
    set({ pendingDelete: null })
    return true
  },

  beginCreate(parent, kind) {
    // The two inline rows are the same slot in the tree; only one can be open.
    set({ pendingCreate: { parent, kind }, pendingRename: null })
    // The row is rendered among that folder's children, so a collapsed folder
    // would take the input somewhere nobody can see it.
    if (!get().expandedDirs[parent]) get().toggleDir(parent)
  },

  cancelCreate() {
    set({ pendingCreate: null })
  },

  async commitCreate(name) {
    const pending = get().pendingCreate
    if (!pending) return false
    const result = await window.api.createPath(pending.parent, name, pending.kind)
    if (!result.ok) {
      // The row stays open carrying the reason: every way this fails is
      // something the user can fix by typing a different name.
      set((s) => (s.pendingCreate ? { pendingCreate: { ...pending, error: result.message } } : {}))
      return false
    }
    set({ pendingCreate: null })
    await get().loadDir(pending.parent)
    // A new file is almost always about to be edited; a new folder is about to
    // be filled, so it opens instead.
    if (pending.kind === 'file') await get().openFile(result.path)
    else if (!get().expandedDirs[result.path]) get().toggleDir(result.path)
    void get().refreshGit()
    return true
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
    // Open files are *reconciled*, never re-read wholesale. Two reasons, and the
    // first one is data loss: this runs at the end of every turn, and blindly
    // re-reading would throw away whatever the user has typed into an open tab
    // since. The second is cost — one `stat` per tab settles the common case
    // (nothing changed) without pulling any file bodies back through IPC.
    const paths = s.openFiles.filter(isFileTab).map((f) => f.path)

    // The stat batch depends on nothing the directory listings produce, so the
    // two go out together — this runs on every turn boundary, and serializing
    // them put the whole tree walk in front of it.
    const [, mtimes] = await Promise.all([
      Promise.all(dirs.map((d) => s.loadDir(d))),
      paths.length > 0
        ? window.api.statFiles(paths)
        : Promise.resolve({} as Record<string, number | null>)
    ])

    await Promise.all(
      paths.map(async (path) => {
        const disk = mtimes[path]
        const prev = get().fileContents[path]
        const known = bufferMtime(path) ?? (prev?.kind === 'text' ? prev.mtimeMs : undefined)
        // Unchanged on disk, or gone (the tab keeps showing what it had rather
        // than blanking — the file may be mid-rename).
        if (disk === null || disk === undefined) return
        if (known !== undefined && disk === known) return

        if (isDirty(path)) {
          // Both sides moved. Don't pick a winner — the bar asks.
          set((st) => ({ fileConflicts: { ...st.fileConflicts, [path]: disk } }))
          return
        }

        const content = await window.api.readFile(path)
        set((st) => ({ fileContents: { ...st.fileContents, [path]: content } }))
        if (content.kind !== 'text') return
        // Moves the buffer whether or not its editor is mounted — a background
        // tab left holding stale text is how an agent's edit gets reverted by
        // the next ⌘S. Updates a mounted view in place rather than rebuilding it.
        adoptDisk(path, content.content, content.mtimeMs)
      })
    )
  },

  async saveFile(path) {
    const buf = getBuffer(path)
    if (!buf || buf.state.readOnly || !isDirty(path)) return
    const text = bufferText(path)
    if (text === null) return
    const result = await window.api.writeFile(path, text, buf.mtimeMs)
    if (result.ok) {
      markSaved(path, result.mtimeMs)
      set((st) => {
        const prev = st.fileContents[path]
        return {
        fileContents: {
          ...st.fileContents,
          [path]: {
            kind: 'text',
            content: text,
            // Carry the language forward: it comes from the extension, which a
            // save cannot change.
            language: prev?.kind === 'text' ? prev.language : undefined,
            truncated: false,
            mtimeMs: result.mtimeMs
          }
        },
        fileConflicts: omit(st.fileConflicts, [path])
        }
      })
      // The edit is a working-tree change like any other — the diff chip and the
      // tree's status colors are wrong until git is re-read.
      void get().refreshGit()
      notifyWatchedChanges([path])
      return
    }
    if (result.reason === 'conflict') {
      set((st) => ({ fileConflicts: { ...st.fileConflicts, [path]: result.mtimeMs } }))
      return
    }
    set({ gitError: `Could not save ${basename(path)}: ${result.message}` })
  },

  async resolveConflict(path, choice) {
    if (choice === 'reload') {
      const content = await window.api.readFile(path)
      set((st) => ({
        fileContents: { ...st.fileContents, [path]: content },
        fileConflicts: omit(st.fileConflicts, [path])
      }))
      if (content.kind !== 'text') return
      // `adoptDisk` refuses a dirty buffer by design; `force` is the user's
      // answer to the conflict bar. Going through it rather than dispatching
      // here is what makes an unmounted tab reload too, and what clears the
      // dirty flag — the same path a background adopt takes.
      adoptDisk(path, content.content, content.mtimeMs, { force: true })
      return
    }
    // Overwrite: rebase onto the mtime that caused the refusal and write again.
    const disk = get().fileConflicts[path]
    if (disk !== undefined) rebaseTo(path, disk)
    set((st) => ({ fileConflicts: omit(st.fileConflicts, [path]) }))
    await get().saveFile(path)
  },

  // ---- Git ----

  explorerOpen: localStorage.getItem('rightDockOpen') === 'true',
  diffWrap: localStorage.getItem('diffWrap') === 'true',
  diffCollapsed: {},
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

  toggleDiffWrap() {
    const wrap = !get().diffWrap
    localStorage.setItem('diffWrap', String(wrap))
    set({ diffWrap: wrap })
  },

  setDiffCollapsed(next) {
    set({ diffCollapsed: next })
  },

  toggleDiffFile(key) {
    set((s) => ({ diffCollapsed: { ...s.diffCollapsed, [key]: !s.diffCollapsed[key] } }))
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
      // A failed request for the project we just left must not clear the new
      // project's result if it completed first.
      if (get().selectedCwd === cwd) set({ git: null })
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
    if (id === 'publish-github') {
      // The name, the owner and the visibility are the user's three decisions,
      // so this rung asks them instead of running anything.
      set({ gitError: null, publishOpen: true })
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

  publishOpen: false,

  setPublishOpen(open) {
    set({ publishOpen: open })
  },

  async publishRepo(opts) {
    const cwd = get().selectedCwd
    if (!cwd) return { ok: false, error: 'No project selected.' }
    const res = await window.api.githubPublish(cwd, opts)
    // Refreshed either way: a failed push still leaves a remote wired up, and a
    // panel still saying "no remote" would send the user to publish it twice.
    await get().refreshGit()
    void get().refreshGithub()
    return res
  },

  async refreshGithub() {
    const cwd = get().selectedCwd
    if (!cwd) {
      set({ github: null, githubBusy: false })
      return
    }
    set({ githubBusy: true })
    try {
      const github = await githubStateFor(cwd)
      // Guard against a project switch happening while we awaited.
      if (get().selectedCwd === cwd) set({ github })
    } catch {
      if (get().selectedCwd === cwd) set({ github: null })
    } finally {
      // An older project's completion must not clear the spinner for the
      // currently selected project's still-running request.
      if (get().selectedCwd === cwd) set({ githubBusy: false })
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
      // While a worktree chat was open `selectedCwd` pointed at its worktree,
      // which is right for that chat's git and file tree but wrong for the home
      // screen — leaving it would show the worktree as the project and start
      // the next chat inside it. A folder picked on the way out wins, though.
      const outgoing = get().chats.find((c) => c.id === get().activeId)
      set((s) => ({
        // Stash the outgoing chat's tabs; the draft/home state opens no tabs.
        ...chatSwitchPatch(s, null),
        // The home screen answers for `selectedCwd`, which may be a different
        // project than the chat being left — so this path can change the canvas
        // project just as a chat switch can, and used to clear nothing at all.
        ...canvasScopePatch(s, {
          activeId: null,
          chats: s.chats,
          selectedCwd: homeCwdLeaving(outgoing, s.selectedCwd)
        }),
        selectedCwd: homeCwdLeaving(outgoing, s.selectedCwd),
        activeId: null,
        messages: [],
        contextUsage: null,
        hiddenBefore: 0,
        planPanel: null,
        settingsOpen: false,
        usageOpen: false,
        panelMaximized: false,
        // The right panel is per chat; a fresh/draft chat starts collapsed.
        panelOpen: false
      }))
      // The list is `selectedCwd`'s now, and nothing else refreshes it on the
      // way out of a chat.
      void get().refreshCanvases()
      return
    }
    set((s) => ({
      // Restore this chat's own tab set (empty if never visited); stash the
      // outgoing chat's. Done synchronously so tabs swap on click, not after
      // the getChat round-trip below.
      ...chatSwitchPatch(s, id),
      activeId: id,
      messages: [],
      contextUsage: null,
      // Cleared synchronously, or the outgoing chat's count would briefly offer
      // "load earlier" on a chat that has nothing earlier to load.
      hiddenBefore: 0,
      loadingOlder: false,
      planPanel: null,
      // Cleared synchronously when the *project* changes, for the reason
      // `hiddenBefore` is: left standing they would briefly list another
      // project's documents under this chat's tab. Within one project they
      // stay — the open documents belong to the folder, not to the chat.
      ...canvasScopePatch(s, { activeId: id, chats: s.chats, selectedCwd: s.selectedCwd }),
      settingsOpen: false,
      usageOpen: false,
      panelMaximized: false,
      // Panel visibility is per chat; unvisited chats start closed.
      panelOpen: s.panelOpenByChat[id] ?? false
    }))
    // Drop cached local images so this chat's inline pictures re-read from disk —
    // it may have been overwritten (by a background turn or externally) since it
    // was last shown.
    invalidateLocalImages()
    const view = await window.api.getChat(id)
    // Guard against a chat switch happening while we awaited.
    if (get().activeId === id && view) {
      const { chat, hiddenBefore } = view
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
          hiddenBefore,
          loadingOlder: false,
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
      void get().refreshCanvases()
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

  async loadOlderMessages() {
    const id = get().activeId
    const before = get().hiddenBefore
    if (!id || before <= 0 || get().loadingOlder) return
    set({ loadingOlder: true })
    try {
      const older = await window.api.loadOlderMessages(id, before)
      // A chat switch (or another load landing first) while we awaited: the
      // window we fetched belongs to a view that no longer exists.
      if (!older || get().activeId !== id || get().hiddenBefore !== before) return
      set((s) => ({ messages: [...older.messages, ...s.messages], hiddenBefore: older.from }))
    } finally {
      set({ loadingOlder: false })
    }
  },

  async newChat(cwd, firstMessage, opts) {
    const { attachments, label, reviewTarget, ...createOpts } = opts ?? {}
    const meta = await window.api.createChat({ cwd, ...createOpts })
    // A worktree chat's cwd is the worktree, not the picked project folder —
    // the panel, git status and file tree all follow it.
    const chatCwd = meta.cwd
    // Starting a chat in a hidden project brings it back into the sidebar.
    if (get().hiddenProjects[cwd]) get().setProjectHidden(cwd, false)
    set((s) => {
      const modelEfforts = { ...(s.defaults?.modelEfforts ?? {}) }
      // Main persists the normalized chat model/effort during creation. Mirror
      // that exact pair so the live renderer cannot restore an older value.
      modelEfforts[meta.model ?? ''] = meta.effort ?? ''
      return {
        // A brand-new chat has no saved tabs, so this stashes the outgoing chat's
        // and opens an empty tab set.
        ...chatSwitchPatch(s, meta.id),
        selectedCwd: chatCwd,
        chats: [meta, ...s.chats],
        activeId: meta.id,
        messages: [],
        contextUsage: null,
        hiddenBefore: 0,
        loadingOlder: false,
        planPanel: null,
        settingsOpen: false,
        usageOpen: false,
        panelMaximized: false,
        defaults: s.defaults
          ? {
              ...s.defaults,
              model: meta.model,
              // The provider travels with the model, always. Mirroring one
              // without the other leaves the next New-chat screen pairing this
              // model with the *previous* pick's provider — which is how a
              // Claude model came to be launched as a Codex chat.
              modelProvider: meta.provider,
              effort: meta.effort,
              serviceTier: opts?.serviceTier,
              permissionMode: opts?.permissionMode ?? s.defaults.permissionMode,
              recentDirs: [cwd, ...s.defaults.recentDirs.filter((d) => d !== cwd)].slice(0, 8),
              modelEfforts
            }
          : s.defaults
      }
    })
    // The new chat keeps whatever panel state was showing when it was created.
    set((s) => panelPatch(s, s.panelOpen))
    get().loadCommands(chatCwd, meta.provider)
    void get().refreshGit()
    if (get().panelOpen && !get().filesByDir[chatCwd]) void get().loadDir(chatCwd)
    // A fresh worktree has no gitignored files — no node_modules, no .env — so
    // run the project's setup script in a visible terminal tab. Deliberately not
    // awaited: the agent starts now and the install races alongside it.
    if (meta.worktree) void get().runWorktreeSetup(meta.id)
    if (reviewTarget) await window.api.startReview(meta.id, reviewTarget)
    else await window.api.send(meta.id, firstMessage, attachments, label)
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

  async exitWorktree(chatId, op) {
    const call =
      op === 'handoff'
        ? window.api.worktreeHandoff
        : op === 'merge'
          ? window.api.worktreeMerge
          : window.api.worktreeFinish
    const res = await call(chatId)
    // Runs even on failure: a leftover branch can still have moved the chat.
    get().followRelocation(chatId)
    return res
  },

  /**
   * Main emits a `meta` patch with the new cwd, which applyEvent folds into the
   * chat list — but the panel follows selectedCwd, so move that too. Shared by
   * both worktree exits; the guard on `worktree` is what makes it a no-op when
   * the operation refused and the chat never moved.
   */
  followRelocation(chatId) {
    const moved = get().chats.find((c) => c.id === chatId)
    if (moved && !moved.worktree && get().activeId === chatId) {
      get().setSelectedCwd(moved.cwd)
      void get().refreshGit()
    }
  },

  async mergeBranchInPlace() {
    const cwd = get().selectedCwd
    if (!cwd) return { ok: false, error: 'No project selected.' }
    const res = await window.api.gitMergeIntoDefault(cwd)
    // The branch, the working tree and the PR picture all just changed; the
    // three refreshes are independent, so only the git one gates returning.
    const refreshed = get().refreshGit()
    void get().refreshGithub()
    if (get().panelOpen) void get().loadDir(cwd)
    await refreshed
    return res
  },

  worktreeNotice: null,

  dismissWorktreeNotice() {
    set({ worktreeNotice: null })
  },

  async runWorktreeSetup(chatId) {
    const { setupCommand, emptyBase } = await window.api.worktreeNotice(chatId)
    if (setupCommand) {
      const chat = get().chats.find((c) => c.id === chatId)
      if (chat) get().openTerminal({ cwd: chat.cwd, command: setupCommand, label: 'Setup' })
    }
    // Silence on either of these used to read as "fine": the agent would open
    // on an empty folder, or start failing on missing dependencies, with
    // nothing on screen to explain why.
    if (emptyBase) set({ worktreeNotice: { chatId, kind: 'empty-base' } })
    else if (!setupCommand) set({ worktreeNotice: { chatId, kind: 'setup-missing' } })
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

  async startCodexReview(target) {
    const id = get().activeId
    if (!id) return
    if ((get().statuses[id] ?? 'idle') !== 'idle') {
      throw new Error('Wait for the current turn to finish before starting a review.')
    }
    await window.api.startReview(id, target)
  },

  async loadCodexGoal(chatId) {
    const goal = await window.api.codexGoalGet(chatId)
    set((s) => ({ codexGoals: { ...s.codexGoals, [chatId]: goal } }))
  },

  async setCodexGoal(chatId, patch) {
    const goal = await window.api.codexGoalSet(chatId, patch)
    set((s) => ({ codexGoals: { ...s.codexGoals, [chatId]: goal } }))
    return goal
  },

  async clearCodexGoal(chatId) {
    const cleared = await window.api.codexGoalClear(chatId)
    if (cleared) {
      set((s) => ({ codexGoals: { ...s.codexGoals, [chatId]: null } }))
    }
    return cleared
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

  async loadModels(chatId, cwd) {
    const available = availableProviders(get().providerClis)
    if (hasCompleteModelCatalog(get().models, available)) return
    const id = chatId ?? get().activeId
    const folder =
      cwd ??
      (id ? get().chats.find((chat) => chat.id === id)?.cwd : undefined) ??
      get().selectedCwd ??
      undefined
    // Either identifies a folder to read the list from — a chat via its cwd, or
    // the new-chat screen's picked folder directly.
    if (!id && !folder) return
    if (modelsLoad) {
      try {
        await modelsLoad
      } catch {
        // The owner of the in-flight request applies the retry policy.
      }
      return
    }
    if (Date.now() < modelsRetryAt) return
    const request = window.api.listModels(id ?? '', folder)
    modelsLoad = request
    try {
      const models = await request
      if (models.length) {
        set((state) => ({ models: mergeModelCatalogs(state.models, models) }))
      }
      modelsRetryAt = hasCompleteModelCatalog(get().models, available)
        ? Number.POSITIVE_INFINITY
        : Date.now() + MODELS_RETRY_MS
    } catch {
      modelsRetryAt = Date.now() + MODELS_RETRY_MS
      // Keep the last good provider rows and static fallback for the missing one.
    } finally {
      if (modelsLoad === request) modelsLoad = null
    }
  },

  async refreshUsage(force = false) {
    try {
      set({ usage: await window.api.usageOverview(force) })
    } catch {
      // Keep the last good numbers rather than blanking the chip: a stale
      // percentage is still worth more than none, and the next turn retries.
    }
  },

  async loadCodexConfigModel() {
    if (get().codexConfigModel !== undefined) return
    codexConfigModelLoad ??= window.api.codexConfigModel()
    try {
      set({ codexConfigModel: await codexConfigModelLoad })
    } catch {
      // The chip can safely retain "Codex (default)" when config is unavailable.
      set({ codexConfigModel: null })
    }
  },

  async loadProviderClis(refresh = false) {
    if (!refresh && get().providerClis.length) return
    try {
      set({ providerClis: await window.api.providerClis(refresh) })
    } catch {
      // Leave the last good answer. An empty list would empty every model
      // picker, which is a far worse failure than a stale install status.
    }
  },

  async setProviderCli(provider, patch) {
    try {
      set({ providerClis: await window.api.setProviderCli(provider, patch) })
    } catch {
      return
    }
    // Enabling a provider makes a catalog fetchable that the retry policy had
    // already given up on, so the models cache is reset rather than merged.
    modelsRetryAt = 0
    set({ models: [] })
    void get().loadModels()
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

  async editMessage(messageId, text) {
    const id = get().activeId
    if (!id) return { ok: false, error: 'No active chat.' }
    const res = await window.api.editMessage(id, messageId, text)
    // A resend starts a turn, so the same post-turn refreshes a normal send
    // gets are already wired; nothing to do here but report.
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
        fastMode: omit(s.fastMode, [id]),
        codexGoals: omit(s.codexGoals, [id]),
        panelOpenByChat: prunePanelState(s, [id]),
        tabsByChat: pruneTabsByChat(s, [id]),
        ...pruneTerminals(s, [id]),
        ...dropDrafts(s, [id])
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
        selectedCwd: s.selectedCwd === cwd ? homeCwd(chats, recentDirs) : s.selectedCwd,
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
        fastMode: omit(s.fastMode, ids),
        codexGoals: omit(s.codexGoals, ids),
        panelOpenByChat: prunePanelState(s, ids),
        tabsByChat: pruneTabsByChat(s, ids),
        ...pruneTerminals(s, ids),
        ...dropDrafts(s, ids, [cwd]),
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

  async setChatPinned(id, pinned) {
    // Mirror locally first: the toggle is a direct manipulation, so it must not
    // wait a round trip. Main answers with the authoritative timestamp.
    const at = pinned ? Date.now() : undefined
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, pinnedAt: at } : c)) }))
    await window.api.setChatPinned(id, pinned)
  },

  async setChatOptions(patch) {
    const id = get().activeId
    if (!id) return
    await window.api.setChatOptions(id, patch)
    // Mirror the new defaults locally so the next New-chat screen uses them —
    // skipping the same corrections main leaves out of `rememberOptions`.
    if (patch.remember === false) return
    set((s) => {
      if (!s.defaults) return {}
      // Effort is also remembered per-model (keyed by the model the change
      // applied to — the patch's own model, or the active chat's) so switching
      // models can restore each one's last effort. Mirror what main persists.
      let modelEfforts = s.defaults.modelEfforts
      if (patch.effort !== undefined) {
        const key = patch.model ?? s.chats.find((c) => c.id === id)?.model ?? ''
        modelEfforts = { ...(modelEfforts ?? {}) }
        modelEfforts[key] = patch.effort
      }
      return {
        defaults: {
          ...s.defaults,
          // Model and provider move together — see the same pairing in newChat.
          // Main records both from this patch; mirroring only the model would
          // leave the next New-chat screen holding a mismatched pair.
          ...(patch.model !== undefined
            ? {
                model: patch.model || undefined,
                modelProvider:
                  patch.modelProvider ??
                  knownProviderForModel(patch.model, s.models) ??
                  s.defaults.modelProvider
              }
            : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort || undefined } : {}),
          ...(patch.serviceTier !== undefined ? { serviceTier: patch.serviceTier } : {}),
          ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
          modelEfforts
        }
      }
    })
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
        // At most one state update per message: the active chat's messages and
        // the row's timestamp go in a single set() so each message causes one
        // render pass rather than two — and often neither, see below.
        //
        // `updatedAt` moves, the row does NOT. The array's own order is the
        // sidebar's order (see `hoistChat`) — re-sorting here is what made a
        // running turn shuffle the list under the cursor several times a
        // second, and with two chats streaming they simply traded places
        // forever.
        //
        // The bump itself is skipped when it would redraw nothing. `updatedAt`
        // is display state here — main owns the persisted value and re-states
        // it in a `meta` patch at the turn's end — and both surfaces that draw
        // it are coarse: a minute, then a day. Remapping `chats` anyway mints a
        // new array, which every Sidebar subscriber compares by identity, so on
        // Claude (where each tool call is its own assistant message) that was a
        // full sidebar re-render dozens of times a turn for a row whose text
        // never changed. The row still ticks over on the message that genuinely
        // crosses a boundary.
        const now = Date.now()
        const row = s.chats.find((c) => c.id === ev.chatId)
        const redraws = !!row && !sameDisplayedTime(row.updatedAt, now)
        const isActive = ev.chatId === s.activeId
        // A background chat whose row would draw exactly as it already does has
        // nothing to write, and `set({})` is not the way to say so: zustand
        // assigns a fresh state object for it and runs every subscriber's
        // selector against it. Same reason `context-usage` below bails before
        // `set` rather than returning an empty patch.
        if (isActive || redraws) {
          set((st) => ({
            ...(isActive ? { messages: upsertMessage(st.messages, ev.message) } : {}),
            ...(redraws
              ? {
                  chats: st.chats.map((c) => (c.id === ev.chatId ? { ...c, updatedAt: now } : c))
                }
              : {})
          }))
        }
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

      case 'context-usage': {
        // Only the chat on screen: this feeds one popover, and a map keyed by
        // chat would retain a breakdown per background chat that is stale as
        // soon as its next turn runs. Bail before `set` rather than returning
        // `{}` — a fresh object fails zustand's identity check and would notify
        // every subscriber for a background chat that changed nothing.
        if (ev.chatId !== get().activeId) break
        set({ contextUsage: ev.usage })
        break
      }
      case 'meta': {
        set((st) => ({
          // Patch in place. A title landing, a model change or a branch switch
          // is not a reason to move the row — and sorting on `updatedAt` here
          // would replay all the churn `message` no longer causes.
          chats: st.chats.map((c) => (c.id === ev.chatId ? { ...c, ...ev.patch } : c)),
          // Any options patch invalidates a Fast reading — it always carries the
          // tier, and a model change can flip Fast support on its own. Drop it
          // and wait for the session to report again; it re-inits on a live
          // toggle, so the gap is short.
          ...(ev.patch.serviceTier !== undefined
            ? { fastMode: omit(st.fastMode, [ev.chatId]) }
            : {})
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

      case 'fast-mode': {
        set((st) => ({ fastMode: { ...st.fastMode, [ev.chatId]: ev.status } }))
        break
      }

      case 'codex-goal': {
        set((st) => ({ codexGoals: { ...st.codexGoals, [ev.chatId]: ev.goal } }))
        break
      }

      case 'canvas': {
        // Splice the summary in rather than refetching: the list is live while
        // a turn runs, and a round trip per write would be a query per token of
        // the model's patience. The tab is deliberately NOT opened — the agents
        // panel's rule holds here too, that something arriving mid-read must
        // not take the document you are looking at off screen.
        set((st) => {
          if (canvasProject(st) !== ev.project) return {}
          const rest = st.canvases.filter((c) => c.id !== ev.canvas.id)
          return { canvases: [ev.canvas, ...rest] }
        })
        // A revision of a canvas that is open should redraw it in place —
        // `openCanvas` re-reads the body and leaves the tab where it is.
        if (get().canvasTabs.includes(ev.canvas.id)) {
          void window.api.canvasGet(ev.canvas.id).then((fresh) => {
            set((st) =>
              st.canvasTabs.includes(ev.canvas.id)
                ? { canvasHtml: { ...st.canvasHtml, [ev.canvas.id]: fresh?.html ?? '' } }
                : {}
            )
          })
        }
        break
      }
      case 'title-pending': {
        set((st) => ({ titling: { ...st.titling, [ev.chatId]: ev.pending } }))
        break
      }

      case 'chat-locked': {
        set((st) => ({ lockedChats: { ...st.lockedChats, [ev.chatId]: true } }))
        break
      }

      // An edit-and-resend rewound the conversation. `keep` counts the whole
      // chat, so it has to come back through `hiddenBefore` to address the
      // window this store actually holds — main truncates to a loaded message,
      // so the result is never negative and never touches the hidden prefix.
      case 'truncate': {
        set((st) => {
          if (st.activeId !== ev.chatId) return {}
          const keep = Math.max(0, ev.keep - st.hiddenBefore)
          if (keep >= st.messages.length) return {}
          return { messages: st.messages.slice(0, keep) }
        })
        break
      }
      case 'status': {
        set((st) => ({
          statuses: { ...st.statuses, [ev.chatId]: ev.status },
          // The one moment a chat is allowed to change place: the start of a
          // turn — which is the user's own send, so the move is theirs and
          // lands before they look away. Everything after it (every streamed
          // message, every tool result) leaves the list exactly as it was.
          chats:
            ev.status !== 'idle' && (st.statuses[ev.chatId] ?? 'idle') === 'idle'
              ? hoistChat(st.chats, ev.chatId)
              : st.chats
        }))
        // Any non-idle status means a live session (a new chat's first turn is
        // 'starting', not 'streaming') — load both live model catalogs once so
        // aliases, capabilities and provider-default resolutions are current.
        if (ev.status !== 'idle') void get().loadModels(ev.chatId)
        // main dedups consecutive statuses, so an `idle` here is a real
        // transition (the interrupt()+result double-`idle` is collapsed there).
        if (ev.status === 'idle') {
          // A turn just drew down the plan, so this is when the usage chip is
          // most likely wrong. Not gated on the active chat like the refreshes
          // below: a background chat's turn spends the same windows. Throttled
          // inside refreshUsage — turn boundaries come far faster than limits
          // move, and each real read spawns a CLI process per provider.
          void get().refreshUsage()
          // A queued message goes out as soon as the chat is free again.
          const next = get().queued[ev.chatId]?.[0]
          if (next) {
            set((st) => ({
              queued: { ...st.queued, [ev.chatId]: st.queued[ev.chatId].slice(1) }
            }))
            void window.api.send(ev.chatId, next.text, next.attachments, next.label)
          }
          // A turn can create or switch a branch (the "Create Branch & Commit"
          // rung, or the agent doing it itself), and that shows in the sidebar
          // for *any* chat — so this one is not gated on the active chat.
          void get().refreshChatBranches()
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
            // Language servers cache the whole project, not just the open tabs.
            // A turn that rewrote a file the user has *not* opened leaves the
            // server answering from its old copy — so jumps land on a line that
            // has moved, which is worse than no jump at all.
            const cwd = get().selectedCwd
            if (cwd) {
              // `lastTurnEditedPaths` answers in repo-relative paths; a server
              // wants uris, so they have to be rejoined onto the root first.
              const touched = lastTurnEditedPaths(get(), cwd).map((rel) => `${cwd}/${rel}`)
              if (touched.length > 0) notifyWatchedChanges(touched)
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
        // Waiting on the user: always sound, and notify if the app is in the
        // background (the notification stays silent — the cue is the sound).
        if (s.notifyPrefs.sound) playCue('attention', s.notifyPrefs.pack)
        if (s.notifyPrefs.permission && !document.hasFocus()) {
          const chat = s.chats.find((c) => c.id === ev.chatId)
          const agent = PROVIDER_SHORT_LABELS[chat?.provider ?? 'claude']
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
        if (get().commandsKey === `${ev.cwd}::${ev.provider}`) set({ commands: ev.commands })
        break
      }
    }
  }
}))

// The editor buffers live outside React and outside this store (see
// `lib/editorBuffers.ts`); this is the one wire back. It fires on clean ⇄ dirty
// transitions only — once per edit session rather than once per keystroke — so
// the tab's unsaved dot can be a plain subscription without making every
// character typed a store write.
setDirtyListener((path, dirty) => {
  useApp.setState((s) =>
    dirty
      ? { dirtyFiles: { ...s.dirtyFiles, [path]: true } }
      : { dirtyFiles: omit(s.dirtyFiles, [path]) }
  )
  // Main needs the count at `close` time, which is synchronous about whether the
  // close is vetoed — so it is pushed on the transition rather than asked for.
  // Counted off the map just written rather than by re-testing every buffer.
  window.api.setDirtyFileCount(Object.keys(useApp.getState().dirtyFiles).length)
})

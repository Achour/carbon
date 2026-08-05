import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Api,
  Attachment,
  ChatEvent,
  DockIconPalette,
  EffortId,
  GitDiffTarget,
  PermissionDecision,
  PermissionModeId,
  PermissionRule,
  PreviewCommand,
  PreviewCommandResult,
  PreviewEvent,
  Provider,
  ChatOptionsPatch,
  ServiceTier,
  TerminalCreateOpts,
  TerminalEvent,
  WorktreeTarget,
  WorktreeDisposition
} from '@shared/types'

/**
 * `ipcRenderer.invoke`, minus Electron's wire-format wrapper on rejections
 * ("Error invoking remote method '<channel>': Error: …"). Handlers that throw a
 * user-facing message — git's own words, say — should reach the renderer
 * readable, and unwrapping here means every channel gets that, not just the one
 * whose caller remembered to strip it.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    throw new Error(msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
  }
}

const api: Api = {
  listChats: () => invoke('chats:list'),
  getChat: (id: string) => invoke('chats:get', id),
  loadOlderMessages: (id: string, before: number) => invoke('chats:load-older', id, before),
  createChat: (opts: {
    cwd: string
    provider?: Provider
    model?: string
    effort?: EffortId
    serviceTier?: ServiceTier
    permissionMode?: PermissionModeId
    worktree?: WorktreeTarget
  }) => invoke('chats:create', opts),
  deleteChat: (id: string, worktree?: WorktreeDisposition) =>
    invoke('chats:delete', id, worktree),
  worktreeStatus: (chatId: string) => invoke('worktree:status', chatId),
  worktreeSetupCommand: (chatId: string) => invoke('worktree:setup-command', chatId),
  listWorktrees: (cwd: string) => invoke('worktree:list', cwd),
  worktreeHandoff: (chatId: string) => invoke('worktree:handoff', chatId),
  worktreeMerge: (chatId: string) => invoke('worktree:merge', chatId),
  worktreeFinish: (chatId: string) => invoke('worktree:finish', chatId),
  worktreeRemove: (path: string) => invoke('worktree:remove', path),
  renameChat: (id: string, title: string) => invoke('chats:rename', id, title),
  setChatPinned: (id: string, pinned: boolean) => invoke('chats:set-pinned', id, pinned),
  send: (chatId: string, text: string, attachments?: Attachment[], label?: string) =>
    invoke('chat:send', chatId, text, attachments, label),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  interrupt: (chatId: string) => invoke('chat:interrupt', chatId),
  stopBackgroundJob: (chatId: string, taskId: string) =>
    invoke('chat:stop-background-job', chatId, taskId),
  respondPermission: (chatId: string, requestId: string, decision: PermissionDecision) =>
    invoke('chat:respond-permission', chatId, requestId, decision),
  setChatOptions: (chatId: string, patch: ChatOptionsPatch) =>
    invoke('chat:set-options', chatId, patch),
  rewindFiles: (chatId: string, userMessageId: string, dryRun: boolean) =>
    invoke('chat:rewind-files', chatId, userMessageId, dryRun),
  sessionLive: (chatId: string) => invoke('session:live', chatId),
  mcpStatus: (chatId: string) => invoke('mcp:status', chatId),
  mcpReconnect: (chatId: string, name: string) => invoke('mcp:reconnect', chatId, name),
  mcpToggle: (chatId: string, name: string, enabled: boolean) =>
    invoke('mcp:toggle', chatId, name, enabled),
  listModels: (chatId: string, cwd?: string) => invoke('session:models', chatId, cwd),
  codexConfigModel: () => invoke('codex:config-model'),
  listAgents: (chatId: string) => invoke('session:agents', chatId),
  accountInfo: (chatId: string) => invoke('session:account', chatId),
  usageInfo: (chatId: string) => invoke('session:usage', chatId),
  usageOverview: (refresh?: boolean) => invoke('usage:overview', refresh),
  getPermissionRules: (cwd: string) => invoke('permissions:list', cwd),
  removePermissionRule: (cwd: string, rule: PermissionRule) =>
    invoke('permissions:remove', cwd, rule),
  pickDirectory: () => invoke('dialog:pick-directory'),
  listDir: (dir: string) => invoke('fs:list', dir),
  readFile: (path: string) => invoke('fs:read', path),
  statPath: (path: string) => invoke('fs:stat', path),
  searchFiles: (cwd: string, query: string) => invoke('fs:search', cwd, query),
  gitStatus: (cwd: string) => invoke('git:status', cwd),
  gitDiff: (cwd: string, target: GitDiffTarget) => invoke('git:diff', cwd, target),
  gitStage: (cwd: string, paths: string[]) => invoke('git:stage', cwd, paths),
  gitUnstage: (cwd: string, paths: string[]) => invoke('git:unstage', cwd, paths),
  gitCommit: (cwd: string, message: string) => invoke('git:commit', cwd, message),
  gitPush: (cwd: string) => invoke('git:push', cwd),
  gitPull: (cwd: string) => invoke('git:pull', cwd),
  gitMergeIntoDefault: (cwd: string) => invoke('git:merge-into-default', cwd),
  gitFetch: (cwd: string) => invoke('git:fetch', cwd),
  gitBranchChanges: (cwd: string, baseBranch?: string) =>
    invoke('git:branch-changes', cwd, baseBranch),
  gitInit: (cwd: string) => invoke('git:init', cwd),
  githubState: (cwd: string) => invoke('github:state', cwd),
  githubOpenPr: (cwd: string) => invoke('github:open-pr', cwd),
  getDefaults: () => invoke('app:get-defaults'),
  forgetDir: (dir: string) => invoke('app:forget-dir', dir),
  revealPath: (path: string) => invoke('app:reveal-path', path),
  focusWindow: () => invoke('app:focus-window'),
  openExternal: (url: string) => invoke('app:open-external', url),
  checkForUpdate: () => invoke('app:check-update'),
  // Resolved once at bridge construction: `app` isn't reachable from preload,
  // and a version that can't change while the process lives has no business
  // being an async call the renderer has to await.
  appVersion: ipcRenderer.sendSync('app:version') as string,
  setWindowAppearance: (mode: 'dark' | 'light' | 'system', resolvedDark: boolean) =>
    invoke('window:set-appearance', mode, resolvedDark),
  setDockIcon: (palette: DockIconPalette) => invoke('window:set-dock-icon', palette),
  setWindowTranslucent: (on: boolean) => invoke('window:set-translucent', on),
  platform: process.platform,
  terminalCreate: (opts: TerminalCreateOpts) => invoke('terminal:create', opts),
  terminalWrite: (id: string, data: string) => invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke('terminal:resize', id, cols, rows),
  terminalKill: (id: string) => invoke('terminal:kill', id),
  getCommands: (cwd: string, provider?: Provider) =>
    invoke('commands:get', cwd, provider),
  previewDetect: (cwd: string) => invoke('preview:detect', cwd),
  previewState: (cwd: string) => invoke('preview:state', cwd),
  previewStart: (cwd: string, command?: string) =>
    invoke('preview:start', cwd, command),
  previewStop: (cwd: string) => invoke('preview:stop', cwd),
  previewLogs: (cwd: string) => invoke('preview:logs', cwd),
  previewReportConsole: (cwd: string, line: string) => {
    void invoke('preview:report-console', cwd, line)
  },
  previewCommandResult: (result: PreviewCommandResult) => {
    void invoke('preview:command-result', result)
  },
  previewCaptureWindow: (rect: { x: number; y: number; width: number; height: number }) =>
    invoke('preview:capture-window', rect),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  onNewChat: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ui:new-chat', listener)
    return () => ipcRenderer.removeListener('ui:new-chat', listener)
  },
  onOpenChat: (cb: (id: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('ui:open-chat', listener)
    return () => ipcRenderer.removeListener('ui:open-chat', listener)
  },
  onTerminalEvent: (cb: (ev: TerminalEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: TerminalEvent): void => cb(ev)
    ipcRenderer.on('terminal:event', listener)
    return () => ipcRenderer.removeListener('terminal:event', listener)
  },
  onPreviewEvent: (cb: (ev: PreviewEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: PreviewEvent): void => cb(ev)
    ipcRenderer.on('preview:event', listener)
    return () => ipcRenderer.removeListener('preview:event', listener)
  },
  onPreviewCommand: (cb: (cmd: PreviewCommand) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, cmd: PreviewCommand): void => cb(cmd)
    ipcRenderer.on('preview:command', listener)
    return () => ipcRenderer.removeListener('preview:command', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

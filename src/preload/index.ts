import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Api,
  Attachment,
  ChatEvent,
  EffortId,
  GitDiffTarget,
  PermissionDecision,
  PermissionModeId,
  PermissionRule,
  PreviewCommand,
  PreviewCommandResult,
  PreviewEvent,
  Provider,
  TerminalCreateOpts,
  TerminalEvent
} from '@shared/types'

const api: Api = {
  listChats: () => ipcRenderer.invoke('chats:list'),
  getChat: (id: string) => ipcRenderer.invoke('chats:get', id),
  createChat: (opts: {
    cwd: string
    provider?: Provider
    model?: string
    effort?: EffortId
    permissionMode?: PermissionModeId
  }) => ipcRenderer.invoke('chats:create', opts),
  deleteChat: (id: string) => ipcRenderer.invoke('chats:delete', id),
  renameChat: (id: string, title: string) => ipcRenderer.invoke('chats:rename', id, title),
  send: (chatId: string, text: string, attachments?: Attachment[], label?: string) =>
    ipcRenderer.invoke('chat:send', chatId, text, attachments, label),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  interrupt: (chatId: string) => ipcRenderer.invoke('chat:interrupt', chatId),
  stopBackgroundJob: (chatId: string, taskId: string) =>
    ipcRenderer.invoke('chat:stop-background-job', chatId, taskId),
  respondPermission: (chatId: string, requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke('chat:respond-permission', chatId, requestId, decision),
  setChatOptions: (
    chatId: string,
    patch: { model?: string; effort?: EffortId | ''; permissionMode?: PermissionModeId }
  ) => ipcRenderer.invoke('chat:set-options', chatId, patch),
  rewindFiles: (chatId: string, userMessageId: string, dryRun: boolean) =>
    ipcRenderer.invoke('chat:rewind-files', chatId, userMessageId, dryRun),
  sessionLive: (chatId: string) => ipcRenderer.invoke('session:live', chatId),
  mcpStatus: (chatId: string) => ipcRenderer.invoke('mcp:status', chatId),
  mcpReconnect: (chatId: string, name: string) => ipcRenderer.invoke('mcp:reconnect', chatId, name),
  mcpToggle: (chatId: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:toggle', chatId, name, enabled),
  listModels: (chatId: string) => ipcRenderer.invoke('session:models', chatId),
  listAgents: (chatId: string) => ipcRenderer.invoke('session:agents', chatId),
  accountInfo: (chatId: string) => ipcRenderer.invoke('session:account', chatId),
  usageInfo: (chatId: string) => ipcRenderer.invoke('session:usage', chatId),
  getPermissionRules: (cwd: string) => ipcRenderer.invoke('permissions:list', cwd),
  removePermissionRule: (cwd: string, rule: PermissionRule) =>
    ipcRenderer.invoke('permissions:remove', cwd, rule),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  listDir: (dir: string) => ipcRenderer.invoke('fs:list', dir),
  readFile: (path: string) => ipcRenderer.invoke('fs:read', path),
  statPath: (path: string) => ipcRenderer.invoke('fs:stat', path),
  searchFiles: (cwd: string, query: string) => ipcRenderer.invoke('fs:search', cwd, query),
  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitDiff: (cwd: string, target: GitDiffTarget) => ipcRenderer.invoke('git:diff', cwd, target),
  gitStage: (cwd: string, paths: string[]) => ipcRenderer.invoke('git:stage', cwd, paths),
  gitUnstage: (cwd: string, paths: string[]) => ipcRenderer.invoke('git:unstage', cwd, paths),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitPull: (cwd: string) => ipcRenderer.invoke('git:pull', cwd),
  gitFetch: (cwd: string) => ipcRenderer.invoke('git:fetch', cwd),
  gitBranchChanges: (cwd: string, baseBranch?: string) =>
    ipcRenderer.invoke('git:branch-changes', cwd, baseBranch),
  gitInit: (cwd: string) => ipcRenderer.invoke('git:init', cwd),
  githubState: (cwd: string) => ipcRenderer.invoke('github:state', cwd),
  githubOpenPr: (cwd: string) => ipcRenderer.invoke('github:open-pr', cwd),
  getDefaults: () => ipcRenderer.invoke('app:get-defaults'),
  forgetDir: (dir: string) => ipcRenderer.invoke('app:forget-dir', dir),
  focusWindow: () => ipcRenderer.invoke('app:focus-window'),
  setWindowAppearance: (mode: 'dark' | 'light' | 'system', resolvedDark: boolean) =>
    ipcRenderer.invoke('window:set-appearance', mode, resolvedDark),
  setWindowTranslucent: (on: boolean) => ipcRenderer.invoke('window:set-translucent', on),
  platform: process.platform,
  terminalCreate: (opts: TerminalCreateOpts) => ipcRenderer.invoke('terminal:create', opts),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  getCommands: (cwd: string, provider?: Provider) =>
    ipcRenderer.invoke('commands:get', cwd, provider),
  previewDetect: (cwd: string) => ipcRenderer.invoke('preview:detect', cwd),
  previewState: (cwd: string) => ipcRenderer.invoke('preview:state', cwd),
  previewStart: (cwd: string, command?: string) =>
    ipcRenderer.invoke('preview:start', cwd, command),
  previewStop: (cwd: string) => ipcRenderer.invoke('preview:stop', cwd),
  previewLogs: (cwd: string) => ipcRenderer.invoke('preview:logs', cwd),
  previewReportConsole: (cwd: string, line: string) => {
    void ipcRenderer.invoke('preview:report-console', cwd, line)
  },
  previewCommandResult: (result: PreviewCommandResult) => {
    void ipcRenderer.invoke('preview:command-result', result)
  },
  previewCaptureWindow: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('preview:capture-window', rect),
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

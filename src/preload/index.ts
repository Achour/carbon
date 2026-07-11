import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  ChatEvent,
  EffortId,
  PermissionDecision,
  PermissionModeId,
  Provider
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
  send: (chatId: string, text: string) => ipcRenderer.invoke('chat:send', chatId, text),
  interrupt: (chatId: string) => ipcRenderer.invoke('chat:interrupt', chatId),
  respondPermission: (chatId: string, requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke('chat:respond-permission', chatId, requestId, decision),
  setChatOptions: (
    chatId: string,
    patch: { model?: string; effort?: EffortId | ''; permissionMode?: PermissionModeId }
  ) => ipcRenderer.invoke('chat:set-options', chatId, patch),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  listDir: (dir: string) => ipcRenderer.invoke('fs:list', dir),
  readFile: (path: string) => ipcRenderer.invoke('fs:read', path),
  getDefaults: () => ipcRenderer.invoke('app:get-defaults'),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  onNewChat: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ui:new-chat', listener)
    return () => ipcRenderer.removeListener('ui:new-chat', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

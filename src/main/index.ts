import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ChatData,
  ChatEvent,
  EffortId,
  GitDiffTarget,
  PermissionDecision,
  PermissionModeId,
  Provider
} from '@shared/types'
import { ChatManager } from './claude'
import { listDir, readFileContent } from './files'
import * as gitOps from './git'
import { Store } from './store'

const __dirname = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let store: Store
let manager: ChatManager

function emit(ev: ChatEvent): void {
  win?.webContents.send('chat:event', ev)
}

function createWindow(): void {
  const bounds = store.getWindowBounds()
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 832,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#131316',
    title: 'AI GUI',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.on('close', () => {
    if (win) store.setWindowBounds(win.getBounds())
  })
  win.on('closed', () => {
    win = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dev utility: surface renderer console output in the terminal.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (details) => {
      console.log(`[renderer:${details.level}]`, details.message)
    })
  }

  // Dev utility: AIGUI_CAPTURE=/path/out.png saves screenshots after load.
  // AIGUI_CAPTURE_DELAY takes one delay or a comma list ("2000,8000") — a list
  // saves out-1.png, out-2.png, … per delay.
  const capturePath = process.env.AIGUI_CAPTURE
  if (capturePath) {
    const delays = (process.env.AIGUI_CAPTURE_DELAY ?? '1500')
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isFinite(d))
    win.webContents.once('did-finish-load', () => {
      delays.forEach((delay, i) => {
        setTimeout(() => {
          const path =
            delays.length === 1
              ? capturePath
              : capturePath.replace(/\.png$/, `-${i + 1}.png`)
          void win?.webContents.capturePage().then((img) => {
            writeFileSync(path, img.toPNG())
          })
        }, delay)
      })
    })
  }

  // Dev utility: AIGUI_E2E=<js> runs a script in the renderer after load.
  const e2e = process.env.AIGUI_E2E
  if (e2e) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win?.webContents
          .executeJavaScript(e2e)
          .then((r) => console.log('[e2e result]', JSON.stringify(r)))
          .catch((err) => console.error('[e2e error]', err))
      }, 1000)
    })
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.send('ui:new-chat')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { label: 'Edit', role: 'editMenu' },
    { label: 'View', role: 'viewMenu' },
    { label: 'Window', role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle('chats:list', () => store.listChats())

  ipcMain.handle('chats:get', (_e, id: string) => store.getChat(id))

  ipcMain.handle(
    'chats:create',
    (
      _e,
      opts: {
        cwd: string
        provider?: Provider
        model?: string
        effort?: EffortId
        permissionMode?: PermissionModeId
      }
    ) => {
    const now = Date.now()
    const chat: ChatData = {
      id: randomUUID(),
      title: '',
      cwd: opts.cwd,
      provider: opts.provider ?? 'claude',
      model: opts.model || undefined,
      effort: opts.effort || undefined,
      permissionMode: opts.permissionMode ?? store.getDefaults().permissionMode,
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    store.addChat(chat)
    store.rememberDir(opts.cwd)
    store.rememberOptions({
      model: opts.model ?? '',
      effort: opts.effort ?? '',
      permissionMode: chat.permissionMode
    })
    const { messages: _messages, ...meta } = chat
    return meta
    }
  )

  ipcMain.handle('chats:delete', (_e, id: string) => {
    manager.disposeChat(id)
    store.deleteChat(id)
  })

  ipcMain.handle('chats:rename', (_e, id: string, title: string) => {
    const chat = store.getChat(id)
    if (!chat) return
    chat.title = title
    store.saveChat(id)
    emit({ type: 'meta', chatId: id, patch: { title } })
  })

  ipcMain.handle('chat:send', (_e, chatId: string, text: string) => {
    manager.send(chatId, text)
  })

  ipcMain.handle('chat:interrupt', (_e, chatId: string) => manager.interrupt(chatId))

  ipcMain.handle(
    'chat:respond-permission',
    (_e, chatId: string, requestId: string, decision: PermissionDecision) => {
      manager.respondPermission(chatId, requestId, decision)
    }
  )

  ipcMain.handle(
    'chat:set-options',
    (
      _e,
      chatId: string,
      patch: { model?: string; effort?: EffortId | ''; permissionMode?: PermissionModeId }
    ) => manager.setOptions(chatId, patch)
  )

  ipcMain.handle('dialog:pick-directory', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('home')
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('app:get-defaults', () => store.getDefaults())

  ipcMain.handle('app:forget-dir', (_e, dir: string) => store.forgetDir(dir))

  ipcMain.handle('fs:list', (_e, dir: string) => listDir(dir))

  ipcMain.handle('fs:read', (_e, path: string) => readFileContent(path))

  ipcMain.handle('git:status', (_e, cwd: string) => gitOps.gitStatus(cwd))
  ipcMain.handle('git:diff', (_e, cwd: string, target: GitDiffTarget) => gitOps.gitDiff(cwd, target))
  ipcMain.handle('git:stage', (_e, cwd: string, paths: string[]) => gitOps.gitStage(cwd, paths))
  ipcMain.handle('git:unstage', (_e, cwd: string, paths: string[]) => gitOps.gitUnstage(cwd, paths))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string) => gitOps.gitCommit(cwd, message))
  ipcMain.handle('git:push', (_e, cwd: string) => gitOps.gitPush(cwd))
  ipcMain.handle('git:init', (_e, cwd: string) => gitOps.gitInit(cwd))
}

app.whenReady().then(() => {
  app.setName('AI GUI')
  // Pin userData so dev and packaged builds share the same history location.
  app.setPath('userData', join(app.getPath('appData'), 'ai-gui'))
  store = new Store()
  manager = new ChatManager(store, emit)
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  manager.disposeAll()
  store.flushAll()
})

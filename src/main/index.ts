import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Attachment,
  ChatData,
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
import { effortForProvider } from '@shared/types'
import { ChatManager } from './claude'
import { listDir, readFileContent, searchFiles, statPath } from './files'
import * as gitOps from './git'
import * as githubOps from './github'
import { getPermissionRules, removePermissionRule } from './permissions'
import { PreviewManager } from './preview'
import { Store } from './store'
import { TerminalManager } from './terminal'
import { hydrateShellPath } from './shellEnv'

const __dirname = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let store: Store
let manager: ChatManager
let terminals: TerminalManager
let preview: PreviewManager

function emit(ev: ChatEvent): void {
  win?.webContents.send('chat:event', ev)
  if (ev.type === 'status') notifyOnStatus(ev.chatId, ev.status)
}

// Native "turn finished" / "needs approval" notifications, but only while the
// app is in the background — if the user is watching, the UI already shows it.
const lastStatus = new Map<string, string>()
function notifyOnStatus(chatId: string, status: string): void {
  const prev = lastStatus.get(chatId)
  lastStatus.set(chatId, status)
  if (!win || win.isFocused() || !Notification.isSupported()) return
  const body =
    prev && prev !== 'idle' && status === 'idle'
      ? 'Finished responding'
      : prev !== 'waiting-permission' && status === 'waiting-permission'
        ? 'Waiting for your approval'
        : null
  if (!body) return
  const title = store.getChat(chatId)?.title?.trim() || 'Karbun'
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (!win) return
    suppressForegroundUntil = 0 // a click is a real request to come forward
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('ui:open-chat', chatId)
  })
  n.show()
}

function emitTerminal(ev: TerminalEvent): void {
  win?.webContents.send('terminal:event', ev)
}

function emitPreview(ev: PreviewEvent): void {
  win?.webContents.send('preview:event', ev)
}

// Preview screenshot/navigate live in the renderer (the <webview>), so main asks
// for them over a request/response channel keyed by a generated id.
const previewPending = new Map<string, (r: PreviewCommandResult) => void>()

// The preview <webview> guest (and capturePage) can yank the app to the
// foreground on macOS when the agent navigates/screenshots while the user is
// working in another app. When a command is dispatched with the app already in
// the background, we note it so any focus the window grabs in the next moment
// is bounced straight back (see the win.on('focus') handler).
let suppressForegroundUntil = 0
function markPreviewActivity(): void {
  if (win && !win.isFocused()) suppressForegroundUntil = Date.now() + 1500
}

function sendPreviewCommand(cmd: Omit<PreviewCommand, 'id'>): Promise<PreviewCommandResult> {
  const id = randomUUID()
  return new Promise<PreviewCommandResult>((resolve) => {
    if (!win) {
      resolve({ id, ok: false, error: 'No window' })
      return
    }
    markPreviewActivity()
    const timer = setTimeout(() => {
      if (previewPending.delete(id)) resolve({ id, ok: false, error: 'Preview command timed out' })
    }, 25_000)
    previewPending.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.send('preview:command', { id, ...cmd })
  })
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
    trafficLightPosition: { x: 13, y: 12 },
    backgroundColor: '#1c1c1c',
    title: 'Karbun',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      // Enables the <webview> tag used by the browser-preview panel.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win?.show())
  // Hand focus back to the user's app when the preview <webview> steals it
  // mid-navigate/screenshot. Only fires in the brief window after a preview
  // command dispatched while we were already in the background — a focus the
  // user didn't ask for — so manual clicks and notification-clicks are safe.
  if (process.platform === 'darwin') {
    win.on('focus', () => {
      if (Date.now() < suppressForegroundUntil) {
        suppressForegroundUntil = 0
        win?.blur()
      }
    })
  }
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

  // The <webview> preview is a browser, not the app shell: a target=_blank link
  // or window.open() inside it should navigate the preview in place, not spawn a
  // new window (or get kicked to the system browser). Without this, clicking an
  // in-app link in the preview appears to "do nothing" / opens externally.
  win.webContents.on('did-attach-webview', (_e, webviewContents) => {
    webviewContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http:') || url.startsWith('https:')) void webviewContents.loadURL(url)
      return { action: 'deny' }
    })
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
    const provider = opts.provider ?? 'claude'
    const effort = effortForProvider(opts.effort, provider)
    const chat: ChatData = {
      id: randomUUID(),
      title: '',
      cwd: opts.cwd,
      provider,
      model: opts.model || undefined,
      effort,
      permissionMode: opts.permissionMode ?? store.getDefaults().permissionMode,
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    store.addChat(chat)
    store.rememberDir(opts.cwd)
    store.rememberOptions({
      model: opts.model ?? '',
      effort: effort ?? '',
      permissionMode: chat.permissionMode
    })
    const { messages: _messages, ...meta } = chat
    return meta
    }
  )

  ipcMain.handle('chats:delete', (_e, id: string) => {
    manager.disposeChat(id)
    store.deleteChat(id)
    lastStatus.delete(id)
  })

  ipcMain.handle('chats:rename', (_e, id: string, title: string) => {
    const chat = store.getChat(id)
    if (!chat) return
    chat.title = title
    store.saveChat(id)
    emit({ type: 'meta', chatId: id, patch: { title } })
  })

  ipcMain.handle('chat:send', (_e, chatId: string, text: string, attachments?: Attachment[]) => {
    manager.send(chatId, text, attachments)
  })

  ipcMain.handle('chat:interrupt', (_e, chatId: string) => manager.interrupt(chatId))

  ipcMain.handle('chat:stop-background-job', (_e, chatId: string, taskId: string) =>
    manager.stopBackgroundJob(chatId, taskId)
  )

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

  ipcMain.handle('chat:rewind-files', (_e, chatId: string, userMessageId: string, dryRun: boolean) =>
    manager.rewindFiles(chatId, userMessageId, dryRun)
  )

  ipcMain.handle('session:live', (_e, chatId: string) => manager.sessionLive(chatId))
  ipcMain.handle('mcp:status', (_e, chatId: string) => manager.mcpStatus(chatId))
  ipcMain.handle('mcp:reconnect', (_e, chatId: string, name: string) =>
    manager.mcpReconnect(chatId, name)
  )
  ipcMain.handle('mcp:toggle', (_e, chatId: string, name: string, enabled: boolean) =>
    manager.mcpToggle(chatId, name, enabled)
  )

  ipcMain.handle('session:models', (_e, chatId: string) => manager.listModels(chatId))
  ipcMain.handle('session:agents', (_e, chatId: string) => manager.listAgents(chatId))
  ipcMain.handle('session:account', (_e, chatId: string) => manager.accountInfo(chatId))
  ipcMain.handle('session:usage', (_e, chatId: string) => manager.usageInfo(chatId))

  ipcMain.handle('permissions:list', (_e, cwd: string) => getPermissionRules(cwd))
  ipcMain.handle('permissions:remove', (_e, cwd: string, rule: PermissionRule) =>
    removePermissionRule(cwd, rule)
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

  ipcMain.handle('app:focus-window', () => {
    if (!win) return
    // The user asked for the window (clicked a notification) — never bounce it.
    suppressForegroundUntil = 0
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  ipcMain.handle('fs:list', (_e, dir: string) => listDir(dir))

  ipcMain.handle('fs:read', (_e, path: string) => readFileContent(path))

  ipcMain.handle('fs:stat', (_e, path: string) => statPath(path))

  ipcMain.handle('fs:search', (_e, cwd: string, query: string) => searchFiles(cwd, query))

  ipcMain.handle('terminal:create', (_e, opts: TerminalCreateOpts) => terminals.create(opts))
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, id: string) => terminals.kill(id))

  ipcMain.handle('commands:get', (_e, cwd: string, provider?: Provider) =>
    manager.getCommands(cwd, provider)
  )

  ipcMain.handle('preview:detect', (_e, cwd: string) => preview.detect(cwd))
  ipcMain.handle('preview:state', (_e, cwd: string) => preview.state(cwd))
  ipcMain.handle('preview:start', (_e, cwd: string, command?: string) => preview.start(cwd, command))
  ipcMain.handle('preview:stop', (_e, cwd: string) => preview.stop(cwd))
  ipcMain.handle('preview:logs', (_e, cwd: string) => preview.logs(cwd))
  ipcMain.handle('preview:report-console', (_e, cwd: string, line: string) =>
    preview.reportConsole(cwd, line)
  )
  // Fallback screenshot: a <webview>'s own capturePage() is flaky (it can hang
  // or throw UnknownVizError), but the guest is composited into the app window,
  // so cropping the window's capture to the pane's rect is a reliable backstop.
  ipcMain.handle(
    'preview:capture-window',
    async (_e, rect: { x: number; y: number; width: number; height: number }) => {
      if (!win) return null
      try {
        const img = await win.webContents.capturePage({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        })
        if (img.isEmpty()) return null
        const url = img.toDataURL()
        return url && url.length > 1024 ? url.replace(/^data:[^;]*;base64,/, '') : null
      } catch {
        return null
      }
    }
  )
  ipcMain.handle('preview:command-result', (_e, result: PreviewCommandResult) => {
    previewPending.get(result.id)?.(result)
    previewPending.delete(result.id)
  })

  ipcMain.handle('git:status', (_e, cwd: string) => gitOps.gitStatus(cwd))
  ipcMain.handle('git:diff', (_e, cwd: string, target: GitDiffTarget) => gitOps.gitDiff(cwd, target))
  ipcMain.handle('git:stage', (_e, cwd: string, paths: string[]) => gitOps.gitStage(cwd, paths))
  ipcMain.handle('git:unstage', (_e, cwd: string, paths: string[]) => gitOps.gitUnstage(cwd, paths))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string) => gitOps.gitCommit(cwd, message))
  ipcMain.handle('git:push', (_e, cwd: string) => gitOps.gitPush(cwd))
  ipcMain.handle('git:pull', (_e, cwd: string) => gitOps.gitPull(cwd))
  ipcMain.handle('git:fetch', (_e, cwd: string) => gitOps.gitFetch(cwd))
  ipcMain.handle('git:init', (_e, cwd: string) => gitOps.gitInit(cwd))
  ipcMain.handle('github:state', (_e, cwd: string) => githubOps.ghState(cwd))
  ipcMain.handle('github:open-pr', (_e, cwd: string) => githubOps.openPrWeb(cwd))
}

app.whenReady().then(() => {
  app.setName('Karbun')
  // Finder/Dock launches do not inherit the user's shell PATH. Hydrate it
  // before constructing managers so Claude, Codex, previews, Git, and terminal
  // sessions all see the same command-line tools as an interactive shell.
  hydrateShellPath()
  // Pin userData to the original folder so existing chat history carries over
  // after the rename (dev and packaged builds share this location).
  // AIGUI_USERDATA overrides it — used to run an isolated dev instance without
  // colliding with an installed build's store.
  app.setPath('userData', process.env.AIGUI_USERDATA || join(app.getPath('appData'), 'ai-gui'))
  store = new Store()
  preview = new PreviewManager(emitPreview, sendPreviewCommand)
  manager = new ChatManager(store, emit, preview)
  terminals = new TerminalManager(emitTerminal)
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
  terminals.disposeAll()
  preview.disposeAll()
  store.flushAll()
})

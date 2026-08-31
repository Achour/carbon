import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell
} from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Attachment,
  ChatData,
  ChatEvent,
  DockIconPalette,
  EffortId,
  GitDiffTarget,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  PermissionRule,
  PreviewCommand,
  PreviewCommandResult,
  PreviewEvent,
  PublishOpts,
  WorktreeNotice,
  Provider,
  ProviderCli,
  ProviderCliConfig,
  ChatOptionsPatch,
  ServiceTier,
  TerminalCreateOpts,
  TerminalEvent,
  WorktreeTarget,
  WorktreeDisposition,
  WorktreeInfo,
  WorktreeStatus
} from '@shared/types'
import { effortForProvider, providerForRememberedModel } from '@shared/types'
import { ChatManager } from './claude'
import { readCodexConfigModel } from './codexConfig'
import {
  createPath,
  listDir,
  renamePath,
  readFileContent,
  searchFiles,
  statFiles,
  statPath,
  writeFileContent
} from './files'
import { LspManager } from './lsp'
import * as gitOps from './git'
import * as githubOps from './github'
import { getPermissionRules, removePermissionRule } from './permissions'
import { PreviewManager } from './preview'
import { CanvasManager } from './canvas.ts'
import { Store } from './store'
import { TerminalManager } from './terminal'
import { checkForUpdate, installedViaHomebrew } from './updates'
import { readUsageOverview } from './usage'
import { readUsageReport } from './usageStats'
import { hydrateShellPath } from './shellEnv'
import { configureProviderClis, providerClis } from './providerCli.ts'
import { dockIconSvg } from './dockIcon'
import {
  checkoutWorktree,
  createWorktree,
  finishWorktree,
  handOffWorktree,
  type HandoffResult,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  resolveWorktree,
  setupCommandFor,
  worktreeStatus
} from './worktree'

const __dirname = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let store: Store
let manager: ChatManager
let terminals: TerminalManager
let preview: PreviewManager
let canvas: CanvasManager

// Native macOS vibrancy is created once in a stable active state. The renderer's
// localStorage preference controls whether the window backing reveals it.
// `resolvedDark` keeps that backing correct across appearance changes.
let translucentEnabled = false
let resolvedDark = true

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
  const title = store.getMeta(chatId)?.title?.trim() || 'Carbon'
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

/**
 * How many open editor buffers have unsaved edits. Pushed from the renderer on
 * every clean ⇄ dirty transition rather than requested at close time: `close`
 * is synchronous about whether it is vetoed, and an IPC round trip inside it
 * would have to guess.
 */
let dirtyFileCount = 0

/** True while the unsaved-changes prompt is on screen, so it cannot stack. */
let askingUnsaved = false

/**
 * Ask before throwing away unsaved editor buffers. Shared by the two exits —
 * closing the window and quitting the app — because on macOS ⌘Q is the common
 * one and a guard that only covered ⌘W would miss it.
 *
 * Two buttons rather than three on purpose: a "Save All" would need the renderer
 * to write every buffer and report back before the exit may proceed, and Cancel
 * already puts the user back where ⌘S works.
 */
async function confirmDiscardingEdits(action: string): Promise<boolean> {
  if (askingUnsaved) return false
  askingUnsaved = true
  try {
    const files = dirtyFileCount === 1 ? '1 file has' : `${dirtyFileCount} files have`
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Discard and Continue'],
      defaultId: 0,
      cancelId: 0,
      message: `${files} unsaved changes.`,
      detail: `${action} discards them. Cancel to go back and save (⌘S).`
    })
    if (response !== 1) return false
    dirtyFileCount = 0
    return true
  } finally {
    askingUnsaved = false
  }
}

function emitTerminal(ev: TerminalEvent): void {
  win?.webContents.send('terminal:event', ev)
}

// Language-server traffic. One channel for every server: the id in the payload
// is what the renderer's transports demultiplex on, and a channel per server
// would mean registering and tearing down listeners as servers come and go.
const lsp = new LspManager((id, message) => {
  win?.webContents.send('lsp:message', { id, message })
})

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
  // Create the native material once and keep its effect state active. Runtime
  // setVibrancy() can only create a followWindow material; that briefly flattens
  // to an opaque-looking slab when Chromium replaces the focused chat's layer
  // tree. CSS and the window backing decide whether the material is visible.
  const mac = process.platform === 'darwin'
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
    // Start opaque; renderer init reveals the already-stable native material
    // only when the saved translucent-sidebar preference is enabled.
    backgroundColor: '#1c1c1c',
    ...(mac
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const }
      : {}),
    title: 'Carbon',
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
  win.on('close', (event) => {
    if (win) store.setWindowBounds(win.getBounds())
    // Closing a *tab* with unsaved edits asks; closing the window used to throw
    // the same edits away without a word. The buffer is the only copy — nothing
    // on disk holds it — so this is the last moment the question can be asked.
    // Skipped during quit: `before-quit` already runs its own teardown, and
    // vetoing a close from inside it wedges the shutdown.
    if (dirtyFileCount > 0 && !readyToQuit) {
      event.preventDefault()
      void confirmDiscardingEdits('Closing the window').then((ok) => {
        if (ok) win?.close()
      })
    }
  })
  win.on('closed', () => {
    win = null
    // The renderer is gone and its buffers with it, so nothing is at risk any
    // more — leaving the count set would veto the next quit over edits that no
    // longer exist anywhere.
    dirtyFileCount = 0
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

// The window backing color for the current translucency + appearance state.
// Translucent: Cursor's glass backing (25% black for dark, transparent white
// for light) so the native "sidebar" material shows through. Opaque: solid app
// colors, so the renderer fully covers the material when glass is off.
function windowBackgroundColor(): string {
  if (translucentEnabled) return resolvedDark ? '#40000000' : '#00FFFFFF'
  return resolvedDark ? '#1c1c1c' : '#ffffff'
}

// Align native chrome and dialogs with the renderer's resolved appearance.
// keeping nativeTheme aligned also prevents the wrong material tone bleeding
// through the translucent sidebar. The backing color follows the current
// translucency state — only translucent when glass is actually on.
function applyWindowAppearance(
  mode: 'dark' | 'light' | 'system',
  dark: boolean
): void {
  if (process.platform !== 'darwin') return
  nativeTheme.themeSource = mode
  resolvedDark = dark
  win?.setBackgroundColor(windowBackgroundColor())
}

// Reveal/hide the constructor-created native material to match the renderer's
// translucency preference. Do not call setVibrancy() here: a material created at
// runtime always follows window activity and flashes solid during chat switches.
// When disabled, the opaque backing and renderer paint fully cover the material.
function setWindowTranslucent(on: boolean): void {
  if (process.platform !== 'darwin') return
  translucentEnabled = on
  win?.setBackgroundColor(windowBackgroundColor())
}

function setDockIcon(palette: DockIconPalette): void {
  if (process.platform !== 'darwin' || !app.dock) return
  console.log('[dock icon palette]', palette)
  const svg = dockIconSvg(palette)
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const icon = nativeImage.createFromDataURL(dataUrl)
  if (!icon.isEmpty()) app.dock.setIcon(icon)
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
  ipcMain.handle('canvas:list', (_e, project: string) => canvas.list(project))
  ipcMain.handle('canvas:get', (_e, id: string) => canvas.get(id))
  ipcMain.handle(
    'canvas:save',
    (
      _e,
      input: { id?: string; project: string; chatId?: string | null; title: string; html: string }
    ) => canvas.save(input)
  )
  ipcMain.handle('canvas:delete', (_e, id: string) => canvas.delete(id))

  // viewChat, not getChat: the renderer gets the loaded suffix, while every
  // main-process caller keeps the full-length array whose index is the row's seq.
  ipcMain.handle('chats:get', (_e, id: string) => store.viewChat(id))

  ipcMain.handle('chats:load-older', (_e, id: string, before: number) =>
    store.loadOlder(id, before)
  )

  ipcMain.handle(
    'chats:create',
    async (
      _e,
      opts: {
        cwd: string
        provider?: Provider
        model?: string
        effort?: EffortId
        serviceTier?: ServiceTier
        permissionMode?: PermissionModeId
        worktree?: WorktreeTarget
      }
    ) => {
    const now = Date.now()
    // The model has the last word on which backend runs it. A chat is the one
    // place the pair is frozen — everything after this reads `chat.provider` —
    // and the renderer carries the two in separate state, so this is where a
    // drifted pair has to be reconciled rather than persisted.
    const provider = providerForRememberedModel(
      opts.model,
      opts.provider,
      manager.modelCatalog()
    )
    const effort = effortForProvider(opts.effort, provider)

    // A worktree chat lives in its own directory; everything downstream
    // (providers, git/fs IPC, preview, checkpoints) is cwd-driven and needs no
    // further awareness. Failure throws — better no chat than an orphaned one.
    let cwd = opts.cwd
    let worktree: WorktreeInfo | undefined
    if (opts.worktree?.kind === 'new') {
      const created = await createWorktree(opts.cwd, opts.worktree.branch)
      cwd = created.path
      worktree = { repoRoot: created.repoRoot, branch: created.branch }
    } else if (opts.worktree?.kind === 'branch') {
      const created = await checkoutWorktree(opts.cwd, opts.worktree.branch)
      cwd = created.path
      worktree = { repoRoot: created.repoRoot, branch: created.branch }
    } else if (opts.worktree?.kind === 'existing') {
      const resolved = await resolveWorktree(opts.worktree.path)
      if (!resolved) throw new Error(`Not a git worktree: ${opts.worktree.path}`)
      cwd = opts.worktree.path
      worktree = resolved
    }

    const chat: ChatData = {
      id: randomUUID(),
      title: '',
      cwd,
      provider,
      model: opts.model || undefined,
      effort,
      serviceTier: opts.serviceTier ?? 'standard',
      permissionMode: opts.permissionMode ?? store.getDefaults().permissionMode,
      worktree,
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    store.addChat(chat)
    // Recents track the project the user picked, never the worktree we derived.
    store.rememberDir(worktree?.repoRoot ?? opts.cwd)
    store.rememberOptions({
      model: opts.model ?? '',
      modelProvider: provider,
      effort: effort ?? '',
      serviceTier: opts.serviceTier,
      permissionMode: chat.permissionMode
    })
    const { messages: _messages, ...meta } = chat
    return meta
    }
  )

  ipcMain.handle(
    'chats:delete',
    async (_e, id: string, disposition: WorktreeDisposition = 'keep'): Promise<OpResult> => {
      const chat = store.getMeta(id)
      const wt = chat?.worktree
      // Release the directory before git touches it — a live provider process
      // holding the cwd makes `git worktree remove` fail on some platforms.
      manager.disposeChat(id)

      let result: OpResult = { ok: true }
      if (wt && chat && disposition !== 'keep') {
        // Another chat may be working in the same worktree (the "new chat in
        // this worktree" path); removing it would pull the rug out from under it.
        if (!store.hasOtherChatIn(chat.cwd, id)) {
          result = await removeWorktree(wt.repoRoot, chat.cwd, wt.branch, disposition === 'force')
        }
      }

      // Shells opened by this chat go with it. Their cwd may be the worktree
      // just removed above, and the tab is about to disappear from the UI — a
      // survivor (typically a dev server) would run on with nothing to stop it.
      terminals.killForChat(id)

      // The chat record goes regardless — a failed cleanup leaves the worktree
      // on disk, which is recoverable; a stuck chat row is not.
      store.deleteChat(id)
      lastStatus.delete(id)
      return result
    }
  )

  ipcMain.handle('worktree:status', async (_e, chatId: string): Promise<WorktreeStatus | null> => {
    const chat = store.getMeta(chatId)
    if (!chat?.worktree) return null
    return worktreeStatus(chat.cwd, chat.worktree.branch)
  })

  ipcMain.handle('worktree:list', (_e, cwd: string) => listWorktrees(cwd))

  // The three ways a chat leaves its worktree (hand-off, merge, finish) share
  // every guard: no other chat may be living in the directory, and the provider
  // process must release the cwd before git touches it — a live process holding
  // it makes `git worktree remove` fail on some platforms. A refused operation
  // still disposed the session; the next send simply resumes it.
  const worktreeExits: [string, (path: string, info: WorktreeInfo) => Promise<HandoffResult>, string][] = [
    ['worktree:handoff', handOffWorktree, 'Hand-off failed.'],
    ['worktree:merge', mergeWorktree, 'Merge failed.'],
    ['worktree:finish', finishWorktree, 'Removal failed.']
  ]
  for (const [channel, run, fallback] of worktreeExits) {
    ipcMain.handle(channel, async (_e, chatId: string): Promise<OpResult> => {
      const chat = store.getMeta(chatId)
      if (!chat?.worktree) return { ok: false, error: 'This chat is not running in a worktree.' }
      if (store.hasOtherChatIn(chat.cwd, chatId)) {
        return { ok: false, error: 'Another chat is working in this worktree.' }
      }
      manager.disposeChat(chatId)

      const res = await run(chat.cwd, chat.worktree)
      // `cwd` is set whenever the worktree is gone — even on a failure like a
      // surviving branch, the chat must move or it points at a deleted directory.
      if (res.cwd) manager.relocateChat(chatId, res.cwd)
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? fallback }
    })
  }

  ipcMain.handle('worktree:remove', async (_e, path: string): Promise<OpResult> => {
    // Removing a directory a chat is living in would strand it, and the chat's
    // own delete flow is the supported way to do that.
    if (store.hasOtherChatIn(path)) {
      return { ok: false, error: 'A chat is still working in this worktree.' }
    }
    const info = await resolveWorktree(path)
    if (!info) return { ok: false, error: 'Not a git worktree.' }
    return removeWorktree(info.repoRoot, path, info.branch, false)
  })

  ipcMain.handle('worktree:notice', async (_e, chatId: string): Promise<WorktreeNotice> => {
    const chat = store.getMeta(chatId)
    if (!chat?.worktree) return { setupCommand: null, emptyBase: false }
    // `emptyBase` is asked of the *repo*, not the worktree: the worktree is
    // empty either way, and what makes that worth saying is the project folder
    // having files the checkout could not bring along.
    const [emptyTree, dirty] = await Promise.all([
      gitOps.hasEmptyTree(chat.worktree.repoRoot),
      gitOps.dirtyFileCount(chat.worktree.repoRoot).catch(() => 0)
    ])
    return {
      setupCommand: setupCommandFor(chat.worktree.repoRoot, chat.cwd),
      emptyBase: emptyTree && dirty > 0
    }
  })

  ipcMain.handle('chats:rename', (_e, id: string, title: string) => {
    const chat = store.getChat(id)
    if (!chat) return
    chat.title = title
    // A manual rename pins the title — the auto-generator must never overwrite it.
    chat.titleManual = true
    store.saveChat(id)
    emit({ type: 'meta', chatId: id, patch: { title, titleManual: true } })
  })

  ipcMain.handle('chats:set-pinned', (_e, id: string, pinned: boolean) => {
    const chat = store.getChat(id)
    if (!chat) return
    if (pinned) chat.pinnedAt = Date.now()
    else delete chat.pinnedAt
    store.saveChat(id)
    emit({ type: 'meta', chatId: id, patch: { pinnedAt: chat.pinnedAt } })
  })

  ipcMain.handle(
    'chat:send',
    (_e, chatId: string, text: string, attachments?: Attachment[], label?: string) => {
      manager.send(chatId, text, attachments, label)
    }
  )

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
    (_e, chatId: string, patch: ChatOptionsPatch) => manager.setOptions(chatId, patch)
  )

  ipcMain.handle('chat:edit-message', (_e, chatId: string, messageId: string, text: string) =>
    manager.editMessage(chatId, messageId, text)
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

  ipcMain.handle('session:models', (_e, chatId: string, cwd?: string) =>
    manager.listModels(chatId, cwd)
  )
  ipcMain.handle('codex:config-model', () => readCodexConfigModel())
  ipcMain.handle('session:agents', (_e, chatId: string) => manager.listAgents(chatId))
  ipcMain.handle('session:account', (_e, chatId: string) => manager.accountInfo(chatId))
  ipcMain.handle('session:usage', (_e, chatId: string) => manager.usageInfo(chatId))
  // Account-level, so it deliberately takes no chat id — and runs from home so
  // no project's settings or hooks sit in the path of a plan-limit read.
  ipcMain.handle('usage:overview', (_e, refresh?: boolean) =>
    readUsageOverview(app.getPath('home'), refresh)
  )
  // History, not headroom: read off the CLIs' own session logs, so it covers
  // turns run outside Carbon and needs no chat either.
  ipcMain.handle('usage:report', (_e, days: number, refresh?: boolean) =>
    readUsageReport(
      { home: app.getPath('home'), cacheDir: app.getPath('userData') },
      days,
      refresh
    )
  )

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
  ipcMain.handle('providers:list', (_e, refresh?: boolean) => providerClis(refresh))
  ipcMain.handle(
    'providers:set',
    (_e, provider: Provider, patch: ProviderCliConfig): Promise<ProviderCli[]> => {
      store.setProviderCli(provider, patch)
      // Re-injecting the whole record clears the resolution cache, so the list
      // returned here already reflects a path the user just pinned.
      configureProviderClis(store.getProviderClis())
      return providerClis(true)
    }
  )

  ipcMain.handle('app:forget-dir', (_e, dir: string) => store.forgetDir(dir))

  ipcMain.handle('app:reveal-path', (_e, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('app:open-external', (_e, url: string) => {
    // Same guard as the window's own navigation handler: only ever hand the OS
    // an http(s) URL, never a file:// or custom scheme from renderer data.
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
  })

  ipcMain.handle('app:check-update', () => checkForUpdate())

  // Sync on purpose — the preload bridge reads it while building `window.api`,
  // and registerIpc() runs before createWindow(), so the channel always exists.
  ipcMain.on('app:version', (e) => {
    e.returnValue = app.getVersion()
  })

  // Same reasoning as `app:version`, and the answer is likewise fixed for the
  // life of the process — nobody re-installs Carbon while it's running.
  ipcMain.on('app:installed-via-homebrew', (e) => {
    e.returnValue = installedViaHomebrew()
  })

  ipcMain.handle(
    'window:set-appearance',
    (_e, mode: 'dark' | 'light' | 'system', dark: boolean) => applyWindowAppearance(mode, dark)
  )

  ipcMain.handle('window:set-translucent', (_e, on: boolean) => setWindowTranslucent(on))

  ipcMain.handle('window:set-dock-icon', (_e, palette: DockIconPalette) => setDockIcon(palette))

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
  ipcMain.handle('fs:write', (_e, path: string, content: string, expectedMtimeMs: number | null) =>
    writeFileContent(path, content, expectedMtimeMs)
  )
  ipcMain.handle('fs:stat-many', (_e, paths: string[]) => statFiles(paths))
  ipcMain.handle('fs:create', (_e, parent: string, name: string, kind: 'file' | 'dir') =>
    createPath(parent, name, kind)
  )
  // `shell.trashItem` rather than `rm`: a delete from the file tree should be
  // recoverable from the Finder, the way it is in every other editor. It also
  // means the confirm dialog can honestly say the work is not gone.
  ipcMain.handle('fs:rename', (_e, path: string, name: string) => renamePath(path, name))
  ipcMain.handle('fs:delete', async (_e, path: string) => {
    try {
      await shell.trashItem(path)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.on('editor:dirty-count', (_e, count: number) => {
    dirtyFileCount = count
  })

  ipcMain.handle('lsp:ensure', (_e, root: string, languageId: string) => lsp.ensure(root, languageId))
  ipcMain.handle('lsp:send', (_e, id: string, message: string) => lsp.send(id, message))
  ipcMain.handle('lsp:release', (_e, id: string) => lsp.release(id))

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
  ipcMain.handle('git:merge-into-default', (_e, cwd: string) => gitOps.gitMergeIntoDefault(cwd))
  ipcMain.handle('git:fetch', (_e, cwd: string) => gitOps.gitFetch(cwd))
  ipcMain.handle('git:branches', (_e, cwds: string[]) => gitOps.branchesAt(cwds))
  ipcMain.handle('git:local-branches', (_e, cwd: string) => gitOps.localBranches(cwd))
  ipcMain.handle('git:branch-changes', (_e, cwd: string, baseBranch?: string) =>
    gitOps.gitBranchChanges(cwd, baseBranch)
  )
  ipcMain.handle('git:init', (_e, cwd: string) => gitOps.gitInit(cwd))
  ipcMain.handle('github:state', (_e, cwd: string) => githubOps.ghState(cwd))
  ipcMain.handle('github:open-pr', (_e, cwd: string) => githubOps.openPrWeb(cwd))
  ipcMain.handle('github:publish-info', (_e, cwd: string) => githubOps.ghPublishInfo(cwd))
  ipcMain.handle('github:publish', (_e, cwd: string, opts: PublishOpts) =>
    githubOps.publishRepo(cwd, opts)
  )
}

app.whenReady().then(() => {
  app.setName('Carbon')
  // Pin userData to the original folder so existing chat history carries over
  // after the rename (dev and packaged builds share this location).
  // AIGUI_USERDATA overrides it — used to run an isolated dev instance without
  // colliding with an installed build's store.
  //
  // Ahead of the PATH hydration below, which now remembers its answer there.
  // `setPath` only records a location — nothing reads userData in between.
  app.setPath('userData', process.env.AIGUI_USERDATA || join(app.getPath('appData'), 'ai-gui'))
  // Finder/Dock launches do not inherit the user's shell PATH. Hydrate it
  // before constructing managers so Claude, Codex, previews, Git, and terminal
  // sessions all see the same command-line tools as an interactive shell.
  //
  // Answered from the previous launch's cache so the window is not held behind
  // an interactive shell startup; the background re-read calls back here only
  // when the PATH actually moved, and the one thing that caches against it is
  // provider-binary resolution.
  hydrateShellPath(app.getPath('userData'), () => {
    configureProviderClis(store.getProviderClis())
  })
  store = new Store(app.getPath('userData'), {
    // Surfaced rather than silently dropped: the user's turn is still in
    // memory and on screen, it just cannot be written while the other
    // instance owns the chat.
    onLockDenied: (chatId) => emit({ type: 'chat-locked', chatId })
  })
  // Provider CLI settings before any manager: session construction, the model
  // catalog and the usage probes all resolve a binary through this, and a
  // resolution that ran against an empty config would cache the wrong answer
  // for a provider the user has switched off or pointed elsewhere.
  configureProviderClis(store.getProviderClis())
  // Constructed before the preview because the preview's loopback bridge serves
  // both tool namespaces and takes this as its second host. The bridge thunk is
  // what breaks the cycle: it is not called until an MCP config is built, long
  // after both objects exist.
  canvas = new CanvasManager(store.canvases, emit, () => preview.bridge())
  preview = new PreviewManager(emitPreview, sendPreviewCommand, canvas)
  manager = new ChatManager(store, emit, preview, canvas)
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

let readyToQuit = false
let quitting: Promise<void> | null = null
app.on('before-quit', (event) => {
  if (readyToQuit) return
  event.preventDefault()
  if (quitting) return
  // ⌘Q is the ordinary way to leave a Mac app, so it has to ask the same
  // question ⌘W does — otherwise the guard covers the rarer exit and the common
  // one silently discards the buffers. Confirming clears the count and quits
  // again, arriving back here with nothing left to ask about.
  if (dirtyFileCount > 0) {
    void confirmDiscardingEdits('Quitting').then((ok) => {
      if (ok) app.quit()
    })
    return
  }
  manager.disposeAll()
  terminals.disposeAll()
  preview.disposeAll()
  lsp.disposeAll()
  quitting = store.flushAll().finally(() => {
    readyToQuit = true
    app.quit()
  })
})

import { BrowserWindow, ipcMain, screen } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuddyState, ChatStatus } from '@shared/types'
import type { Store } from './store'

/**
 * Settings → Chats → "Desktop buddy": a small bear in its own transparent
 * window, floating over every app and Space, that reacts to your chats. See
 * `docs/buddy.md` for why it is built this way.
 *
 * The mood is computed here, from the same `emit` chokepoint `keepAwake.ts`
 * reads, and the window is sent one small `BuddyState` when it changes. The
 * buddy's page never subscribes to `chat:event`: a second renderer parsing
 * every streamed delta to decide whether a bear looks busy is the wrong price.
 */

const WIDTH = 220
const HEIGHT = 236
/** Gap from the work area's right edge for the default spot. */
const MARGIN = 24
const DONE_MS = 8_000
const BACK_MS = 6_000
/** Idle this long and the bear naps until something happens. */
const NAP_MS = 5 * 60_000

interface Deps {
  store: Store
  /** Brings Carbon forward on this chat, creating the window if it was closed. */
  openChat(chatId: string): void
  /** Brings Carbon forward, creating the window if it was closed. */
  focusApp(): void
}

export class Buddy {
  private win: BrowserWindow | null = null
  private enabled = false
  private readonly status = new Map<string, ChatStatus>()
  /** The chat that just finished, until its cheer runs out. */
  private done: { chatId: string; until: number } | null = null
  private backUntil = 0
  /** Chats that finished while the screen was locked, for the greeting. */
  private finishedAway = 0
  /** `finishedAway` as of the last unlock, for the greeting showing now. */
  private greeting = 0
  private locked = false
  private idleSince = Date.now()
  private timer: ReturnType<typeof setTimeout> | null = null
  private sent = ''
  /** Dev only (`AIGUI_BUDDY`): a pinned state that outranks the real one. */
  private pinned: BuddyState | null = null

  constructor(private readonly deps: Deps) {
    ipcMain.on('buddy:ready', () => {
      this.sent = ''
      this.sync()
    })
    ipcMain.on('buddy:click', () => {
      const chatId = this.target()
      if (chatId) {
        // Opening the chat is the acknowledgement: the cheer has done its job.
        if (this.done?.chatId === chatId) this.done = null
        this.deps.openChat(chatId)
      } else this.deps.focusApp()
      this.sync()
    })
    ipcMain.on('buddy:drag', (_e, dx: number, dy: number, end: boolean) => {
      if (!this.win) return
      const [x, y] = this.win.getPosition()
      this.win.setPosition(Math.round(x + dx), Math.round(y + dy))
      if (end) {
        const [nx, ny] = this.win.getPosition()
        this.deps.store.setBuddyPosition({ x: nx, y: ny })
      }
    })
    ipcMain.on('buddy:pass-through', (_e, on: boolean) => {
      this.win?.setIgnoreMouseEvents(on, { forward: true })
    })
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) this.open()
    else this.close()
  }

  /** Fed every `status` event, beside `keepAwake`'s `noteStatus`. */
  noteStatus(chatId: string, status: ChatStatus): void {
    const prev = this.status.get(chatId)
    this.status.set(chatId, status)
    const meta = this.deps.store.getMeta(chatId)
    // The same exclusions `notifyOnStatus` makes, so the bear and the
    // notification never disagree about one event: an ephemeral chat with no
    // thread has nothing to open, and a scheduled run's ending has its own
    // notice that says how it went.
    if (meta?.ephemeral && !meta.sideOf) {
      this.status.delete(chatId)
      return
    }
    if (prev && prev !== 'idle' && status === 'idle' && meta?.scheduled?.status !== 'running') {
      this.done = { chatId, until: Date.now() + DONE_MS }
      if (this.locked) this.finishedAway++
    }
    this.sync()
  }

  /** The chat was deleted or its session disposed; neither emits a last status. */
  forget(chatId: string): void {
    this.status.delete(chatId)
    if (this.done?.chatId === chatId) this.done = null
    this.sync()
  }

  /** `powerMonitor`'s `lock-screen`. */
  noteLocked(): void {
    this.locked = true
    this.finishedAway = 0
  }

  /** `powerMonitor`'s `unlock-screen` (and `resume`, which may skip a lock). */
  noteBack(): void {
    if (!this.locked && this.backUntil > Date.now()) return
    this.locked = false
    this.backUntil = Date.now() + BACK_MS
    // The greeting owns the count: a later resume with no lock between must
    // not repeat it.
    this.greeting = this.finishedAway
    this.finishedAway = 0
    this.sync()
  }

  /** Dev only: pin a state, for capturing each mood without a live turn. */
  pin(state: BuddyState | null): void {
    this.pinned = state
    this.sent = ''
    this.sync()
  }

  /** Dev only: the buddy window, so `AIGUI_BUDDY_CAPTURE` can shoot it. */
  capture(path: string): void {
    void this.win?.webContents.capturePage().then((img) => writeFileSync(path, img.toPNG()))
  }

  dispose(): void {
    this.close()
    if (this.timer) clearTimeout(this.timer)
  }

  private chats(status: ChatStatus | ChatStatus[]): string[] {
    const want = Array.isArray(status) ? status : [status]
    return [...this.status].filter(([, s]) => want.includes(s)).map(([id]) => id)
  }

  /** What a click opens: whoever needs you, else what just finished, else the one at work. */
  private target(): string | null {
    const working = this.chats(['starting', 'streaming'])
    return (
      this.chats('waiting-permission')[0] ??
      (this.done && this.done.until > Date.now() ? this.done.chatId : null) ??
      (working.length === 1 ? working[0] : null)
    )
  }

  private title(chatId: string): string {
    return this.deps.store.getMeta(chatId)?.title?.trim() || 'New chat'
  }

  private compute(): BuddyState {
    const now = Date.now()
    if (this.done && this.done.until <= now) this.done = null
    const needs = this.chats('waiting-permission')
    const working = this.chats(['starting', 'streaming'])
    const hasChat = this.target() !== null
    let state: BuddyState
    if (needs.length)
      state = {
        mood: 'needs',
        text: needs.length === 1 ? `Needs you · ${this.title(needs[0])}` : `${needs.length} chats need you`
      }
    else if (this.backUntil > now)
      state = {
        mood: 'back',
        text:
          this.greeting === 1
            ? "You're back! A chat finished"
            : this.greeting > 1
              ? `You're back! ${this.greeting} chats finished`
              : "You're back!"
      }
    else if (this.done) state = { mood: 'done', text: `Done! · ${this.title(this.done.chatId)}` }
    else if (working.length)
      state = {
        mood: 'working',
        text: working.length === 1 ? this.title(working[0]) : `Working on ${working.length} chats`
      }
    else state = { mood: now - this.idleSince >= NAP_MS ? 'sleep' : 'idle' }
    return { ...state, hasChat }
  }

  private sync(): void {
    if (!this.enabled) return
    const state = this.pinned ?? this.compute()
    if (state.mood !== 'idle' && state.mood !== 'sleep') this.idleSince = Date.now()
    // One timer for whichever deadline is next: a cheer or greeting running
    // out, or the nap. Re-armed on every change, so it never fires stale.
    if (this.timer) clearTimeout(this.timer)
    const now = Date.now()
    const deadlines = [this.done?.until, this.backUntil > now ? this.backUntil : undefined]
    if (state.mood === 'idle') deadlines.push(this.idleSince + NAP_MS)
    const next = Math.min(...deadlines.filter((d): d is number => d !== undefined))
    this.timer = Number.isFinite(next)
      ? setTimeout(() => this.sync(), Math.max(50, next - now + 20))
      : null
    const json = JSON.stringify(state)
    if (json === this.sent || !this.win) return
    this.sent = json
    this.win.webContents.send('buddy:state', state)
  }

  private position(): { x: number; y: number } {
    const saved = this.deps.store.getBuddyPosition()
    if (saved) {
      // A monitor unplugged since would strand it offscreen: keep the saved
      // spot only while most of the window still lands on a display.
      const rect = { ...saved, width: WIDTH, height: HEIGHT }
      const area = screen.getDisplayMatching(rect).workArea
      const overlapX = Math.min(rect.x + WIDTH, area.x + area.width) - Math.max(rect.x, area.x)
      const overlapY = Math.min(rect.y + HEIGHT, area.y + area.height) - Math.max(rect.y, area.y)
      if (overlapX > WIDTH / 2 && overlapY > HEIGHT / 2) return saved
    }
    const area = screen.getPrimaryDisplay().workArea
    return { x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - HEIGHT }
  }

  private open(): void {
    if (this.win) return
    const { x, y } = this.position()
    const mac = process.platform === 'darwin'
    const win = new BrowserWindow({
      x,
      y,
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Never takes focus: clicking the bear must not pull you out of the app
      // you are in. A panel is a non-activating window that still gets the
      // first click, and stays out of ⌘-Tab and Mission Control.
      focusable: false,
      acceptFirstMouse: true,
      ...(mac ? { type: 'panel' as const } : {}),
      title: 'Carbon buddy',
      webPreferences: {
        preload: join(__dirname, '../preload/buddy.mjs'),
        contextIsolation: true,
        sandbox: false
      }
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Transparent margins pass clicks to whatever is underneath until the
    // pointer is over the bear or its bubble; the page flips it back.
    win.setIgnoreMouseEvents(true, { forward: true })
    win.once('ready-to-show', () => win.showInactive())
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/buddy.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/buddy.html'))
    }
    this.win = win
    this.sent = ''
  }

  private close(): void {
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }
}

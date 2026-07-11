import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppDefaults, ChatData, ChatMeta } from '@shared/types'

interface SettingsFile {
  defaults: AppDefaults
  windowBounds?: { x?: number; y?: number; width: number; height: number }
}

const DEFAULT_SETTINGS: SettingsFile = {
  defaults: { permissionMode: 'default', recentDirs: [] }
}

export class Store {
  private chatsDir: string
  private settingsPath: string
  private chats = new Map<string, ChatData>()
  private settings: SettingsFile
  private saveTimers = new Map<string, NodeJS.Timeout>()

  constructor() {
    const userData = app.getPath('userData')
    this.chatsDir = join(userData, 'chats')
    this.settingsPath = join(userData, 'settings.json')
    mkdirSync(this.chatsDir, { recursive: true })
    this.settings = this.readSettings()
    this.loadChats()
  }

  private readSettings(): SettingsFile {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<SettingsFile>
        return {
          ...DEFAULT_SETTINGS,
          ...raw,
          defaults: { ...DEFAULT_SETTINGS.defaults, ...raw.defaults }
        }
      }
    } catch (err) {
      console.error('Failed to read settings:', err)
    }
    return structuredClone(DEFAULT_SETTINGS)
  }

  private writeSettings(): void {
    try {
      writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2))
    } catch (err) {
      console.error('Failed to write settings:', err)
    }
  }

  private loadChats(): void {
    for (const file of readdirSync(this.chatsDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(join(this.chatsDir, file), 'utf8')) as ChatData
        if (data?.id) this.chats.set(data.id, data)
      } catch (err) {
        console.error(`Failed to load chat ${file}:`, err)
      }
    }
  }

  listChats(): ChatMeta[] {
    return [...this.chats.values()]
      .map(({ messages: _messages, ...meta }) => meta)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getChat(id: string): ChatData | null {
    return this.chats.get(id) ?? null
  }

  addChat(chat: ChatData): void {
    this.chats.set(chat.id, chat)
    this.saveChat(chat.id)
  }

  deleteChat(id: string): void {
    this.chats.delete(id)
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    try {
      rmSync(join(this.chatsDir, `${id}.json`), { force: true })
    } catch (err) {
      console.error('Failed to delete chat file:', err)
    }
  }

  saveChat(id: string): void {
    const chat = this.chats.get(id)
    if (!chat) return
    try {
      writeFileSync(join(this.chatsDir, `${id}.json`), JSON.stringify(chat))
    } catch (err) {
      console.error('Failed to save chat:', err)
    }
  }

  /** Debounced save for high-frequency streaming updates. */
  saveChatSoon(id: string): void {
    if (this.saveTimers.has(id)) return
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id)
        this.saveChat(id)
      }, 800)
    )
  }

  flushAll(): void {
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer)
      this.saveChat(id)
    }
    this.saveTimers.clear()
  }

  getDefaults(): AppDefaults {
    return this.settings.defaults
  }

  rememberDir(dir: string): void {
    const dirs = this.settings.defaults.recentDirs.filter((d) => d !== dir)
    dirs.unshift(dir)
    this.settings.defaults.recentDirs = dirs.slice(0, 8)
    this.writeSettings()
  }

  getWindowBounds(): SettingsFile['windowBounds'] {
    return this.settings.windowBounds
  }

  setWindowBounds(bounds: NonNullable<SettingsFile['windowBounds']>): void {
    this.settings.windowBounds = bounds
    this.writeSettings()
  }
}

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import {
  rename as renameAsync,
  rm as rmAsync,
  writeFile as writeFileAsync
} from 'node:fs/promises'
import { join } from 'node:path'
import type { AppDefaults, ChatData, ChatMeta, EffortId, PermissionModeId } from '@shared/types'

/**
 * Write via a temp file + atomic rename so a crash or force-quit mid-write can't
 * leave a half-written (and thus unparseable) JSON file — a bare writeFileSync
 * truncates first, and streaming updates hammer these paths constantly.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

async function writeFileAtomicAsync(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFileAsync(tmp, data)
  await renameAsync(tmp, path)
}

interface SettingsFile {
  defaults: AppDefaults
  windowBounds?: { x?: number; y?: number; width: number; height: number }
}

const DEFAULT_SETTINGS: SettingsFile = {
  defaults: { permissionMode: 'default', recentDirs: [] }
}

function settleOrphanedTools(chat: ChatData): boolean {
  let changed = false
  const settle = (parts: unknown): void => {
    if (!Array.isArray(parts)) return
    for (const raw of parts) {
      if (!raw || typeof raw !== 'object') continue
      const part = raw as {
        type?: string
        status?: string
        children?: unknown[]
      }
      if (part.type === 'tool' && (part.status === 'running' || part.status === 'pending')) {
        part.status = 'error'
        changed = true
      }
      if (part.children) settle(part.children)
    }
  }
  for (const message of chat.messages) {
    if (message.role === 'assistant') settle(message.parts)
  }
  return changed
}

export class Store {
  private chatsDir: string
  private settingsPath: string
  private chats = new Map<string, ChatData>()
  private settings: SettingsFile
  private saveTimers = new Map<string, NodeJS.Timeout>()
  private firstDirtyAt = new Map<string, number>()
  private requestedWrites = new Map<string, number>()
  private chatWrites = new Map<string, Promise<void>>()

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
      writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    } catch (err) {
      console.error('Failed to write settings:', err)
    }
  }

  private loadChats(): void {
    for (const file of readdirSync(this.chatsDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(join(this.chatsDir, file), 'utf8')) as ChatData
        if (data?.id) {
          this.chats.set(data.id, data)
          // No provider process survives an application restart. Repair stale
          // persisted running states so reopened histories cannot animate forever.
          if (settleOrphanedTools(data)) this.saveChatSoon(data.id)
        }
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

  /**
   * Is any chat other than `exceptId` working in `cwd`? Used before removing a
   * worktree, so a directory another chat still occupies is left alone.
   */
  hasOtherChatIn(cwd: string, exceptId: string): boolean {
    for (const c of this.chats.values()) if (c.id !== exceptId && c.cwd === cwd) return true
    return false
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
    this.firstDirtyAt.delete(id)
    this.requestedWrites.delete(id)
    // An already-running atomic write may still rename its temp file. Remove
    // only after it settles so deletion cannot be undone by that late rename.
    const pending = this.chatWrites.get(id) ?? Promise.resolve()
    void pending
      .catch(() => undefined)
      .then(() => rmAsync(join(this.chatsDir, `${id}.json`), { force: true }))
      .catch((err) => console.error('Failed to delete chat file:', err))
  }

  saveChat(id: string): void {
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    this.firstDirtyAt.delete(id)
    this.requestChatWrite(id)
  }

  /**
   * Serialize writes per chat and collapse updates that arrive while disk I/O is
   * in progress. JSON creation is yielded to a later event-loop turn, while the
   * actual file write/rename is fully asynchronous.
   */
  private requestChatWrite(id: string): void {
    if (!this.chats.has(id)) return
    this.requestedWrites.set(id, (this.requestedWrites.get(id) ?? 0) + 1)
    if (this.chatWrites.has(id)) return
    const write = this.drainChatWrites(id)
    this.chatWrites.set(id, write)
    void write.finally(() => {
      if (this.chatWrites.get(id) !== write) return
      this.chatWrites.delete(id)
      if (this.chats.has(id) && (this.requestedWrites.get(id) ?? 0) > 0) {
        this.requestChatWrite(id)
      }
    })
  }

  private async drainChatWrites(id: string): Promise<void> {
    while (this.chats.has(id)) {
      const requested = this.requestedWrites.get(id) ?? 0
      this.requestedWrites.set(id, 0)
      await new Promise<void>((resolve) => setImmediate(resolve))
      const chat = this.chats.get(id)
      if (!chat) return
      try {
        const data = JSON.stringify(chat)
        await writeFileAtomicAsync(join(this.chatsDir, `${id}.json`), data)
      } catch (err) {
        console.error('Failed to save chat:', err)
      }
      // Nothing arrived while serializing/writing, so this snapshot is current.
      if ((this.requestedWrites.get(id) ?? 0) === 0) return
      // Preserve the fact that at least one write was requested even if callers
      // happened to enqueue it before this loop read the counter.
      if (requested === 0) this.requestedWrites.set(id, 1)
    }
  }

  /**
   * Trailing debounce for streaming updates, with a five-second maximum delay
   * so a long-running turn still gets periodic crash-recovery snapshots.
   */
  saveChatSoon(id: string): void {
    const existing = this.saveTimers.get(id)
    if (existing) clearTimeout(existing)
    const now = Date.now()
    const first = this.firstDirtyAt.get(id) ?? now
    this.firstDirtyAt.set(id, first)
    const delay = Math.min(1500, Math.max(0, 5000 - (now - first)))
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id)
        this.firstDirtyAt.delete(id)
        this.saveChat(id)
      }, delay)
    )
  }

  async flushAll(): Promise<void> {
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer)
      this.requestChatWrite(id)
    }
    this.saveTimers.clear()
    this.firstDirtyAt.clear()
    for (const id of this.chats.keys()) this.requestChatWrite(id)
    while (this.chatWrites.size > 0) {
      await Promise.allSettled([...this.chatWrites.values()])
    }
  }

  getDefaults(): AppDefaults {
    return this.settings.defaults
  }

  /** Remember the user's last chosen options as the defaults for new chats. */
  rememberOptions(patch: {
    model?: string
    effort?: EffortId | ''
    permissionMode?: PermissionModeId
  }): void {
    const defaults = this.settings.defaults
    if (patch.permissionMode !== undefined) defaults.permissionMode = patch.permissionMode
    if (patch.model !== undefined) defaults.model = patch.model || undefined
    if (patch.effort !== undefined) defaults.effort = patch.effort || undefined
    this.writeSettings()
  }

  rememberDir(dir: string): void {
    const dirs = this.settings.defaults.recentDirs.filter((d) => d !== dir)
    dirs.unshift(dir)
    this.settings.defaults.recentDirs = dirs.slice(0, 8)
    this.writeSettings()
  }

  forgetDir(dir: string): void {
    this.settings.defaults.recentDirs = this.settings.defaults.recentDirs.filter((d) => d !== dir)
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

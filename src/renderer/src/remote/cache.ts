import type { ChatMessage, RemoteSnapshot } from '@shared/types'

/**
 * What the phone last saw, kept in its own storage so a launch draws at once:
 * the chat list and the last few transcripts opened, shown while "Connecting…"
 * says they are not live yet, then replaced by the Mac's answer. Live state —
 * which chats are working, what is waiting on an answer — is left out, so a
 * stale spinner or an approval already given can never be drawn. Per phone and
 * best-effort: a private window or a full quota just means a cold launch.
 */

const SNAPSHOT = 'carbon.remote.cache.snapshot'
const CHAT = 'carbon.remote.cache.chat:'
const RECENT = 'carbon.remote.cache.recent'
/** Transcripts kept, most recently opened first. */
const KEEP_CHATS = 4
/** The tail of a transcript kept: what the screen shows on opening, and some above. */
const KEEP_MESSAGES = 40
/** A transcript bigger than this (tool output, images) is not worth the quota. */
const MAX_CHAT_BYTES = 600_000

export type CachedSnapshot = Omit<RemoteSnapshot, 'statuses' | 'permissions'> & {
  icons?: Record<string, string | null>
}

export interface CachedChat {
  messages: ChatMessage[]
  hiddenBefore: number
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or a private window: the next launch is a cold one, nothing worse.
  }
}

export function loadSnapshot(): CachedSnapshot | null {
  return read<CachedSnapshot>(SNAPSHOT)
}

export function saveSnapshot(snap: CachedSnapshot): void {
  write(SNAPSHOT, snap)
}

export function loadChat(id: string): CachedChat | null {
  return read<CachedChat>(CHAT + id)
}

export function saveChat(id: string, messages: ChatMessage[], hiddenBefore: number): void {
  const drop = Math.max(0, messages.length - KEEP_MESSAGES)
  const entry: CachedChat = { messages: messages.slice(drop), hiddenBefore: hiddenBefore + drop }
  const json = JSON.stringify(entry)
  if (json.length > MAX_CHAT_BYTES) return
  try {
    localStorage.setItem(CHAT + id, json)
  } catch {
    return
  }
  const recent = [id, ...(read<string[]>(RECENT) ?? []).filter((x) => x !== id)]
  for (const old of recent.slice(KEEP_CHATS)) {
    try {
      localStorage.removeItem(CHAT + old)
    } catch {
      // Gone already, or storage unavailable.
    }
  }
  write(RECENT, recent.slice(0, KEEP_CHATS))
}

/** Unpairing or a revoked cookie: what was cached belongs to that pairing. */
export function clearCache(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('carbon.remote.cache.')) localStorage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

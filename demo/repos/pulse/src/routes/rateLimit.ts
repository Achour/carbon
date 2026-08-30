import type { IncomingMessage } from 'node:http'

interface Window {
  count: number
  resetsAt: number
}

const WINDOW_MS = 60_000
const DEFAULT_LIMIT = 1_000
const windows = new Map<string, Window>()

export async function rateLimit(
  req: IncomingMessage
): Promise<{ retryAfter: number } | null> {
  const key = req.headers['x-project-id']
  if (typeof key !== 'string') return null

  const now = Date.now()
  const existing = windows.get(key)
  if (!existing || existing.resetsAt <= now) {
    windows.set(key, { count: 1, resetsAt: now + WINDOW_MS })
    return null
  }

  existing.count += 1
  if (existing.count <= DEFAULT_LIMIT) return null
  return { retryAfter: Math.ceil((existing.resetsAt - now) / 1000) }
}

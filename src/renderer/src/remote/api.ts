import type { ChatEvent, RemoteSnapshot } from '@shared/types'

/**
 * The phone's half of the wire (`main/remoteAccess.ts` is the other).
 *
 * Calls are `POST /api/invoke` naming the same channel the desktop's preload
 * would `ipcRenderer.invoke`, so the arguments are exactly the `Api` method's.
 * Events are one `EventSource`, which reconnects on its own — each reconnect
 * is a new connection id, and the `hello` that names it is the cue to resync.
 */

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function post<T>(path: string, body: unknown, keepalive = false): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive,
    headers: { 'content-type': 'application/json', 'x-carbon-remote': '1' },
    body: JSON.stringify(body)
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new RemoteError(data.error ?? `Request failed (${res.status})`, res.status)
  return data
}

export async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // Trailing `undefined`s would serialize as `null`; leave them out instead.
  while (args.length && args[args.length - 1] === undefined) args.pop()
  const data = await post<{ result: T }>('/api/invoke', { channel, args })
  return data.result
}

export async function pair(code: string, name: string): Promise<void> {
  await post('/api/pair', { code, name })
}

/** True when this browser holds a working device cookie. */
export async function paired(): Promise<boolean> {
  const res = await fetch('/api/session', { credentials: 'same-origin' })
  if (res.status === 401) return false
  if (!res.ok) throw new RemoteError(`Carbon answered ${res.status}`, res.status)
  return true
}

export async function snapshot(): Promise<RemoteSnapshot> {
  const res = await fetch('/api/snapshot', { credentials: 'same-origin' })
  if (!res.ok) throw new RemoteError(`Carbon answered ${res.status}`, res.status)
  return (await res.json()) as RemoteSnapshot
}

/** Each project's mark, keyed by project root; null where it has none. */
export async function icons(): Promise<Record<string, string | null>> {
  const res = await fetch('/api/icons', { credentials: 'same-origin' })
  if (!res.ok) throw new RemoteError(`Carbon answered ${res.status}`, res.status)
  return (await res.json()) as Record<string, string | null>
}

/** Each listed chat folder's checked-out branch, for the detailed sidebar rows. */
export async function branches(): Promise<Record<string, string | null>> {
  const res = await fetch('/api/branches', { credentials: 'same-origin' })
  if (!res.ok) throw new RemoteError(`Carbon answered ${res.status}`, res.status)
  return (await res.json()) as Record<string, string | null>
}

/**
 * Which chat this page is reading, and whether it is on screen — the Mac
 * skips the notification for a chat the phone is looking at. `keepalive` so
 * the "hidden" report still leaves when iOS suspends the page right after it
 * (`sendBeacon` would, too, but cannot carry the CSRF header).
 */
export async function watch(conn: string, chatId: string | null, visible = true): Promise<void> {
  await post('/api/watch', { conn, chatId, visible }, true)
}

export async function pushInfo(): Promise<{ publicKey: string; subscribed: boolean }> {
  const res = await fetch('/api/push', { credentials: 'same-origin' })
  if (!res.ok) throw new RemoteError(`Carbon answered ${res.status}`, res.status)
  return (await res.json()) as { publicKey: string; subscribed: boolean }
}

/** Hand the Mac this phone's subscription, or `null` to stop notifications. */
export async function setPushSubscription(subscription: PushSubscriptionJSON | null): Promise<void> {
  await post('/api/push', { subscription })
}

export interface EventHandlers {
  onHello(conn: string): void
  onEvent(ev: ChatEvent): void
  /** `closed`: the browser gave up on the stream and will not retry it. */
  onDown(closed: boolean): void
}

/** Open the event stream; returns a closer. */
export function connectEvents(h: EventHandlers): () => void {
  const es = new EventSource('/api/events', { withCredentials: true })
  es.addEventListener('hello', (e) => {
    const { conn } = JSON.parse((e as MessageEvent<string>).data) as { conn: string }
    h.onHello(conn)
  })
  es.onmessage = (e) => h.onEvent(JSON.parse(e.data) as ChatEvent)
  es.onerror = () => h.onDown(es.readyState === EventSource.CLOSED)
  return () => es.close()
}

/** "iPhone", "iPad", "Android phone" — what the Mac's device list calls this one. */
export function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad'
  return 'Browser'
}

import * as React from 'react'
import * as api from './api'
import { navigate } from './App'

/**
 * Notifications on the phone: Web Push to the Home Screen app.
 *
 * Three things have to be true, and each one missing is its own sentence to
 * the user rather than a dead button. The page has to be a secure context —
 * the Tailscale HTTPS address, not `.local` — because service workers exist
 * nowhere else. On iOS it has to be running as the Home Screen app, the only
 * place WebKit exposes `PushManager`. And the permission prompt can only come
 * from a tap. See `docs/remote.md`.
 */

export type PushState =
  | 'loading'
  /** Plain HTTP: open the `https://` address instead. */
  | 'insecure'
  /** iOS Safari tab: add to the Home Screen and open it from there. */
  | 'install'
  /** No Web Push in this browser at all. */
  | 'unsupported'
  /** The user said no; only the OS's settings can undo it. */
  | 'denied'
  | 'off'
  | 'on'

const SW_PATH = '/remote-sw.js'

function standalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  )
}

function ios(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
}

/** Why push cannot work here, or null when it can. */
function blocked(): PushState | null {
  if (!window.isSecureContext) return 'insecure'
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!capable) return ios() && !standalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return null
}

/** The VAPID key as raw bytes — WebKit is pickier about the base64 string than Chrome. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let registration: Promise<ServiceWorkerRegistration> | null = null

/** Register the worker once, and follow its "open this chat" messages. */
function worker(): Promise<ServiceWorkerRegistration> {
  if (!registration) {
    registration = navigator.serviceWorker.register(SW_PATH)
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; hash?: string }>) => {
      if (e.data?.type === 'open' && e.data.hash) navigate(e.data.hash)
    })
  }
  return registration
}

/**
 * Where this phone stands, from both sides: the browser's subscription and
 * the Mac's record of it. A subscription the Mac lost (it answered 410 once,
 * or the phone was re-paired) reads as off, so turning it on re-sends it.
 */
async function current(): Promise<PushState> {
  const why = blocked()
  if (why) return why
  const reg = await worker()
  const [sub, info] = await Promise.all([reg.pushManager.getSubscription(), api.pushInfo()])
  return sub && info.subscribed && Notification.permission === 'granted' ? 'on' : 'off'
}

async function enable(): Promise<PushState> {
  // Asked first and directly inside the tap: iOS refuses a prompt that is not.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const reg = await worker()
  const { publicKey } = await api.pushInfo()
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another key (the Mac's settings were reset) can't
  // be signed for; replace it.
  const key = sub?.options.applicationServerKey
  if (sub && key && !sameBytes(new Uint8Array(key), keyBytes(publicKey))) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await api.setPushSubscription(sub.toJSON())
  return 'on'
}

async function disable(): Promise<PushState> {
  const reg = await worker()
  const sub = await reg.pushManager.getSubscription()
  await api.setPushSubscription(null)
  await sub?.unsubscribe()
  return 'off'
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** What the sidebar's bell says about each state, when tapping it cannot help. */
export const PUSH_HINT: Partial<Record<PushState, string>> = {
  insecure:
    'Notifications need the HTTPS address. On your Mac, open Settings → Remote access and pair this phone at the https:// address.',
  install: 'Add Carbon to your Home Screen first (Share → Add to Home Screen), then open it from there.',
  unsupported: 'This browser does not support notifications from web apps.',
  denied: 'Notifications are turned off for Carbon. Turn them on in Settings → Notifications → Carbon.'
}

/**
 * One state for the whole page: the sidebar's bell and the home screen's card
 * both read it, so turning notifications on in one updates the other.
 */
let shared: { state: PushState; busy: boolean } = { state: 'loading', busy: false }
const listeners = new Set<() => void>()
let loaded = false

function publish(next: Partial<typeof shared>): void {
  shared = { ...shared, ...next }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!loaded) {
    loaded = true
    current()
      .then((state) => publish({ state }))
      .catch(() => publish({ state: 'off' }))
  }
  return () => listeners.delete(listener)
}

async function toggle(): Promise<void> {
  const { state } = shared
  if ((state !== 'on' && state !== 'off') || shared.busy) return
  publish({ busy: true })
  try {
    publish({ state: await (state === 'on' ? disable() : enable()) })
  } finally {
    publish({ busy: false })
  }
}

export function usePush(): { state: PushState; busy: boolean; toggle: () => Promise<void> } {
  const snap = React.useSyncExternalStore(subscribe, () => shared)
  return { ...snap, toggle }
}

/** Register the worker at launch, so a tap on a notification can be routed. */
export function installPushWorker(): void {
  const why = blocked()
  if (!why || why === 'denied') void worker().catch(() => {})
}

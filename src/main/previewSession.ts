import { dialog, session, type BrowserWindow } from 'electron'

/** The `<webview>` partition every preview pane shares (`BrowserPane`). */
export const PREVIEW_PARTITION = 'persist:karbun-preview'

/**
 * Permissions a page in the preview may have without asking: nothing here
 * reaches past the page itself.
 */
const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock'])

/** Permissions worth a question — each one reaches the user's hardware, location or attention. */
const ASKABLE: Record<string, string> = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'record your screen',
  'idle-detection': 'know when you are idle',
  'storage-access': 'use its cookies in an embedded frame',
  'top-level-storage-access': 'use its cookies in an embedded frame',
  'speaker-selection': 'choose an audio output device',
  openExternal: 'open another application'
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The preview's permission policy. Electron's default grants every request,
 * so any page loaded in the preview — a dev app, or whatever a link led to —
 * got the camera, the microphone and the user's location without a prompt.
 * Now the harmless ones are granted, the ones that reach the user's machine
 * ask once per site for the app's lifetime, and the rest are refused.
 * Device choosers (USB, HID, serial, Bluetooth) are refused outright: Carbon
 * draws no chooser for them.
 */
export function configurePreviewSession(getWindow: () => BrowserWindow | null): void {
  const ses = session.fromPartition(PREVIEW_PARTITION)
  const decided = new Map<string, boolean>()
  const inflight = new Map<string, Promise<boolean>>()

  const ask = (origin: string, permission: string, what: string): Promise<boolean> => {
    const key = `${origin}\u0000${permission}`
    const known = decided.get(key)
    if (known !== undefined) return Promise.resolve(known)
    const pending = inflight.get(key)
    if (pending) return pending
    const win = getWindow()
    const opts = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${origin} wants to ${what}.`,
      detail: 'Asked by a page in the preview. Carbon remembers your answer until it quits.'
    }
    const p = (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
      .then(({ response }) => {
        const allow = response === 0
        decided.set(key, allow)
        return allow
      })
      .catch(() => false)
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true)
    const what = ASKABLE[permission]
    if (!what) return callback(false)
    const origin = originOf(details.requestingUrl ?? '')
    void ask(origin, permission, what).then(callback)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (ALWAYS.has(permission)) return true
    return decided.get(`${originOf(requestingOrigin)}\u0000${permission}`) === true
  })

  ses.setDevicePermissionHandler(() => false)
}

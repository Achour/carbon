/** Notification preferences + the completion chime. */

export interface NotifyPrefs {
  /** Notify when a turn finishes while the app is in the background. */
  finish: boolean
  /** Notify when Claude is waiting for an approval. */
  permission: boolean
  /** Play a chime when a turn finishes. */
  sound: boolean
}

const DEFAULTS: NotifyPrefs = { finish: true, permission: true, sound: true }

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem('notifyPrefs') ?? '{}') as Partial<NotifyPrefs>
    return { ...DEFAULTS, ...raw }
  } catch {
    return DEFAULTS
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  localStorage.setItem('notifyPrefs', JSON.stringify(prefs))
}

let audio: AudioContext | null = null

/** Soft two-note chime for turn completion. */
export function playChime(): void {
  try {
    audio ??= new AudioContext()
    const t0 = audio.currentTime
    for (const [freq, at] of [
      [660, 0],
      [990, 0.12]
    ] as const) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + at)
      gain.gain.exponentialRampToValueAtTime(0.09, t0 + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4)
      osc.connect(gain).connect(audio.destination)
      osc.start(t0 + at)
      osc.stop(t0 + at + 0.45)
    }
  } catch {
    // audio unavailable — never block the event flow over a chime
  }
}

/** Native desktop notification; clicking focuses the app via onClick. */
export function notify(
  title: string,
  body: string,
  opts?: { silent?: boolean; onClick?: () => void }
): void {
  try {
    const n = new Notification(title, { body, silent: opts?.silent ?? true })
    if (opts?.onClick) n.onclick = opts.onClick
  } catch {
    // notifications unavailable
  }
}

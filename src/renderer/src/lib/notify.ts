/** Notification preferences. The cues themselves live in `lib/sounds.ts`. */

import { DEFAULT_SOUND_PACK, knownSoundPack, type SoundPackId } from '@/lib/sounds'

export interface NotifyPrefs {
  /** Notify when a turn finishes while the app is in the background. */
  finish: boolean
  /** Notify when Claude is waiting for an approval. */
  permission: boolean
  /** Play a cue when a turn finishes, fails, or the agent needs an answer. */
  sound: boolean
  /** Which voice those cues are played in. */
  pack: SoundPackId
}

const DEFAULTS: NotifyPrefs = {
  finish: true,
  permission: true,
  sound: true,
  pack: DEFAULT_SOUND_PACK
}

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem('notifyPrefs') ?? '{}') as Partial<NotifyPrefs>
    return { ...DEFAULTS, ...raw, pack: knownSoundPack(raw.pack) }
  } catch {
    return DEFAULTS
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  localStorage.setItem('notifyPrefs', JSON.stringify(prefs))
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

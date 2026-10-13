import type { Api } from '@shared/types'
import { useApp } from '@/store'
import { invoke } from './api'
import { useRemote } from './state'

/**
 * What lets the phone draw the desktop's own transcript components.
 *
 * Those components read two things the desktop provides: `window.api`, and a
 * handful of fields of the desktop store (`useApp`). The phone supplies both,
 * narrowly, and nothing else of the desktop runs here — `useApp` is created
 * but never initialized, so none of its loaders, timers or persistence fire.
 *
 * - **`window.api`** answers the calls the transcript makes, through the
 *   relay where the server allows the channel (an edit-and-resend, a turn's
 *   Undo, a canvas), and refuses everything else. A refusal is what the desktop code already
 *   handles for a file that is gone or a channel that failed, so a file link
 *   tapped on the phone simply does nothing; the server's allowlist is still
 *   the gate (`REMOTE_CHANNELS`), this only saves a round trip to be told no.
 * - **`useApp`** mirrors the phone's own state: the chat list, statuses,
 *   prompts, the appearance, and the open chat as the desktop's *active* one
 *   — `messagesOf`, which the agent rows read through, keys off `activeId`.
 */

const refused = (): Promise<never> => Promise.reject(new Error('Not available on the phone.'))

const bridge: Partial<Api> = {
  editMessage: (chatId, messageId, text) => invoke('chat:edit-message', chatId, messageId, text),
  rewindFiles: (chatId, userMessageId, dryRun) =>
    invoke('chat:rewind-files', chatId, userMessageId, dryRun),
  canvasList: (project) => invoke('canvas:list', project),
  canvasGet: (id) => invoke('canvas:get', id),
  // Looked up to decide whether a path in a reply is a link; null draws it as
  // plain text, which is right on a device that cannot open it.
  statPath: () => Promise.resolve(null),
  favicon: () => Promise.resolve(null),
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  }
}

export function installDesktopBridge(): void {
  ;(window as unknown as { api: Api }).api = new Proxy(bridge as Api, {
    get(target, name) {
      if (typeof name !== 'string') return undefined
      const own = (target as unknown as Record<string, unknown>)[name]
      if (own) return own
      // Subscriptions (`onChatEvent`, …): nothing arrives this way here.
      if (/^on[A-Z]/.test(name)) return () => () => {}
      return refused
    }
  })

  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const mirror = (): void => {
    const s = useRemote.getState()
    useApp.setState({
      chats: s.chats,
      statuses: s.statuses,
      permissions: s.permissions,
      activeId: s.open?.id ?? null,
      messages: s.open?.messages ?? [],
      hiddenBefore: s.open?.hiddenBefore ?? 0,
      contextUsage: s.open?.contextUsage ?? null,
      resolvedAppearance: dark.matches ? 'dark' : 'light'
    })
  }
  mirror()
  useRemote.subscribe((s, prev) => {
    if (
      s.chats !== prev.chats ||
      s.statuses !== prev.statuses ||
      s.permissions !== prev.permissions ||
      s.open !== prev.open
    ) {
      mirror()
    }
  })
  dark.addEventListener('change', mirror)
}

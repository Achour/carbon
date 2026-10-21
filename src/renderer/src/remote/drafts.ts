import type { WorktreeTarget } from '@shared/types'
import type { OptionValues } from './options'

/**
 * Text typed and not sent, per chat and per project's New-chat screen — the
 * phone's `lib/drafts.ts`. A phone loses a half-written message for reasons a
 * desktop never does: the drawer opened to check something else, a
 * notification tapped, the app evicted in the background. So the composer's
 * text is kept here as it is typed, and a New-chat draft keeps where the chat
 * will run and the pickers with it, as the desktop's does: restoring the words
 * onto a different model or checkout than the chips said is worse than losing
 * them.
 *
 * In the page's own `localStorage`, per phone, never on the Mac: the desktop's
 * drafts are its own, and a phone draft syncing over one typed at the desk is
 * a conflict with no right answer. Photos are not kept — a draft is text, and
 * a few megabytes of base64 per draft would crowd out everything else stored.
 */

export interface RemoteDraft {
  text?: string
  /** New-chat only: what the pickers were moved to. */
  picked?: Partial<OptionValues>
  /** New-chat only: where the chat runs, when not the main checkout. */
  target?: WorktreeTarget
  at: number
}

const KEY = 'carbon.remote.drafts'
/** Oldest go first past this; a draft untouched for a month is gone too. */
const MAX = 40
const TTL_MS = 30 * 24 * 3600_000

export const chatDraftKey = (chatId: string): string => `c:${chatId}`
export const newChatDraftKey = (cwd: string): string => `n:${cwd}`

function readAll(): Record<string, RemoteDraft> {
  try {
    const raw = localStorage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, RemoteDraft>) : {}
    return all && typeof all === 'object' ? all : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, RemoteDraft>): void {
  const now = Date.now()
  const kept = Object.entries(all)
    .filter(([, d]) => now - d.at < TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    /* storage full or blocked: the draft lives as long as the screen does */
  }
}

export function readDraft(key: string): RemoteDraft | undefined {
  return readAll()[key]
}

/**
 * Merge into a draft. The pickers are kept even while there is no text — they
 * are usually chosen before the first word — but only a draft with text is
 * one (`draftOptions`): the pickers alone are already remembered on the Mac as
 * its defaults.
 */
export function patchDraft(key: string, patch: Partial<Omit<RemoteDraft, 'at'>>): void {
  const all = readAll()
  const next: RemoteDraft = { ...all[key], ...patch, at: Date.now() }
  if (!next.text?.trim() && !next.picked && !next.target) delete all[key]
  else all[key] = next
  writeAll(all)
}

/** What a New-chat draft restores beside its text — nothing, without text. */
export function draftOptions(draft: RemoteDraft | undefined): Pick<RemoteDraft, 'picked' | 'target'> {
  return draft?.text?.trim() ? { picked: draft.picked, target: draft.target } : {}
}

export function clearDraft(key: string): void {
  const all = readAll()
  if (!(key in all)) return
  delete all[key]
  writeAll(all)
}

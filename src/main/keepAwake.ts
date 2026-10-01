import { powerSaveBlocker } from 'electron'
import type { ChatStatus } from '@shared/types'

/**
 * Settings → Chats → "Keep computer awake": hold off idle system sleep while
 * any chat is working, so a long turn left running is still running when you
 * come back.
 *
 * `prevent-app-suspension` is Chromium's `kIOPMAssertionTypeNoIdleSleep` —
 * `pmset -g assertions` lists it as `NoIdleSleepAssertion named: "Electron"`
 * under this process. It stops *idle* sleep only: the display still sleeps and
 * locks, and closing the lid or choosing Sleep still sleeps the Mac; no
 * user-space assertion overrides those. `prevent-display-sleep` would keep the
 * screen lit for nothing, and `caffeinate -i` is the same assertion from a
 * second process.
 *
 * "Working" is a turn in flight *or* a background job still running — Claude
 * emits `idle` while a backgrounded shell or agent carries on, and that work
 * is suspended by sleep just the same. A turn waiting on an approval does not
 * count: nothing moves until you answer, and an unanswered prompt keeping a
 * laptop up all night is the failure this avoids.
 */
const turns = new Set<string>()
const jobs = new Map<string, number>()
let enabled = false
let blocker: number | null = null

function sync(): void {
  const want = enabled && (turns.size > 0 || jobs.size > 0)
  if (want && blocker === null) {
    blocker = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!want && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}

export function setKeepAwake(on: boolean): void {
  enabled = on
  sync()
}

/** Fed every `status` event; `emit` in `index.ts` is the one chokepoint. */
export function noteStatus(chatId: string, status: ChatStatus): void {
  if (status === 'starting' || status === 'streaming') turns.add(chatId)
  else turns.delete(chatId)
  sync()
}

/** Fed every `background-jobs` event, which always carries the whole set. */
export function noteJobs(chatId: string, count: number): void {
  if (count > 0) jobs.set(chatId, count)
  else jobs.delete(chatId)
  sync()
}

/**
 * The chat's session was disposed or the chat deleted. Neither emits a final
 * status, and a disposed session's jobs went with its process, so nothing
 * else would ever release the hold.
 */
export function forgetChat(chatId: string): void {
  turns.delete(chatId)
  jobs.delete(chatId)
  sync()
}

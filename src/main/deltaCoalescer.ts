import type { Emit } from './session'

/** Coalescing window: per-token renders make long thinking phases feel hung. */
const FLUSH_MS = 80

/**
 * Buffers streaming text/thinking deltas for ~80ms, then emits them as coalesced
 * `part-delta` events over IPC and persists once. Both `ClaudeSession` and
 * `CodexSession` own one: Claude feeds the true deltas its SDK yields; Codex diffs
 * the appended suffix out of the full accumulated text (its own concern) and feeds
 * that in. The `part-delta` contract and once-per-flush `saveChatSoon` live here,
 * in one place, rather than being re-implemented per provider.
 *
 * Every dependency is read lazily (through the constructor callbacks) so the
 * owning session can create this as a field initializer regardless of when its
 * `emit`/`chat`/`store` are assigned. (Plain fields, not parameter properties, so
 * the file stays loadable under Node's strip-only TS loader in tests.)
 */
export class DeltaCoalescer {
  private buf = new Map<string, { messageId: string; partIndex: number; text: string }>()
  private timer: NodeJS.Timeout | null = null
  private readonly emit: Emit
  private readonly chatId: () => string
  private readonly onFlush: () => void
  private readonly isDisposed: () => boolean

  constructor(emit: Emit, chatId: () => string, onFlush: () => void, isDisposed: () => boolean) {
    this.emit = emit
    this.chatId = chatId
    this.onFlush = onFlush
    this.isDisposed = isDisposed
  }

  /** Append a delta to a part slot's buffer, arming the flush timer. */
  queue(messageId: string, partIndex: number, delta: string): void {
    const key = `${messageId}:${partIndex}`
    const buffered = this.buf.get(key)
    if (buffered) buffered.text += delta
    else this.buf.set(key, { messageId, partIndex, text: delta })
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  /**
   * Discard any buffered delta for a slot — call before an authoritative full-part
   * emit so a stale suffix can't append onto a part the renderer just replaced.
   */
  drop(messageId: string, partIndex: number): void {
    this.buf.delete(`${messageId}:${partIndex}`)
  }

  /** Emit all buffered deltas now and persist once. No-op if empty or disposed. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.isDisposed()) {
      this.buf.clear()
      return
    }
    if (this.buf.size === 0) return
    const chatId = this.chatId()
    for (const { messageId, partIndex, text } of this.buf.values()) {
      this.emit({ type: 'part-delta', chatId, messageId, partIndex, delta: text })
    }
    this.buf.clear()
    // Persist once per coalesced flush (~12x/sec) instead of once per token.
    // saveChatSoon is a trailing debounce, so per-flush is equivalent for
    // durability; final state is still forced on message/turn finalization.
    this.onFlush()
  }
}

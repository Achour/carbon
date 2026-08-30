/**
 * Pacing for streamed text, so a reply *flows* instead of landing in lumps.
 *
 * Two buffers sit between the model and the screen, and both are there for good
 * reasons: main coalesces deltas for ~80ms (per-token IPC and a persist per
 * token are genuinely too expensive), and the renderer used to commit at most
 * every 120ms (a markdown re-parse per token makes the window feel hung). What
 * neither did was *spread* the text out again on the way in — each commit jumped
 * to the latest string, so at a normal generation rate the reader saw five or six
 * words appear at once, eight times a second. The words were arriving smoothly;
 * only the display was chunky.
 *
 * So the throttle becomes a **drain**. The full text is held, and the visible
 * prefix walks toward it a little per animation frame, closing a share of the
 * gap each time (see `DRAIN_MS`). Network jitter and the 80ms coalescing stop
 * being visible: a burst is spread out, a lull is caught up on.
 *
 * Dependency-free, so `node --test` runs `test/streamReveal.test.ts` against the
 * `.ts` directly — the constraint every `lib/` module pinned by a test lives
 * under.
 */

/**
 * The catch-up time constant. Each frame closes the same *fraction* of the
 * remaining gap, so the backlog decays exponentially: ~63% of it is gone after
 * DRAIN_MS and it is visually caught up within two or three times that.
 *
 * A constant fraction rather than a constant rate, because the two feel
 * different and only one is right. A fixed characters-per-second either crawls
 * behind a fast model or races ahead of a slow one; closing a share of the gap
 * is self-tuning — far behind is fast, nearly caught up is gentle, which is the
 * deceleration that reads as natural rather than mechanical. In the common case
 * of steady streaming the gap is about a word, so the lag is about a word.
 */
export const DRAIN_MS = 180

/**
 * A trailing run longer than this is revealed rather than held. Holding the
 * incomplete word assumes another delimiter is coming; a base64 data URI or a
 * minified line is a "word" thousands of characters long, and waiting for its
 * end would stall the reveal for the whole of it.
 */
const MAX_HELD_WORD = 240

function isBoundary(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
}

/**
 * How much of `text` may be shown right now.
 *
 * **The still-arriving word is held back**, and that is the difference between a
 * typewriter and a smooth reveal. Revealing character by character means
 * `**bold**` is on screen as `*`, then `**`, then `**b` — a flash of literal
 * asterisks that snaps into bold a frame later, on every emphasis in the reply.
 * A word is the smallest unit that keeps inline markdown intact, because none of
 * its delimiters contain a space. The cost is one word of latency, which is
 * below what the 120ms commit already cost.
 *
 * `hold` is false once the text stops growing, so a reply ending mid-word — the
 * common case, since replies end in "." rather than a space — is not left one
 * word short while it waits for a delimiter that is never coming.
 */
export function revealLimit(text: string, hold: boolean): number {
  if (!hold) return text.length
  let i = text.length
  while (i > 0 && !isBoundary(text[i - 1])) i--
  return text.length - i > MAX_HELD_WORD ? text.length : i
}

/**
 * The next visible length, one frame on.
 *
 * The step is a share of the *backlog* rather than a fixed rate — see
 * `DRAIN_MS` for why that shape and not a constant speed. The result then runs
 * forward to the next boundary: a step that lands mid-word would put back the
 * artifact `revealLimit` exists to prevent, and it is also what guarantees the
 * tail finishes rather than halving forever.
 */
export function nextReveal(
  text: string,
  shown: number,
  limit: number,
  elapsedMs: number,
  drainMs: number = DRAIN_MS
): number {
  if (limit <= shown) return shown
  const share = Math.min(1, Math.max(0, elapsedMs) / drainMs)
  // At least one character, so a frame can never be a no-op and stall the
  // drain; the boundary walk below turns that into at least one word.
  let next = shown + Math.max(1, Math.ceil((limit - shown) * share))
  if (next >= limit) return limit
  while (next < limit && !isBoundary(text[next - 1])) next++
  return next
}

/**
 * The two throttles every provider's emitters share. Each ships a payload that
 * carries *everything accumulated so far* — a tool call's whole input, a
 * sub-agent's whole transcript — so a fixed window makes the total quadratic in
 * the size of what streams. Both windows widen with that size, which keeps it
 * linear. Claude's session introduced them; Codex's sub-agents and Cursor's
 * partial tool calls had the same shape and none of the bound.
 */

// How often a still-streaming tool input is re-parsed and shown. Coarser than
// the 80ms text coalescer: a command or a path is read, not watched, and each
// emit is a full-part IPC plus a parse of the whole prefix.
const PARTIAL_INPUT_MS = 120
// …and how much of one may be shipped per millisecond of that window, plus the
// ceiling on the window itself. See `partialInputDelay`.
const PARTIAL_INPUT_BYTES_PER_MS = 100
const PARTIAL_INPUT_MAX_MS = 5000
// How often a sub-agent's accumulated transcript is shipped to its spawning
// card, and how much the window widens per child. See `childUpdateDelay`.
const CHILD_UPDATE_MS = 120
const CHILD_UPDATE_PER_CHILD_MS = 8
const CHILD_UPDATE_MAX_MS = 1000

/**
 * How long to wait before shipping the next partial input, given how much of it
 * has already arrived.
 *
 * Each emit re-parses the *whole* accumulated prefix and structured-clones the
 * whole part to a renderer that re-renders on it, so a fixed window makes
 * streaming one call quadratic in the size of its input. Measured on this
 * repo's own chats, an 80 KB canvas write streams for ~280 s: at a flat 120 ms
 * that is ~2,300 emits carrying ~190 MB between them, and a `saveChatSoon` on
 * each — the app going sluggish for the whole of a long write, for a row whose
 * label settled in the first few hundred bytes.
 *
 * Scaling the window with the prefix keeps the total work linear while the row
 * still fills in as it streams, which a hard cap would have taken away: the
 * progressive `Edit` diff is drawn from exactly these partial inputs.
 *
 * The ceiling is above `saveChatSoon`'s 5 s cap, not below it, and that is the
 * one number here with a wrong answer next to it. The debounce is *trailing*:
 * while emits land inside its 1.5 s window they keep resetting it and only the
 * cap ever fires, so a ceiling between the two (2 s, say) would make every emit
 * miss the window and persist — more writes than the flat window it replaced,
 * on exactly the large inputs this exists for.
 */
export function partialInputDelay(length: number): number {
  return Math.min(
    PARTIAL_INPUT_MAX_MS,
    Math.max(PARTIAL_INPUT_MS, length / PARTIAL_INPUT_BYTES_PER_MS)
  )
}

/**
 * How long to wait before shipping a sub-agent's transcript again, given how
 * much of it there is.
 *
 * **The third emitter with this shape, and the one with no bound at all.** A
 * child update carries the parent call's *whole* `children` array — every
 * text, thought and tool result the agent has produced — because that is what
 * `ToolPart.children` is, and it went out once per child event. So an agent
 * that makes fifty calls ships the first child fifty times and the fiftieth
 * once: quadratic in the agent's own output, with a `saveChatSoon` on each and
 * a structured clone of the lot in between, and `/simplify` spawning four
 * review agents is four of those at once. Read off the code rather than
 * measured: the probes in `demo/e2e` cover the transcript's own streaming and
 * none of them spawns an agent, so the size of the win here is unquantified.
 *
 * The window widens with the child count for exactly the reason
 * `partialInputDelay`'s does — that keeps the total linear — and the ceiling
 * is chosen the other way round from that one: it sits **below**
 * `saveChatSoon`'s 1.5 s debounce window rather than above its 5 s cap, so
 * emits keep resetting the debounce and persistence behaves as it did. Above
 * 1.5 s every emit would miss the window and write.
 */
export function childUpdateDelay(children: number): number {
  return Math.min(
    CHILD_UPDATE_MAX_MS,
    Math.max(CHILD_UPDATE_MS, children * CHILD_UPDATE_PER_CHILD_MS)
  )
}

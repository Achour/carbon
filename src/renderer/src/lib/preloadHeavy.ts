import { preloadMermaid } from '@/components/Markdown'

/**
 * Fetch the lazily-loaded heavy chunks once the app has nothing better to do.
 *
 * **This is the half of lazy loading that keeps it honest.** Splitting
 * CodeMirror, xterm and mermaid out of the entry chunk takes ~2 MB off the
 * parse that stands between launch and first paint — but on its own it only
 * *moves* that cost, to the first click on a file, the first terminal tab and
 * the first diagram, where it lands as a visible hitch in the middle of a
 * gesture. A hitch there is worse than the launch cost it replaced: at launch
 * nobody is mid-action.
 *
 * So the chunks are warmed on idle instead, and the two properties together are
 * what make the split free rather than a trade: nothing is on the critical path
 * to first paint, and nothing is on the critical path to first use either.
 *
 * They are warmed **one at a time**, each on its own idle callback rather than
 * all three at once. Fetching is off-thread but *evaluating* a module is not,
 * and ~2 MB of it back to back is exactly the kind of long task that drops a
 * frame if the user starts typing halfway through. One per callback lets the
 * browser interleave, and lets it stop giving us idle time the moment there is
 * none — which is the correct behaviour: a busy app has more urgent work than
 * a chunk nobody has asked for yet.
 *
 * Ordered by how soon each is likely to be wanted. Failures are swallowed: a
 * preload that does not land costs a slow first open, and the real import at
 * the call site will report anything that actually matters.
 */
const CHUNKS: { name: string; load: () => Promise<unknown> }[] = [
  // The file tree is on screen from the start, so a click on it is the nearest
  // of the three.
  { name: 'editor', load: () => import('@/components/CodeEditor') },
  // A diagram needs an agent to write one, but it arrives without being asked
  // for — and it renders into a block the user is already reading.
  { name: 'mermaid', load: () => preloadMermaid() },
  // A terminal tab is always a deliberate act, and many sessions never open one.
  { name: 'terminal', load: () => import('@/components/TerminalPanel') }
]

/**
 * `requestIdleCallback` with a real timeout so a permanently busy app still
 * warms eventually, and a `setTimeout` fallback for anywhere it is missing.
 */
function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 1_000)
}

let started = false

export function preloadHeavyChunks(): void {
  // Idempotent: React 18's StrictMode mounts effects twice in development, and
  // a second pass would queue every chunk again.
  if (started) return
  started = true

  let next = 0
  const step = (): void => {
    const chunk = CHUNKS[next++]
    if (!chunk) return
    void chunk
      .load()
      .catch(() => undefined)
      .then(() => whenIdle(step))
  }
  whenIdle(step)
}

/**
 * A tiny global cache for local-image data URIs, shared by every `<LocalImage>`.
 *
 * Codex/Claude reference generated images by filesystem path; the renderer can't
 * load a bare path, so it resolves each to a data URI over IPC (`readImageOnce`)
 * and caches the result by path. Because the cache is keyed only by path, an
 * agent (or the user) overwriting the same file would keep showing stale bytes —
 * so the store calls `invalidateLocalImages()` at moments a displayed file may
 * have changed (any turn completing, opening a chat, a file refresh). That bumps
 * an epoch (which `<LocalImage>` subscribes to, re-reading) and clears the cache.
 *
 * Dependency-free on purpose (no React, no `window.api`) so it unit-tests under
 * `node --test` and so importing it from the store doesn't create a cycle.
 */

const cache = new Map<string, Promise<string | null>>()
let epoch = 0
const listeners = new Set<() => void>()

/**
 * Resolve `abs` to a data URI once and cache it. `read` performs the actual load
 * (injected so this stays free of `window.api`). A miss (null) is never cached —
 * the file may not have appeared yet, or may be replaced later — so a subsequent
 * read retries.
 */
export function readImageOnce(
  abs: string,
  read: (path: string) => Promise<string | null>
): Promise<string | null> {
  let pending = cache.get(abs)
  if (!pending) {
    pending = read(abs).catch(() => null)
    cache.set(abs, pending)
    void pending.then((uri) => {
      if (uri == null) cache.delete(abs)
    })
  }
  return pending
}

/** Clear every cached image and bump the epoch so mounted images re-read. */
export function invalidateLocalImages(): void {
  epoch += 1
  cache.clear()
  listeners.forEach((l) => l())
}

/** Subscribe to epoch bumps (for `useSyncExternalStore`). */
export function subscribeImageEpoch(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getImageEpoch(): number {
  return epoch
}

/** Test-only: reset module state between cases. */
export function __resetImageCacheForTest(): void {
  cache.clear()
  epoch = 0
  listeners.clear()
}

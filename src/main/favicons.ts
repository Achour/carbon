/**
 * The mark beside an external link in a message.
 *
 * A favicon is a network fetch keyed on a domain the *model* chose, so it runs
 * here rather than in the renderer: one place to cap, time out and cache, and
 * the page never learns anything from the reader's window. Answers a `data:`
 * URI so the renderer draws it without a second request, or null — a link with
 * no mark is the normal case, not a failure worth reporting.
 *
 * This file is only the half that knows where `userData` is. The resolver
 * itself lives in `faviconCache.ts`, which takes its directory by constructor
 * and imports nothing but `node:*` — the split `store.ts` and `updateCheck.ts`
 * already keep, and what lets the fetch, the sniff and the parse be exercised
 * outside Electron.
 */

import { join } from 'node:path'
import { app } from 'electron'
import { FaviconCache } from './faviconCache'

let cache: FaviconCache | null = null

export async function siteFavicon(url: string): Promise<string | null> {
  try {
    // Lazy: `app.getPath` is only correct after `whenReady` has repointed
    // userData at `ai-gui`, and a module-scope read would capture the default.
    if (!cache) cache = new FaviconCache(join(app.getPath('userData'), 'favicons'))
    return await cache.get(url)
  } catch {
    return null
  }
}

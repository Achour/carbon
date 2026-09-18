/**
 * A site's mark: beside an external link in a message, and on a browser
 * preview's tab.
 *
 * A favicon is a network fetch keyed on a domain the *model* chose, so it runs
 * here rather than in the renderer: one place to cap, time out and cache, and
 * the page never learns anything from the reader's window. Answers a `data:`
 * URI so the renderer draws it without a second request, or null — a link with
 * no mark is the normal case, not a failure worth reporting.
 *
 * The two callers ask different questions — a link has only an origin, while
 * the pane's guest has already named the icons the page declares — so there
 * are two entry points over one cache.
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

/**
 * Lazy: `app.getPath` is only correct after `whenReady` has repointed userData
 * at `ai-gui`, and a module-scope read would capture the default.
 */
function resolver(): FaviconCache {
  if (!cache) cache = new FaviconCache(join(app.getPath('userData'), 'favicons'))
  return cache
}

export async function siteFavicon(url: string): Promise<string | null> {
  try {
    return await resolver().get(url)
  } catch {
    return null
  }
}

/**
 * The image at one exact URL, for a caller that already knows which icon it
 * wants — the browser pane, whose guest has just told it what the page
 * declares. See `FaviconCache.image`.
 */
export async function faviconImage(url: string): Promise<string | null> {
  try {
    return await resolver().image(url)
  } catch {
    return null
  }
}

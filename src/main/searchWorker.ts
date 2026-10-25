/**
 * The search index's own thread (`chatIndex.ts`). It reads `chats.db`
 * (read-only; WAL lets it beside the store's writes) and owns `search.db`,
 * so building and refreshing the index never runs on the main thread.
 *
 * The first build reads every chat once, in slices so a search can still be
 * answered while it runs; after that a refresh is a handful of changed chats,
 * done before each search and once a minute.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { openIndex, searchIndex, syncIndex } from './chatIndex'

const { chatsDb, indexDb } = workerData as { chatsDb: string; indexDb: string }

const src = new DatabaseSync(chatsDb, { readOnly: true })
src.exec('PRAGMA busy_timeout = 5000')
const idx = new DatabaseSync(indexDb)
openIndex(idx)

/** False until the first build has read every chat. */
let complete = false

function step(): void {
  let done = false
  try {
    done = syncIndex(src, idx, 250)
  } catch (err) {
    console.warn('[search] index refresh failed:', err)
    done = true
  }
  if (done) complete = true
  // A short breath between slices of the first build; a minute between refreshes after.
  setTimeout(step, done ? 60_000 : 25)
}

// After launch has settled: the first build is a background job, not part of starting up.
setTimeout(step, 8_000)

parentPort?.on('message', (m: { id: number; query: string; limit?: number }) => {
  let hits: ReturnType<typeof searchIndex> = []
  try {
    // Whatever changed since the last refresh, so the chat just written in is found.
    if (complete) syncIndex(src, idx, 200)
    hits = searchIndex(idx, m.query, m.limit ?? 30)
  } catch (err) {
    console.warn('[search] query failed:', err)
  }
  parentPort?.postMessage({ id: m.id, hits, complete })
})

/**
 * The blob store's own thread (`blobStore.ts`). Two jobs, both off the main
 * thread because both read every row of `chats.db`:
 *
 * - **Migration, once.** Rows written before images moved out of line still
 *   carry base64. Each is rewritten with refs, with a compare-and-swap on the
 *   old body (`AND body = ?`), so a row the store wrote meanwhile is left to
 *   the store, whose own encoder produces the same refs. The write lock is
 *   held only for a batch of UPDATEs; reading, hashing and writing files
 *   happen outside it, so the store's writes never wait behind a migration.
 *   A row the store never touches again is the reason this exists: the store
 *   rewrites a row only when a pass compares it.
 * - **Sweeping, daily.** An image no row names (its chat deleted, a turn
 *   rewound) is deleted once it is `GRACE_MS` old, which leaves any session
 *   that emitted a ref and has not yet written its row long since done.
 *
 * Both are safe with two instances on one `userData`: the swap refuses to
 * overwrite a row that moved, and a blob write is idempotent and atomic.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { ChatMessage } from '@shared/types'
import { BlobStore, INLINE_MAX, externalizeMessage, refsIn, sweepBlobs } from './blobStore'

const { chatsDb, blobDir } = workerData as { chatsDb: string; blobDir: string }

const MIGRATED = 'blobs:migrated'
const SWEPT = 'blobs:swept'
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000
const GRACE_MS = 7 * 24 * 60 * 60 * 1000
const BATCH = 100

const db = new DatabaseSync(chatsDb)
db.exec('PRAGMA busy_timeout = 5000')
const blobs = new BlobStore(blobDir)
const put = blobs.put.bind(blobs)

const kvGet = db.prepare('SELECT v FROM kv WHERE k = ?')
const kvSet = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
const page = db.prepare(
  // The row-value form, which SQLite walks as a range on `messages_pk`.
  'SELECT chat_id, seq, body FROM messages WHERE (chat_id, seq) > (?, ?) ORDER BY chat_id, seq LIMIT ?'
)
const swap = db.prepare('UPDATE messages SET body = ? WHERE chat_id = ? AND seq = ? AND body = ?')

const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
const report = (m: Record<string, unknown>): void => parentPort?.postMessage(m)

type Row = { chat_id: string; seq: number; body: string }

/** Walk every row in key order, a page at a time, so no read holds the WAL open for long. */
async function eachPage(visit: (rows: Row[]) => void): Promise<void> {
  let chat = ''
  let seq = -1
  for (;;) {
    const rows = page.all(chat, seq, BATCH) as Row[]
    if (!rows.length) return
    visit(rows)
    chat = rows[rows.length - 1].chat_id
    seq = Number(rows[rows.length - 1].seq)
    await breathe()
  }
}

async function migrate(): Promise<void> {
  if (kvGet.get(MIGRATED)) return
  const started = Date.now()
  let rewritten = 0
  let saved = 0
  await eachPage((rows) => {
    const writes: [string, string, number, string][] = []
    for (const row of rows) {
      if (row.body.length <= INLINE_MAX || !row.body.includes('"data":"')) continue
      let message: ChatMessage
      try {
        message = JSON.parse(row.body) as ChatMessage
      } catch {
        // Unreadable rows are the store's to salvage, never this thread's to touch.
        continue
      }
      const next = externalizeMessage(message, put)
      if (next === message) continue
      writes.push([JSON.stringify(next), row.chat_id, Number(row.seq), row.body])
    }
    if (!writes.length) return
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [body, chatId, seq, old] of writes) {
        if (Number(swap.run(body, chatId, seq, old).changes) > 0) {
          rewritten++
          saved += old.length - body.length
        }
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  })
  kvSet.run(MIGRATED, String(Date.now()))
  report({ kind: 'migrated', rows: rewritten, bytes: saved, ms: Date.now() - started })
}

async function sweep(): Promise<void> {
  // Only over a fully migrated database: a row still holding base64 names no
  // ref yet, and the file its migration would point at may already be here.
  if (!kvGet.get(MIGRATED)) return
  const last = Number((kvGet.get(SWEPT) as { v?: string } | undefined)?.v ?? 0)
  if (Date.now() - last < SWEEP_EVERY_MS) return
  const referenced = new Set<string>()
  await eachPage((rows) => {
    for (const row of rows) if (row.body.includes('"ref":"')) refsIn(row.body, referenced)
  })
  const gone = sweepBlobs(blobDir, referenced, GRACE_MS)
  kvSet.run(SWEPT, String(Date.now()))
  report({ kind: 'swept', referenced: referenced.size, ...gone })
}

// After launch has settled, like the search index: this is background work.
setTimeout(() => {
  migrate()
    .then(sweep)
    .catch((err) => report({ kind: 'error', error: String((err as Error)?.stack ?? err) }))
}, 10_000)

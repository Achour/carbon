/**
 * A full-text index of what was *said* in every chat, for search.
 *
 * `chats.db` holds 2.8 GB of message bodies, almost all of it tool input and
 * output, and a `LIKE` over it took five seconds — on the main thread, since
 * `node:sqlite` is synchronous. So the index keeps only the conversation: the
 * user's prompts and the agents' text replies, never tool calls, their output
 * or thinking. That is a few percent of the bytes, and it answers what people
 * search for ("the chat where we fixed the worktree chip").
 *
 * It lives in its own file (`search.db`) and is written by its own thread
 * (`searchWorker.ts`), which only *reads* `chats.db` — WAL lets it do that
 * beside the store's writes — so nothing here can touch history or the store's
 * write path. Being derived, it can be deleted at any time and is rebuilt.
 *
 * Kept current by comparing each chat's `updated_at` with the one it was
 * indexed at. A chat that only grew re-reads its last rows (the tail is the
 * part that still changes while a turn streams); one that shrank — a rewind,
 * an edit — is re-read whole.
 *
 * Dependency-free (only `node:*`) so `node --test` runs it directly.
 */

import type { DatabaseSync } from 'node:sqlite'

/** Markers around a match in a snippet, which no message contains. */
export const HIT_OPEN = '\u0002'
export const HIT_CLOSE = '\u0003'

export interface SearchHit {
  chatId: string
  seq: number
  role: 'user' | 'assistant'
  /** The matching passage, matches wrapped in `HIT_OPEN` / `HIT_CLOSE`. */
  snippet: string
}

export function openIndex(idx: DatabaseSync): void {
  idx.exec('PRAGMA journal_mode = WAL')
  idx.exec('PRAGMA busy_timeout = 5000')
  idx.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    text, chat_id UNINDEXED, seq UNINDEXED, role UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  )`)
  idx.exec(`CREATE TABLE IF NOT EXISTS indexed (
    chat_id TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`)
}

/** The words a stored message said, or null for anything that is not conversation. */
export function messageText(body: string): { role: 'user' | 'assistant'; text: string } | null {
  let m: { role?: string; text?: unknown; parts?: unknown }
  try {
    m = JSON.parse(body)
  } catch {
    return null
  }
  if (m.role === 'user') {
    return typeof m.text === 'string' && m.text.trim() ? { role: 'user', text: m.text } : null
  }
  if (m.role === 'assistant' && Array.isArray(m.parts)) {
    const text = m.parts
      .filter((p): p is { type: 'text'; text: string } => !!p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n\n')
    return text.trim() ? { role: 'assistant', text } : null
  }
  return null
}

/** Rows re-read from the end of a chat that only grew: the tail is what still moves. */
const TAIL = 2

/**
 * Bring the index up to `src`'s chats, most recently active first, stopping
 * once `budgetMs` is spent. Each chat commits on its own, so stopping (or a
 * quit) loses nothing; the next call carries on. Answers whether it finished.
 */
export function syncIndex(src: DatabaseSync, idx: DatabaseSync, budgetMs = Infinity): boolean {
  const started = Date.now()
  const chats = src.prepare('SELECT id, updated_at FROM chats ORDER BY updated_at DESC').all() as {
    id: string
    updated_at: number
  }[]
  const known = new Map(
    (idx.prepare('SELECT chat_id, updated_at, count FROM indexed').all() as {
      chat_id: string
      updated_at: number
      count: number
    }[]).map((r) => [r.chat_id, r])
  )

  // Deleted chats leave the index.
  const live = new Set(chats.map((c) => c.id))
  const dropDocs = idx.prepare('DELETE FROM docs WHERE chat_id = ?')
  const dropIndexed = idx.prepare('DELETE FROM indexed WHERE chat_id = ?')
  for (const id of known.keys()) {
    if (live.has(id)) continue
    dropDocs.run(id)
    dropIndexed.run(id)
  }

  const count = src.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?')
  const rows = src.prepare('SELECT seq, body FROM messages WHERE chat_id = ? AND seq >= ? ORDER BY seq')
  const dropFrom = idx.prepare('DELETE FROM docs WHERE chat_id = ? AND seq >= ?')
  const insert = idx.prepare('INSERT INTO docs (text, chat_id, seq, role) VALUES (?, ?, ?, ?)')
  const mark = idx.prepare(
    'INSERT INTO indexed (chat_id, updated_at, count) VALUES (?, ?, ?) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET updated_at = excluded.updated_at, count = excluded.count'
  )

  for (const chat of chats) {
    const prev = known.get(chat.id)
    if (prev && prev.updated_at === chat.updated_at) continue
    if (Date.now() - started > budgetMs) return false
    const n = (count.get(chat.id) as { n: number }).n
    const from = prev && n >= prev.count ? Math.max(0, prev.count - TAIL) : 0
    idx.exec('BEGIN')
    try {
      dropFrom.run(chat.id, from)
      for (const row of rows.iterate(chat.id, from) as Iterable<{ seq: number; body: string }>) {
        const said = messageText(row.body)
        if (said) insert.run(said.text, chat.id, row.seq, said.role)
      }
      mark.run(chat.id, chat.updated_at, n)
      idx.exec('COMMIT')
    } catch (err) {
      idx.exec('ROLLBACK')
      throw err
    }
  }
  return true
}

/**
 * The user's words as an FTS5 query: every word must appear, each as a
 * prefix ("worktr" finds "worktree"), quoted so punctuation is never syntax.
 */
export function ftsQuery(query: string): string | null {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/"/g, '').trim())
    .filter(Boolean)
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null
}

/** The best match in each of up to `limit` chats, best chat first. */
export function searchIndex(idx: DatabaseSync, query: string, limit = 30): SearchHit[] {
  const match = ftsQuery(query)
  if (!match) return []
  const rows = idx
    .prepare(
      `SELECT chat_id, seq, role, snippet(docs, 0, ?, ?, '…', 14) AS snippet
       FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(HIT_OPEN, HIT_CLOSE, match, limit * 10) as { chat_id: string; seq: number; role: string; snippet: string }[]
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.chat_id)) continue
    seen.add(r.chat_id)
    hits.push({ chatId: r.chat_id, seq: Number(r.seq), role: r.role === 'user' ? 'user' : 'assistant', snippet: r.snippet })
    if (hits.length >= limit) break
  }
  return hits
}

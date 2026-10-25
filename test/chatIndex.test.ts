import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ftsQuery, HIT_CLOSE, HIT_OPEN, messageText, openIndex, searchIndex, syncIndex } from '../src/main/chatIndex.ts'

function source(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL, meta TEXT NOT NULL)')
  db.exec('CREATE TABLE messages (chat_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL)')
  return db
}

const user = (text: string): string => JSON.stringify({ id: 'u', role: 'user', text, ts: 0 })
const assistant = (...parts: unknown[]): string => JSON.stringify({ id: 'a', role: 'assistant', parts, ts: 0 })

function put(db: DatabaseSync, chat: string, at: number, bodies: string[]): void {
  db.prepare('INSERT OR REPLACE INTO chats VALUES (?, ?, ?, ?)').run(chat, at, '/x', '{}')
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat)
  bodies.forEach((b, seq) => db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(chat, seq, b))
}

function index(): DatabaseSync {
  const idx = new DatabaseSync(':memory:')
  openIndex(idx)
  return idx
}

test('keeps what was said, not tool calls or thinking', () => {
  assert.deepEqual(messageText(user('fix the chip')), { role: 'user', text: 'fix the chip' })
  const said = messageText(
    assistant(
      { type: 'thinking', text: 'secret plan' },
      { type: 'tool', name: 'Bash', input: { command: 'rm -rf build' } },
      { type: 'text', text: 'Done.' }
    )
  )
  assert.deepEqual(said, { role: 'assistant', text: 'Done.' })
  assert.equal(messageText(JSON.stringify({ role: 'event', text: 'x' })), null)
  assert.equal(messageText(assistant({ type: 'tool', name: 'Read' })), null)
  assert.equal(messageText('not json'), null)
})

test('finds a chat by a word from its conversation, prefix included', () => {
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('the worktree chip is clipped'), assistant({ type: 'text', text: 'Fixed the padding.' })])
  put(src, 'b', 2, [user('add dark mode'), assistant({ type: 'tool', name: 'Bash', input: { command: 'worktree list' } })])
  assert.equal(syncIndex(src, idx), true)
  const hits = searchIndex(idx, 'worktr')
  assert.deepEqual(hits.map((h) => h.chatId), ['a'])
  assert.ok(hits[0].snippet.includes(`${HIT_OPEN}worktree${HIT_CLOSE}`))
  assert.deepEqual(searchIndex(idx, 'padding').map((h) => [h.chatId, h.role]), [['a', 'assistant']])
})

test('every word must appear', () => {
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('dark mode for pricing')])
  put(src, 'b', 1, [user('dark sidebar')])
  syncIndex(src, idx)
  assert.deepEqual(searchIndex(idx, 'dark pricing').map((h) => h.chatId), ['a'])
})

test('a chat that grew is caught up; one that shrank is re-read whole', () => {
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('first question')])
  syncIndex(src, idx)
  put(src, 'a', 2, [user('first question'), assistant({ type: 'text', text: 'an answer about zebras' })])
  syncIndex(src, idx)
  assert.equal(searchIndex(idx, 'zebras').length, 1)
  assert.equal((idx.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n, 2)
  put(src, 'a', 3, [user('rewritten question')])
  syncIndex(src, idx)
  assert.equal(searchIndex(idx, 'zebras').length, 0)
  assert.equal(searchIndex(idx, 'rewritten').length, 1)
})

test('a deleted chat leaves the index', () => {
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('ephemeral thought')])
  syncIndex(src, idx)
  src.prepare('DELETE FROM chats WHERE id = ?').run('a')
  syncIndex(src, idx)
  assert.equal(searchIndex(idx, 'ephemeral').length, 0)
})

test('an unchanged chat is not re-read, and a spent budget stops between chats', () => {
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('one')])
  put(src, 'b', 1, [user('two')])
  assert.equal(syncIndex(src, idx, -1), false)
  assert.equal(syncIndex(src, idx), true)
  assert.equal(searchIndex(idx, 'one').length + searchIndex(idx, 'two').length, 2)
})

test('punctuation is never query syntax', () => {
  assert.equal(ftsQuery('  '), null)
  assert.equal(ftsQuery('a "b" c-d'), '"a"* "b"* "c-d"*')
  const src = source()
  const idx = index()
  put(src, 'a', 1, [user('use c-d flags (OR NOT)')])
  syncIndex(src, idx)
  assert.doesNotThrow(() => searchIndex(idx, 'OR NOT ('))
})

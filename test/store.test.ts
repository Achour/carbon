import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { AssistantMessage, ChatData, ChatMessage } from '../src/shared/types.ts'
import { Store } from '../src/main/store.ts'

// Store takes userDataDir by constructor precisely so it can run here: the whole
// file — migration included — depends only on node: builtins.
function userDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-store-'))
  mkdirSync(join(dir, 'chats'), { recursive: true })
  return dir
}

let seq = 0
function makeChat(patch: Partial<ChatData> = {}): ChatData {
  seq++
  return {
    id: `chat-${seq}`,
    title: `Chat ${seq}`,
    cwd: '/tmp/project',
    provider: 'claude',
    permissionMode: 'default',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
    ...patch
  }
}

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: 'user', text, ts: 1 }
}

function toolMsg(id: string, status: 'running' | 'success'): AssistantMessage {
  return {
    id,
    role: 'assistant',
    ts: 1,
    parts: [{ type: 'tool', toolUseId: `${id}-t`, name: 'Bash', status }]
  }
}

function rowCount(dir: string, chatId: string): number {
  const db = new DatabaseSync(join(dir, 'chats.db'), { readOnly: true })
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId) as {
    n: number
  }
  db.close()
  return Number(row.n)
}

function bodyAt(dir: string, chatId: string, s: number): string | null {
  const db = new DatabaseSync(join(dir, 'chats.db'), { readOnly: true })
  const row = db.prepare('SELECT body FROM messages WHERE chat_id = ? AND seq = ?').get(chatId, s) as
    | { body: string }
    | undefined
  db.close()
  return row?.body ?? null
}

// ---------- Round-trip ----------

test('a chat survives a store restart with its messages in order', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  for (let i = 0; i < 5; i++) {
    chat.messages.push(userMsg(`m${i}`, `hello ${i}`))
    chat.updatedAt = 2000 + i
    store.saveChat(chat.id)
  }
  await store.flushAll()

  const reopened = new Store(dir)
  const loaded = reopened.getChat(chat.id)
  assert.ok(loaded)
  assert.deepEqual(
    loaded.messages.map((m) => m.id),
    ['m0', 'm1', 'm2', 'm3', 'm4']
  )
  assert.equal(loaded.updatedAt, 2004)
  assert.deepEqual(
    reopened.listChats().map((c) => c.id),
    [chat.id]
  )
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('listChats sorts by updatedAt and never parses message bodies', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const older = makeChat({ updatedAt: 10 })
  const newer = makeChat({ updatedAt: 99 })
  store.addChat(older)
  store.addChat(newer)
  newer.messages.push(userMsg('x', 'body'))
  store.saveChat(newer.id)
  await store.flushAll()

  const reopened = new Store(dir)
  const metas = reopened.listChats()
  assert.deepEqual(
    metas.map((m) => m.id),
    [newer.id, older.id]
  )
  // ChatMeta is ChatData minus `messages` — the sidebar must never carry bodies.
  assert.ok(metas.every((m) => !('messages' in m)))
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Identity (hard constraint 2) ----------

test('getChat returns the same object a live holder is mutating, even after eviction', async () => {
  const dir = userDir()
  // A one-byte budget makes every non-MRU chat evictable on the next tick.
  const store = new Store(dir, { residentBudget: 1, saveDelayMs: 5 })
  const held = makeChat()
  store.addChat(held)
  held.messages.push(userMsg('live', 'streamed'))
  store.saveChat(held.id)
  assert.equal(store.getChat(held.id), held)

  // Admit another chat so `held` becomes the LRU victim.
  store.addChat(makeChat())
  await new Promise((r) => setImmediate(r))
  assert.ok(store.stats.evictions > 0, 'the budget must have forced an eviction')
  assert.ok(!store.residentIds().includes(held.id))

  // `held` is still reachable from this closure — exactly the situation a live
  // ClaudeSession/CodexSession is in — so the WeakRef must hand back that object.
  const again = store.getChat(held.id)
  assert.equal(again, held, 'identity must survive eviction while someone holds the chat')
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a debounced save is not dropped when the chat is not resident', async () => {
  const dir = userDir()
  const store = new Store(dir, { residentBudget: 1, saveDelayMs: 5 })
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(userMsg('m0', 'first'))
  store.saveChat(chat.id)
  store.addChat(makeChat())
  await new Promise((r) => setImmediate(r))
  assert.ok(!store.residentIds().includes(chat.id))

  // The old implementation early-returned when the chat was missing from the
  // in-memory map, silently losing the write.
  chat.messages.push(userMsg('m1', 'second'))
  chat.updatedAt = 7777
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))
  await store.flushAll()

  const reopened = new Store(dir)
  assert.deepEqual(
    reopened.getChat(chat.id)?.messages.map((m) => m.id),
    ['m0', 'm1']
  )
  assert.equal(reopened.getMeta(chat.id)?.updatedAt, 7777)
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('getMeta hands back the live object, so it can never be a stale copy', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  chat.title = 'renamed in memory'
  assert.equal(store.getMeta(chat.id), chat)
  assert.equal(store.getMeta(chat.id)?.title, 'renamed in memory')
  // Not live: a detached row, which is why getMeta is typed Readonly.
  await store.flushAll()
  const reopened = new Store(dir)
  const meta = reopened.getMeta(chat.id)
  assert.equal(meta?.title, 'Chat ' + chat.id.split('-')[1])
  assert.notEqual(meta, chat)
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Incremental writes ----------

test('a streaming save writes only the rows that changed', async () => {
  const dir = userDir()
  const store = new Store(dir, { saveDelayMs: 5 })
  const chat = makeChat()
  store.addChat(chat)
  for (let i = 0; i < 20; i++) chat.messages.push(userMsg(`m${i}`, `body ${i}`))
  store.saveChat(chat.id)

  const before = store.stats.rowWrites
  // Append one message and mutate the tail, the streaming shape. The debounced
  // path takes the incremental pass; the turn boundary takes the full one.
  chat.messages.push(userMsg('tail', 'tail v1'))
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))
  ;(chat.messages[chat.messages.length - 1] as { text: string }).text = 'tail v2'
  store.saveChat(chat.id)

  // Two passes over a 21-message chat: one row each, not 42.
  assert.equal(store.stats.rowWrites - before, 2)
  await store.flushAll()
  assert.equal(bodyAt(dir, chat.id, 20), JSON.stringify(chat.messages[20]))
  rmSync(dir, { recursive: true, force: true })
})

test('a tool that completes after later messages arrive is still persisted', async () => {
  const dir = userDir()
  const store = new Store(dir, { saveDelayMs: 5 })
  const chat = makeChat()
  store.addChat(chat)
  const tool = toolMsg('t0', 'running')
  chat.messages.push(tool)
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))

  // Push past it, so the tool message is neither the tail nor newly appended…
  chat.messages.push(userMsg('m1', 'next'))
  chat.messages.push(userMsg('m2', 'next next'))
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))

  // …then complete it, the way handleToolResults does long after the fact.
  ;(tool.parts[0] as { status: string }).status = 'success'
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))
  await store.flushAll()

  const reopened = new Store(dir)
  const loaded = reopened.getChat(chat.id)?.messages[0] as AssistantMessage
  assert.equal((loaded.parts[0] as { status: string }).status, 'success')
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('markMessageDirty persists a mutation the predicate cannot see', async () => {
  const dir = userDir()
  const store = new Store(dir, { saveDelayMs: 5 })
  const chat = makeChat()
  store.addChat(chat)
  const done = toolMsg('sealed', 'success')
  chat.messages.push(done)
  chat.messages.push(userMsg('after', 'later turn'))
  store.saveChat(chat.id)

  // The codex.ts:680 shape: assign to a fully terminal, non-tail message.
  done.fileChanges = [{ path: 'a.ts', additions: 3, deletions: 1 }]
  store.markMessageDirty(chat.id, 'sealed')
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 60))

  const persisted = JSON.parse(bodyAt(dir, chat.id, 0) ?? '{}') as AssistantMessage
  assert.deepEqual(persisted.fileChanges, [{ path: 'a.ts', additions: 3, deletions: 1 }])
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('the reconcile pass catches an unflagged mutation of an old message', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(userMsg('m0', 'original'))
  chat.messages.push(userMsg('m1', 'tail'))
  store.saveChat(chat.id)

  // Nothing flags this; only the full pass at the next turn boundary can see it.
  ;(chat.messages[0] as { text: string }).text = 'edited behind the predicate'
  store.saveChat(chat.id)

  const persisted = JSON.parse(bodyAt(dir, chat.id, 0) ?? '{}') as { text: string }
  assert.equal(persisted.text, 'edited behind the predicate')
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a tool born-and-terminalized while buried, on a tool-less snapshot, survives when flagged', async () => {
  // The review scenario the plain predicate misses: an assistant message is first
  // persisted holding ONLY thinking (a mid-stream snapshot), so it enters neither
  // the watched set (no live tool was ever observed) nor stays the tail. A tool
  // then appears and terminalizes entirely between two passes. Only claude.ts's
  // flagBuriedMutation -> markMessageDirty contract carries it to disk before the
  // next full reconcile; this pins that contract on the store side.
  const dir = userDir()
  const store = new Store(dir, { saveDelayMs: 5 })
  const chat = makeChat()
  store.addChat(chat)

  const asst: AssistantMessage = {
    id: 'a',
    role: 'assistant',
    ts: 1,
    parts: [{ type: 'thinking', text: 'hmm' }]
  }
  chat.messages.push(asst)
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 30))

  // A later turn buries it: no longer the tail, not newly appended.
  chat.messages.push(userMsg('u1', 'later'))
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 30))

  // Born already terminal, so hasLiveTool never sees it 'running' -> never watched.
  asst.parts.push({ type: 'tool', toolUseId: 'a-t', name: 'Bash', status: 'success', output: 'ok' })
  store.markMessageDirty(chat.id, 'a')
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 30))
  await store.flushAll()

  const reopened = new Store(dir)
  const loaded = reopened.getChat(chat.id)?.messages[0] as AssistantMessage
  assert.equal(loaded.parts.length, 2)
  assert.equal((loaded.parts[1] as { status?: string }).status, 'success')
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a write whose COMMIT fails forces a full reconcile, so no row is lost', async () => {
  // Phantom-baseline defect: reconcile/writeIncremental advance the in-memory
  // baseline inside the tx body, before COMMIT. A COMMIT that fails (SQLITE_FULL)
  // rolls the rows back but leaves the baseline claiming they are durable — so a
  // naive next incremental pass skips them. The fix sets needsFull in the catch.
  const dir = userDir()
  const store = new Store(dir, { saveDelayMs: 0, maxSaveDelayMs: 10 ** 9 })
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(userMsg('m0', 'zero'))
  chat.messages.push(userMsg('m1', 'one'))
  store.saveChat(chat.id) // clean full baseline: rows 0,1 durable, persisted = 2

  chat.messages.push(userMsg('m2', 'two'))
  const raw = (store as unknown as { db: { exec: (sql: string) => void } }).db
  const realExec = raw.exec.bind(raw)
  let failCommit = true
  raw.exec = (sql: string): void => {
    if (failCommit && sql.trim().toUpperCase().startsWith('COMMIT')) {
      failCommit = false
      throw new Error('simulated SQLITE_FULL at commit')
    }
    realExec(sql)
  }
  store.saveChatSoon(chat.id) // incremental: writes row 2, COMMIT throws, rolled back
  await new Promise((r) => setTimeout(r, 10))
  raw.exec = realExec
  assert.equal(rowCount(dir, chat.id), 2) // the failed commit really did roll back row 2

  // The chat is still dirty. A naive incremental pass would skip row 2 (baseline
  // says it is durable); needsFull must upgrade this to a full reconcile.
  chat.updatedAt = 5000
  store.saveChatSoon(chat.id)
  await new Promise((r) => setTimeout(r, 10))
  await store.flushAll()

  const reopened = new Store(dir)
  const loaded = reopened.getChat(chat.id)
  assert.equal(loaded?.messages.length, 3)
  assert.equal((loaded?.messages[2] as { text: string }).text, 'two')
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('an unreadable row keeps its slot instead of shifting later history', async () => {
  // Reported repro: m0,m1,m2 with m1 unreadable came back as m0,m2,m2 — the
  // hydrate compacted past m1, so every later message sat one seq too low and
  // the next reconcile rewrote each row with its neighbour's content.
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(userMsg('m0', 'zero'))
  chat.messages.push(userMsg('m1', 'one'))
  chat.messages.push(userMsg('m2', 'two'))
  store.saveChat(chat.id)
  await store.flushAll()

  // Damage exactly one row, the way a bad sector or a torn write would.
  const db = new DatabaseSync(join(dir, 'chats.db'))
  db.prepare('UPDATE messages SET body = ? WHERE chat_id = ? AND seq = 1').run('{not json', chat.id)
  db.close()

  const reopened = new Store(dir)
  const loaded = reopened.getChat(chat.id)!
  assert.equal(loaded.messages.length, 3, 'the slot count must be preserved')
  assert.equal((loaded.messages[0] as { text: string }).text, 'zero')
  assert.equal((loaded.messages[2] as { text: string }).text, 'two', 'm2 must stay at seq 2')
  assert.match(loaded.messages[1].id, /^unreadable-1$/)

  // A later turn must not write the placeholder over the damaged row: those
  // bytes are the only copy of that message left.
  chat.updatedAt = 9999
  loaded.updatedAt = 9999
  reopened.saveChat(chat.id)
  await reopened.flushAll()
  assert.equal(bodyAt(dir, chat.id, 1), '{not json', 'the original bytes must survive')
  assert.equal(bodyAt(dir, chat.id, 2), JSON.stringify(loaded.messages[2]), 'm2 row must be untouched')
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt database salvages post-migration history instead of reverting to stale JSON', async () => {
  // Reported repro: chats/*.json stop being written after the migration, so
  // rebuilding from them alone silently drops everything recorded since.
  const dir = userDir()
  const legacy: ChatData = {
    ...makeChat({ id: 'legacy-chat', updatedAt: 500 }),
    messages: [userMsg('old', 'from the archive')]
  }
  writeFileSync(join(dir, 'chats', 'legacy-chat.json'), JSON.stringify(legacy))

  const store = new Store(dir) // migrates the archive in
  const live = store.getChat('legacy-chat')!
  live.messages.push(userMsg('new', 'recorded after the migration'))
  live.updatedAt = 900
  store.saveChat('legacy-chat')
  await store.flushAll()

  // Corrupt the database header so it cannot be opened at all.
  writeFileSync(join(dir, 'chats.db'), Buffer.from('this is not a sqlite file at all'))
  rmSync(join(dir, 'chats.db-wal'), { force: true })
  rmSync(join(dir, 'chats.db-shm'), { force: true })

  const rebuilt = new Store(dir)
  const after = rebuilt.getChat('legacy-chat')
  assert.ok(after, 'the chat must survive a rebuild')
  // Recovery is complete here because flushAll left a backup — the archive is
  // the last rung of the ladder, not the one that answers this.
  assert.deepEqual(
    after.messages.map((m) => m.id),
    ['old', 'new'],
    'a rebuild must not silently roll history back to the migration'
  )
  // The damaged file is kept, never deleted, so nothing is unrecoverable.
  const setAside = readdirSync(dir).filter((f) => f.includes('chats.db.corrupt-'))
  assert.ok(setAside.length > 0, 'the corrupt database must be set aside, not discarded')
  await rebuilt.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a totally destroyed database recovers post-migration history from the backup', async () => {
  // The case the archive cannot answer: the live database is unreadable, so
  // localized salvage yields nothing. Without a real backup the only fallback is
  // chats/*.json, which stopped being written at the migration — so every
  // message recorded since would be lost.
  const dir = userDir()
  const legacy: ChatData = {
    ...makeChat({ id: 'c1', updatedAt: 500 }),
    messages: [userMsg('old', 'from the archive')]
  }
  writeFileSync(join(dir, 'chats', 'c1.json'), JSON.stringify(legacy))

  const store = new Store(dir)
  const live = store.getChat('c1')!
  live.messages.push(userMsg('new', 'recorded long after the migration'))
  live.updatedAt = 900
  store.saveChat('c1')
  await store.flushAll() // flushAll takes the snapshot
  assert.ok(existsSync(join(dir, 'chats.db.bak')), 'quit must leave a backup behind')

  // Total loss: the header itself is gone, so nothing is salvageable.
  writeFileSync(join(dir, 'chats.db'), Buffer.from('not a sqlite file'))
  rmSync(join(dir, 'chats.db-wal'), { force: true })
  rmSync(join(dir, 'chats.db-shm'), { force: true })

  const rebuilt = new Store(dir)
  const after = rebuilt.getChat('c1')!
  assert.deepEqual(
    after.messages.map((m) => m.id),
    ['old', 'new'],
    'the post-migration message must come back from the backup, not be lost to the archive'
  )
  await rebuilt.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('salvage carries readable rows and tombstones out of a damaged database', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const keep = makeChat({ id: 'keep' })
  store.addChat(keep)
  keep.messages.push(userMsg('k0', 'post-migration content'))
  store.saveChat('keep')
  const gone = makeChat({ id: 'gone' })
  store.addChat(gone)
  store.saveChat('gone')
  store.deleteChat('gone') // writes tomb:gone
  await store.flushAll()

  // Salvage reads the file that failed to OPEN, so exercise it directly against
  // a readable source — that is the partial-corruption case it exists for (a few
  // damaged pages, header and most rows still readable).
  const source = join(dir, 'chats.db')
  const into = userDir()
  const rebuilt = new Store(into)
  const n = (
    rebuilt as unknown as { salvage(from: string, into: unknown): number; db: unknown }
  ).salvage(source, (rebuilt as unknown as { db: unknown }).db)
  assert.ok(n >= 1, 'at least the surviving chat should be salvaged')

  const loaded = rebuilt.getChat('keep')
  assert.ok(loaded, 'a readable chat must be salvaged, not lost')
  assert.equal((loaded.messages[0] as { text: string }).text, 'post-migration content')

  const check = new DatabaseSync(join(into, 'chats.db'), { readOnly: true })
  const tomb = check.prepare("SELECT v FROM kv WHERE k = 'tomb:gone'").get() as
    | { v: string }
    | undefined
  check.close()
  assert.ok(tomb, 'tombstones must survive the rebuild or deletions are undone')

  await store.flushAll()
  await rebuilt.flushAll()
  rmSync(dir, { recursive: true, force: true })
  rmSync(into, { recursive: true, force: true })
})

test('a chat open in two instances is only written by the one that claimed it', async () => {
  // Reported repro: both instances append at the same (chat_id, seq) and the
  // last writer wins, so "from-a" disappears.
  const dir = userDir()
  const a = new Store(dir, { instanceId: 'A' })
  const chat = makeChat({ id: 'shared' })
  a.addChat(chat)
  chat.messages.push(userMsg('from-a', 'written by A'))
  a.saveChat('shared') // A claims the chat on its first write

  const denied: string[] = []
  const b = new Store(dir, { instanceId: 'B', onLockDenied: (id) => denied.push(id) })
  const bView = b.getChat('shared')!
  assert.equal(bView.messages.length, 1, 'reading in a second instance stays allowed')
  assert.equal(b.lockedElsewhere('shared'), true)

  // B appends at exactly the seq A would use next — the collision from the repro.
  bView.messages.push(userMsg('from-b', 'written by B'))
  b.saveChat('shared')
  assert.deepEqual(denied, ['shared'], 'the refusal must be reported, not silent')
  assert.equal(rowCount(dir, 'shared'), 1, "B's write must not land")
  assert.equal(JSON.parse(bodyAt(dir, 'shared', 0) ?? '{}').id, 'from-a', 'A must survive')

  // A keeps writing normally throughout.
  chat.messages.push(userMsg('a2', 'A again'))
  a.saveChat('shared')
  assert.equal(rowCount(dir, 'shared'), 2)

  // THE HANDOFF. A quits and releases the claim, so B can now take the lock —
  // but B's view was hydrated before a2 existed. Writing it would replace a2
  // with from-b. The rev check must refuse, and the final contents must still
  // be A's.
  await a.flushAll()
  assert.equal(b.lockedElsewhere('shared'), false, 'the claim is free once A quits')
  await b.flushAll()

  assert.equal(rowCount(dir, 'shared'), 2, "B must not truncate A's history")
  assert.equal(
    JSON.parse(bodyAt(dir, 'shared', 1) ?? '{}').id,
    'a2',
    'a2 must survive the handoff, not be replaced by B'
  )
  assert.equal(JSON.parse(bodyAt(dir, 'shared', 0) ?? '{}').id, 'from-a')

  // And a fresh instance reads exactly what A wrote.
  const c = new Store(dir, { instanceId: 'C' })
  const final = c.getChat('shared')!
  assert.deepEqual(
    final.messages.map((m) => m.id),
    ['from-a', 'a2'],
    'the surviving history is A\'s, in order'
  )
  await c.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('an instance that never contended still cannot replay a stale view after handoff', async () => {
  // The lock alone does not cover this: B never attempts a write while A owns
  // the chat, so B is never flagged. B simply holds a view hydrated before A's
  // last messages, and takes the lock cleanly once A quits. Only the rev check
  // stops B writing that view back over A's newer rows.
  const dir = userDir()
  const a = new Store(dir, { instanceId: 'A' })
  const chat = makeChat({ id: 'shared2' })
  a.addChat(chat)
  chat.messages.push(userMsg('m0', 'first'))
  a.saveChat('shared2')

  // B opens the chat to read it and does nothing else — no write, no contention.
  const denied: string[] = []
  const b = new Store(dir, { instanceId: 'B', onLockDenied: (id) => denied.push(id) })
  const bView = b.getChat('shared2')!
  assert.equal(bView.messages.length, 1)

  // A keeps working, then quits and hands the claim back.
  chat.messages.push(userMsg('a2', 'second, after B opened it'))
  a.saveChat('shared2')
  await a.flushAll()

  // Now B writes for the first time. The lock is free, so only the rev check
  // stands between B's stale view and A's history.
  bView.messages.push(userMsg('from-b', 'stale replay'))
  b.saveChat('shared2')

  assert.deepEqual(denied, ['shared2'], 'B must be told its view is stale')
  assert.equal(rowCount(dir, 'shared2'), 2, "B must not write over A's rows")
  assert.equal(
    JSON.parse(bodyAt(dir, 'shared2', 1) ?? '{}').id,
    'a2',
    'a2 must survive: B replayed a view from before it existed'
  )
  await b.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a lock left behind by a crashed instance goes stale and can be taken over', async () => {
  const dir = userDir()
  const owner = new Store(dir, { instanceId: 'crashed' })
  const chat = makeChat({ id: 'orphaned' })
  owner.addChat(chat)
  chat.messages.push(userMsg('m0', 'before the crash'))
  owner.saveChat('orphaned')
  // Simulate the crash: no flushAll, so the claim is never handed back. Age its
  // heartbeat past the staleness window.
  const db = new DatabaseSync(join(dir, 'chats.db'))
  db.prepare('UPDATE locks SET heartbeat = ? WHERE chat_id = ?').run(
    Date.now() - 120_000,
    'orphaned'
  )
  db.close()

  const next = new Store(dir, { instanceId: 'fresh' })
  assert.equal(next.lockedElsewhere('orphaned'), false, 'a dead claim must not wedge the chat')
  const view = next.getChat('orphaned')!
  view.messages.push(userMsg('m1', 'after the restart'))
  next.saveChat('orphaned')
  assert.equal(rowCount(dir, 'orphaned'), 2, 'the new instance must be able to write')
  await next.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('reconcile never deletes rows it does not have in memory', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(userMsg('m0', 'a'))
  chat.messages.push(userMsg('m1', 'b'))
  store.saveChat(chat.id)

  // Stand in for the other process that shares userData (dev + packaged build).
  const db = new DatabaseSync(join(dir, 'chats.db'))
  db.prepare('INSERT INTO messages (chat_id, seq, body) VALUES (?, ?, ?)').run(
    chat.id,
    2,
    JSON.stringify(userMsg('from-elsewhere', 'c'))
  )
  db.close()

  // `store` still holds two messages in memory. A full reconcile against a
  // database that now has three must not truncate the third.
  chat.updatedAt = 4242
  store.saveChat(chat.id)
  await store.flushAll()
  assert.equal(rowCount(dir, chat.id), 3)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Eviction ----------

test('eviction is byte-budgeted, drops the LRU first and keeps the MRU resident', async () => {
  const dir = userDir()
  // 500 KB of budget over six ~200 KB chats: the oldest have to go, and the
  // budget is in BYTES because the real corpus spans 82 KB to 36.6 MB per chat.
  const store = new Store(dir, { residentBudget: 500_000 })
  const big = 'x'.repeat(200_000)
  const ids: string[] = []
  for (let i = 0; i < 6; i++) {
    const chat = makeChat()
    ids.push(chat.id)
    store.addChat(chat)
    chat.messages.push(userMsg(`m${i}`, big))
    store.saveChat(chat.id)
    await new Promise((r) => setImmediate(r))
  }
  const resident = store.residentIds()
  assert.ok(resident.length < ids.length, 'something must have been evicted')
  assert.ok(resident.includes(ids[ids.length - 1]), 'the MRU chat stays resident')
  assert.ok(!resident.includes(ids[0]), 'the LRU chat goes first')
  // Evicted chats are still readable and still complete.
  for (const id of ids) assert.equal(store.getChat(id)?.messages.length, 1)
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Startup behaviour ----------

test('startup performs no writes and repairs orphaned tools at hydrate time', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  chat.messages.push(toolMsg('t0', 'running'))
  store.saveChat(chat.id)
  await store.flushAll()

  const reopened = new Store(dir)
  assert.equal(reopened.stats.rowWrites, 0, 'constructing the store must write nothing')
  assert.equal(reopened.stats.metaWrites, 0)
  reopened.listChats()
  assert.equal(reopened.stats.rowWrites, 0, 'listing the sidebar must write nothing')
  assert.equal(reopened.stats.hydrations, 0, 'the sidebar must not parse message bodies')

  const loaded = reopened.getChat(chat.id)
  const part = (loaded?.messages[0] as AssistantMessage).parts[0] as { status: string }
  assert.equal(part.status, 'error', 'a stale running tool is settled on hydrate')
  // The repair wrote exactly the one affected row.
  assert.equal(reopened.stats.rowWrites, 1)
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('flushAll writes only chats that were actually mutated', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const a = makeChat()
  const b = makeChat()
  store.addChat(a)
  store.addChat(b)
  await store.flushAll()

  const reopened = new Store(dir)
  reopened.getChat(a.id)
  const touched = reopened.getChat(b.id)
  assert.ok(touched)
  touched.title = 'changed'
  reopened.saveChatSoon(b.id)
  const rows = reopened.stats.rowWrites
  const metas = reopened.stats.metaWrites
  await reopened.flushAll()
  // One chats-row write for b; a was loaded but never dirtied. The old
  // implementation rewrote every loaded chat's file — 145 MB on every quit.
  assert.equal(reopened.stats.metaWrites - metas, 1)
  assert.equal(reopened.stats.rowWrites - rows, 0)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Deletion ----------

test('deleteChat removes both the meta row and every message row', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const chat = makeChat()
  store.addChat(chat)
  for (let i = 0; i < 4; i++) chat.messages.push(userMsg(`m${i}`, 'x'))
  store.saveChat(chat.id)
  store.deleteChat(chat.id)
  await store.flushAll()

  assert.equal(rowCount(dir, chat.id), 0)
  const reopened = new Store(dir)
  assert.equal(reopened.getChat(chat.id), null)
  assert.deepEqual(reopened.listChats(), [])
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('hasOtherChatIn sees non-resident chats and honours an unflushed cwd', async () => {
  const dir = userDir()
  const store = new Store(dir)
  const a = makeChat({ cwd: '/tmp/wt' })
  const b = makeChat({ cwd: '/tmp/wt' })
  store.addChat(a)
  store.addChat(b)
  await store.flushAll()

  const reopened = new Store(dir)
  assert.equal(reopened.hasOtherChatIn('/tmp/wt', a.id), true)
  assert.equal(reopened.hasOtherChatIn('/tmp/other', a.id), false)
  // Relocating b in memory must be visible before its row is rewritten.
  const live = reopened.getChat(b.id)!
  live.cwd = '/tmp/moved'
  assert.equal(reopened.hasOtherChatIn('/tmp/wt', a.id), false)
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Migration ----------

function writeLegacy(dir: string, chat: ChatData): string {
  const path = join(dir, 'chats', `${chat.id}.json`)
  writeFileSync(path, JSON.stringify(chat))
  return path
}

test('migration imports legacy JSON and never touches the source files', async () => {
  const dir = userDir()
  const a = makeChat({ updatedAt: 5 })
  a.messages.push(userMsg('m0', 'one'), userMsg('m1', 'two'))
  const b = makeChat({ updatedAt: 9 })
  b.messages.push(toolMsg('t0', 'running'))
  const pathA = writeLegacy(dir, a)
  const pathB = writeLegacy(dir, b)
  const rawA = readFileSync(pathA, 'utf8')

  const store = new Store(dir)
  assert.deepEqual(
    store.listChats().map((c) => c.id),
    [b.id, a.id]
  )
  assert.deepEqual(
    store.getChat(a.id)?.messages.map((m) => m.id),
    ['m0', 'm1']
  )
  // Hard constraint 1: the legacy corpus is read-only, forever.
  assert.equal(readFileSync(pathA, 'utf8'), rawA)
  assert.ok(existsSync(pathB))
  await store.flushAll()

  // Second launch must not re-import (and must not duplicate rows).
  const again = new Store(dir)
  assert.equal(rowCount(dir, a.id), 2)
  assert.equal(again.listChats().length, 2)
  await again.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('an unparseable legacy file is skipped, not fatal', async () => {
  const dir = userDir()
  const ok = makeChat()
  writeLegacy(dir, ok)
  writeFileSync(join(dir, 'chats', 'broken.json'), '{ this is not json')

  const store = new Store(dir)
  assert.deepEqual(
    store.listChats().map((c) => c.id),
    [ok.id]
  )
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a downgrade that writes newer JSON is re-imported; an older rewrite is not', async () => {
  const dir = userDir()
  const chat = makeChat({ updatedAt: 100 })
  chat.messages.push(userMsg('m0', 'before'))
  writeLegacy(dir, chat)

  const store = new Store(dir)
  const live = store.getChat(chat.id)!
  live.messages.push(userMsg('m1', 'written by the new build'))
  live.updatedAt = 200
  store.saveChat(chat.id)
  await store.flushAll()

  // The legacy flushAll rewrote every file on quit, so a fresh mtime alone must
  // never be enough — this rewrite carries OLDER data and has to be ignored.
  await new Promise((r) => setTimeout(r, 10))
  writeLegacy(dir, { ...chat, updatedAt: 100 })
  const guarded = new Store(dir)
  assert.deepEqual(
    guarded.getChat(chat.id)?.messages.map((m) => m.id),
    ['m0', 'm1']
  )
  await guarded.flushAll()

  // A genuine downgrade-era turn (strictly newer updatedAt) does win.
  await new Promise((r) => setTimeout(r, 10))
  writeLegacy(dir, {
    ...chat,
    updatedAt: 300,
    messages: [userMsg('m0', 'before'), userMsg('m1', 'written by the new build'), userMsg('m2', 'from the old build')]
  })
  const merged = new Store(dir)
  assert.deepEqual(
    merged.getChat(chat.id)?.messages.map((m) => m.id),
    ['m0', 'm1', 'm2']
  )
  await merged.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a chat deleted here is not resurrected by a later legacy rewrite', async () => {
  const dir = userDir()
  const chat = makeChat({ updatedAt: 100 })
  writeLegacy(dir, chat)
  const store = new Store(dir)
  assert.equal(store.listChats().length, 1)
  store.deleteChat(chat.id)
  await store.flushAll()

  await new Promise((r) => setTimeout(r, 10))
  writeLegacy(dir, chat) // an older build quits and rewrites every file
  const reopened = new Store(dir)
  assert.deepEqual(reopened.listChats(), [])
  await reopened.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- Crash safety ----------

test('SIGKILL mid-stream loses nothing that was committed', async () => {
  const dir = userDir()
  const storePath = fileURLToPath(new URL('../src/main/store.ts', import.meta.url))
  const script = join(dir, 'writer.mjs')
  writeFileSync(
    script,
    `import { Store } from ${JSON.stringify(storePath)}
const store = new Store(${JSON.stringify(dir)})
const chat = { id: 'kill-me', title: 'k', cwd: '/tmp', provider: 'claude', permissionMode: 'default', createdAt: 1, updatedAt: 1, messages: [] }
store.addChat(chat)
for (let i = 0; i < 200; i++) {
  chat.messages.push({ id: 'm' + i, role: 'user', text: 'x'.repeat(2000), ts: i })
  chat.updatedAt = i
  store.saveChat(chat.id)
}
console.log('COMMITTED')
// No flushAll, no close: exactly the force-quit the old temp-file+rename dance
// was there to survive.
process.kill(process.pid, 'SIGKILL')
`
  )
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.match(child.stdout, /COMMITTED/)

  // Reopening must recover the WAL and see every committed row.
  const db = new DatabaseSync(join(dir, 'chats.db'))
  const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  assert.equal(check.integrity_check, 'ok')
  db.close()
  const store = new Store(dir)
  assert.equal(store.getChat('kill-me')?.messages.length, 200)
  await store.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt database is set aside and rebuilt from the untouched JSON', async () => {
  const dir = userDir()
  const chat = makeChat()
  chat.messages.push(userMsg('m0', 'irreplaceable'))
  writeLegacy(dir, chat)
  const store = new Store(dir)
  assert.equal(store.getChat(chat.id)?.messages.length, 1)
  await store.flushAll()

  writeFileSync(join(dir, 'chats.db'), 'this is not a database')
  const rebuilt = new Store(dir)
  assert.equal(rebuilt.getChat(chat.id)?.messages.length, 1)
  await rebuilt.flushAll()
  rmSync(dir, { recursive: true, force: true })
})

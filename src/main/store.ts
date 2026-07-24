import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync, backup, type StatementSync } from 'node:sqlite'
import type {
  AppDefaults,
  ChatData,
  ChatMessage,
  ChatMeta,
  EffortId,
  PermissionModeId,
  ServiceTier
} from '@shared/types'

/**
 * Write via a temp file + atomic rename so a crash or force-quit mid-write can't
 * leave a half-written (and thus unparseable) JSON file. Only settings.json is
 * written this way now — chats live in SQLite, which gets the same guarantee
 * from its own journal.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

interface SettingsFile {
  defaults: AppDefaults
  windowBounds?: { x?: number; y?: number; width: number; height: number }
}

const DEFAULT_SETTINGS: SettingsFile = {
  defaults: { permissionMode: 'default', recentDirs: [] }
}

const SCHEMA_VERSION = 2

/**
 * How long a lock survives without a heartbeat before another instance may take
 * it. Generous: the cost of stealing too early is two instances writing the same
 * chat again, the cost of stealing too late is a chat that stays read-only for a
 * few seconds after a crash.
 */
const LOCK_STALE_MS = 30_000
const HEARTBEAT_MS = 10_000

/**
 * How often a rolling backup of chats.db is taken, and how many pages each
 * step copies. The legacy chats/*.json archive stops tracking reality the
 * moment the migration lands, so it cannot answer "the database is a total
 * loss" — only a real backup can. Incremental (`rate`) so the copy yields to
 * the event loop instead of stalling the window for the size of the corpus.
 */
const BACKUP_MS = 5 * 60_000
const BACKUP_RATE = 256

/**
 * Ceiling on parsed message bytes we keep in memory. A budget in BYTES rather
 * than in chats because the corpus is wildly skewed — median chat 82 KB, the
 * largest 36.6 MB — so "keep N chats" would either evict nothing worth evicting
 * or blow the heap on one outlier.
 */
const RESIDENT_BUDGET = 64 * 1024 * 1024

/**
 * Floor for the full reconcile pass. Turn boundaries (`saveChat`) reconcile
 * unconditionally; this only covers a turn that runs longer than this without
 * reaching one, so the backstop's exposure is bounded by wall clock too.
 */
const RECONCILE_FLOOR_MS = 30_000

/**
 * How much of a chat one non-thorough reconcile may re-serialize. The tail is
 * always checked; the rest is covered by a rotating cursor across passes, so the
 * safety net stays sound while no single pass stalls the main thread for the
 * size of the whole chat.
 */
const RECONCILE_TAIL = 8
const RECONCILE_VERIFY_BYTES = 512 * 1024

/**
 * Injected the way worktree.ts injects its clock and codex.ts its SDK factory:
 * so the residency and debounce behaviour can be exercised by `node --test`
 * without waiting seconds or allocating megabytes.
 */
export interface StoreOptions {
  /** Ceiling on resident message bytes before the LRU starts evicting. */
  residentBudget?: number
  /** Trailing debounce for streaming saves. */
  saveDelayMs?: number
  /** Hard ceiling on how long a streaming save can be deferred. */
  maxSaveDelayMs?: number
  /**
   * Called the first time a chat's writes are refused because another live
   * instance owns it. Main turns this into a `chat-locked` event so the window
   * can say so rather than silently dropping the user's turn.
   */
  onLockDenied?: (chatId: string) => void
  /** Overrides the per-process id; tests use it to stage a second instance. */
  instanceId?: string
}

/**
 * No provider process survives an application restart, so persisted
 * running/pending tool states are stale. Returns the indices of the messages it
 * repaired — the caller writes exactly those rows instead of the whole chat.
 * Runs at hydrate time for the one chat being opened, not at boot for all of
 * them, so startup performs zero writes.
 */
function settleOrphanedTools(chat: ChatData): number[] {
  const changed: number[] = []
  const settle = (parts: unknown): boolean => {
    if (!Array.isArray(parts)) return false
    let hit = false
    for (const raw of parts) {
      if (!raw || typeof raw !== 'object') continue
      const part = raw as { type?: string; status?: string; children?: unknown[] }
      if (part.type === 'tool' && (part.status === 'running' || part.status === 'pending')) {
        part.status = 'error'
        hit = true
      }
      if (part.children && settle(part.children)) hit = true
    }
    return hit
  }
  chat.messages.forEach((message, index) => {
    if (message.role === 'assistant' && settle(message.parts)) changed.push(index)
  })
  return changed
}

/**
 * Does this message still hold a tool the agent can come back and finish? Every
 * mutation of an already-appended message in claude.ts (handleToolResults,
 * markToolDenied, terminalizeRunning, sub-agent children) and codex.ts
 * (updateCodexAgent, completeCodexAgentTool, terminalizeRunning) only ever
 * touches a part in one of these two states — which is what lets the
 * incremental write pass skip everything else. Shallow: it never touches text.
 */
function hasLiveTool(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  const scan = (parts: unknown): boolean => {
    if (!Array.isArray(parts)) return false
    for (const raw of parts) {
      if (!raw || typeof raw !== 'object') continue
      const part = raw as { type?: string; status?: string; children?: unknown[] }
      if (part.type !== 'tool') continue
      if (part.status === 'running' || part.status === 'pending') return true
      if (part.children && scan(part.children)) return true
    }
    return false
  }
  return scan(message.parts)
}

function metaOf(chat: ChatData): ChatMeta {
  const { messages: _messages, ...meta } = chat
  return meta
}

/**
 * Stand-in for a row that would not parse, or a `seq` with no row at all. It
 * exists to HOLD THE POSITION: dropping the slot and compacting would renumber
 * every later message, and the next reconcile — which matches in-memory index to
 * stored `seq` — would then rewrite each row with its neighbour's content,
 * turning one unreadable message into a corrupted tail. The slot is recorded in
 * `Resident.corrupt` so no write pass ever overwrites the original bytes; the
 * damaged row stays on disk exactly as found, available for manual recovery.
 */
function unreadableMessage(seq: number): ChatMessage {
  return {
    id: `unreadable-${seq}`,
    role: 'assistant',
    ts: 0,
    parts: [{ type: 'text', text: '⚠️ This message could not be read from the chat database.' }]
  }
}

/** A chat held in the strong residency set, with its write baseline. */
interface Resident {
  chat: ChatData
  /**
   * JSON text of the rows we last wrote, kept only for the indices in the
   * current write window — so this cache is O(live window), not O(chat size).
   */
  bodies: Map<number, string>
  /** JSON text of the chats row we last wrote. */
  metaJson: string
  /** Indices that held a live tool on the previous pass; see candidateRows. */
  watched: Set<number>
  /** Indices flagged by markMessageDirty — mutations the predicate can't see. */
  forced: Set<number>
  /**
   * Rows we believe exist for this chat. ADVISORY only: the reconcile pass
   * recomputes it from what the database actually holds, so a crash can never
   * leave a counter claiming rows that aren't there.
   */
  persisted: number
  /** Sum of persisted body lengths — the currency of RESIDENT_BUDGET. */
  bytes: number
  /** When the last full reconcile ran, for RECONCILE_FLOOR_MS. */
  reconciledAt: number
  /** Set after a WeakRef re-admission, where there is no in-memory baseline. */
  needsFull: boolean
  /**
   * Slots holding an `unreadableMessage` placeholder. Every write pass skips
   * these, so a row we could not parse is never overwritten by the placeholder
   * that stands in for it.
   */
  corrupt: Set<number>
  /**
   * The `chats.rev` this baseline was built against, or -1 for a chat with no
   * row yet. A write asserts this still matches disk: if it does not, another
   * instance advanced the chat while we were not looking and our messages would
   * overwrite theirs at the same seq.
   */
  rev: number
  /** Set once writes are refused; cleared only by a fresh hydrate. */
  refused: boolean
  /** Rotating position for the bounded reconcile's verification window. */
  scanCursor: number
}

/** Thrown when a write would overwrite another instance's newer state. */
class StaleView extends Error {}

export class Store {
  private chatsDir: string
  private settingsPath: string
  private settings: SettingsFile
  private db: DatabaseSync
  private closed = false

  /** Strong residency set, in LRU order (Map preserves insertion order). */
  private resident = new Map<string, Resident>()
  /**
   * Evicted chats someone else may still hold. THE IDENTITY GUARANTEE: there is
   * at most one ChatData per id alive in this process, and `getChat` always
   * returns it. Provider sessions keep `this.chat` for their whole lifetime and
   * mutate it in place (claude.ts:411, codex.ts:340), so while a session lives
   * its WeakRef always resolves and it is re-admitted as the same object.
   *
   * A WeakRef rather than a strong pin keyed on ChatManager.sessions because
   * that pin would have to stay in sync across createSession, pruneIdleSessions,
   * the onDead callback and disposeChat — and it would still miss async holders
   * like ChatManager.runCodexCommand, which carries a ChatData across awaits
   * with no entry in `sessions` at all. The GC can only reclaim the object once
   * nothing holds it, which is exactly when identity stops being observable.
   */
  private evicted = new Map<string, WeakRef<ChatData>>()
  /**
   * MUTATED IMPLIES STRONGLY HELD UNTIL DURABLE. Populated synchronously by
   * saveChat/saveChatSoon and cleared when the write lands, so a debounced write
   * can never be dropped because the chat fell out of the residency set (and the
   * GC can never collect a chat between its mutation and its flush).
   */
  private dirty = new Map<string, ChatData>()
  /** Body-byte size per chat id, kept across eviction so re-admission can budget. */
  private sizes = new Map<string, number>()
  private saveTimers = new Map<string, NodeJS.Timeout>()
  private firstDirtyAt = new Map<string, number>()
  private evictScheduled = false
  private budget: number
  private saveDelayMs: number
  private maxSaveDelayMs: number
  /** Identifies this process in the `locks` table. */
  private instanceId: string
  /** Chats whose write lock this instance currently holds. */
  private held = new Set<string>()
  /** Chats we have already reported as locked, so the UI is told once. */
  private denied = new Set<string>()
  /**
   * Chats written this session whose whole contents have NOT been verified
   * against disk since. A bounded reconcile checks the tail plus a rotating
   * window, and an incremental pass checks even less — so a mutation outside
   * that window can be durable-looking (the chat leaves `dirty`) while still
   * absent from the database. Quit thorough-checks this set as well as `dirty`,
   * which is what stops such a mutation reverting on the next launch.
   */
  private unverified = new Set<string>()
  private onLockDenied?: (chatId: string) => void
  private heartbeat: NodeJS.Timeout | null = null
  private backupPath: string
  private backupTimer: NodeJS.Timeout | null = null
  private backupInFlight = false
  /** Something has been written since the last successful backup. */
  private backupDue = false

  /**
   * Instrumentation, not API. The acceptance tests pin the two properties that
   * are easy to regress silently: startup performs zero writes, and a streaming
   * save writes one row rather than the whole chat.
   */
  readonly stats = { rowWrites: 0, metaWrites: 0, hydrations: 0, evictions: 0 }

  private selMeta!: StatementSync
  private selBodies!: StatementSync
  private upsertChat!: StatementSync
  private upsertMsg!: StatementSync
  private selRev!: StatementSync
  private selLens!: StatementSync
  private selSeqs!: StatementSync
  private selBody!: StatementSync

  constructor(userDataDir: string, opts: StoreOptions = {}) {
    this.budget = opts.residentBudget ?? RESIDENT_BUDGET
    this.saveDelayMs = opts.saveDelayMs ?? 1500
    this.maxSaveDelayMs = opts.maxSaveDelayMs ?? 5000
    this.instanceId = opts.instanceId ?? randomUUID()
    this.onLockDenied = opts.onLockDenied
    this.chatsDir = join(userDataDir, 'chats')
    this.settingsPath = join(userDataDir, 'settings.json')
    mkdirSync(this.chatsDir, { recursive: true })
    this.settings = this.readSettings()
    this.backupPath = join(userDataDir, 'chats.db.bak')
    this.db = this.openDb(join(userDataDir, 'chats.db'))
    this.prepare()
    this.migrate()
    // unref: a heartbeat must never be the reason the process stays alive.
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.backupTimer = setInterval(() => void this.backup(), BACKUP_MS)
    this.backupTimer.unref?.()
  }

  // ---------- Database ----------

  private openDb(path: string): DatabaseSync {
    try {
      return this.connect(path)
    } catch (err) {
      // The legacy chats/*.json STOP being written once the migration lands, so
      // they are a snapshot of the corpus at that moment — not a live backup.
      // Rebuilding from them alone would silently drop every chat and message
      // recorded since. So: set the damaged file aside, then salvage whatever
      // SQLite can still read out of it (corruption is usually localised to a
      // few pages), and only afterwards let migrate() fill the remaining gaps
      // from the JSON archive under its `guard` — which cannot overwrite a
      // salvaged row with an older one.
      console.error('Chat database unusable, salvaging what is readable:', err)
      const aside = `${path}.corrupt-${Date.now()}`
      let moved = false
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix)
        }
        moved = true
      } catch (renameErr) {
        console.error('Failed to set aside the corrupt database:', renameErr)
      }
      const fresh = this.connect(path)
      // Precedence: the damaged live database first (newest, maybe partial),
      // then the rolling backup (recent and known-good), and only then the
      // chats/ archive — which is frozen at the migration and therefore the
      // last resort, not the backstop it looks like.
      const salvaged = moved ? this.salvage(aside, fresh) : 0
      const restored = existsSync(this.backupPath) ? this.salvage(this.backupPath, fresh, true) : 0
      console.error(
        `Chat database rebuild: ${salvaged} chats salvaged from ${moved ? aside : 'nothing'}, ` +
          `${restored} restored from the backup. Anything still missing comes from chats/, ` +
          `which is only current as of the migration.`
      )
      return fresh
    }
  }

  /**
   * Best-effort copy of a damaged database into a fresh one. Each chat moves in
   * its own transaction so one unreadable chat cannot abort the rest, and `kv`
   * comes too — it carries `migrated_at` and the deletion tombstones, without
   * which the JSON archive would resurrect every chat the user has deleted.
   */
  private salvage(fromPath: string, into: DatabaseSync, onlyMissing = false): number {
    let chats = 0
    let old: DatabaseSync | null = null
    try {
      old = new DatabaseSync(fromPath, { readOnly: true })
      // OR IGNORE in gap-fill mode: the newer source's kv (tombstones above all)
      // must win, or restoring from an older backup would undo deletions.
      const insKv = into.prepare(
        onlyMissing
          ? 'INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)'
          : 'INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)'
      )
      try {
        for (const raw of old.prepare('SELECT k, v FROM kv').all()) {
          const row = raw as unknown as { k: string; v: string }
          insKv.run(row.k, row.v)
        }
      } catch (kvErr) {
        console.error('Could not salvage kv (tombstones/migration marker):', kvErr)
      }
      const insChat = into.prepare(
        'INSERT OR REPLACE INTO chats (id, updated_at, cwd, meta) VALUES (?, ?, ?, ?)'
      )
      const insMsg = into.prepare(
        'INSERT OR REPLACE INTO messages (chat_id, seq, body) VALUES (?, ?, ?)'
      )
      const selMsgs = old.prepare('SELECT seq, body FROM messages WHERE chat_id = ?')
      const rows = old.prepare('SELECT id, updated_at, cwd, meta FROM chats').all()
      const present = onlyMissing
        ? new Set((into.prepare('SELECT id FROM chats').all() as { id: string }[]).map((r) => r.id))
        : new Set<string>()
      for (const raw of rows) {
        const c = raw as unknown as { id: string; updated_at: number; cwd: string; meta: string }
        // A chat already recovered from the newer source wins; the backup only
        // fills what that source could not produce.
        if (present.has(c.id)) continue
        // And never resurrect a chat the user deleted: the tombstone recorded at
        // deletion outranks any backup taken before it.
        if (onlyMissing) {
          const tomb = into.prepare('SELECT v FROM kv WHERE k = ?').get(`tomb:${c.id}`) as
            | { v: string }
            | undefined
          if (tomb) continue
        }
        try {
          into.exec('BEGIN IMMEDIATE')
          insChat.run(c.id, c.updated_at, c.cwd, c.meta)
          for (const rawMsg of selMsgs.all(c.id)) {
            const m = rawMsg as unknown as { seq: number; body: string }
            insMsg.run(c.id, m.seq, m.body)
          }
          into.exec('COMMIT')
          chats++
        } catch (chatErr) {
          try {
            into.exec('ROLLBACK')
          } catch {
            // Already unwound by the failure itself.
          }
          console.error(`Could not salvage chat ${c.id}:`, chatErr)
        }
      }
    } catch (openErr) {
      console.error('Could not read the corrupt database at all:', openErr)
    } finally {
      try {
        old?.close()
      } catch {
        // Nothing useful to do if the damaged handle will not close.
      }
    }
    return chats
  }

  private connect(path: string): DatabaseSync {
    const db = new DatabaseSync(path)
    // WAL: readers never block the writer, and SQLite recovers a torn tail on
    // open instead of leaving unparseable state behind.
    db.exec('PRAGMA journal_mode = WAL')
    // Same durability class as the old writeFileSync + renameSync with no fsync:
    // a force-quit loses nothing, an OS crash can lose the last transactions.
    db.exec('PRAGMA synchronous = NORMAL')
    // Dev and packaged builds share userData by design (see index.ts), so two
    // processes can contend for the write lock.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id         TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        cwd        TEXT NOT NULL,
        meta       TEXT NOT NULL,
        -- Bumped on every meta write. The lock stops two instances writing a
        -- chat AT THE SAME TIME; this stops the second one writing a view it
        -- hydrated BEFORE the first instance's changes landed. Without it a
        -- denied instance silently replays its stale messages the moment the
        -- owner quits and the lock frees up.
        rev        INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chats_updated_at ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS chats_cwd ON chats(cwd);

      -- Deliberately a rowid table: the hot path is writes, and keeping the big
      -- body in the heap B-tree keeps the (chat_id, seq) index tiny. If the
      -- per-message write amplification ever matters (the corpus already holds a
      -- 5.3 MB message, rewritten on every debounce while it is the live tail),
      -- the lever is a part_seq column here — an added column, not a rewrite.
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        body    TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS messages_pk ON messages(chat_id, seq);

      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;

      -- Per-chat write ownership. userData is deliberately shared between the
      -- dev and packaged builds, so two instances can have the same chat open;
      -- without this they both append at the same (chat_id, seq) and the last
      -- writer silently erases the other's message. Advisory and per-CHAT rather
      -- than a single-instance lock, so the shared-history workflow survives:
      -- only the chat actually being written is claimed. A heartbeat older than
      -- LOCK_STALE_MS is treated as dead, so a crash cannot wedge a chat.
      CREATE TABLE IF NOT EXISTS locks (
        chat_id   TEXT PRIMARY KEY,
        owner     TEXT NOT NULL,
        heartbeat INTEGER NOT NULL
      ) STRICT;
    `)
    // Databases created before `rev` existed get the column added in place;
    // SCHEMA_VERSION is untouched so this does not re-trigger a legacy rescan.
    const cols = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'rev')) {
      db.exec('ALTER TABLE chats ADD COLUMN rev INTEGER NOT NULL DEFAULT 0')
    }
    return db
  }

  private prepare(): void {
    this.selMeta = this.db.prepare('SELECT meta FROM chats WHERE id = ?')
    this.selBodies = this.db.prepare('SELECT seq, body FROM messages WHERE chat_id = ? ORDER BY seq')
    this.upsertChat = this.db.prepare(
      `INSERT INTO chats (id, updated_at, cwd, meta, rev) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
                                     cwd = excluded.cwd,
                                     meta = excluded.meta,
                                     rev = chats.rev + 1
       RETURNING rev`
    )
    this.selRev = this.db.prepare('SELECT rev FROM chats WHERE id = ?')
    this.selLens = this.db.prepare(
      'SELECT seq, length(body) AS n FROM messages WHERE chat_id = ? ORDER BY seq'
    )
    // Covering: messages_pk is (chat_id, seq), so this answers "which rows
    // exist" straight from the index without touching a single body page —
    // the difference between a ~20 ms scan of a 34 MB chat and a ~1 ms one.
    this.selSeqs = this.db.prepare('SELECT seq FROM messages WHERE chat_id = ? ORDER BY seq')
    this.selBody = this.db.prepare('SELECT body FROM messages WHERE chat_id = ? AND seq = ?')
    // A true upsert, not INSERT OR REPLACE: on a rowid table the latter would
    // delete and reinsert, churning the heap on every streaming tail write.
    this.upsertMsg = this.db.prepare(
      `INSERT INTO messages (chat_id, seq, body) VALUES (?, ?, ?)
       ON CONFLICT(chat_id, seq) DO UPDATE SET body = excluded.body`
    )
  }

  /**
   * Claim write ownership of a chat, or confirm we still hold it. Acquired
   * LAZILY, on the first write rather than on open, so merely viewing a chat in
   * a second window never blocks the instance that is actually streaming into
   * it. Returns false when another instance holds a live claim.
   */
  private acquire(chatId: string): boolean {
    if (this.held.has(chatId)) return true
    try {
      return this.tx(() => {
        const row = this.db.prepare('SELECT owner, heartbeat FROM locks WHERE chat_id = ?').get(chatId) as
          | { owner: string; heartbeat: number }
          | undefined
        const now = Date.now()
        if (row && row.owner !== this.instanceId && now - Number(row.heartbeat) < LOCK_STALE_MS) {
          return false
        }
        this.db
          .prepare(
            `INSERT INTO locks (chat_id, owner, heartbeat) VALUES (?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET owner = excluded.owner, heartbeat = excluded.heartbeat`
          )
          .run(chatId, this.instanceId, now)
        this.held.add(chatId)
        return true
      })
    } catch (err) {
      // A lock table we cannot read must not take persistence down with it —
      // fall back to the pre-lock behaviour rather than refusing every write.
      console.error('Could not evaluate the chat lock; writing anyway:', err)
      return true
    }
  }

  /**
   * Stop writing this chat and say so once. Both reasons mean the same thing to
   * the user — what is on screen here is not what is being saved — and both are
   * cleared the same way: close it in the other instance, then reopen it here,
   * which hydrates a fresh baseline. Dropping it from `dirty` stops a refused
   * chat being retried on every later flush.
   */
  private refuse(id: string, entry: Resident, reason: string): void {
    entry.refused = true
    this.dirty.delete(id)
    if (!this.denied.has(id)) {
      this.denied.add(id)
      console.error(`Chat ${id} ${reason}; not saving here.`)
      this.onLockDenied?.(id)
    }
  }

  /** Is another live instance writing this chat? Drives the read-only banner. */
  lockedElsewhere(chatId: string): boolean {
    if (this.held.has(chatId) || this.closed) return false
    try {
      const row = this.db.prepare('SELECT owner, heartbeat FROM locks WHERE chat_id = ?').get(chatId) as
        | { owner: string; heartbeat: number }
        | undefined
      if (!row || row.owner === this.instanceId) return false
      return Date.now() - Number(row.heartbeat) < LOCK_STALE_MS
    } catch {
      return false
    }
  }

  /** Keep every claim we hold alive; a stalled instance loses them by timeout. */
  private beat(): void {
    if (this.closed || this.held.size === 0) return
    try {
      const stmt = this.db.prepare(
        'UPDATE locks SET heartbeat = ? WHERE chat_id = ? AND owner = ?'
      )
      const now = Date.now()
      for (const chatId of this.held) stmt.run(now, chatId, this.instanceId)
    } catch (err) {
      console.error('Failed to refresh chat locks:', err)
    }
  }

  private releaseLocks(): void {
    if (this.held.size === 0) return
    try {
      const stmt = this.db.prepare('DELETE FROM locks WHERE chat_id = ? AND owner = ?')
      for (const chatId of this.held) stmt.run(chatId, this.instanceId)
    } catch (err) {
      console.error('Failed to release chat locks:', err)
    }
    this.held.clear()
  }

  private kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v ?? null
  }

  private kvSet(key: string, value: string): void {
    this.backupDue = true
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value)
  }

  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction was already unwound by the failure itself.
      }
      throw err
    }
  }

  // ---------- Migration ----------

  /**
   * One-time import of userData/chats/*.json, then a cheap re-import check on
   * every later launch. NOTHING in chats/ is ever written, renamed or deleted:
   * the legacy files stay exactly where they are, which makes `rm chats.db` a
   * complete, permanent rollback.
   */
  private migrate(): void {
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
        ?.user_version ?? 0
    )
    if (version < SCHEMA_VERSION) {
      const started = Date.now()
      let imported = 0
      // Has this database ever held state? `migrated_at` is written once the
      // first import completes, and is carried over by salvage() after a
      // rebuild — so it, not user_version, is what distinguishes a virgin
      // install from a database that already has history and tombstones. (A
      // rebuilt database is a fresh FILE, so its user_version is 0 even though
      // its contents are not virgin.)
      const seeded = this.kvGet('migrated_at') !== null
      const existing = new Set(
        (this.db.prepare('SELECT id FROM chats').all() as { id: string }[]).map((r) => r.id)
      )
      for (const file of this.legacyFiles()) {
        // A crash mid-migration resumes by skipping the ids already committed.
        if (existing.has(file.slice(0, -'.json'.length))) continue
        // On a virgin install the permissive form is right (it imports even a
        // updatedAt=0 chat). Once seeded — a future schema bump, or a rebuild
        // after corruption — the legacy files on disk include the archives of
        // chats deleted since, so the tomb/floor must be respected or every
        // deletion is undone.
        if (this.importLegacy(join(this.chatsDir, file), seeded)) imported++
      }
      // The marker goes last, after every chat row is committed, so it can never
      // claim data the database does not actually hold.
      this.kvSet('migrated_at', String(Date.now()))
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      if (imported) console.log(`Imported ${imported} chats into chats.db in ${Date.now() - started}ms`)
      return
    }
    this.reimportChanged()
  }

  private legacyFiles(): string[] {
    try {
      return readdirSync(this.chatsDir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  }

  /**
   * Downgrade hedge. An older build still reads chats/*.json and still writes
   * them, so anything it recorded after the migration would be invisible here.
   * statSync every legacy file (~1 ms for 165) and parse only the ones touched
   * since the last scan. The `updatedAt` guard is required, not belt-and-braces:
   * the legacy flushAll rewrote ALL 165 files on every quit, so mtime alone
   * would clobber post-migration work with older data on the very first launch.
   */
  private reimportChanged(): void {
    const since = Number(this.kvGet('migrated_at') ?? 0)
    if (!since) return
    let reimported = 0
    let newest = since
    for (const file of this.legacyFiles()) {
      const path = join(this.chatsDir, file)
      let mtime = 0
      try {
        // Floor it: mtimeMs carries sub-millisecond precision that Date.now()
        // does not, and without this every file written in the same millisecond
        // as the migration looks newer than it on the very next launch.
        mtime = Math.floor(statSync(path).mtimeMs)
      } catch {
        continue
      }
      if (mtime <= since) continue
      newest = Math.max(newest, mtime)
      if (this.importLegacy(path, true)) reimported++
    }
    if (reimported) console.log(`Re-imported ${reimported} chats written by an older build`)
    // Only when something actually moved, so a steady-state launch writes nothing.
    if (newest > since) this.kvSet('migrated_at', String(newest))
  }

  /**
   * Import one legacy file. With `guard`, the file only wins if it is strictly
   * newer than what the database (or a tombstone from a deletion made here)
   * already knows. Verification is a byte-exact read-back of every row in seq
   * order — strictly stronger than a row count, and it catches the
   * seq-assignment mistakes a count cannot see. A mismatch rolls the whole chat
   * back, leaving the JSON to be retried on the next launch.
   */
  private importLegacy(path: string, guard: boolean): boolean {
    let chat: ChatData
    try {
      chat = JSON.parse(readFileSync(path, 'utf8')) as ChatData
    } catch (err) {
      console.error(`Failed to load chat ${path}:`, err)
      return false
    }
    if (!chat?.id || !Array.isArray(chat.messages)) return false
    if (guard) {
      const known = this.db.prepare('SELECT updated_at FROM chats WHERE id = ?').get(chat.id) as
        | { updated_at: number }
        | undefined
      const tomb = Number(this.kvGet(`tomb:${chat.id}`) ?? 0)
      const floor = Math.max(known?.updated_at ?? 0, tomb)
      if (!(Number(chat.updatedAt) > floor)) return false
    }
    const bodies = chat.messages.map((m) => JSON.stringify(m))
    try {
      this.tx(() => {
        this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id)
        this.writeMeta(chat)
        for (let i = 0; i < bodies.length; i++) this.upsertMsg.run(chat.id, i, bodies[i])
        let seen = 0
        for (const raw of this.selBodies.iterate(chat.id)) {
          const row = raw as unknown as { seq: number; body: string }
          if (row.seq !== seen || row.body !== bodies[seen]) {
            throw new Error(`row ${row.seq} did not round-trip`)
          }
          seen++
        }
        if (seen !== bodies.length) throw new Error(`wrote ${seen} of ${bodies.length} messages`)
      })
    } catch (err) {
      console.error(`Failed to import chat ${chat.id}, leaving its JSON in place:`, err)
      return false
    }
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(`tomb:${chat.id}`)
    this.sizes.set(chat.id, bodies.reduce((n, b) => n + b.length, 0))
    return true
  }

  // ---------- Residency ----------

  /** The one live ChatData for `id`, if anything in this process still holds it. */
  private live(id: string): ChatData | null {
    const entry = this.resident.get(id)
    if (entry) return entry.chat
    return this.dirty.get(id) ?? this.evicted.get(id)?.deref() ?? null
  }

  private admit(
    chat: ChatData,
    bodies: Map<number, string>,
    bytes: number,
    corrupt: Set<number> = new Set()
  ): Resident {
    const entry: Resident = {
      chat,
      bodies,
      metaJson: JSON.stringify(metaOf(chat)),
      watched: new Set(),
      forced: new Set(),
      persisted: chat.messages.length,
      bytes,
      reconciledAt: Date.now(),
      needsFull: false,
      corrupt,
      rev: this.diskRev(chat.id),
      refused: false,
      scanCursor: 0
    }
    for (let i = 0; i < chat.messages.length; i++) {
      if (hasLiveTool(chat.messages[i])) entry.watched.add(i)
    }
    this.evicted.delete(chat.id)
    this.resident.set(chat.id, entry)
    this.sizes.set(chat.id, bytes)
    this.scheduleEvict()
    return entry
  }

  /** Move to the MRU end of the LRU. */
  private touch(id: string): void {
    const entry = this.resident.get(id)
    if (!entry) return
    this.resident.delete(id)
    this.resident.set(id, entry)
  }

  /**
   * Off the synchronous path that admitted the chat, so a chat switch never pays
   * for a cascade of reconcile passes inside one IPC handler.
   */
  private scheduleEvict(): void {
    if (this.evictScheduled || this.closed) return
    this.evictScheduled = true
    setImmediate(() => {
      this.evictScheduled = false
      if (!this.closed) this.evictOverBudget()
    })
  }

  private evictOverBudget(): void {
    let total = 0
    for (const entry of this.resident.values()) total += entry.bytes
    if (total <= this.budget) return
    // Oldest first; the MRU entry is the one just admitted, so it is never a
    // candidate. Dirty chats are skipped — they are mid-turn by definition.
    const order = [...this.resident.entries()].slice(0, -1)
    for (const [id, entry] of order) {
      if (total <= this.budget) return
      if (this.dirty.has(id)) continue
      // THOROUGH, not bounded: this is the last moment the chat is guaranteed
      // reachable. After the strong ref goes, only a WeakRef remains, and a
      // collected object cannot be re-verified at quit — so an older unflagged
      // mutation that a bounded pass skipped would be lost outright.
      if (!this.writeChat(id, true, true)) continue
      // Still not fully on disk (a refused or failed write): keep it resident
      // rather than trade correctness for memory.
      if (this.unverified.has(id)) continue
      this.resident.delete(id)
      this.evicted.set(id, new WeakRef(entry.chat))
      this.stats.evictions++
      total -= entry.bytes
    }
  }

  /** Residency snapshot for the memory acceptance tests. */
  residentIds(): string[] {
    return [...this.resident.keys()]
  }

  // ---------- Reads ----------

  listChats(): ChatMeta[] {
    const rows = this.db.prepare('SELECT id, meta FROM chats ORDER BY updated_at DESC').all() as {
      id: string
      meta: string
    }[]
    const out: ChatMeta[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      // Read title/updatedAt off the live object when there is one — including
      // a chat that fell out of the byte budget mid-turn — so the sidebar is
      // never up to a debounce interval stale.
      const chat = this.live(row.id)
      if (chat) {
        out.push(metaOf(chat))
      } else {
        try {
          out.push(JSON.parse(row.meta) as ChatMeta)
        } catch (err) {
          console.error(`Failed to parse chat meta ${row.id}:`, err)
          continue
        }
      }
      seen.add(row.id)
    }
    for (const [id, entry] of this.resident) if (!seen.has(id)) out.push(metaOf(entry.chat))
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * The chat's own fields without hydrating its message bodies. Returns the SAME
   * object getChat would when one is live, so it can never hand back a stale
   * copy; `Readonly` keeps that from becoming a licence to mutate it — a
   * detached row is not what the sessions hold, so mutation sites use getChat.
   */
  getMeta(id: string): Readonly<ChatMeta> | null {
    const chat = this.live(id)
    if (chat) return chat
    const row = this.selMeta.get(id) as { meta: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.meta) as ChatMeta
    } catch (err) {
      console.error(`Failed to parse chat meta ${id}:`, err)
      return null
    }
  }

  getChat(id: string): ChatData | null {
    const resident = this.resident.get(id)
    if (resident) {
      this.touch(id)
      return resident.chat
    }
    const held = this.live(id)
    if (held) {
      // Someone still holds it, so re-admit that exact object. There is no
      // in-memory write baseline any more, so the next save reconciles in full.
      const entry = this.admit(held, new Map(), this.sizes.get(id) ?? 0)
      entry.needsFull = true
      return held
    }
    const row = this.selMeta.get(id) as { meta: string } | undefined
    if (!row) return null
    this.stats.hydrations++
    let chat: ChatData
    try {
      chat = { ...(JSON.parse(row.meta) as ChatMeta), messages: [] }
    } catch (err) {
      console.error(`Failed to parse chat meta ${id}:`, err)
      return null
    }
    const bodies = new Map<number, string>()
    const corrupt = new Set<number>()
    let bytes = 0
    let maxSeq = -1
    let tail = ''
    for (const raw of this.selBodies.iterate(id)) {
      const rowMsg = raw as unknown as { seq: number; body: string }
      if (!Number.isInteger(rowMsg.seq) || rowMsg.seq < 0) continue
      // Place each message AT ITS OWN seq. Pushing would compact past an
      // unparseable row and silently renumber the rest of the chat.
      try {
        chat.messages[rowMsg.seq] = JSON.parse(rowMsg.body) as ChatMessage
      } catch (err) {
        console.error(`Failed to parse message ${id}/${rowMsg.seq}:`, err)
        chat.messages[rowMsg.seq] = unreadableMessage(rowMsg.seq)
        corrupt.add(rowMsg.seq)
      }
      bytes += rowMsg.body.length
      if (rowMsg.seq > maxSeq) {
        maxSeq = rowMsg.seq
        tail = rowMsg.body
      }
    }
    // A seq with no row at all (one lost outright) leaves a hole; fill it so the
    // array has no undefined entries, and mark it so no pass overwrites it.
    for (let i = 0; i < chat.messages.length; i++) {
      if (!chat.messages[i]) {
        chat.messages[i] = unreadableMessage(i)
        corrupt.add(i)
      }
    }
    // Seed the baseline with the tail alone: the next streaming pass rewrites it
    // only if it actually changed, and the rest of the window is rebuilt lazily.
    // Never for a corrupt tail — its placeholder is not what the row holds.
    if (chat.messages.length && !corrupt.has(chat.messages.length - 1)) {
      bodies.set(chat.messages.length - 1, tail)
    }
    const repaired = settleOrphanedTools(chat)
    const entry = this.admit(chat, bodies, bytes, corrupt)
    if (repaired.length) {
      for (const index of repaired) entry.forced.add(index)
      this.writeChat(id, false)
    }
    return chat
  }

  /**
   * Is any chat other than `exceptId` working in `cwd`? Used before removing a
   * worktree, so a directory another chat still occupies is left alone.
   */
  hasOtherChatIn(cwd: string, exceptId: string): boolean {
    // Live objects first and authoritatively: a chat whose cwd just changed in
    // memory must not be judged by whatever its row still says.
    const live = new Set<string>()
    for (const id of this.liveIds()) {
      const chat = this.live(id)
      if (!chat) continue
      live.add(id)
      if (id !== exceptId && chat.cwd === cwd) return true
    }
    const rows = this.db.prepare('SELECT id FROM chats WHERE cwd = ? AND id <> ?').all(cwd, exceptId) as {
      id: string
    }[]
    return rows.some((r) => !live.has(r.id))
  }

  private liveIds(): Set<string> {
    const ids = new Set<string>(this.resident.keys())
    for (const id of this.dirty.keys()) ids.add(id)
    for (const [id, ref] of this.evicted) if (ref.deref()) ids.add(id)
    return ids
  }

  // ---------- Writes ----------

  addChat(chat: ChatData): void {
    this.admit(chat, new Map(), 0)
    this.saveChat(chat.id)
  }

  deleteChat(id: string): void {
    // Stop any pending debounced write up front so it cannot race the delete.
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    this.firstDirtyAt.delete(id)
    const forget = (): void => {
      this.dirty.delete(id)
      this.unverified.delete(id)
      this.resident.delete(id)
      this.evicted.delete(id)
      this.sizes.delete(id)
    }
    // No durable delete is possible after the database is closed; just drop it.
    if (this.closed) return forget()
    // Clamp the tombstone to the chat's last-known edit time. A bare Date.now()
    // can be LOWER than a legacy file's updatedAt if the clock stepped backwards
    // since that edit — and then the downgrade hedge (reimportChanged) would rank
    // the archive above the tomb and resurrect the chat. max(now, updatedAt) can
    // never be out-ranked by an edit that predates the deletion.
    const updatedAt =
      Number(this.live(id)?.updatedAt) ||
      Number(
        (
          this.db.prepare('SELECT updated_at FROM chats WHERE id = ?').get(id) as
            | { updated_at?: number }
            | undefined
        )?.updated_at
      ) ||
      0
    try {
      this.tx(() => {
        // A deletion is a change the backup must capture: without this the next
        // clean quit skips the snapshot, and a later rebuild restores the chat
        // the user deleted from a backup that predates the deletion.
        this.backupDue = true
        this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id)
        this.db.prepare('DELETE FROM chats WHERE id = ?').run(id)
        this.db.prepare('DELETE FROM locks WHERE chat_id = ?').run(id)
        // The legacy chats/<id>.json is never deleted (it is the rollback
        // archive), so record the deletion — otherwise the downgrade hedge would
        // resurrect the chat the next time an older build rewrote that file.
        this.kvSet(`tomb:${id}`, String(Math.max(Date.now(), updatedAt)))
      })
    } catch (err) {
      // The durable delete failed. Keep every in-memory entry so a still-live
      // provider session's later mutations are not silently dropped, and so the
      // chat is not left forgotten-yet-undeleted (which a later flush could
      // resurrect tombstone-less). It stays visible; the user can retry.
      console.error('Failed to delete chat:', err)
      return
    }
    forget()
  }

  /**
   * Turn boundary / explicit user action. Reconciles the chat in full against
   * what is on disk, so the loss window for any mutation the incremental
   * predicate cannot see is one turn rather than a stretch of wall clock.
   */
  saveChat(id: string): void {
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    this.firstDirtyAt.delete(id)
    const chat = this.live(id)
    if (chat) this.dirty.set(id, chat)
    this.writeChat(id, true)
  }

  /**
   * Trailing debounce for streaming updates, with a five-second maximum delay so
   * a long-running turn still gets periodic crash-recovery snapshots. The write
   * itself is incremental: one or two rows, not the whole chat.
   */
  saveChatSoon(id: string): void {
    const chat = this.live(id)
    // Mutated implies strongly held until durable — the chat cannot be evicted
    // or collected between here and the timer firing.
    if (chat) this.dirty.set(id, chat)
    const existing = this.saveTimers.get(id)
    if (existing) clearTimeout(existing)
    const now = Date.now()
    const first = this.firstDirtyAt.get(id) ?? now
    this.firstDirtyAt.set(id, first)
    const delay = Math.min(this.saveDelayMs, Math.max(0, this.maxSaveDelayMs - (now - first)))
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id)
        this.firstDirtyAt.delete(id)
        this.writeChat(id, false)
      }, delay)
    )
  }

  /**
   * Flag a message the incremental predicate is blind to: one that is fully
   * terminal and no longer the tail, yet still gets mutated. The one such site
   * today is codex.ts, which assigns `fileChanges` after terminalizeRunning has
   * already driven every part of that message terminal.
   */
  markMessageDirty(chatId: string, messageId: string): void {
    const entry = this.entryFor(chatId)
    if (!entry) return
    for (let i = entry.chat.messages.length - 1; i >= 0; i--) {
      if (entry.chat.messages[i].id === messageId) {
        entry.forced.add(i)
        return
      }
    }
  }

  /**
   * Indices worth re-serializing on an incremental pass: everything appended
   * since the last write, the live tail, anything that holds (or held, on the
   * previous pass, so its completion is still caught) an unfinished tool, and
   * anything markMessageDirty flagged.
   */
  private candidateRows(entry: Resident): number[] {
    const messages = entry.chat.messages
    const set = new Set<number>()
    for (let i = Math.max(0, entry.persisted); i < messages.length; i++) set.add(i)
    if (messages.length) set.add(messages.length - 1)
    for (const i of entry.watched) if (i < messages.length) set.add(i)
    for (const i of entry.forced) if (i < messages.length) set.add(i)
    entry.watched.clear()
    for (let i = 0; i < messages.length; i++) {
      if (hasLiveTool(messages[i])) {
        set.add(i)
        entry.watched.add(i)
      }
    }
    // Never write back over a row we could not read: the placeholder standing in
    // for it is not its content, and the original bytes are the only copy left.
    for (const i of entry.corrupt) set.delete(i)
    return [...set].sort((a, b) => a - b)
  }

  private writeMeta(chat: ChatData): { json: string; rev: number } {
    const json = JSON.stringify(metaOf(chat))
    // updated_at and cwd are promoted out of the JSON because they are the only
    // two fields anything queries. Everything else in ChatMeta rides in `meta`,
    // so adding a field in shared/types.ts never needs a schema migration.
    const row = this.upsertChat.get(
      chat.id,
      Math.trunc(Number(chat.updatedAt)) || 0,
      chat.cwd ?? '',
      json
    ) as { rev?: number } | undefined
    this.stats.metaWrites++
    // Metadata is data: a rename, a resumed sessionId, a cwd move. Without this
    // a meta-only change never triggers a snapshot, and a rebuild restores the
    // stale value from a backup taken before it.
    this.backupDue = true
    return { json, rev: Number(row?.rev ?? 0) }
  }

  /**
   * Roll a fresh copy of chats.db to chats.db.bak. Written to a temp path and
   * renamed, so a backup interrupted half way never replaces a good one with a
   * torn file — the whole point is that this copy is trustworthy when the live
   * database is not.
   */
  async backup(): Promise<boolean> {
    if (this.closed || this.backupInFlight || !this.backupDue) return false
    this.backupInFlight = true
    const tmp = `${this.backupPath}.tmp`
    try {
      await backup(this.db, tmp, { rate: BACKUP_RATE })
      renameSync(tmp, this.backupPath)
      // Only now: a write that landed mid-copy may not be in this snapshot, and
      // clearing the flag first would let it be missed by the next one too.
      this.backupDue = false
      return true
    } catch (err) {
      console.error('Failed to back up the chat database:', err)
      try {
        if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`)
      } catch {
        // Nothing further to do; the previous good backup is still in place.
      }
      return false
    } finally {
      this.backupInFlight = false
    }
  }

  /**
   * Advance `rev` for a chat whose MESSAGE rows changed but whose meta did not.
   * Streaming is exactly this shape — a tool completing, or a part landing, with
   * `updatedAt` unchanged — and without this the row write is invisible to the
   * stale-view check, so another instance holding an older view could overwrite
   * it the moment it acquired the lock.
   */
  private bumpRev(id: string): number {
    this.backupDue = true
    const row = this.db
      .prepare('UPDATE chats SET rev = rev + 1 WHERE id = ? RETURNING rev')
      .get(id) as { rev?: number } | undefined
    return Number(row?.rev ?? 0)
  }

  /** One stored body, fetched only for rows inside the verification window. */
  private bodyOf(chatId: string, seq: number): string | null {
    const row = this.selBody.get(chatId, seq) as { body: string } | undefined
    return row?.body ?? null
  }

  /** The rev currently on disk, or -1 when the chat has no row yet. */
  private diskRev(id: string): number {
    const row = this.selRev.get(id) as { rev?: number } | undefined
    return row ? Number(row.rev ?? 0) : -1
  }

  private putRow(chatId: string, seq: number, body: string): void {
    this.upsertMsg.run(chatId, seq, body)
    this.stats.rowWrites++
    this.backupDue = true
  }

  private writeChat(id: string, full: boolean, thorough = false): boolean {
    if (this.closed) return false
    const entry = this.entryFor(id)
    if (!entry) return false
    // Another live instance owns this chat. Refusing is the whole point: writing
    // anyway would upsert our messages over theirs at the same (chat_id, seq).
    // The chat stays fully usable in memory — it just does not reach disk — and
    // the UI is told once so the user is not silently losing the turn.
    // Already told the user this chat is not being saved here; a fresh hydrate
    // is the only thing that clears it. Retrying would just churn.
    if (entry.refused) return false
    if (!this.acquire(id)) {
      this.refuse(id, entry, 'is open in another Carbon instance')
      return false
    }
    this.denied.delete(id)
    if (entry.needsFull || Date.now() - entry.reconciledAt >= RECONCILE_FLOOR_MS) full = true
    try {
      this.tx(() => {
        // Inside the transaction, so the check and the write cannot straddle
        // another instance's commit. Holding the lock is not sufficient on its
        // own: a denied instance can acquire it later, once the owner quits and
        // releases — and would then write the view it hydrated before any of the
        // owner's changes landed, silently replacing them.
        const onDisk = this.diskRev(id)
        if (entry.rev >= 0 && onDisk >= 0 && onDisk !== entry.rev) throw new StaleView()
        return full ? this.reconcile(entry, thorough) : this.writeIncremental(entry)
      })
      this.dirty.delete(id)
      return true
    } catch (err) {
      if (err instanceof StaleView) {
        this.refuse(id, entry, 'changed in another Carbon instance since it was opened here')
        return false
      }
      // reconcile()/writeIncremental() advance the in-memory baseline (bodies,
      // persisted, reconciledAt) inside the tx body, before COMMIT. A COMMIT that
      // fails (SQLITE_FULL, an fsync error) rolls the rows back but leaves that
      // baseline claiming never-committed data as durable — so the next
      // incremental pass would skip the divergent rows. Force the next pass to be
      // a full reconcile, which reads what the database actually holds and
      // rewrites anything that differs; and keep the chat in `dirty` so it retries.
      entry.needsFull = true
      // The rollback also reverted `rev` on disk, while the in-memory copy was
      // advanced inside the tx. Resync to disk truth, or the next write would
      // mistake our own rolled-back bump for another instance's change and
      // refuse to save — turning a transient I/O error into a dead chat.
      entry.rev = this.diskRev(id)
      console.error('Failed to save chat:', err)
      return false
    }
  }

  /** Resolve the write baseline, re-admitting a live-but-evicted chat. */
  private entryFor(id: string): Resident | null {
    const existing = this.resident.get(id)
    if (existing) return existing
    const chat = this.live(id)
    if (!chat) return null
    const entry = this.admit(chat, new Map(), this.sizes.get(id) ?? 0)
    entry.needsFull = true
    return entry
  }

  private writeIncremental(entry: Resident): void {
    const { chat } = entry
    let metaWritten = false
    if (JSON.stringify(metaOf(chat)) !== entry.metaJson) {
      const written = this.writeMeta(chat)
      entry.metaJson = written.json
      entry.rev = written.rev
      metaWritten = true
    }
    const indices = this.candidateRows(entry)
    const kept = new Map<number, string>()
    let wroteRows = false
    for (const i of indices) {
      const body = JSON.stringify(chat.messages[i])
      const previous = entry.bodies.get(i)
      if (body !== previous) {
        this.putRow(chat.id, i, body)
        entry.bytes += body.length - (previous?.length ?? 0)
        wroteRows = true
      }
      kept.set(i, body)
    }
    // Rows changed but meta did not: the write still has to be visible to the
    // stale-view check, or a streamed message is unprotected.
    if (wroteRows && !metaWritten) entry.rev = this.bumpRev(chat.id)
    // Prune the baseline to the window, so it stays O(live window) rather than
    // growing into a second copy of the chat.
    entry.bodies = kept
    entry.forced.clear()
    entry.persisted = chat.messages.length
    this.sizes.set(chat.id, entry.bytes)
    // An incremental pass only looks at its candidate window, so it can never
    // establish that the rest of the chat matches disk.
    this.unverified.add(chat.id)
  }

  /**
   * Full pass: stream what the database actually holds and rewrite only the rows
   * that differ. The sound backstop the incremental predicate is measured
   * against, and the only pass that can repair a row nobody flagged.
   *
   * It deliberately never DELETEs. `chat.messages` is append-only (nothing in
   * src/main splices, pops or truncates it), so extra rows can only come from
   * another process that shares this userData — and dropping them would destroy
   * real history to satisfy a stale in-memory array.
   */
  private reconcile(entry: Resident, thorough = false): void {
    const { chat } = entry
    const writtenMeta = this.writeMeta(chat)
    entry.metaJson = writtenMeta.json
    entry.rev = writtenMeta.rev
    const messages = chat.messages
    // Which rows exist, and how big they are, WITHOUT pulling 36 MB of bodies
    // into JS. length() is computed in SQLite, so this pass costs a table scan
    // rather than a scan plus a string allocation per row.
    // A thorough pass recomputes exact byte totals (it is re-serializing
    // everything anyway); a routine one only needs to know WHICH rows exist, and
    // gets that from the covering index without reading any body.
    const storedLen = new Map<number, number>()
    const storedSeqs = new Set<number>()
    let stored = 0
    if (thorough) {
      for (const raw of this.selLens.iterate(chat.id)) {
        const row = raw as unknown as { seq: number; n: number }
        stored = Math.max(stored, row.seq + 1)
        storedLen.set(row.seq, Number(row.n))
        storedSeqs.add(row.seq)
      }
    } else {
      for (const raw of this.selSeqs.iterate(chat.id)) {
        const seq = Number((raw as unknown as { seq: number }).seq)
        stored = Math.max(stored, seq + 1)
        storedSeqs.add(seq)
      }
    }

    // Verifying every message means re-serializing the whole chat, which is the
    // single largest stall in the store (~40 ms on the 36 MB chat) and it lands
    // on the Electron main thread at every turn boundary. Bound it: always check
    // the live tail, then continue a rotating cursor through the rest until the
    // byte budget is spent. Successive passes cover the whole chat, so the
    // safety net still catches an unflagged mutation — just a few turns later
    // rather than immediately. `thorough` (quit, or an explicit full pass)
    // ignores the budget and checks everything.
    const verify = new Set<number>()
    for (let i = Math.max(0, messages.length - RECONCILE_TAIL); i < messages.length; i++) {
      verify.add(i)
    }
    if (thorough) {
      for (let i = 0; i < messages.length; i++) verify.add(i)
    } else {
      let budget = RECONCILE_VERIFY_BYTES
      let cursor = entry.scanCursor
      for (let n = 0; n < messages.length && budget > 0; n++) {
        cursor = cursor % Math.max(1, messages.length)
        if (!verify.has(cursor)) {
          verify.add(cursor)
          budget -= storedLen.get(cursor) ?? Math.ceil(entry.bytes / Math.max(1, messages.length))
        }
        cursor++
      }
      entry.scanCursor = cursor % Math.max(1, messages.length)
    }

    const changed: [number, string][] = []
    let bytes = 0
    let unmeasured = 0
    let tail = ''
    for (let i = 0; i < messages.length; i++) {
      // An unreadable row keeps its stored bytes and its slot: comparing the
      // placeholder against it would "repair" real (if damaged) history away.
      if (entry.corrupt.has(i)) {
        bytes += storedLen.get(i) ?? 0
        unmeasured++
        continue
      }
      const has = storedSeqs.has(i)
      if (has && !verify.has(i)) {
        // Not in this pass's window: trust the stored row. Its exact size is
        // only known on a thorough pass, so a routine one carries the previous
        // total forward rather than pretending to recompute it.
        bytes += storedLen.get(i) ?? 0
        unmeasured++
        continue
      }
      const body = JSON.stringify(messages[i])
      if (!has || body !== this.bodyOf(chat.id, i)) changed.push([i, body])
      bytes += body.length
      if (i === messages.length - 1) tail = body
    }
    // The tail must always have a baseline, even when it was trusted unverified.
    if (!tail && messages.length && !entry.corrupt.has(messages.length - 1)) {
      tail = JSON.stringify(messages[messages.length - 1])
    }
    for (const [seq, body] of changed) this.putRow(chat.id, seq, body)
    if (stored > messages.length) {
      console.error(
        `Chat ${chat.id}: ${stored} stored messages vs ${messages.length} in memory; leaving the extras alone`
      )
    }
    // Keep only the tail as a baseline; candidateRows rebuilds the rest of the
    // window on the next incremental pass.
    entry.bodies = new Map()
    if (messages.length && !entry.corrupt.has(messages.length - 1)) {
      entry.bodies.set(messages.length - 1, tail)
    }
    entry.forced.clear()
    entry.persisted = messages.length
    // A partial pass cannot produce an exact total, and a wrong one would
    // mis-drive the RESIDENT_BUDGET LRU. Keep the last exact figure instead.
    if (unmeasured === 0) entry.bytes = bytes
    // Only a pass that actually compared every message can promise the chat is
    // fully on disk; anything less leaves work for the thorough pass at quit.
    if (unmeasured === 0) this.unverified.delete(chat.id)
    else this.unverified.add(chat.id)
    entry.reconciledAt = Date.now()
    entry.needsFull = false
    this.sizes.set(chat.id, entry.bytes)
  }

  /**
   * Quit path. Only chats that were actually mutated get written — the old
   * implementation rewrote every loaded chat's file on every single quit.
   * Closing the database checkpoints the WAL back into chats.db.
   */
  async flushAll(): Promise<void> {
    if (this.closed) return
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    this.firstDirtyAt.clear()
    // dirty ∪ unverified: a chat can have left `dirty` after a bounded pass that
    // silently skipped the very mutation this thorough pass exists to catch.
    for (const id of new Set([...this.dirty.keys(), ...this.unverified])) {
      this.writeChat(id, true, true)
    }
    this.unverified.clear()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.backupTimer) clearInterval(this.backupTimer)
    this.backupTimer = null
    // A clean quit is the best moment to snapshot: everything dirty has just
    // been flushed, so the backup is exactly the state the user last saw.
    await this.backup()
    // Hand every claim back before closing, so the next instance to open these
    // chats does not have to wait out LOCK_STALE_MS.
    this.releaseLocks()
    this.closed = true
    try {
      this.db.close()
    } catch (err) {
      console.error('Failed to close the chat database:', err)
    }
  }

  // ---------- Settings ----------

  private readSettings(): SettingsFile {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<SettingsFile>
        return {
          ...DEFAULT_SETTINGS,
          ...raw,
          defaults: { ...DEFAULT_SETTINGS.defaults, ...raw.defaults }
        }
      }
    } catch (err) {
      console.error('Failed to read settings:', err)
    }
    return structuredClone(DEFAULT_SETTINGS)
  }

  private writeSettings(): void {
    try {
      writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    } catch (err) {
      console.error('Failed to write settings:', err)
    }
  }

  getDefaults(): AppDefaults {
    return this.settings.defaults
  }

  /**
   * Remember the user's last chosen options as the defaults for new chats.
   * `currentModel` is the model the effort was chosen under (the chat's model
   * when the patch itself carries none), so effort can also be remembered
   * per-model — see `AppDefaults.modelEfforts`.
   */
  rememberOptions(
    patch: {
      model?: string
      effort?: EffortId | ''
      serviceTier?: ServiceTier
      permissionMode?: PermissionModeId
    },
    currentModel?: string
  ): void {
    const defaults = this.settings.defaults
    if (patch.permissionMode !== undefined) defaults.permissionMode = patch.permissionMode
    if (patch.model !== undefined) defaults.model = patch.model || undefined
    if (patch.effort !== undefined) defaults.effort = patch.effort || undefined
    if (patch.serviceTier !== undefined) defaults.serviceTier = patch.serviceTier
    if (patch.effort !== undefined) {
      const key = patch.model !== undefined ? patch.model || '' : currentModel || ''
      const map = { ...(defaults.modelEfforts ?? {}) }
      // Empty string is an explicit "use provider default" choice, distinct
      // from this model having no remembered effort yet.
      map[key] = patch.effort
      defaults.modelEfforts = map
    }
    this.writeSettings()
  }

  rememberDir(dir: string): void {
    const dirs = this.settings.defaults.recentDirs.filter((d) => d !== dir)
    dirs.unshift(dir)
    this.settings.defaults.recentDirs = dirs.slice(0, 8)
    this.writeSettings()
  }

  forgetDir(dir: string): void {
    this.settings.defaults.recentDirs = this.settings.defaults.recentDirs.filter((d) => d !== dir)
    this.writeSettings()
  }

  getWindowBounds(): SettingsFile['windowBounds'] {
    return this.settings.windowBounds
  }

  setWindowBounds(bounds: NonNullable<SettingsFile['windowBounds']>): void {
    this.settings.windowBounds = bounds
    this.writeSettings()
  }
}

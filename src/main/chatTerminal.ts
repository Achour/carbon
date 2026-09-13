import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { open, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatData, ChatEvent, ChatMeta, Provider, TerminalEvent } from '@shared/types'
import { chatTerminalId, isChatTerminalId } from '@shared/types'
import { deriveTitle } from './titles'
import { titleShowsWork } from './termTitle.ts'
import type { TerminalManager } from './terminal'
import type { Store } from './store'

/**
 * Terminal chats: a login shell in the column where the transcript would be,
 * and Carbon's job is to **notice** which CLI session you start in it, so that
 * reopening the chat can put you back in that session. See
 * `docs/terminal-chats.md`.
 *
 * Carbon launches nothing on its own. You type `claude`, `codex`, `grok` — with
 * whatever flags you use — and this module works out, from the processes under
 * the pane's shell, which session each of them is writing. That id is the
 * chat's `sessionId`, and on the next open it is resumed for you, typed into
 * your shell exactly as you would have typed it.
 */

function q(value: string): string {
  return /^[\w.-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function grokHome(): string {
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// ---------- Which session is running in this pane ----------

/**
 * Every process under the pane's shell.
 *
 * Descendants rather than the foreground process, because the foreground names
 * nothing useful — measured: Claude Code reports as `2.1.270` (its versioned
 * binary), Codex as `node` (its launcher shim, same as any npm script), and Grok
 * as `grok-1.0.30-maco` (truncated). The real process is somewhere in the tree,
 * and each CLI leaves its own evidence of which session it is.
 */
function descendants(root: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { timeout: 4000 }, (error, stdout) => {
      if (error) return resolve([])
      const children = new Map<number, number[]>()
      for (const line of stdout.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number)
        if (!pid || !ppid) continue
        const list = children.get(ppid)
        if (list) list.push(pid)
        else children.set(ppid, [pid])
      }
      const found: number[] = []
      const queue = [root]
      while (queue.length > 0) {
        for (const child of children.get(queue.shift()!) ?? []) {
          found.push(child)
          queue.push(child)
        }
      }
      resolve(found)
    })
  })
}

/**
 * Claude Code registers every live process in `~/.claude/sessions/<pid>.json`
 * with the session it is on — and rewrites it when that changes, so `/clear`
 * and an in-CLI `/resume` are followed by reading the same file again. Only the
 * pid and session id are read; the file sits beside a key and a socket path that
 * are none of Carbon's business.
 */
function claudeSessionIn(pids: number[]): string | null {
  const dir = join(claudeHome(), 'sessions')
  for (const pid of pids) {
    try {
      const record = JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')) as {
        pid?: number
        sessionId?: string
      }
      if (record.pid === pid && record.sessionId) return record.sessionId
    } catch {
      // not a Claude process, or the file is mid-rewrite — asked again next probe
    }
  }
  return null
}

const CODEX_LOCK = /thread-writer-locks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock/

/**
 * Codex keeps no registry, but it holds a writer lock for the thread it is
 * writing — `~/.codex/thread-writer-locks/<thread>.lock`, empty, held open for
 * the life of the thread. The open file *is* the link, so `lsof` over the pane's
 * processes names the thread exactly. Carbon's own Codex chats run under
 * Carbon's main process, never under a pane, so they cannot be mistaken for it.
 */
function codexSessionIn(pids: number[]): Promise<string | null> {
  if (pids.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', pids.join(','), '-Fn'], { timeout: 5000 }, (_error, stdout) => {
      // lsof exits 1 whenever one of the listed pids matches nothing, with the
      // answer for the others still on stdout — so the exit code says nothing.
      resolve(CODEX_LOCK.exec(stdout ?? '')?.[1] ?? null)
    })
  })
}

/**
 * Grok holds nothing open and registers nothing, so it is the one provider
 * identified by inference: a session directory **created in this folder while
 * grok was running in this pane**, and only if exactly one was. Anything
 * already known to Carbon is excluded, which covers its own Grok chats.
 */
async function grokSessionIn(
  cwd: string,
  bornAfter: number,
  exclude: ReadonlySet<string>
): Promise<string | null> {
  const root = join(grokHome(), 'sessions', encodeURIComponent(cwd))
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const born = entries.filter((entry) => {
    if (!entry.isDirectory() || exclude.has(entry.name)) return false
    try {
      return statSync(join(root, entry.name)).birthtimeMs >= bornAfter
    } catch {
      return false
    }
  })
  return born.length === 1 ? born[0].name : null
}

// ---------- Transcripts ----------

const claudeDirs = new Map<string, string>()

/**
 * The Claude project directory for `cwd`, by the CLI's slug rule — verified for
 * `/` and `.` becoming `-`, with the everything-else variant tried second. A
 * miss is settled by `claudeTranscript`'s search by file name.
 */
function claudeProjectDir(cwd: string): string | null {
  const cached = claudeDirs.get(cwd)
  if (cached && existsSync(cached)) return cached
  const projects = join(claudeHome(), 'projects')
  for (const slug of [cwd.replace(/[/.]/g, '-'), cwd.replace(/[^a-zA-Z0-9]/g, '-')]) {
    const dir = join(projects, slug)
    if (existsSync(dir)) {
      claudeDirs.set(cwd, dir)
      return dir
    }
  }
  return null
}

function claudeTranscript(cwd: string, sessionId: string): string | null {
  const direct = claudeProjectDir(cwd)
  if (direct && existsSync(join(direct, `${sessionId}.jsonl`))) return join(direct, `${sessionId}.jsonl`)
  // Resolved by name across every project, which is exact where the slug guess
  // is not — and the one place a miss is worth a directory listing.
  const projects = join(claudeHome(), 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(projects)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(path)) {
      claudeDirs.set(cwd, join(projects, dir))
      return path
    }
  }
  return null
}

/** `~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<thread>.jsonl`, newest days first. */
function codexRollout(threadId: string): string | null {
  const suffix = `${threadId}.jsonl`
  const walk = (dir: string, depth: number): string | null => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))
    } catch {
      return null
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith(suffix)) return path
      if (entry.isDirectory() && depth < 3) {
        const hit = walk(path, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(join(codexHome(), 'sessions'), 0)
}

/**
 * The file this session's CLI appends to — the proof that it can be resumed,
 * and the only signal a terminal chat gives that the agent did something.
 * Checked against disk every time rather than trusted: `claude --resume` on an
 * id that is gone exits at once, which would read as the chat failing to open.
 */
function transcriptPath(provider: Provider, cwd: string, sessionId: string): string | null {
  if (provider === 'claude') return claudeTranscript(cwd, sessionId)
  if (provider === 'codex') return codexRollout(sessionId)
  const dir = join(grokHome(), 'sessions', encodeURIComponent(cwd), sessionId)
  if (!existsSync(dir)) return null
  const history = join(dir, 'chat_history.jsonl')
  return existsSync(history) ? history : dir
}

// ---------- Titles ----------

/**
 * The file whose change can mean a new title. Followed for the life of the
 * session rather than read once: Grok refreshes its summary as the conversation
 * moves, and a title can land after the first read. A title you set yourself
 * still wins (`titleManual`).
 */
function titleSource(provider: Provider, path: string): string {
  if (provider === 'grok') return join(path.endsWith('.jsonl') ? dirname(path) : path, 'summary.json')
  if (provider === 'codex') return join(codexHome(), 'history.jsonl')
  return path
}

async function readTail(path: string, bytes: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const count = Math.min(size, bytes)
    const buffer = Buffer.allocUnsafe(count)
    const { bytesRead } = await file.read(buffer, 0, count, size - count)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close().catch(() => undefined)
  }
}

/**
 * The name the CLI gave this conversation, so the sidebar row says what the
 * CLI's own session list says.
 *
 * - Claude appends an `ai-title` record to its transcript.
 * - Grok writes `generated_title` into `summary.json` beside it.
 * - Codex names nothing, but records every submitted prompt in
 *   `~/.codex/history.jsonl` with its thread id — so its title is the opening
 *   prompt, which is what a new Carbon chat is titled by too. Not the rollout's
 *   own first user message: Codex prepends injected context to that one.
 */
async function cliTitle(provider: Provider, sessionId: string, path: string): Promise<string | null> {
  try {
    if (provider === 'claude') {
      const size = statSync(path).size
      const text = size <= 2_000_000 ? await readFile(path, 'utf8') : await readTail(path, 1_000_000)
      let title: string | null = null
      for (const line of text.split('\n')) {
        if (!line.includes('"ai-title"')) continue
        try {
          const record = JSON.parse(line) as { type?: string; aiTitle?: string }
          if (record.type === 'ai-title' && record.aiTitle) title = record.aiTitle
        } catch {
          // a half-written trailing line
        }
      }
      return title
    }
    if (provider === 'grok') {
      const dir = path.endsWith('.jsonl') ? dirname(path) : path
      const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as {
        generated_title?: string
        session_summary?: string
      }
      return summary.generated_title || summary.session_summary || null
    }
    const history = await readTail(join(codexHome(), 'history.jsonl'), 512_000)
    for (const line of history.split('\n')) {
      if (!line.includes(sessionId)) continue
      try {
        const record = JSON.parse(line) as { session_id?: string; text?: string }
        if (record.session_id === sessionId && record.text) return record.text
      } catch {
        // the tail's first line is usually cut in half
      }
    }
  } catch {
    // no title yet, or a file being rewritten under us — asked again later
  }
  return null
}

// ---------- Resume ----------

/**
 * What to type to get back into a session. Typed, not spawned: the pane is your
 * login shell with its PATH, aliases and prompt, and the command lands in its
 * history — so leaving the CLI puts you at your own prompt, and ↑ gets you back
 * in. Your original flags are not replayed (Carbon never saw them); the CLI
 * restores the conversation, and anything else is one keystroke away inside it.
 */
function resumeLine(provider: Provider, sessionId: string): string {
  const args = provider === 'codex' ? ['codex', 'resume', sessionId] : [provider, '--resume', sessionId]
  return args.map(q).join(' ')
}

// ---------- The manager ----------

/** How often a live pane is checked for movement. */
const POLL_MS = 1500

/**
 * How long the transcript must be quiet before the session counts as having
 * finished something. A turn writes continuously, so the gap is the signal.
 */
const QUIET_MS = 1200

/**
 * How often "what is running in this pane" is asked while something is. Codex's
 * answer costs an `lsof`, so a command that turns out not to be a CLI — a dev
 * server left running for an hour — backs off rather than paying it every tick.
 */
const PROBE_MS = 2500
const PROBE_IDLE_MS = 15_000
/**
 * Once the running CLI has been identified, asking again only catches it
 * changing session underneath us (`/clear`, its own `/resume`) — a deliberate
 * action, not something that happens mid-turn.
 */
const PROBE_STEADY_MS = 8000
const PROBE_MISSES_BEFORE_BACKOFF = 4

interface Watch {
  chatId: string
  cwd: string
  /** The session this pane is on, once one has been identified. */
  provider: Provider | null
  sessionId: string | null
  /** Its transcript, or null while it has yet to be written or found. */
  path: string | null
  lastLocate: number
  mtimeMs: number
  dirty: boolean
  lastChange: number
  /** Mtime of the title source (`titleSource`) when the title was last read. */
  titleMtime: number
  /** The session the title was last taken from. */
  titledFor: string | null
  polling: boolean
  /** When the current foreground command started; 0 while the shell is in front. */
  busyStart: number
  busyName: string | null
  lastProbe: number
  misses: number
  /** The current foreground command has been identified as a CLI session. */
  found: boolean
}

export class ChatTerminalManager {
  private watches = new Map<string, Watch>()
  /** Session ids a pane has adopted, so two panes can never share one. */
  private claimed = new Set<string>()
  /** Chats whose CLI is mid-turn, by its title's spinner (see `termTitle.ts`). */
  private working = new Set<string>()

  constructor(
    private terminals: TerminalManager,
    private store: Store,
    private emitTerminal: (ev: TerminalEvent) => void,
    private emitChat: (ev: ChatEvent) => void
  ) {
    terminals.onTitle((id, title) => {
      if (isChatTerminalId(id)) this.setWorking(id.slice(chatTerminalId('').length), titleShowsWork(title))
    })
  }

  /**
   * Published as the chat's ordinary status, so a terminal chat gets what any
   * chat gets from a turn: the sidebar's working mark, the hoist at its start,
   * and the "finished" notification while Carbon is in the background.
   */
  private setWorking(chatId: string, working: boolean): void {
    if (this.working.has(chatId) === working) return
    if (working) this.working.add(chatId)
    else this.working.delete(chatId)
    this.emitChat({ type: 'status', chatId, status: working ? 'streaming' : 'idle' })
  }

  /**
   * Bring a chat's pane up: a login shell in the chat's folder, and — if the
   * chat has a session the CLI can still find — that session resumed in it.
   * Called on every mount; a pane that is already running is left exactly as it
   * is, which is what makes switching chats free.
   */
  start(
    chatId: string,
    cols: number,
    rows: number,
    opts: { fresh?: boolean; restart?: boolean } = {}
  ): { id: string } | { error: string } {
    const id = chatTerminalId(chatId)
    if (!opts.restart && this.terminals.has(id)) return { id }
    const chat = this.store.getChat(chatId)
    if (!chat) return { error: 'This chat no longer exists.' }
    // userData is shared between builds, so the same chat can be open twice —
    // which here would be two CLIs resuming one session and interleaving their
    // writes into a single transcript. This instance declines instead.
    if (this.store.lockedElsewhere(chatId)) {
      return {
        error:
          'This chat is open in another Carbon instance.\n\nClose it there, then reopen this chat.'
      }
    }

    const resumable =
      !opts.fresh && chat.sessionId ? transcriptPath(chat.provider, chat.cwd, chat.sessionId) : null
    if (chat.sessionId && !resumable) this.forget(chat)

    this.terminals.create({ id, cwd: chat.cwd, cols, rows, chatId, persist: true })
    if (resumable && chat.sessionId) {
      const line = resumeLine(chat.provider, chat.sessionId)
      // After the prompt has drawn: typed ahead of it, the line is echoed once
      // by the tty and again by the shell's line editor.
      void this.terminals.whenQuiet(id, 250, 4000).then(() => this.terminals.write(id, `${line}\r`))
    }
    this.watch(chat, resumable)
    return { id }
  }

  restart(chatId: string, cols: number, rows: number, opts: { fresh?: boolean } = {}): { id: string } | { error: string } {
    this.stop(chatId)
    this.terminals.kill(chatTerminalId(chatId))
    return this.start(chatId, cols, rows, { ...opts, restart: true })
  }

  /**
   * The chat's directory moved out from under its pane — a worktree hand-off or
   * removal — so the shell, and whatever is running in it, is still sitting in a
   * directory git may have just deleted. It is replaced by one in the new
   * checkout. `relocateChat` has already cleared the session that lived there.
   */
  relocate(chatId: string): void {
    const size = this.terminals.size(chatTerminalId(chatId))
    if (size) this.restart(chatId, size.cols, size.rows, { fresh: true })
  }

  /** Drop a chat's watcher. The pty is reaped separately (`killForChat`). */
  stop(chatId: string): void {
    // Whatever was running went with the pane.
    this.setWorking(chatId, false)
    const watch = this.watches.get(chatId)
    if (!watch) return
    this.watches.delete(chatId)
    if (watch.sessionId) this.claimed.delete(watch.sessionId)
  }

  disposeAll(): void {
    this.working.clear()
    this.watches.clear()
    this.claimed.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private timer: NodeJS.Timeout | null = null

  private watch(chat: ChatData, resumable: string | null): void {
    this.stop(chat.id)
    const watch: Watch = {
      chatId: chat.id,
      cwd: chat.cwd,
      provider: resumable ? chat.provider : null,
      sessionId: resumable ? (chat.sessionId ?? null) : null,
      path: resumable,
      lastLocate: 0,
      // Adopting the resumed transcript's mtime now is what keeps reopening a
      // chat from reporting its previous session's last turn as fresh activity.
      mtimeMs: resumable ? mtimeOf(resumable) : 0,
      dirty: false,
      lastChange: 0,
      titleMtime: 0,
      // A resumed chat that already has a name has had its Codex title read.
      titledFor: resumable && chat.title !== 'Terminal' ? (chat.sessionId ?? null) : null,
      polling: false,
      busyStart: 0,
      busyName: null,
      lastProbe: 0,
      misses: 0,
      found: false
    }
    if (watch.sessionId) this.claimed.add(watch.sessionId)
    this.watches.set(chat.id, watch)
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const chatId of this.watches.keys()) void this.poll(chatId)
      }, POLL_MS)
      this.timer.unref?.()
    }
  }

  private async poll(chatId: string): Promise<void> {
    const watch = this.watches.get(chatId)
    if (!watch || watch.polling) return
    const id = chatTerminalId(chatId)
    if (!this.terminals.has(id)) {
      this.stop(chatId)
      if (this.watches.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
      return
    }
    watch.polling = true
    try {
      const now = Date.now()
      const foreground = this.terminals.foreground(id)
      if (foreground && !watch.busyStart) {
        watch.busyStart = now
        watch.busyName = foreground
        watch.lastProbe = 0
        watch.misses = 0
        watch.found = false
      } else if (!foreground && watch.busyStart) {
        // A command just finished and the prompt is back. Whatever it was — the
        // CLI exiting, a `git commit`, an install — it may have changed files.
        watch.busyStart = 0
        watch.busyName = null
        // A CLI that crashed or was killed mid-turn never draws its idle title.
        this.setWorking(chatId, false)
        this.activity(watch)
      }

      if (watch.busyStart) {
        const every =
          watch.misses >= PROBE_MISSES_BEFORE_BACKOFF
            ? PROBE_IDLE_MS
            : watch.found
              ? PROBE_STEADY_MS
              : PROBE_MS
        if (now - watch.lastProbe >= every) {
          watch.lastProbe = now
          await this.probe(watch)
        }
      }

      if (watch.sessionId && watch.provider && !watch.path && now - watch.lastLocate >= 5000) {
        watch.lastLocate = now
        watch.path = transcriptPath(watch.provider, watch.cwd, watch.sessionId)
        if (watch.path) watch.mtimeMs = 0
      }
      if (!watch.path) return

      // Read once the source has settled: a title lands in its own write, and
      // Grok's lands in another file entirely, well after the turn's last line.
      const source = titleSource(watch.provider!, watch.path)
      const titleMtime = mtimeOf(source)
      if (titleMtime > watch.titleMtime && now - titleMtime >= QUIET_MS) {
        watch.titleMtime = titleMtime
        await this.applyCliTitle(watch)
      }

      const mtimeMs = mtimeOf(watch.path)
      if (mtimeMs > watch.mtimeMs) {
        watch.mtimeMs = mtimeMs
        watch.dirty = true
        watch.lastChange = now
      } else if (watch.dirty && now - watch.lastChange >= QUIET_MS) {
        watch.dirty = false
        this.activity(watch)
      }
    } finally {
      watch.polling = false
    }
  }

  /** Ask the processes under the pane which session they are on. */
  private async probe(watch: Watch): Promise<void> {
    const root = this.terminals.pid(chatTerminalId(watch.chatId))
    if (!root) return
    const pids = await descendants(root)
    let found: { provider: Provider; sessionId: string } | null = null

    const claude = claudeSessionIn(pids)
    if (claude) found = { provider: 'claude', sessionId: claude }
    if (!found) {
      const codex = await codexSessionIn(pids)
      if (codex) found = { provider: 'codex', sessionId: codex }
    }
    // Grok is inferred, so it is only asked when grok is what is in front.
    if (!found && watch.busyName?.startsWith('grok')) {
      const known = new Set(this.claimed)
      for (const meta of [...this.store.listChats(), ...this.store.listSideChats()]) {
        if (meta.sessionId) known.add(meta.sessionId)
      }
      if (watch.sessionId) known.add(watch.sessionId)
      const grok = await grokSessionIn(watch.cwd, watch.busyStart - 5000, known)
      if (grok) found = { provider: 'grok', sessionId: grok }
    }

    if (!found) {
      watch.misses++
      return
    }
    watch.misses = 0
    watch.found = true
    if (found.sessionId !== watch.sessionId) this.adopt(watch, found.provider, found.sessionId)
  }

  private adopt(watch: Watch, provider: Provider, sessionId: string): void {
    const chat = this.store.getChat(watch.chatId)
    if (!chat || this.claimed.has(sessionId)) return
    if (watch.sessionId) this.claimed.delete(watch.sessionId)
    this.claimed.add(sessionId)
    watch.provider = provider
    watch.sessionId = sessionId
    watch.path = transcriptPath(provider, watch.cwd, sessionId)
    watch.lastLocate = Date.now()
    watch.mtimeMs = watch.path ? mtimeOf(watch.path) : 0
    watch.titleMtime = 0
    watch.titledFor = null
    const patch: Partial<ChatMeta> = { sessionId }
    chat.sessionId = sessionId
    if (chat.provider !== provider) {
      chat.provider = provider
      patch.provider = provider
    }
    this.store.saveChat(watch.chatId)
    this.emitChat({ type: 'meta', chatId: watch.chatId, patch })
  }

  /** The stored session can no longer be resumed; the chat stops pointing at it. */
  private forget(chat: ChatData): void {
    if (!chat.sessionId) return
    this.claimed.delete(chat.sessionId)
    chat.sessionId = undefined
    this.store.saveChat(chat.id)
    this.emitChat({ type: 'meta', chatId: chat.id, patch: { sessionId: undefined } })
  }

  /**
   * The pane's equivalent of a turn ending. It refreshes the file tree, open
   * editors and git status, and it is the only thing that moves a terminal
   * chat's `updatedAt` — which otherwise never changes, sinking the chat you use
   * all day down a Recent-ordered sidebar.
   */
  private activity(watch: Watch): void {
    const chat = this.store.getChat(watch.chatId)
    if (chat) {
      chat.updatedAt = Date.now()
      this.store.saveChat(watch.chatId)
    }
    this.emitTerminal({ type: 'activity', id: chatTerminalId(watch.chatId), chatId: watch.chatId })
  }

  private async applyCliTitle(watch: Watch): Promise<void> {
    if (!watch.path || !watch.provider || !watch.sessionId) return
    // A Codex title is the opening prompt, which never changes — and a later
    // read from the history's tail could find a later prompt once it scrolls out.
    if (watch.provider === 'codex' && watch.titledFor === watch.sessionId) return
    const title = await cliTitle(watch.provider, watch.sessionId, watch.path)
    if (!title) return
    watch.titledFor = watch.sessionId
    const chat = this.store.getChat(watch.chatId)
    if (!chat || chat.titleManual) return
    const clean = deriveTitle(title)
    if (!clean || chat.title === clean) return
    chat.title = clean
    this.store.saveChat(watch.chatId)
    this.emitChat({ type: 'meta', chatId: watch.chatId, patch: { title: clean } })
  }
}

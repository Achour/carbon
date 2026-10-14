import { createReadStream, type Dirent } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { UsageFact, UsageProvider, UsageReport } from '@shared/types'
import {
  CodexFileReader,
  addSample,
  cellKinds,
  cellTokens,
  emptyCell,
  emptyKinds,
  localDay,
  parseClaudeLine,
  parseGrokLine,
  priceCell,
  type UsageCell
} from './usageScan'
import { loadRates } from './usageRates'
import { resolveProjects } from './usageProjects'

/**
 * Walks every CLI's session logs and turns them into the Usage page's report.
 * Parsing and pricing live in `usageScan.ts`; this file owns the filesystem, the
 * cache, and the aggregation.
 *
 * The corpus is large — ~2,000 files and a couple of gigabytes on a heavy user —
 * so the design is built around never reading a file twice. Every file's
 * contribution is reduced to a handful of (model, day) cells and cached under
 * `(path, mtime, size)`, persisted to `userData/usage-cache.json`. Session logs
 * are append-only, so a file whose mtime and size are unchanged cannot have
 * changed content; a re-scan then costs one `stat` per file and reads only what
 * was written since. That is also why changing the range (7 / 30 / 90 days) never
 * re-reads anything: cells are stored per day and simply re-filtered.
 */

/** Skip anything modified before the window — an append-only log can't hide newer entries. */
const MTIME_SLACK_MS = 24 * 60 * 60 * 1000
/** Files read in parallel. Enough to keep the disk busy, few enough to stay polite. */
const CONCURRENCY = 6
/** A file this far past the window's end still gets stat'd, but its cells are filtered. */
const CACHE_FILE = 'usage-cache.json'
/**
 * Bumped whenever parsing or pricing changes. The cache stores *derived* cells,
 * not raw lines, so a file that hasn't changed still has to be re-read when the
 * derivation does — otherwise a corrected rate would apply only to sessions that
 * happened to be written afterwards.
 *
 * Adding Grok deliberately did *not* bump it. No existing cell's derivation
 * moved: Claude and Codex parse exactly as before, and `priceCell`'s new branch
 * only fires on a cell carrying a provider-reported cost, which only Grok writes.
 * Grok's own logs are picked up regardless, because they are paths the cache has
 * never seen. Bumping would have forced every user through a cold ~2 GB rescan
 * to arrive at numbers identical to the ones already cached.
 *
 * 3 is the inverse case, and the rule reads the same from the other side:
 * skipping a fork's replayed lines (`forkedFrom`, `usageScan.ts`) moves the
 * derivation of cells already on disk — the double-counted ones sit in files
 * that will never be modified again — so only a rescan can correct them.
 *
 * 4 adds the folder each file ran in (`CacheEntry.cwd`), which the project
 * split needs and no earlier entry recorded.
 */
const CACHE_VERSION = 4
/** Don't let the cache grow unbounded as sessions accumulate. */
const CACHE_MAX_FILES = 20_000

interface CacheEntry {
  mtimeMs: number
  size: number
  cells: UsageCell[]
  /**
   * The folder the session ran in, as the log recorded it — *not* the project
   * root. Resolving a folder to its repository reads the disk, and the answer
   * moves when a worktree is removed, so it is done per scan and never cached.
   */
  cwd?: string
}

interface FileRead {
  cells: UsageCell[]
  cwd?: string
}

interface Source {
  provider: UsageProvider
  path: string
}

export interface UsageStatsOptions {
  /** `$HOME` — where both CLIs keep their logs by default. */
  home: string
  /** Where to persist the per-file cache (the app's `userData`). */
  cacheDir: string
}

// ---------- Filesystem ----------

/**
 * Every `.jsonl` under `dir`, at most `depth` levels down. A missing directory is
 * normal (that CLI was never installed) and yields nothing rather than throwing.
 */
async function collectJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth > 0) dirs.push(join(dir, e.name))
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(join(dir, e.name))
    }
  }
  await Promise.all(dirs.map((d) => collectJsonl(d, depth - 1, out)))
}

async function listSources(home: string): Promise<Source[]> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const codexHome = process.env.CODEX_HOME || join(home, '.codex')
  const grokHome = process.env.GROK_HOME || join(home, '.grok')
  const claude: string[] = []
  const codex: string[] = []
  const grok: string[] = []
  await Promise.all([
    // Claude's main transcripts sit at `projects/<slug>/<session>.jsonl`, but a
    // Task/subagent turn is written to its own file beside them —
    // `<session>/subagents/agent-*.jsonl`, and one level deeper again under
    // `subagents/workflows/<id>/`. Those files hold no `isSidechain` copy in the
    // parent and share no message ids with it: they are additional spend, and
    // stopping the walk at the session file silently omits every subagent turn.
    collectJsonl(join(claudeHome, 'projects'), 6, claude),
    collectJsonl(join(codexHome, 'sessions'), 4, codex),
    // Codex moves finished threads here; they are still real spend.
    collectJsonl(join(codexHome, 'archived_sessions'), 4, codex),
    // Grok nests one directory deep — `sessions/<encoded cwd>/<id>/*.jsonl` —
    // and writes several JSONL files per session (`events`, `chat_history`,
    // `rewind_points`). Only `updates.jsonl` carries usage; the others are
    // filtered below rather than here so the walk stays one shared helper.
    collectJsonl(join(grokHome, 'sessions'), 4, grok)
  ])
  return [
    ...claude.map((path): Source => ({ provider: 'claude', path })),
    ...codex.map((path): Source => ({ provider: 'codex', path })),
    ...grok
      .filter((path) => path.endsWith('updates.jsonl'))
      .map((path): Source => ({ provider: 'grok', path }))
  ]
}

/**
 * Feed a file to `onLine` a line at a time, streaming.
 *
 * Not `readFile` + `split`: the largest transcripts here run to ~100 MB, and
 * materializing one as a string plus an array of every line would spike the main
 * process by a few hundred megabytes for a number nobody is watching yet.
 */
function forEachLine(path: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    let carry = ''
    stream.on('data', (chunk) => {
      const text = carry + (chunk as string)
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        if (nl === -1) break
        const line = text.slice(start, nl)
        if (line) onLine(line)
        start = nl + 1
      }
      carry = text.slice(start)
    })
    stream.on('end', () => {
      if (carry) onLine(carry)
      resolve()
    })
    stream.on('error', reject)
  })
}

// ---------- Per-file reduction ----------

async function readClaudeFile(path: string): Promise<FileRead> {
  const cells = new Map<string, UsageCell>()
  let cwd: string | undefined
  // A single API response is written once per content block, so a turn with text
  // and a tool call appears twice carrying identical usage. Dedupe within the
  // file: a message id never crosses sessions.
  const seen = new Set<string>()
  await forEachLine(path, (line) => {
    const s = parseClaudeLine(line)
    if (!s) return
    if (s.key) {
      if (seen.has(s.key)) return
      seen.add(s.key)
    }
    cwd ??= s.cwd
    const day = localDay(s.ts)
    // Speed is part of the key: fast mode is a different SKU on the same model
    // id, so folding the two together would make the cell unpriceable later.
    const k = `${s.model} ${s.speed ?? ''} ${day}`
    let c = cells.get(k)
    if (!c) cells.set(k, (c = emptyCell('claude', s.model, day, s.speed)))
    addSample(c, s)
  })
  return { cells: [...cells.values()], cwd }
}

async function readCodexFile(path: string): Promise<FileRead> {
  const cells = new Map<string, UsageCell>()
  const reader = new CodexFileReader()
  await forEachLine(path, (line) => reader.push(line))
  for (const s of reader.take()) {
    const day = localDay(s.ts)
    const k = `${s.model} ${day}`
    let c = cells.get(k)
    if (!c) cells.set(k, (c = emptyCell('codex', s.model, day)))
    addSample(c, {
      input: s.input,
      cacheRead: s.cacheRead,
      // OpenAI charges no cache-write premium, so the TTL split doesn't apply;
      // the 5-minute slot carries the whole figure.
      cacheWrite5m: s.cacheWrite,
      cacheWrite1h: 0,
      output: s.output,
      reasoning: s.reasoning
    })
  }
  return { cells: [...cells.values()], cwd: reader.cwd }
}

/**
 * Grok records no folder inside the log; the session directory's parent *is*
 * the folder, percent-encoded: `sessions/%2FUsers%2Fme%2Fapp/<id>/updates.jsonl`.
 */
function grokCwd(path: string): string | undefined {
  try {
    const decoded = decodeURIComponent(basename(dirname(dirname(path))))
    return decoded.startsWith('/') ? decoded : undefined
  } catch {
    return undefined
  }
}

async function readGrokFile(path: string): Promise<FileRead> {
  const cells = new Map<string, UsageCell>()
  await forEachLine(path, (line) => {
    const samples = parseGrokLine(line)
    if (!samples) return
    for (const s of samples) {
      const day = localDay(s.ts)
      const k = `${s.model} ${day}`
      let c = cells.get(k)
      if (!c) cells.set(k, (c = emptyCell('grok', s.model, day)))
      addSample(c, {
        input: s.input,
        cacheRead: s.cacheRead,
        cacheWrite5m: s.cacheWrite,
        cacheWrite1h: 0,
        output: s.output,
        reasoning: s.reasoning
      })
      // Costs sum across the turns folded into this cell; see `UsageCell.costUsd`
      // for why a reported figure is stored where a computed one would not be.
      c.costUsd = (c.costUsd ?? 0) + s.costUsd
    }
  })
  return { cells: [...cells.values()], cwd: grokCwd(path) }
}

/**
 * Which reader parses which provider's logs. A table rather than a chain of
 * ternaries so a fourth provider is a missing key the compiler names, not a
 * silent fall-through into Codex's parser.
 */
const READERS: Record<UsageProvider, (path: string) => Promise<FileRead>> = {
  claude: readClaudeFile,
  codex: readCodexFile,
  grok: readGrokFile
}

// ---------- Cache ----------

type Cache = Map<string, CacheEntry>

async function loadCache(dir: string): Promise<Cache> {
  try {
    const raw = await readFile(join(dir, CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { version?: number; files?: Record<string, CacheEntry> }
    if (parsed.version !== CACHE_VERSION || !parsed.files) return new Map()
    const cache: Cache = new Map()
    for (const [path, entry] of Object.entries(parsed.files)) {
      if (entry && typeof entry.mtimeMs === 'number' && Array.isArray(entry.cells)) {
        cache.set(path, entry)
      }
    }
    return cache
  } catch {
    // No cache yet, or one written by an incompatible build. Rebuilding is the
    // correct answer either way — it costs a scan, never a wrong number.
    return new Map()
  }
}

/**
 * Serialized: the whole file is rewritten each time, and two ranges asked for in
 * quick succession would otherwise interleave their writes into a file that
 * parses as neither.
 */
let writing: Promise<void> = Promise.resolve()

function saveCache(dir: string, cache: Cache): Promise<void> {
  // Over budget, keep the most recently written files — those are the sessions
  // still being appended to, and the ones a re-scan would otherwise re-read.
  const entries = [...cache.entries()]
  if (entries.length > CACHE_MAX_FILES) {
    entries.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    entries.length = CACHE_MAX_FILES
  }
  const files = Object.fromEntries(entries)
  writing = writing.then(async () => {
    try {
      await writeFile(join(dir, CACHE_FILE), JSON.stringify({ version: CACHE_VERSION, files }))
    } catch (err) {
      // A cache we can't persist just means the next launch re-reads. Never fatal.
      console.error('usage cache write failed:', err)
    }
  })
  return writing
}

// ---------- Retention ----------

/** Claude Code's default `cleanupPeriodDays`. */
const CLAUDE_RETENTION_DAYS = 30

/**
 * How many days of transcripts Claude Code keeps. It deletes older ones at
 * startup, so the logs are not a history past this point — on a default
 * install, the oldest Claude transcript on disk is a month old however long
 * the CLI has been in use. Codex and Grok keep everything.
 */
async function claudeRetentionDays(home: string): Promise<number> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  try {
    const settings = JSON.parse(await readFile(join(claudeHome, 'settings.json'), 'utf8')) as {
      cleanupPeriodDays?: unknown
    }
    const days = settings.cleanupPeriodDays
    return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : CLAUDE_RETENTION_DAYS
  } catch {
    return CLAUDE_RETENTION_DAYS
  }
}

// ---------- Aggregation ----------

/** Every local day in `[from, to]`, so the chart has no gaps to interpolate. */
function dayRange(from: Date, to: Date): string[] {
  const out: string[] = []
  const cur = new Date(from)
  while (cur <= to) {
    out.push(localDay(cur.getTime()))
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

// ---------- Entry point ----------

let inflight: Promise<UsageReport> | null = null
let inflightKey = ''

async function scan(opts: UsageStatsOptions, days: number, refresh: boolean): Promise<UsageReport> {
  const now = new Date()
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = new Date(now)
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)
  // The same-length window just before this one, for the change line. It is
  // read through the same cache, so after the first scan it costs nothing.
  const prevStart = new Date(start)
  prevStart.setDate(prevStart.getDate() - days)

  // Rates and the file list are independent; fetch and walk together so a cold
  // rate fetch never adds to the scan's wall clock.
  const [cache, sources, rates, claudeDays] = await Promise.all([
    refresh ? Promise.resolve(new Map<string, CacheEntry>()) : loadCache(opts.cacheDir),
    listSources(opts.home),
    loadRates(opts.cacheDir),
    claudeRetentionDays(opts.home)
  ])
  const claudeKept = new Date(now)
  claudeKept.setDate(claudeKept.getDate() - claudeDays)
  const notes: string[] = []
  if (!sources.length) {
    notes.push('No Claude Code, Codex or Grok session logs found in your home directory.')
  }

  // An append-only log last written before the window began can hold nothing
  // inside it, so it never has to be opened — the single biggest saving on a
  // 7-day view over years of history.
  const floor = prevStart.getTime() - MTIME_SLACK_MS
  const live = new Map<string, CacheEntry>()
  const pending: { source: Source; mtimeMs: number; size: number }[] = []

  await runPool(sources, CONCURRENCY, async (source) => {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(source.path)
    } catch {
      return
    }
    const cached = cache.get(source.path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      live.set(source.path, cached)
      return
    }
    // Last written before the window opened, so nothing in it can fall inside:
    // skip without reading. It is deliberately *not* cached as empty — a wider
    // range later moves the floor back and has to open it for real.
    if (info.mtimeMs < floor) return
    pending.push({ source, mtimeMs: info.mtimeMs, size: info.size })
  })

  let failures = 0
  await runPool(pending, CONCURRENCY, async ({ source, mtimeMs, size }) => {
    try {
      const { cells, cwd } = await READERS[source.provider](source.path)
      live.set(source.path, { mtimeMs, size, cells, cwd })
    } catch {
      failures++
    }
  })

  if (failures) {
    notes.push(`${failures} session log${failures === 1 ? '' : 's'} couldn’t be read and were skipped.`)
  }

  // Merge the freshly-read entries back over the cache so files outside this
  // window (never opened, but still valid) survive for the next, wider range,
  // and drop entries whose file is gone.
  for (const [path, entry] of live) cache.set(path, entry)
  const onDisk = new Set(sources.map((s) => s.path))
  for (const path of [...cache.keys()]) {
    if (!onDisk.has(path)) cache.delete(path)
  }
  void saveCache(opts.cacheDir, cache)

  const from = localDay(start.getTime())
  const to = localDay(end.getTime())
  const prevFrom = localDay(prevStart.getTime())
  const dayList = dayRange(start, end)
  const dayIndex = new Map(dayList.map((d, i) => [d, i]))

  // Only folders that contributed to the window are worth resolving.
  const cwds = new Set<string>()
  for (const entry of live.values()) {
    if (entry.cwd && entry.cells.some((c) => c.day >= from && c.day <= to)) cwds.add(entry.cwd)
  }
  const owner = await resolveProjects(cwds, opts.home)
  const projects: string[] = []
  const projectIndex = new Map<string, number>()
  const projectOf = (cwd: string | undefined): number => {
    const root = cwd ? (owner.get(cwd) ?? cwd) : ''
    let i = projectIndex.get(root)
    if (i === undefined) {
      i = projects.length
      projects.push(root)
      projectIndex.set(root, i)
    }
    return i
  }

  const facts = new Map<string, UsageFact>()
  const daySessions = dayList.map(() => 0)
  const previous = { costUsd: 0, tokens: 0 }
  let sessions = 0

  for (const [path, entry] of live) {
    // A subagent transcript is part of its parent session, not another one —
    // counting the files would roughly double the number a user recognizes.
    const isSession = !path.includes('/subagents/')
    const activeDays = new Set<number>()
    let project = -1
    for (const cell of entry.cells) {
      if (cell.day < prevFrom || cell.day > to) continue
      // Priced here rather than at parse time: cells are cached per file and
      // rates refresh daily, so cost has to be a function of the current table
      // and not a number frozen into a file that never changes again.
      const cost = priceCell(cell, rates)
      if (cell.day < from) {
        previous.costUsd += cost.costUsd
        previous.tokens += cellTokens(cell)
        continue
      }
      activeDays.add(dayIndex.get(cell.day) ?? -1)
      if (project === -1) project = projectOf(entry.cwd)
      const key = `${cell.day} ${cell.provider} ${cell.model} ${project}`
      let fact = facts.get(key)
      if (!fact) {
        facts.set(
          key,
          (fact = {
            day: cell.day,
            provider: cell.provider,
            model: cell.model,
            project,
            tokens: emptyKinds(),
            cost: emptyKinds(),
            reasoning: 0,
            savedUsd: 0,
            responses: 0,
            unpriced: 0
          })
        )
      }
      const tokens = cellKinds(cell)
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
        fact.tokens[k] += tokens[k]
        fact.cost[k] += cost.byKind[k]
      }
      fact.reasoning += cell.reasoning
      fact.savedUsd += cost.savingsUsd
      fact.responses += cell.responses
      fact.unpriced += cost.unpricedTokens
    }
    if (isSession && activeDays.size) {
      sessions++
      for (const i of activeDays) if (i >= 0) daySessions[i]++
    }
  }

  return {
    from,
    to,
    days: dayList,
    facts: [...facts.values()],
    projects,
    daySessions,
    sessions,
    previous,
    keptFrom: { claude: localDay(claudeKept.getTime()) },
    scannedAt: Date.now(),
    notes
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = i++
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

/**
 * The report for the last `days` days. Concurrent asks for the same window share
 * one scan — the panel mounts and the range buttons both call this, and a cold
 * scan is seconds of disk.
 */
export function readUsageReport(
  opts: UsageStatsOptions,
  days: number,
  refresh = false
): Promise<UsageReport> {
  const key = `${days}:${refresh}`
  if (inflight && inflightKey === key) return inflight
  const run = scan(opts, days, refresh)
  inflight = run
  inflightKey = key
  void run.finally(() => {
    if (inflight === run) {
      inflight = null
      inflightKey = ''
    }
  })
  return run
}

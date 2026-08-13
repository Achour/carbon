import { createReadStream, type Dirent } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Provider, UsageDay, UsageModelRow, UsageReport, UsageTotals } from '@shared/types'
import {
  CodexFileReader,
  addSample,
  emptyCell,
  localDay,
  parseClaudeLine,
  parseGrokLine,
  priceCell,
  type CellCost,
  type UsageCell
} from './usageScan'
import { loadRates } from './usageRates'

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
 */
const CACHE_VERSION = 2
/** Don't let the cache grow unbounded as sessions accumulate. */
const CACHE_MAX_FILES = 20_000

interface CacheEntry {
  mtimeMs: number
  size: number
  cells: UsageCell[]
}

interface Source {
  provider: Provider
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

async function readClaudeFile(path: string): Promise<UsageCell[]> {
  const cells = new Map<string, UsageCell>()
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
    const day = localDay(s.ts)
    // Speed is part of the key: fast mode is a different SKU on the same model
    // id, so folding the two together would make the cell unpriceable later.
    const k = `${s.model} ${s.speed ?? ''} ${day}`
    let c = cells.get(k)
    if (!c) cells.set(k, (c = emptyCell('claude', s.model, day, s.speed)))
    addSample(c, s)
  })
  return [...cells.values()]
}

async function readCodexFile(path: string): Promise<UsageCell[]> {
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
  return [...cells.values()]
}

async function readGrokFile(path: string): Promise<UsageCell[]> {
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
  return [...cells.values()]
}

/**
 * Which reader parses which provider's logs. A table rather than a chain of
 * ternaries so a fourth provider is a missing key the compiler names, not a
 * silent fall-through into Codex's parser.
 */
const READERS: Record<Provider, (path: string) => Promise<UsageCell[]>> = {
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

// ---------- Aggregation ----------

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    savingsUsd: 0,
    responses: 0,
    unpricedTokens: 0
  }
}

/** Fold a cell and its freshly-computed cost into a running total. */
function accumulate(into: UsageTotals, cell: UsageCell, cost: CellCost): void {
  into.input += cell.input
  into.cacheRead += cell.cacheRead
  into.cacheWrite += cell.cacheWrite5m + cell.cacheWrite1h
  into.output += cell.output
  into.reasoning += cell.reasoning
  into.responses += cell.responses
  into.costUsd += cost.costUsd
  into.savingsUsd += cost.savingsUsd
  into.unpricedTokens += cost.unpricedTokens
}

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

  // Rates and the file list are independent; fetch and walk together so a cold
  // rate fetch never adds to the scan's wall clock.
  const [cache, sources, rates] = await Promise.all([
    refresh ? Promise.resolve(new Map<string, CacheEntry>()) : loadCache(opts.cacheDir),
    listSources(opts.home),
    loadRates(opts.cacheDir)
  ])
  const notes: string[] = []
  if (!sources.length) {
    notes.push('No Claude Code or Codex session logs found in your home directory.')
  }

  // An append-only log last written before the window began can hold nothing
  // inside it, so it never has to be opened — the single biggest saving on a
  // 7-day view over years of history.
  const floor = start.getTime() - MTIME_SLACK_MS
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
      const cells = await READERS[source.provider](source.path)
      live.set(source.path, { mtimeMs, size, cells })
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
  const byDay = new Map<string, UsageDay>()
  for (const day of dayRange(start, end)) {
    byDay.set(day, { day, claude: emptyTotals(), codex: emptyTotals(), grok: emptyTotals() })
  }
  const byModel = new Map<string, UsageModelRow>()
  const claude = emptyTotals()
  const codex = emptyTotals()
  const grok = emptyTotals()
  const total = emptyTotals()
  // Hoisted: the loop below runs once per cached cell across every session file
  // in the window — tens of thousands on a real corpus — and an inline
  // `{ claude, codex, grok }[cell.provider]` would allocate a throwaway object
  // on each pass purely to do a lookup.
  const providerTotals: Record<Provider, UsageTotals> = { claude, codex, grok }
  let sessions = 0

  for (const [path, entry] of live) {
    let counted = false
    for (const cell of entry.cells) {
      if (cell.day < from || cell.day > to) continue
      counted = true
      // Priced here rather than at parse time: cells are cached per file and
      // rates refresh daily, so cost has to be a function of the current table
      // and not a number frozen into a file that never changes again.
      const cost = priceCell(cell, rates)
      const dayRow = byDay.get(cell.day)
      if (dayRow) accumulate(dayRow[cell.provider], cell, cost)
      const key = `${cell.provider} ${cell.model}`
      let row = byModel.get(key)
      if (!row) {
        byModel.set(key, (row = { provider: cell.provider, model: cell.model, ...emptyTotals() }))
      }
      accumulate(row, cell, cost)
      accumulate(providerTotals[cell.provider], cell, cost)
      accumulate(total, cell, cost)
    }
    // A subagent transcript is part of its parent session, not another one —
    // counting the files would roughly double the number a user recognizes.
    if (counted && !path.includes('/subagents/')) sessions++
  }

  return {
    from,
    to,
    days: [...byDay.values()],
    models: [...byModel.values()].sort(
      (a, b) => b.costUsd - a.costUsd || tokensOf(b) - tokensOf(a)
    ),
    claude,
    codex,
    grok,
    total,
    sessions,
    scannedAt: Date.now(),
    notes
  }
}

function tokensOf(t: UsageTotals): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output
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

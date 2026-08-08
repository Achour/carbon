import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rate, RateLookup } from './usageScan'
import { lookupFrom, parseRateFeed, staticRate } from './usageScan'

/**
 * Where the Usage page's prices come from.
 *
 * A hard-coded table cannot stay right. The rates that matter most here are the
 * ones nobody publishes on a pricing page — the Codex-only model slugs
 * (`gpt-5.6-sol` and friends), which are billed *well* above the GPT-5 family
 * they are named after. Pricing them by family guess understated Codex spend by
 * about 4x, and no amount of care in the parser fixes a wrong rate.
 *
 * So the rates are fetched from LiteLLM's `model_prices_and_context_window.json`
 * — the community-maintained table that `ccusage` and other usage tools already
 * price against. It is a public JSON file in a public repo, not a provider's
 * private endpoint and nothing to do with anyone's login.
 *
 * Three properties make this safe to depend on:
 *
 * - **It is a cache, not a dependency.** The built-in table in `usageScan.ts`
 *   answers before the first fetch lands, and forever if the fetch never does.
 *   The page is never blocked on the network and never blank because of it.
 * - **One request a day, and only if you look.** The fetch is lazy — opening the
 *   Usage page is what triggers it — and the snapshot on disk is good for 24h.
 * - **Fetched rates lose to nothing.** A model the feed doesn't know (Codex's
 *   internal review model, say) falls through to the built-in table, and then to
 *   being reported as unpriced rather than silently free.
 */

const RATES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
/** Rates move rarely; a day-old table is not meaningfully wrong. */
const TTL_MS = 24 * 60 * 60 * 1000
/** The page has a working answer without this; don't make anyone wait for it. */
const TIMEOUT_MS = 10_000
const SNAPSHOT_FILE = 'usage-rates.json'

interface Snapshot {
  fetchedAt: number
  /** Model id → rate, in dollars per million tokens. */
  rates: Record<string, Rate>
}

async function readSnapshot(dir: string): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, SNAPSHOT_FILE), 'utf8')) as Snapshot
    if (typeof parsed?.fetchedAt !== 'number' || !parsed.rates) return null
    return parsed
  } catch {
    return null
  }
}

async function fetchRates(): Promise<Record<string, Rate> | null> {
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const rates = parseRateFeed(await res.json())
    return Object.keys(rates).length ? rates : null
  } catch {
    // Offline, rate-limited, or the file moved. The built-in table still works.
    return null
  }
}

let inflight: Promise<RateLookup> | null = null

/**
 * The rate lookup to price a scan with.
 *
 * Refreshes at most daily and never throws: every failure path ends at the
 * previous snapshot, and then at the built-in table.
 */
export function loadRates(cacheDir: string): Promise<RateLookup> {
  if (inflight) return inflight
  const run = (async (): Promise<RateLookup> => {
    const snapshot = await readSnapshot(cacheDir)
    if (snapshot && Date.now() - snapshot.fetchedAt < TTL_MS) return lookupFrom(snapshot.rates)
    const fresh = await fetchRates()
    if (!fresh) return snapshot ? lookupFrom(snapshot.rates) : staticRate
    const next: Snapshot = { fetchedAt: Date.now(), rates: fresh }
    try {
      await writeFile(join(cacheDir, SNAPSHOT_FILE), JSON.stringify(next))
    } catch (err) {
      console.error('usage rate snapshot write failed:', err)
    }
    return lookupFrom(fresh)
  })()
  inflight = run
  void run.finally(() => {
    // Cleared so the next scan past the TTL refreshes; within it, `readSnapshot`
    // is the cheap path and re-running costs one small file read.
    if (inflight === run) inflight = null
  })
  return run
}

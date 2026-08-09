import type { EffortId, ModelOption } from '@shared/types'
import { OPENCODE_DEFAULT_MODEL, OPENCODE_MODEL_PREFIX } from '../shared/types.ts'

/**
 * OpenCode model ids, and the picker rows built from `/config/providers`.
 *
 * OpenCode addresses a model as a (providerID, modelID) pair — `openai` +
 * `gpt-5.6-luna`, or `opencode` + `deepseek-v4-flash-free` for its own Zen
 * gateway — where `ModelOption.id` is a single string. Encoding the pair keeps
 * the id self-describing, which is what lets `providerForModel` route it before
 * any live catalog exists.
 */

/** `openai` + `gpt-5.6-luna` → `opencode:openai/gpt-5.6-luna`. */
export function opencodeModelId(providerID: string, modelID: string): string {
  return `${OPENCODE_MODEL_PREFIX}${providerID}/${modelID}`
}

export interface OpencodeModelRef {
  providerID: string
  modelID: string
}

/**
 * The inverse. Null means "no model pinned" — the sentinel, an empty id, or
 * anything unparseable — and the caller then omits `model` from the prompt so
 * the server falls back to the user's configured default.
 *
 * Split on the *first* slash: providerIDs never contain one, model ids
 * sometimes do (`anthropic/claude-3.5`), so a last-slash split would shred them.
 */
export function parseOpencodeModelId(id: string | undefined): OpencodeModelRef | null {
  if (!id || id === OPENCODE_DEFAULT_MODEL) return null
  if (!id.startsWith(OPENCODE_MODEL_PREFIX)) return null
  const rest = id.slice(OPENCODE_MODEL_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const providerID = rest.slice(0, slash)
  const modelID = rest.slice(slash + 1)
  return providerID && modelID ? { providerID, modelID } : null
}

// ---- /config/providers → picker rows ----

interface RawModelInfo {
  id?: string
  name?: string
  limit?: { context?: number; output?: number }
  /** Present on Zen's free tier; used only to sort the free ones last. */
  cost?: { input?: number; output?: number }
  /**
   * Reasoning levels this exact model offers, keyed by the name to send back as
   * the prompt's `variant` — OpenCode's word for what Carbon calls effort.
   */
  variants?: Record<string, unknown>
}

/**
 * OpenCode variant names that are Carbon efforts.
 *
 * The catalog also carries `none` (reason as little as possible), `thinking`
 * and `default`, which have no Carbon equivalent: `default` is already the ''
 * row, and the other two would need a new member on the shared `EffortId` union
 * that Claude and Codex would then have to exclude. Dropping them costs those
 * few models a level rather than mistranslating one — sending `high` where the
 * user asked for `none` would be worse than not offering it.
 */
const VARIANT_EFFORTS = new Set<EffortId>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** A model's variants as Carbon efforts, in the picker's own order. */
export function variantEfforts(variants: Record<string, unknown> | undefined): EffortId[] {
  if (!variants) return []
  const named = new Set(Object.keys(variants))
  return [...VARIANT_EFFORTS].filter((effort) => named.has(effort))
}

interface RawProvider {
  id?: string
  name?: string
  models?: Record<string, RawModelInfo>
}

export interface RawProviderList {
  /** `/config/providers` spells it `providers`; `/provider` spells it `all`. */
  providers?: RawProvider[]
  all?: RawProvider[]
  /** Present on `/provider` only. Absent means "everything listed is usable". */
  connected?: string[]
  /** providerID → default modelID. */
  default?: Record<string, string>
}

/**
 * Whether a model costs nothing to run.
 *
 * Taken from OpenCode Zen's own `-free` id suffix rather than from the reported
 * `cost`, which is **0 for every model** the server lists — paid ones included
 * (`gpt-5.6-sol` reports 0/0 alongside `deepseek-v4-flash-free`), because on a
 * subscription nothing is billed per token. Badging from cost would therefore
 * mark the whole catalog free, which is exactly the claim not to get wrong.
 *
 * The suffix under-claims instead: a free model without it (Zen's `big-pickle`)
 * simply goes unbadged. A missing badge costs the user nothing; a wrong one
 * tells them a paid model is free.
 */
export function isFreeModel(modelID: string): boolean {
  return /-free$/i.test(modelID)
}

/** The sentinel row: run OpenCode on whatever its own config selects. */
export function opencodeDefaultOption(): ModelOption {
  return {
    id: OPENCODE_DEFAULT_MODEL,
    label: 'OpenCode (default)',
    description: 'Model from your opencode config',
    provider: 'opencode'
  }
}

/**
 * Picker rows for every model the server reports.
 *
 * `supportedEfforts` comes from each model's own `variants` — OpenCode's word
 * for reasoning effort. It is per *model*, not per provider: one Zen model
 * offers low/high/max, another offers nothing at all, so a provider-wide list
 * would offer levels half the catalog would reject.
 */
export function mapProviderList(raw: RawProviderList | null | undefined): ModelOption[] {
  const providers = raw?.providers ?? raw?.all ?? []
  if (!providers.length) return []
  // `connected` is authoritative when the endpoint sends it. When it doesn't,
  // every provider listed is one the user has credentials for — the server does
  // not advertise backends it cannot reach.
  const connected = raw?.connected?.length ? new Set(raw.connected) : null

  const rows: ModelOption[] = []
  for (const provider of providers) {
    const providerID = provider.id
    if (!providerID) continue
    if (connected && !connected.has(providerID)) continue
    for (const [key, info] of Object.entries(provider.models ?? {})) {
      const modelID = info.id ?? key
      if (!modelID) continue
      const free = isFreeModel(modelID)
      const efforts = variantEfforts(info.variants)
      rows.push({
        id: opencodeModelId(providerID, modelID),
        // Zen names its free models "… Free", and the row already carries a Free
        // badge — printing both reads as a stutter ("DeepSeek V4 Flash Free  Free").
        label: free ? (info.name || modelID).replace(/\s+free$/i, '') : info.name || modelID,
        description: provider.name || providerID,
        provider: 'opencode',
        ...(info.limit?.context ? { contextWindow: info.limit.context } : {}),
        ...(efforts.length ? { supportedEfforts: efforts } : {}),
        ...(free ? { free: true } : {})
      })
    }
  }
  rows.sort(
    (a, b) => a.description!.localeCompare(b.description!) || a.label.localeCompare(b.label)
  )
  return rows.length ? [opencodeDefaultOption(), ...rows] : []
}

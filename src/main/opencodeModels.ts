import type { ModelOption } from '@shared/types'
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
 * No `supportedEfforts`: OpenCode has no effort concept at all, and an empty
 * list is how the composer knows to collapse that menu to "Default" rather than
 * inheriting Claude's levels.
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
      rows.push({
        id: opencodeModelId(providerID, modelID),
        label: info.name || modelID,
        description: provider.name || providerID,
        provider: 'opencode',
        ...(info.limit?.context ? { contextWindow: info.limit.context } : {})
      })
    }
  }
  rows.sort(
    (a, b) => a.description!.localeCompare(b.description!) || a.label.localeCompare(b.label)
  )
  return rows.length ? [opencodeDefaultOption(), ...rows] : []
}

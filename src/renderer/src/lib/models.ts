import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PROVIDER_EFFORTS,
  PROVIDER_LABELS,
  SERVICE_TIER_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
  rememberedServiceTierForModel,
  type EffortId,
  type ModelOption,
  type Provider
} from '@shared/types'

export { canonicalModelId, rememberedEffortForModel, rememberedServiceTierForModel }

/**
 * The full model picker list, restricted to providers whose CLI is available.
 *
 * Carbon spawns the CLIs the user installed rather than copies of its own, so
 * "which providers can this machine run" is a real question and `available` is
 * its answer — a provider missing from it contributes no rows at all, because
 * every send would fail on a missing binary. That rule started as Grok's alone
 * (the one CLI the app never shipped) and now covers all three.
 *
 * Within an available provider the static `MODEL_OPTIONS` rows still stand in
 * for a catalog that hasn't arrived yet: the CLI is there, so the fetch is
 * pending rather than impossible, and the rows it will return are the ones
 * already listed. Grok keeps no static fallback even when installed — its
 * catalog is entirely runtime-discovered, and `MODEL_OPTIONS` carries its rows
 * only so `knownProviderForModel` can place a stored `grok-4.6`. Antigravity is
 * the same, for the same reason.
 */
export function assembleModelOptions(
  dynamicModels: ModelOption[],
  codexConfigModel: string | null | undefined,
  available: Provider[]
): ModelOption[] {
  const can = new Set(available)
  const providerOptions = (provider: ModelOption['provider']): ModelOption[] => {
    if (!can.has(provider)) return []
    const live = dynamicModels.filter((option) => option.provider === provider)
    return live.length ? live : MODEL_OPTIONS.filter((option) => option.provider === provider)
  }
  const codexModels = providerOptions('codex').map((option) =>
    option.id === 'codex-default' && codexConfigModel && !option.resolvedModel
      ? { ...option, resolvedModel: codexConfigModel }
      : option
  )
  // Live-only: neither has a static catalog to stand in, and Antigravity's
  // empty answer also means "nobody is signed in", when a row would only fail.
  const liveOnly = (provider: ModelOption['provider']): ModelOption[] =>
    can.has(provider) ? dynamicModels.filter((option) => option.provider === provider) : []
  return [
    ...providerOptions('claude'),
    ...codexModels,
    ...liveOnly('grok'),
    ...liveOnly('antigravity')
  ]
}

/**
 * The reasoning levels to offer for one model. Effort support is model-specific
 * where the provider reports it (Codex and Grok both do), since a CLI's global
 * config accepts more values than any one model necessarily advertises.
 * `PROVIDER_EFFORTS` is the provider-wide union and the right fallback when the
 * model says nothing.
 */
export function effortOptionsFor(
  option: ModelOption | undefined,
  provider: Provider
): typeof EFFORT_OPTIONS {
  const supported = new Set(option?.supportedEfforts ?? PROVIDER_EFFORTS[provider])
  return EFFORT_OPTIONS.filter((e) => e.id === '' || supported.has(e.id as EffortId)).map((e) =>
    e.id === '' ? { ...e, description: `Uses your ${PROVIDER_LABELS[provider]} config` } : e
  )
}

/**
 * The speeds to offer for one model. Capability flags only become
 * authoritative once this provider's live catalog has loaded. Static fallbacks
 * may omit them, so keep Fast available in that case rather than hiding a
 * working option.
 */
export function serviceTierOptionsFor(
  option: ModelOption | undefined,
  provider: Provider,
  dynamicModels: ModelOption[]
): typeof SERVICE_TIER_OPTIONS {
  const knowsFastSupport = dynamicModels.some((o) => o.provider === provider)
  return knowsFastSupport && option?.supportsFastMode !== true
    ? SERVICE_TIER_OPTIONS.filter((tier) => tier.id === 'standard')
    : SERVICE_TIER_OPTIONS
}

/**
 * A model row's identity across providers. Ids are unique only within one —
 * `''` is Claude's Default row — so anything keyed by model across the whole
 * picker keys by both.
 */
export function modelKey(provider: Provider, id: string): string {
  return `${provider}:${id}`
}

/**
 * The rows a picker offers: everything but what Settings → Models switched
 * off. `keep` names the ids currently selected, which stay listed even when
 * hidden — hiding a model declutters the menu, it does not strand a chat
 * already running on it with a picker that cannot name its own model.
 */
export function visibleModelOptions(
  options: ModelOption[],
  hidden: string[] | undefined,
  keep: string[] = []
): ModelOption[] {
  if (!hidden?.length) return options
  const off = new Set(hidden)
  return options.filter(
    (option) => keep.includes(option.id) || !off.has(modelKey(option.provider, option.id))
  )
}

/**
 * The model picker's search: every word typed must appear somewhere in the
 * row — its label, the model it resolves to, its id, or its provider's name —
 * so "opus 5", "codex" and "gpt-5" all find what they should.
 */
export function matchesModelQuery(option: ModelOption, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [
    option.label,
    option.resolvedModel,
    option.id,
    option.description,
    PROVIDER_LABELS[option.provider]
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return words.every((word) => hay.includes(word))
}

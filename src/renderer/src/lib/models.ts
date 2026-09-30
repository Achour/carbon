import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PROVIDER_EFFORTS,
  PROVIDER_LABELS,
  SERVICE_TIER_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
  type EffortId,
  type ModelOption,
  type Provider
} from '@shared/types'

export { canonicalModelId, rememberedEffortForModel }

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
 * only so `knownProviderForModel` can place a stored `grok-4.6`.
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
  const grokModels = can.has('grok')
    ? dynamicModels.filter((option) => option.provider === 'grok')
    : []
  return [...providerOptions('claude'), ...codexModels, ...grokModels]
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

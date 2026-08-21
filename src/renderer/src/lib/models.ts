import {
  MODEL_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
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

import {
  MODEL_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
  type ModelOption
} from '@shared/types'

export { canonicalModelId, rememberedEffortForModel }

/**
 * The full model picker list. Each provider independently prefers its live
 * catalog and falls back to static rows, so one unavailable CLI cannot hide the
 * other provider. Shared by the composer and plan review picker.
 */
export function assembleModelOptions(
  dynamicModels: ModelOption[],
  codexConfigModel: string | null | undefined
): ModelOption[] {
  const providerOptions = (provider: ModelOption['provider']): ModelOption[] => {
    const live = dynamicModels.filter((option) => option.provider === provider)
    return live.length ? live : MODEL_OPTIONS.filter((option) => option.provider === provider)
  }
  const codexModels = providerOptions('codex').map((option) =>
    option.id === 'codex-default' && codexConfigModel && !option.resolvedModel
      ? { ...option, resolvedModel: codexConfigModel }
      : option
  )
  return [...providerOptions('claude'), ...codexModels]
}

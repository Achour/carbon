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
  // OpenCode is a locally-installed CLI, so unlike the other two it can be
  // legitimately absent. It contributes its live rows or nothing at all — the
  // static catalog holds only its sentinel, and a picker group containing just
  // "OpenCode (default)" on a machine without the binary is a dead end.
  const opencodeModels = dynamicModels.filter((option) => option.provider === 'opencode')
  return [...providerOptions('claude'), ...codexModels, ...opencodeModels]
}

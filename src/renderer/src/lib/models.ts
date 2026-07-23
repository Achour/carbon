import {
  MODEL_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
  type ModelOption
} from '@shared/types'

export { canonicalModelId, rememberedEffortForModel }

/**
 * The full model picker list: the SDK-reported Claude models when loaded
 * (falling back to the static rows), plus the static Codex rows with the
 * config-selected model resolved onto the "Codex (default)" row. Shared by the
 * composer and the plan review's "Build with" picker so the two can't drift.
 */
export function assembleModelOptions(
  dynamicModels: ModelOption[],
  codexConfigModel: string | null | undefined
): ModelOption[] {
  const codexModels = MODEL_OPTIONS.filter((option) => option.provider === 'codex').map((option) =>
    option.id === 'codex-default' && codexConfigModel
      ? { ...option, resolvedModel: codexConfigModel }
      : option
  )
  return dynamicModels.length > 0
    ? [...dynamicModels, ...codexModels]
    : [...MODEL_OPTIONS.filter((option) => option.provider === 'claude'), ...codexModels]
}

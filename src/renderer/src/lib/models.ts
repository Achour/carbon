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
 *
 * Grok is the exception, and only ever appears live. Claude and Codex ship with
 * the app, so their static rows are a safe stand-in for a catalog that has not
 * arrived yet — the CLI is there either way. Grok is a separate install, and
 * its probe returning nothing is the answer "not installed", not "not fetched".
 * Falling back to static rows there would put models in the picker whose every
 * send fails with a missing binary, which is worse than not offering them: the
 * static rows still exist in `MODEL_OPTIONS`, where they place a stored id like
 * `grok-4.6` for `knownProviderForModel` without advertising anything.
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
  const grokModels = dynamicModels.filter((option) => option.provider === 'grok')
  return [...providerOptions('claude'), ...codexModels, ...grokModels]
}

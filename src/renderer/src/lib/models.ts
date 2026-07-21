import { MODEL_OPTIONS, type ModelOption } from '@shared/types'

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

const canonModel = (s?: string): string => (s ?? '').replace(/\[1m\]$/i, '')

/**
 * Resolve a chat's stored model id to the picker row that covers it. A chat
 * pinned to an older static id (e.g. 'claude-sonnet-5') won't equal the SDK's
 * alias value ('sonnet'), so match on `resolvedModel` (ignoring the '[1m]'
 * suffix) to keep the picker highlighted.
 */
export function canonicalModelId(model: string, options: ModelOption[]): string {
  if (options.some((o) => o.id === model)) return model
  const match = options.find(
    (o) =>
      o.id !== '' &&
      (canonModel(o.id) === canonModel(model) || canonModel(o.resolvedModel) === canonModel(model))
  )
  return match ? match.id : model
}

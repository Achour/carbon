import { visibleModels } from '@/lib/modelCatalog'
import {
  MODEL_OPTIONS,
  canonicalModelId,
  rememberedEffortForModel,
  type ModelOption
} from '@shared/types'

export { canonicalModelId, rememberedEffortForModel }

export interface AssembleOpts {
  /** Model ids the user has hidden in Settings. */
  hidden?: ReadonlySet<string>
  /**
   * A model to keep regardless of `hidden` — the one currently selected.
   * Hiding the model a chat is already running would blank its own picker and
   * make the composer look broken, so the rule is "hidden from the menu", not
   * "removed from existence".
   */
  keep?: string
}

/**
 * The full model picker list. Each provider independently prefers its live
 * catalog and falls back to static rows, so one unavailable CLI cannot hide the
 * other provider. Shared by the composer and plan review picker.
 */
export function assembleModelOptions(
  dynamicModels: ModelOption[],
  codexConfigModel: string | null | undefined,
  opts: AssembleOpts = {}
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
  // legitimately absent — and it has no static rows to fall back to. It
  // contributes its live catalog or nothing: every OpenCode model is discovered
  // from the running server, and a lone "OpenCode (default)" row on a machine
  // without the binary would be a dead end in the picker.
  const opencodeModels = dynamicModels.filter((option) => option.provider === 'opencode')
  const all = [...providerOptions('claude'), ...codexModels, ...opencodeModels]
  return visibleModels(all, opts.hidden, opts.keep)
}

/**
 * Every model the picker could offer, ignoring what's hidden — what Settings
 * lists so a hidden model can be found again and switched back on.
 */
export function allModelOptions(
  dynamicModels: ModelOption[],
  codexConfigModel: string | null | undefined
): ModelOption[] {
  return assembleModelOptions(dynamicModels, codexConfigModel)
}

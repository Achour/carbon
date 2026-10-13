import * as React from 'react'
import {
  PROVIDER_LABELS,
  canonicalModelId,
  modelDisplayName,
  type EffortId,
  type ModelOption,
  type PermissionModeId,
  type Provider,
  type ServiceTier
} from '@shared/types'
import {
  assembleModelOptions,
  effortOptionsFor,
  rememberedEffortForModel,
  rememberedServiceTierForModel,
  serviceTierOptionsFor,
  visibleModelOptions
} from '@/lib/models'
import { PROVIDER_PERMISSION_MODES, codexPermissionValue } from '@/lib/permissionModes'
import { useRemote } from './state'

/**
 * The composer's four pickers, computed exactly as the desktop's `Composer`
 * computes them — same catalog assembly, same Settings → Models hiding, same
 * per-model effort and speed lists, same per-provider modes — so a phone
 * never offers a row the Mac would not.
 */
export interface OptionValues {
  provider: Provider
  model: string
  effort: EffortId | ''
  serviceTier: ServiceTier
  permissionMode: PermissionModeId
}

export interface Pickers {
  /** Every row the model sheet lists, provider by provider. */
  models: ModelOption[]
  selectedModel: string
  modelLabel: string
  efforts: { id: EffortId | ''; label: string; description: string }[]
  effort: EffortId | ''
  tiers: { id: ServiceTier; label: string; description: string }[]
  serviceTier: ServiceTier
  modes: { id: PermissionModeId; label: string; description: string }[]
  permissionMode: PermissionModeId
  /**
   * The patch a model pick sends: the model, plus the effort and speed last
   * used with it (`remember: false` — replaying a stored value must not re-key
   * it to the model being left). Mirrors `Composer.handleModelChange`.
   */
  pickModel(option: ModelOption): Partial<OptionValues> & { replayed: Partial<OptionValues> }
}

export function useAllModels(): ModelOption[] {
  const models = useRemote((s) => s.models)
  const codex = useRemote((s) => s.codexConfigModel)
  const available = useRemote((s) => s.available)
  return React.useMemo(() => assembleModelOptions(models, codex, available), [models, codex, available])
}

export function usePickers(v: OptionValues): Pickers {
  const all = useAllModels()
  const live = useRemote((s) => s.models)
  const defaults = useRemote((s) => s.defaults)
  return React.useMemo(() => {
    const selectedModel = canonicalModelId(v.model, all)
    const option = all.find((o) => o.id === selectedModel && o.provider === v.provider)
    const efforts = effortOptionsFor(option, v.provider)
    const tiers = serviceTierOptionsFor(option, v.provider, live)
    const modes = PROVIDER_PERMISSION_MODES[v.provider]
    const requested = v.provider === 'codex' ? codexPermissionValue(v.permissionMode) : v.permissionMode
    return {
      models: visibleModelOptions(all, defaults?.hiddenModels, [selectedModel]),
      selectedModel,
      modelLabel: modelDisplayName(v.model, v.provider, all),
      efforts,
      // A value this model does not offer reads as what will actually run.
      effort: efforts.some((e) => e.id === v.effort) ? v.effort : '',
      tiers,
      serviceTier: tiers.some((t) => t.id === v.serviceTier) ? v.serviceTier : 'standard',
      modes,
      permissionMode: modes.some((m) => m.id === requested) ? requested : 'default',
      pickModel(next) {
        const replayed: Partial<OptionValues> = {}
        const effort = rememberedEffortForModel(defaults?.modelEfforts, next.id, all)
        if (effort !== undefined && effort !== v.effort) replayed.effort = effort
        const tier = rememberedServiceTierForModel(defaults?.modelServiceTiers, next.id, all) ?? 'standard'
        if (tier !== v.serviceTier) replayed.serviceTier = tier
        return { model: next.id, provider: next.provider, replayed }
      }
    }
  }, [v.model, v.provider, v.effort, v.serviceTier, v.permissionMode, all, live, defaults])
}

/** Model rows grouped under their provider, in the catalog's order. */
export function groupByProvider(models: ModelOption[]): { provider: Provider; label: string; rows: ModelOption[] }[] {
  const out: { provider: Provider; label: string; rows: ModelOption[] }[] = []
  for (const m of models) {
    const group = out.find((g) => g.provider === m.provider)
    if (group) group.rows.push(m)
    else out.push({ provider: m.provider, label: PROVIDER_LABELS[m.provider], rows: [m] })
  }
  return out
}

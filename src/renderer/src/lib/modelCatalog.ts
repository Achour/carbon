import type { ModelOption } from '@shared/types'

/**
 * A live picker is complete once both bundled provider catalogs are represented.
 *
 * Deliberately *not* extended to OpenCode: it is an optional CLI the user
 * installs themselves, so on most machines its catalog never arrives. Requiring
 * it here would leave the picker permanently incomplete and re-fetch models
 * forever (`modelsRetryAt` never settles); OpenCode's rows ride the same warmup
 * and merge in through `mergeModelCatalogs` whenever they do show up.
 */
export function hasCompleteModelCatalog(models: ModelOption[]): boolean {
  return (
    models.some((option) => option.provider === 'claude') &&
    models.some((option) => option.provider === 'codex')
  )
}

/**
 * Drop the models the user hid in Settings.
 *
 * `keep` survives hiding: it is the model the chat is currently on, and a picker
 * that omits its own selection shows no model at all and reads as broken. Hiding
 * trims the menu; it does not take a model away from a chat already using it.
 */
export function visibleModels(
  all: ModelOption[],
  hidden: ReadonlySet<string> | undefined,
  keep?: string
): ModelOption[] {
  if (!hidden?.size) return all
  return all.filter((option) => !hidden.has(option.id) || option.id === keep)
}

/** Replace only providers present in a response, retaining the other good catalog. */
export function mergeModelCatalogs(
  current: ModelOption[],
  incoming: ModelOption[]
): ModelOption[] {
  if (!incoming.length) return current
  const providers = new Set(incoming.map((option) => option.provider))
  return [...current.filter((option) => !providers.has(option.provider)), ...incoming]
}

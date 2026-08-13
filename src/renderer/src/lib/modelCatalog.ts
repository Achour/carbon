import type { ModelOption } from '@shared/types'

/**
 * A live picker is complete once both *required* provider catalogs are present.
 *
 * Grok is deliberately not one of them. Claude and Codex ship with the app, so a
 * missing catalog there means a fetch that has not landed yet and is worth
 * retrying; Grok is a third-party CLI the user may simply not have installed,
 * and requiring it would leave those users retrying a probe forever that is
 * correctly returning nothing.
 */
export function hasCompleteModelCatalog(models: ModelOption[]): boolean {
  return (
    models.some((option) => option.provider === 'claude') &&
    models.some((option) => option.provider === 'codex')
  )
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

import type { ModelOption } from '@shared/types'

/** A live picker is complete only once both provider catalogs are represented. */
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

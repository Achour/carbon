import type { ModelOption, Provider, ProviderCli } from '@shared/types'

/**
 * Providers whose CLI is switched on and actually installed. Carbon runs the
 * user's own CLIs, so this is the list the pickers are drawn from — a provider
 * with nothing to spawn must not be offered a model, since every send would
 * fail on a missing binary.
 */
export function availableProviders(clis: ProviderCli[]): Provider[] {
  return clis.filter((cli) => cli.enabled && cli.installed).map((cli) => cli.provider)
}

/**
 * A live picker is complete once every *available* provider has answered.
 *
 * This is what stops the fetch retrying forever: a provider that isn't
 * installed is correctly returning nothing, so waiting on it is waiting on an
 * answer that will never come. It was Grok-shaped when Grok was the only CLI
 * the app didn't ship; now all three are the user's own install and the rule
 * generalizes. `available` empty means nothing to fetch, which counts as
 * complete rather than as a permanently pending load.
 */
export function hasCompleteModelCatalog(models: ModelOption[], available: Provider[]): boolean {
  return available.every((provider) => models.some((option) => option.provider === provider))
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

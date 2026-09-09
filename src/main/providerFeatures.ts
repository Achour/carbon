// Relative and .ts-extensioned, like `lsp.ts`'s import of the same module:
// `test/providerFeatures.test.ts` runs this file directly under `node --test`,
// with no bundler to resolve an alias.
import { providerFeatureConfig } from './providerCli.ts'
import { CLAUDE_FEATURES } from '../shared/types.ts'
import type { Provider, ProviderFeature, ProviderFeatureState } from '../shared/types.ts'

/**
 * What a provider's capability switches are worth, once the user's setting, the
 * environment and the provider's own default have been reconciled.
 *
 * **The precedence is fixed and the environment wins.** Carbon has always let a
 * user turn one of Claude's gated features off by exporting
 * `CLAUDE_CODE_ARTIFACT=0` before launching, and CLAUDE.md documents that as the
 * opt-out; a settings page that silently overrode it would break the escape
 * hatch that exists for exactly the case where the UI is wrong. So the variable
 * outranks the switch — the same shape as `CARBON_CLAUDE_PATH` outranking
 * resolution in `providerCli.ts` — and the row *says so* rather than showing a
 * control that does nothing (`ProviderFeatureState.overriddenBy`).
 *
 * Below that, an unset switch means "leave the provider alone", which is not
 * the same as off: Codex reports ~130 flags Carbon never surfaces, and writing
 * `false` for a feature nobody touched would turn off things the CLI ships on.
 * That is why the stored record is sparse and this resolves against
 * `defaultEnabled` rather than filling it in.
 */
export function resolveFeature(
  provider: Provider,
  feature: ProviderFeature,
  envName: string | undefined,
  env: NodeJS.ProcessEnv
): ProviderFeatureState {
  // **Only a `0` overrides.** These variables are opt-*outs* — CLAUDE.md
  // describes each as "set unless the user already has: `=0` is then their
  // opt-out" — and Carbon's own answer is on, so a `1` asks for nothing the
  // switch would not already do. Reading it as an override was actively wrong:
  // Claude Code exports all three to every subprocess it spawns, so a Carbon
  // launched from a terminal inside a session — which is how Carbon is
  // developed — inherited three `1`s that nobody chose and greyed out all three
  // switches permanently. A `0` still wins and still says so, because that one
  // *is* a deliberate instruction and is the escape hatch for a UI that is
  // wrong about something.
  const override = envName ? env[envName] : undefined
  if (override === '0') {
    return { ...feature, enabled: false, overriddenBy: envName }
  }
  const chosen = providerFeatureConfig(provider)?.[feature.id]
  return { ...feature, enabled: chosen ?? feature.defaultEnabled }
}

/** Claude's three, resolved. Static — the CLI lists no equivalent of its own. */
export function claudeFeatureStates(env: NodeJS.ProcessEnv = process.env): ProviderFeatureState[] {
  return CLAUDE_FEATURES.map((f) => resolveFeature('claude', f, f.env, env))
}

/**
 * The environment block a Claude session spawns with.
 *
 * Every entry is written unconditionally, including the `'0'`s: the CLI reads
 * these as booleans, and *omitting* one is not the same as disabling it — for
 * `CLAUDE_CODE_ENABLE_CFC` and `CLAUDE_CODE_ARTIFACT` an absent variable means
 * the CLI falls back to its own gate, which for a session the SDK spawned is
 * "off" for Chrome but is an account rollout flag for Artifacts. Spelling the
 * choice out leaves nothing to infer. A variable the user set themselves comes
 * back out of `resolveFeature` unchanged, so this cannot clobber it.
 */
export function claudeFeatureEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of CLAUDE_FEATURES) {
    out[f.env] = resolveFeature('claude', f, f.env, env).enabled ? '1' : '0'
  }
  return out
}

/**
 * Codex feature choices as app-server command-line overrides.
 *
 * `experimentalFeature/enablement/set` exists and works, but it is explicitly
 * *process-wide runtime* state: it dies with the app server, and Carbon
 * disposes those freely — every throwaway probe spawns one. The durable
 * spelling is `features.<name>`, the same one the CLI's own `--enable` /
 * `--disable` flags compile to, applied at spawn. Only keys the user actually
 * set are emitted, so a flag Carbon has never shown reaches the CLI untouched.
 */
export function codexFeatureArgs(
  features: Record<string, boolean> | undefined = providerFeatureConfig('codex')
): string[] {
  if (!features) return []
  const args: string[] = []
  for (const [name, on] of Object.entries(features)) {
    args.push('-c', `features.${name}=${on ? 'true' : 'false'}`)
  }
  return args
}

/**
 * Codex's discovered list, resolved against the user's switches.
 *
 * `enabled` as the CLI reports it is *its* answer under whatever config it
 * loaded — which already includes the `-c features.…` overrides Carbon spawned
 * it with, so it would be circular to trust for the switch position. The user's
 * own choice is the truth where they made one; the CLI's `defaultEnabled` fills
 * the rest. No environment variable governs these, hence the undefined.
 */
export function codexFeatureStates(discovered: ProviderFeature[]): ProviderFeatureState[] {
  return discovered.map((f) => resolveFeature('codex', f, undefined, {}))
}

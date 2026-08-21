import assert from 'node:assert/strict'
import test from 'node:test'
import {
  availableProviders,
  hasCompleteModelCatalog,
  mergeModelCatalogs
} from '../src/renderer/src/lib/modelCatalog.ts'
import type { ModelOption, Provider, ProviderCli } from '../src/shared/types.ts'

const claude: ModelOption = { id: 'claude-live', label: 'Claude Live', provider: 'claude' }
const codex: ModelOption = { id: 'codex-live', label: 'Codex Live', provider: 'codex' }

test('a model catalog is complete once every available provider has loaded', () => {
  const both: Provider[] = ['claude', 'codex']
  assert.equal(hasCompleteModelCatalog([], both), false)
  assert.equal(hasCompleteModelCatalog([codex], both), false)
  assert.equal(hasCompleteModelCatalog([claude, codex], both), true)
})

test('a provider with no CLI is not waited on', () => {
  // The retry policy stops on "complete", so counting an uninstalled provider
  // would retry a probe that is correctly returning nothing, forever.
  assert.equal(hasCompleteModelCatalog([codex], ['codex']), true)
  assert.equal(hasCompleteModelCatalog([], []), true)
})

test('only installed and enabled providers are available', () => {
  const cli = (patch: Partial<ProviderCli>): ProviderCli => ({
    provider: 'claude',
    enabled: true,
    path: '/usr/local/bin/claude',
    installed: true,
    version: '2.1.0',
    source: 'path',
    outdated: false,
    minVersion: '2.0.0',
    installCommand: 'npm i -g x',
    ...patch
  })

  assert.deepEqual(
    availableProviders([
      cli({ provider: 'claude' }),
      // Installed but switched off in Settings → Providers: hidden exactly like
      // a missing one, which is the whole point of the switch.
      cli({ provider: 'codex', enabled: false }),
      // Found somewhere, but not runnable — resolved, still unavailable.
      cli({ provider: 'grok', installed: false, path: '/gone/grok' })
    ]),
    ['claude']
  )
})

test('a partial model refresh preserves the other provider catalog', () => {
  const refreshedCodex: ModelOption = {
    id: 'codex-next',
    label: 'Codex Next',
    provider: 'codex'
  }

  assert.deepEqual(mergeModelCatalogs([claude, codex], [refreshedCodex]), [
    claude,
    refreshedCodex
  ])
  assert.deepEqual(mergeModelCatalogs([claude, codex], []), [claude, codex])
})

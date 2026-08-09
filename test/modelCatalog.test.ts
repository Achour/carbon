import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasCompleteModelCatalog,
  mergeModelCatalogs
} from '../src/renderer/src/lib/modelCatalog.ts'
import type { ModelOption } from '../src/shared/types.ts'

const claude: ModelOption = { id: 'claude-live', label: 'Claude Live', provider: 'claude' }
const codex: ModelOption = { id: 'codex-live', label: 'Codex Live', provider: 'codex' }

test('a model catalog is complete only after both providers load', () => {
  assert.equal(hasCompleteModelCatalog([]), false)
  assert.equal(hasCompleteModelCatalog([codex]), false)
  assert.equal(hasCompleteModelCatalog([claude, codex]), true)
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

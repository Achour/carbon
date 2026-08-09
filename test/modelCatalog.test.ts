import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasCompleteModelCatalog,
  mergeModelCatalogs,
  visibleModels
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

test('hiding models trims the picker but never removes the current selection', () => {
  const all = [
    { id: 'a', label: 'A', provider: 'claude' as const },
    { id: 'b', label: 'B', provider: 'codex' as const },
    { id: 'c', label: 'C', provider: 'opencode' as const }
  ]
  assert.deepEqual(visibleModels(all, new Set(['b'])).map((m) => m.id), ['a', 'c'])
  // The chat's own model survives being hidden: a picker with no selection in
  // it shows nothing at all and reads as broken.
  assert.deepEqual(visibleModels(all, new Set(['b']), 'b').map((m) => m.id), ['a', 'b', 'c'])
  // Hiding everything still leaves the one in use.
  assert.deepEqual(visibleModels(all, new Set(['a', 'b', 'c']), 'c').map((m) => m.id), ['c'])
  // No hidden set is the identity, and the array is returned as-is.
  assert.equal(visibleModels(all, undefined), all)
  assert.equal(visibleModels(all, new Set()), all)
})

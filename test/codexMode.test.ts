import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexPlan } from '../src/main/codexMode.ts'

test('extracts a native App Server plan and removes transport tags from displayed text', () => {
  assert.deepEqual(
    parseCodexPlan('Ready for review.\n\n<proposed_plan>\n## Steps\n\n1. Edit `a.ts`.\n</proposed_plan>'),
    {
      plan: '## Steps\n\n1. Edit `a.ts`.',
      displayText: 'Ready for review.\n\n## Steps\n\n1. Edit `a.ts`.'
    }
  )
})

test('does not turn untagged prose or clarifying questions into a plan', () => {
  assert.equal(parseCodexPlan('## Plan\n\n1. Verify it.'), null)
  assert.equal(parseCodexPlan('Which database should I use?'), null)
  assert.equal(parseCodexPlan('   '), null)
})

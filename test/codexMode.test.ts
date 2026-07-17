import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexPlan, promptForCodexMode } from '../src/main/codexMode.ts'

test('Plan mode instructs Codex to investigate without implementing', () => {
  const prompt = promptForCodexMode('Add authentication', true)

  assert.match(prompt, /# Collaboration Mode: Plan/)
  assert.match(prompt, /do not implement it/i)
  assert.match(prompt, /Do not edit, create, or delete files/)
  assert.match(prompt, /<proposed_plan>/)
  assert.ok(prompt.endsWith('Add authentication'))
})

test('Default mode explicitly releases a resumed thread from Plan mode', () => {
  const prompt = promptForCodexMode('Implement the plan', false)

  assert.match(prompt, /# Collaboration Mode: Default/)
  assert.match(prompt, /Plan mode instruction from an earlier turn no longer applies/)
  assert.ok(prompt.endsWith('Implement the plan'))
})

test('Codex keeps the parent turn alive until spawned agents finish', () => {
  const prompt = promptForCodexMode('Use three agents', false)

  assert.match(prompt, /Do not send the final answer while any spawned agent is pending or running/)
  assert.match(prompt, /Use wait_agent repeatedly/)
  assert.match(prompt, /ending a Codex exec turn interrupts unfinished child agents/)
})

test('an empty Plan prompt still carries the mode instruction', () => {
  const prompt = promptForCodexMode('', true)

  assert.match(prompt, /# Collaboration Mode: Plan/)
  assert.doesNotMatch(prompt, /undefined/)
})

test('extracts a tagged proposal and removes transport tags from displayed text', () => {
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentForMode,
  decisionToReply,
  isSilentMode,
  rulesetForMode,
  type OpencodeAction
} from '../src/main/opencodeMode.ts'
import { buildApprovedPlanPrompt, buildPlanFeedbackPrompt } from '../src/main/opencodePlan.ts'

function actionFor(mode: Parameters<typeof rulesetForMode>[0], permission: string): OpencodeAction {
  const rule = rulesetForMode(mode).find((r) => r.permission === permission)
  assert.ok(rule, `${mode} should carry a rule for ${permission}`)
  return rule.action
}

test('plan mode runs the plan agent and refuses mutations outright', () => {
  assert.equal(agentForMode('plan'), 'plan')
  assert.equal(actionFor('plan', 'edit'), 'deny')
  assert.equal(actionFor('plan', 'bash'), 'deny')
  assert.equal(actionFor('plan', 'read'), 'allow')
})

test('every other mode runs the default agent', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    assert.equal(agentForMode(mode), undefined)
  }
})

test('default mode asks before edits and commands but never before reads', () => {
  assert.equal(actionFor('default', 'edit'), 'ask')
  assert.equal(actionFor('default', 'bash'), 'ask')
  assert.equal(actionFor('default', 'read'), 'allow')
  assert.equal(actionFor('default', 'grep'), 'allow')
})

test('acceptEdits allows edits but still gates running commands', () => {
  assert.equal(actionFor('acceptEdits', 'edit'), 'allow')
  assert.equal(actionFor('acceptEdits', 'bash'), 'ask')
  assert.equal(actionFor('acceptEdits', 'webfetch'), 'ask')
})

test('auto is deliberately no broader than acceptEdits on this backend', () => {
  // Claude's Auto defers to a classifier. OpenCode has none, so rather than
  // approving commands on a guess, Auto occupies the same slot with the same
  // guarantees — the honest subset.
  assert.equal(actionFor('auto', 'edit'), 'allow')
  assert.equal(actionFor('auto', 'bash'), 'ask')
})

test('bypassPermissions allows everything and asks for nothing', () => {
  const ruleset = rulesetForMode('bypassPermissions')
  assert.ok(ruleset.length > 0)
  assert.ok(
    ruleset.every((r) => r.action === 'allow'),
    'no rule may be ask or deny under full access'
  )
  assert.ok(isSilentMode('bypassPermissions'))
  assert.ok(!isSilentMode('default'))
})

test('rules are scoped to the session, so patterns are broad but the ruleset is not global', () => {
  for (const rule of rulesetForMode('default')) assert.equal(rule.pattern, '**')
})

test('a Carbon decision becomes an OpenCode reply, with no "deny always"', () => {
  assert.equal(decisionToReply({ behavior: 'allow' }), 'once')
  assert.equal(decisionToReply({ behavior: 'allow', always: true }), 'always')
  assert.equal(decisionToReply({ behavior: 'deny' }), 'reject')
  // OpenCode has no persistent denial; a deny is always the single request.
  assert.equal(decisionToReply({ behavior: 'deny', message: 'no' }), 'reject')
})

test('plan prompts carry the plan in tags the model can find', () => {
  const approved = buildApprovedPlanPrompt('1. do it')
  assert.match(approved, /<approved_plan>\n1\. do it\n<\/approved_plan>/)

  const revision = buildPlanFeedbackPrompt('1. do it', '  use fewer files  ')
  assert.match(revision, /<previous_plan>\n1\. do it\n<\/previous_plan>/)
  assert.match(revision, /<plan_feedback>\nuse fewer files\n<\/plan_feedback>/)
  // An empty rejection still has to say something actionable.
  assert.match(buildPlanFeedbackPrompt('p', '   '), /Revise the plan/)
})

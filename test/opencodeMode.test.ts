import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENCODE_AGENTS,
  agentForMode,
  decisionToReply,
  modeForAgent,
  supportedModes
} from '../src/main/opencodeMode.ts'
import { buildApprovedPlanPrompt, buildPlanFeedbackPrompt } from '../src/main/opencodePlan.ts'

/**
 * OpenCode has two modes and they are its own: build and plan.
 *
 * An earlier version of this file tested four modes synthesized out of
 * per-session permission rulesets. They worked, but they were Carbon's
 * invention — an OpenCode user has an agent, and what gets approved is their
 * own `opencode.json`. These tests exist mostly to keep that from creeping back.
 */

test('the two modes are OpenCode’s two primary agents', () => {
  assert.deepEqual([...OPENCODE_AGENTS], ['build', 'plan'])
  assert.equal(agentForMode('plan'), 'plan')
  assert.equal(agentForMode('default'), 'build')
})

test('an agent is always named, never left to the server’s default', () => {
  // The server's default is build today; naming it means a turn can't quietly
  // change meaning if that ever moves.
  for (const mode of ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    assert.ok(OPENCODE_AGENTS.includes(agentForMode(mode)), `${mode} must resolve to an agent`)
  }
})

test('modes Carbon has but OpenCode does not all fall to build', () => {
  // acceptEdits / auto / bypassPermissions are permission policy, which on this
  // backend is the user's config rather than a per-chat choice. A chat switched
  // in from Claude carrying one runs as the default agent.
  assert.equal(agentForMode('acceptEdits'), 'build')
  assert.equal(agentForMode('auto'), 'build')
  assert.equal(agentForMode('bypassPermissions'), 'build')
})

test('the picker offers exactly the modes the agents map back to', () => {
  assert.deepEqual(supportedModes(), ['default', 'plan'])
  assert.equal(modeForAgent('build'), 'default')
  assert.equal(modeForAgent('plan'), 'plan')
})

test('a Carbon decision becomes an OpenCode reply, with no "deny always"', () => {
  // Requests still reach the user — the build agent gates a few things by
  // default and their config may gate more — so answering them is still ours.
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

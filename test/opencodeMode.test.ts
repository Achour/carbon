import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENCODE_DEFAULT_AGENT,
  agentForChat,
  decisionToReply,
  modeForAgent,
  primaryAgents
} from '../src/main/opencodeMode.ts'
import { buildApprovedPlanPrompt, buildPlanFeedbackPrompt } from '../src/main/opencodePlan.ts'

/**
 * OpenCode's modes are its agents, and the list belongs to the user.
 *
 * Two things this file exists to keep from creeping back: the permission
 * rulesets an earlier version synthesized (a taxonomy no OpenCode user
 * recognizes), and the hardcoded build/plan pair that replaced them (which hid
 * every agent a user defines in their own opencode.json).
 *
 * The payload below is what a default install actually answers with — recorded
 * from `GET /agent` on opencode 1.18.15.
 */
const DEFAULT_INSTALL = [
  { name: 'build', mode: 'primary', native: true, description: 'The default agent.' },
  { name: 'compaction', mode: 'primary', hidden: true, native: true, description: '' },
  { name: 'explore', mode: 'subagent', native: true, description: 'Fast agent for exploring.' },
  { name: 'general', mode: 'subagent', native: true, description: 'General-purpose agent.' },
  { name: 'plan', mode: 'primary', native: true, description: 'Plan mode. Disallows all edit tools.' },
  { name: 'summary', mode: 'primary', hidden: true, native: true, description: '' },
  { name: 'title', mode: 'primary', hidden: true, native: true, description: '' }
]

test('a default install yields exactly build and plan', () => {
  const agents = primaryAgents(DEFAULT_INSTALL)
  assert.deepEqual(
    agents.map((a) => a.name),
    ['build', 'plan']
  )
  // The description is the agent author's, carried through for the picker row.
  assert.equal(agents[1].description, 'Plan mode. Disallows all edit tools.')
})

test('a user’s own agents come through, with build still leading', () => {
  const agents = primaryAgents([
    { name: 'reviewer', mode: 'primary', description: 'Reviews a diff.' },
    ...DEFAULT_INSTALL,
    { name: 'docs', mode: 'all', description: 'Writes docs.' }
  ])
  assert.deepEqual(
    agents.map((a) => a.name),
    ['build', 'reviewer', 'plan', 'docs']
  )
})

test('hidden agents and subagents are never offered', () => {
  // compaction/summary/title are OpenCode's own machinery; explore/general are
  // spawned by a turn rather than chosen for one.
  const names = primaryAgents(DEFAULT_INSTALL).map((a) => a.name)
  for (const internal of ['compaction', 'summary', 'title', 'explore', 'general']) {
    assert.ok(!names.includes(internal), `${internal} must not be offered`)
  }
})

test('an unusable payload is dropped rather than guessed at', () => {
  assert.deepEqual(primaryAgents(undefined), [])
  assert.deepEqual(primaryAgents({ agents: [] }), [])
  assert.deepEqual(primaryAgents([null, 'build', { mode: 'primary' }, { name: '   ' }]), [])
  // A nameless entry goes; a describable one survives beside it.
  assert.deepEqual(
    primaryAgents([{ name: '', mode: 'primary' }, { name: 'solo', mode: 'primary' }]),
    [{ name: 'solo' }]
  )
})

test('an agent is always named, and plan mode overrides the stored pick', () => {
  assert.equal(agentForChat(undefined, 'default'), OPENCODE_DEFAULT_AGENT)
  assert.equal(agentForChat('reviewer', 'default'), 'reviewer')
  assert.equal(agentForChat('   ', 'default'), 'build')
  // The plan-review gate keys off the mode, so a turn it treats as read-only
  // has to actually run the read-only agent.
  assert.equal(agentForChat('reviewer', 'plan'), 'plan')
})

test('modes Carbon has but OpenCode does not all fall to the default agent', () => {
  // acceptEdits / auto / bypassPermissions are permission policy, which on this
  // backend is the user's config rather than a per-chat choice. A chat switched
  // in from Claude carrying one runs as build.
  for (const mode of ['acceptEdits', 'auto', 'bypassPermissions'] as const) {
    assert.equal(agentForChat(undefined, mode), 'build')
  }
})

test('only plan maps back to a mode of its own', () => {
  assert.equal(modeForAgent('plan'), 'plan')
  assert.equal(modeForAgent('build'), 'default')
  // Carbon can't know what a custom agent may do; putting it behind the plan
  // gate would stall an agent that edits, and outside it one that doesn't.
  assert.equal(modeForAgent('reviewer'), 'default')
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

import type { PermissionDecision, PermissionModeId } from '@shared/types'

/**
 * OpenCode has two modes, and they are its own: **build** and **plan**.
 *
 * That is the entire mapping. Carbon deliberately sends no permission ruleset —
 * an earlier version constructed four modes out of `{permission, pattern,
 * action}` triples, which worked but invented a taxonomy no OpenCode user
 * recognizes and could not express a custom agent at all. Picking the agent is
 * what OpenCode asks a client to do; permissions come from the user's own
 * `opencode.json` and the agent's own declaration, so a chat here behaves
 * exactly like the same prompt in their TUI.
 *
 * The consequence worth stating: "accept edits" and "full access" are no longer
 * per-chat. They are config, global to the user's OpenCode install — which is
 * also why Carbon must not write them, since that config is shared with every
 * other client talking to the same server.
 */

/** OpenCode's primary agents, in the order the picker shows them. */
export const OPENCODE_AGENTS = ['build', 'plan'] as const
export type OpencodeAgent = (typeof OPENCODE_AGENTS)[number]

/**
 * The agent a turn runs as.
 *
 * Sent explicitly rather than omitted for build: the server's default is build
 * today, but naming it means a turn cannot silently change meaning if that
 * default ever moves.
 */
export function agentForMode(mode: PermissionModeId): OpencodeAgent {
  return mode === 'plan' ? 'plan' : 'build'
}

/**
 * Carbon's mode for an agent — the inverse, used when normalizing a chat that
 * arrived carrying a mode from another provider.
 */
export function modeForAgent(agent: OpencodeAgent): PermissionModeId {
  return agent === 'plan' ? 'plan' : 'default'
}

/** Every mode OpenCode can express. Anything else normalizes onto `default`. */
export function supportedModes(): PermissionModeId[] {
  return OPENCODE_AGENTS.map(modeForAgent)
}

export type OpencodeReply = 'once' | 'always' | 'reject'

/**
 * A Carbon permission answer as an OpenCode reply.
 *
 * Permission requests still reach the user — the build agent gates a few things
 * by default and their config may gate more — so answering them is still
 * Carbon's job even though choosing the policy is not.
 *
 * Note the asymmetry: OpenCode has no "deny always". A denial is always `reject`
 * — the single request fails and the model is told so, which is what Carbon's
 * deny means anyway; only the *allow* side has a persistent form.
 */
export function decisionToReply(decision: PermissionDecision): OpencodeReply {
  if (decision.behavior !== 'allow') return 'reject'
  return decision.always ? 'always' : 'once'
}

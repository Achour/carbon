import type { OpencodeAgentInfo, PermissionDecision, PermissionModeId } from '@shared/types'

/**
 * OpenCode's modes are its **agents**, and the list is the user's, not ours.
 *
 * `GET /agent` answers with every agent the server knows; the ones a turn can
 * run as are the unhidden primaries (`mode: 'primary' | 'all'`). A default
 * install answers with exactly `build` and `plan` — but `opencode.json` can
 * define more, and a client that hardcodes the pair silently hides them. So the
 * picker is built from the server's answer, with the pair as the fallback for
 * when it can't be asked.
 *
 * Carbon still sends no permission ruleset. An earlier version constructed four
 * modes out of `{permission, pattern, action}` triples, which worked but
 * invented a taxonomy no OpenCode user recognizes — and could not express a
 * custom agent at all, which is precisely what this file now does. What gets
 * approved comes from the user's own `opencode.json` and the agent's own
 * declaration, so a chat here behaves exactly like the same prompt in their TUI.
 *
 * The consequence worth stating: "accept edits" and "full access" are not
 * per-chat here. They are config, global to the user's OpenCode install — which
 * is also why Carbon must not write them, since that config is shared with
 * every other client talking to the same server.
 */

/** OpenCode's own name for its default agent. */
export const OPENCODE_DEFAULT_AGENT = 'build'

interface RawAgent {
  name?: unknown
  description?: unknown
  mode?: unknown
  hidden?: unknown
}

/**
 * The agents a turn can run as, in the order the picker shows them.
 *
 * `hidden` agents (`compaction`, `summary`, `title`) are OpenCode's own
 * machinery and `subagent`s (`explore`, `general`) are spawned by a turn rather
 * than chosen for one — neither is something to offer. `build` leads when it is
 * present, since it is the default; anything unrecognizable in the payload is
 * dropped rather than guessed at.
 */
export function primaryAgents(raw: unknown): OpencodeAgentInfo[] {
  if (!Array.isArray(raw)) return []
  const out: OpencodeAgentInfo[] = []
  for (const item of raw as RawAgent[]) {
    if (!item || typeof item !== 'object') continue
    if (item.hidden === true) continue
    if (item.mode !== 'primary' && item.mode !== 'all') continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    out.push(description ? { name, description } : { name })
  }
  out.sort((a, b) =>
    a.name === OPENCODE_DEFAULT_AGENT ? -1 : b.name === OPENCODE_DEFAULT_AGENT ? 1 : 0
  )
  return out
}

/**
 * The agent a turn runs as.
 *
 * Plan mode wins over the stored agent: the plan-review gate keys off
 * `permissionMode`, so a turn it treats as read-only must actually be read-only.
 * The two normally agree — picking an agent sets the mode alongside it — and
 * this is what keeps them agreeing when a chat arrives carrying `plan` from
 * another provider.
 *
 * An agent is always named rather than omitted for `build`: the server's default
 * is `build` today, but naming it means a turn cannot silently change meaning if
 * that default ever moves.
 */
export function agentForChat(agent: string | undefined, mode: PermissionModeId): string {
  if (mode === 'plan') return 'plan'
  return agent?.trim() || OPENCODE_DEFAULT_AGENT
}

/**
 * Carbon's mode for an agent — the inverse, used when the user picks one.
 *
 * Only `plan` maps to a mode of its own; every other agent, custom ones
 * included, is `default`. Carbon has no way to know what a custom agent is
 * allowed to do, and guessing would put a read-only agent behind the plan gate
 * or an editing one outside it.
 */
export function modeForAgent(agent: string): PermissionModeId {
  return agent === 'plan' ? 'plan' : 'default'
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

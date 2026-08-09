import type { PermissionDecision, PermissionModeId } from '@shared/types'

/**
 * Carbon's five permission modes, expressed the way OpenCode expects them.
 *
 * OpenCode takes a **per-session permission ruleset** at session creation —
 * `{permission, pattern, action}` triples over its own tool taxonomy — plus the
 * name of the agent the turn runs as. That is the whole mapping, and it is
 * better than the alternative it replaced: the obvious way to implement "full
 * access" is to edit the server's permission config, but that config is global
 * and the server is shared with the user's own TUI, so a bypass set for one
 * Carbon chat would silently disarm every other client talking to it. A ruleset
 * is scoped to the session it was created with and cannot leak.
 */

/** OpenCode's permission keys, from the server's own PermissionConfig schema. */
export const OPENCODE_PERMISSIONS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill'
] as const

export type OpencodePermission = (typeof OPENCODE_PERMISSIONS)[number]
export type OpencodeAction = 'allow' | 'deny' | 'ask'

export interface OpencodePermissionRule {
  permission: string
  pattern: string
  action: OpencodeAction
}

/** Everything that only observes the workspace — never gated in any mode. */
const READ_ONLY: OpencodePermission[] = [
  'read',
  'glob',
  'grep',
  'list',
  'lsp',
  'skill',
  'todowrite',
  'question'
]

/** Everything that changes files or reaches outside the workspace. */
const MUTATING: OpencodePermission[] = ['edit', 'bash', 'task', 'external_directory', 'doom_loop']

/** Network reads: not mutations, but they leave the machine. */
const NETWORK: OpencodePermission[] = ['webfetch', 'websearch']

function rules(map: Partial<Record<OpencodePermission, OpencodeAction>>): OpencodePermissionRule[] {
  return OPENCODE_PERMISSIONS.filter((p) => map[p] !== undefined).map((permission) => ({
    permission,
    pattern: '**',
    action: map[permission] as OpencodeAction
  }))
}

function fill(
  permissions: OpencodePermission[],
  action: OpencodeAction
): Partial<Record<OpencodePermission, OpencodeAction>> {
  return Object.fromEntries(permissions.map((p) => [p, action]))
}

/**
 * The agent a turn runs as. `plan` is OpenCode's own read-only agent — Carbon
 * layers its plan *review* on top of it, so the model genuinely cannot edit
 * while planning rather than merely being asked not to.
 */
export function agentForMode(mode: PermissionModeId): string | undefined {
  return mode === 'plan' ? 'plan' : undefined
}

/** The session's permission ruleset for a mode. */
export function rulesetForMode(mode: PermissionModeId): OpencodePermissionRule[] {
  switch (mode) {
    case 'plan':
      // Belt and braces over the plan agent: if a future OpenCode lets the plan
      // agent write, the ruleset still refuses rather than silently allowing it.
      return rules({ ...fill(READ_ONLY, 'allow'), ...fill(MUTATING, 'deny'), ...fill(NETWORK, 'ask') })
    case 'acceptEdits':
      return rules({
        ...fill(READ_ONLY, 'allow'),
        ...fill(MUTATING, 'ask'),
        ...fill(NETWORK, 'ask'),
        edit: 'allow'
      })
    case 'auto':
      // No classifier exists on this backend, so "auto" is the honest subset:
      // edits and reads go through, anything that runs a command or leaves the
      // machine still asks. Named the same as Claude's mode because it occupies
      // the same slot, but it is deliberately more conservative.
      return rules({
        ...fill(READ_ONLY, 'allow'),
        ...fill(MUTATING, 'ask'),
        ...fill(NETWORK, 'ask'),
        edit: 'allow'
      })
    case 'bypassPermissions':
      return rules(fill([...READ_ONLY, ...MUTATING, ...NETWORK], 'allow'))
    default:
      return rules({ ...fill(READ_ONLY, 'allow'), ...fill(MUTATING, 'ask'), ...fill(NETWORK, 'ask') })
  }
}

/** True when the mode answers every request itself and none reach the user. */
export function isSilentMode(mode: PermissionModeId): boolean {
  return mode === 'bypassPermissions'
}

export type OpencodeReply = 'once' | 'always' | 'reject'

/**
 * A Carbon permission answer as an OpenCode reply.
 *
 * Note the asymmetry: OpenCode has no "deny always". A denial is always `reject`
 * — the single request fails and the model is told so, which is what Carbon's
 * deny means anyway; only the *allow* side has a persistent form.
 */
export function decisionToReply(decision: PermissionDecision): OpencodeReply {
  if (decision.behavior !== 'allow') return 'reject'
  return decision.always ? 'always' : 'once'
}

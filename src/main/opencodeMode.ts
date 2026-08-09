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

/**
 * A ruleset: allow everything, then narrow.
 *
 * `*` is OpenCode's own idiom — its built-in `build` agent ships
 * `[{*: allow}, {doom_loop: ask}, {external_directory: ask}]` — and the array is
 * ordered with later rules winning. Written this way rather than by enumerating
 * the taxonomy so a permission key OpenCode adds later is covered by the
 * wildcard instead of silently falling outside every mode.
 */
function ruleset(
  base: OpencodeAction,
  overrides: Partial<Record<OpencodePermission, OpencodeAction>> = {}
): OpencodePermissionRule[] {
  return [
    { permission: '*', pattern: '**', action: base },
    ...OPENCODE_PERMISSIONS.filter((p) => overrides[p] !== undefined).map((permission) => ({
      permission,
      pattern: '**',
      action: overrides[permission] as OpencodeAction
    }))
  ]
}

/** Everything that changes files or reaches outside the workspace. */
const GATED: Partial<Record<OpencodePermission, OpencodeAction>> = {
  edit: 'ask',
  bash: 'ask',
  task: 'ask',
  external_directory: 'ask',
  doom_loop: 'ask',
  webfetch: 'ask',
  websearch: 'ask'
}

/**
 * The agent a turn runs as.
 *
 * OpenCode has exactly two primary agents a user drives — `build` and `plan` —
 * so this is the only place a Carbon mode maps onto one of *its* concepts.
 * Everything else a mode expresses is carried by the ruleset.
 */
export function agentForMode(mode: PermissionModeId): string | undefined {
  return mode === 'plan' ? 'plan' : undefined
}

/** The session's permission ruleset for a mode. */
export function rulesetForMode(mode: PermissionModeId): OpencodePermissionRule[] {
  switch (mode) {
    case 'plan':
      // Belt and braces over the plan agent, which already disallows edit tools:
      // if a future OpenCode loosens it, the ruleset still refuses.
      return ruleset('allow', { ...GATED, edit: 'deny', bash: 'deny', task: 'deny' })
    case 'acceptEdits':
    // 'auto' is not offered for OpenCode — there is no classifier to defer to,
    // so it would be Accept edits under another name. Kept here only because a
    // chat switched in from Claude can still carry the mode.
    case 'auto':
      return ruleset('allow', { ...GATED, edit: 'allow' })
    case 'bypassPermissions':
      return ruleset('allow')
    default:
      return ruleset('allow', GATED)
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

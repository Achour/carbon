/**
 * Variables that name the CLI session Carbon itself was launched from.
 *
 * They exist only when Carbon was started from a terminal *inside* a running
 * Claude Code (or Codex) session — which is how Carbon is developed, and never
 * how it is used from the Dock. Every process Carbon spawns inherits them, and
 * they do not describe that process: they describe someone else's session.
 *
 * The measured cost of leaving them in place is not cosmetic. `claude` treats
 * `CLAUDE_CODE_CHILD_SESSION` as "you are a child of another session" and turns
 * **transcript saving off** for the whole run — the CLI says so in its own
 * status line. For a terminal chat that is the entire feature: no transcript
 * means no `--resume`, no title, and no signal that the agent did anything. The
 * messaging socket and token are worse in kind rather than degree: a session
 * that adopts them is wired into another session's channel.
 *
 * So every process Carbon spawns is given the environment it would have had if
 * Carbon had been opened from the Dock. Stripping can only ever restore that,
 * which is why it is unconditional rather than a mode.
 *
 * Deliberately **not** here: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTHROPIC_*`,
 * `XAI_API_KEY`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY` and the feature gates. Those
 * are configuration the user chose, and they mean the same thing in a child as
 * they do in the parent.
 */
const PARENT_SESSION_VARS = [
  // "You are running inside a Claude Code session", and the parent's identity.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  // The parent's in-process settings, which a new session decides for itself.
  'CLAUDE_EFFORT',
  'CLAUDE_PLUGIN_DATA',
  // The parent's control channel. Inheriting these points a fresh session at
  // another session's socket.
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  // Codex's plugin equivalents.
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_COMPANION_TRANSCRIPT_PATH'
] as const

/**
 * `process.env` without the markers above, plus any additions. Returned as a
 * plain object because both callers hand it to a spawn that replaces the child's
 * environment wholesale rather than merging into it.
 */
export function spawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    env[key] = value
  }
  for (const key of PARENT_SESSION_VARS) delete env[key]
  return { ...env, ...extra }
}

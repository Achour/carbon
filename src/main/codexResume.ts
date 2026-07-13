/**
 * The Codex SDK wraps CLI failures in an Error whose message includes the
 * app-server failure. Keep this matcher deliberately narrow: auth, network, and
 * model errors must remain visible and must not silently fork the conversation.
 */
export function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes('no rollout found for thread id')
}

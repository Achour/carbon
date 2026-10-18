import type { PermissionRequestPayload } from './types'

/**
 * What a waiting prompt is asking, in a line: a phone notification's body
 * (`remoteAccess.ts`) and the phone home screen's Needs you row, which say the
 * same thing about the same ask.
 */
export function promptLine(r: PermissionRequestPayload): string {
  if (r.toolName === 'ExitPlanMode') return 'A plan is ready for your review'
  if (r.toolName === 'AskUserQuestion') return 'Has a question for you'
  if (r.title?.trim()) return r.title.trim()
  // The thing being approved, where the input says it plainly: the command,
  // or the file. "Bash" alone gives the reader nothing to decide on.
  const input = (r.input ?? {}) as Record<string, unknown>
  const detail =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path.split('/').pop()
        : ''
  return `Approve ${r.displayName || r.toolName}${detail ? `: ${detail}` : ''}`
}

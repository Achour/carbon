import type { AssistantMessage, AssistantPart, ChatMessage } from '@shared/types'

export interface TurnPresentation {
  userMessageId: string
  /** One aggregate assistant message used by the single turn-level changes card. */
  summary?: AssistantMessage
  hasChanges: boolean
}

function relative(path: string, cwd: string): string {
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

/** Structured edit paths reported by Claude tools and Codex file_change items. */
export function changedPathsFromParts(parts: AssistantPart[], cwd: string): string[] {
  const paths = new Set<string>()
  for (const part of parts) {
    if (!part || part.type !== 'tool') continue
    if (part.denied || part.status !== 'success') continue
    const input = (part.input ?? {}) as Record<string, unknown>
    const direct = [input.file_path, input.notebook_path, input.path]
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(part.name)) {
      for (const value of direct) {
        if (typeof value === 'string' && value) paths.add(relative(value, cwd))
      }
    }
    if (Array.isArray(input.changes)) {
      for (const change of input.changes) {
        const path = (change as { path?: unknown } | null)?.path
        if (typeof path === 'string' && path) paths.add(relative(path, cwd))
      }
    }
  }
  return [...paths]
}

/**
 * Build one changes presentation per user turn. Claude commonly persists
 * several assistant messages per turn while Codex commonly persists one, so
 * message-level summaries would repeat the same working-tree totals.
 */
export function turnPresentations(
  messages: ChatMessage[],
  cwd: string,
  busy: boolean
): Map<string, TurnPresentation> {
  const result = new Map<string, TurnPresentation>()
  let userMessageId: string | undefined
  let assistants: AssistantMessage[] = []

  const flush = (complete: boolean): void => {
    if (!userMessageId || assistants.length === 0) {
      assistants = []
      return
    }

    const last = assistants[assistants.length - 1]
    const exact = [...assistants].reverse().find((message) => message.fileChanges !== undefined)
      ?.fileChanges
    const summary: AssistantMessage = {
      ...last,
      parts: assistants.flatMap((message) => message.parts),
      ...(exact !== undefined ? { fileChanges: exact } : {})
    }
    const hasChanges =
      complete && (summary.fileChanges?.length ?? changedPathsFromParts(summary.parts, cwd).length) > 0
    const presentation = {
      userMessageId,
      summary: complete ? summary : undefined,
      hasChanges
    }
    for (const assistant of assistants) result.set(assistant.id, presentation)
    assistants = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush(true)
      userMessageId = message.id
    } else if (message.role === 'assistant' && userMessageId) {
      assistants.push(message)
    }
  }
  // A busy final turn is still changing, so it must not show a partial summary.
  flush(!busy)
  return result
}

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

/** A changed file and its line deltas — `TurnFileChange`, or the same summed out of git. */
export interface ChangedFile {
  path: string
  additions: number
  deletions: number
}

export type ChangeEntry =
  | { kind: 'file'; file: ChangedFile }
  | { kind: 'group'; dir: string; files: ChangedFile[]; additions: number; deletions: number }

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}

/**
 * Fold a turn's changed files into the rows the card draws: one collapsible row
 * per directory holding **two or more** of them, and a plain file row for
 * everything else.
 *
 * Grouping only pays where files pile up in one place. A turn that touches
 * three files in three directories is the common shape, and a group row apiece
 * would double the card's height to say what each file's own path already
 * says — so a lone file keeps its directory as a dimmed prefix instead. The
 * directory is the file's own, not a tree: `web/src/lib` is one row, the way
 * the review panel names it, rather than three nested ones.
 *
 * Entries are ordered by directory so a group and the loose files beside it
 * read as one alphabetical list; root files sort first.
 */
export function groupChanges(files: ChangedFile[]): ChangeEntry[] {
  const byDir = new Map<string, ChangedFile[]>()
  for (const file of files) {
    const dir = dirOf(file.path)
    const bucket = byDir.get(dir)
    if (bucket) bucket.push(file)
    else byDir.set(dir, [file])
  }
  const entries: ChangeEntry[] = []
  for (const [dir, bucket] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...bucket].sort((a, b) => a.path.localeCompare(b.path))
    if (!dir || sorted.length < 2) {
      for (const file of sorted) entries.push({ kind: 'file', file })
      continue
    }
    entries.push({
      kind: 'group',
      dir,
      files: sorted,
      additions: sorted.reduce((sum, file) => sum + file.additions, 0),
      deletions: sorted.reduce((sum, file) => sum + file.deletions, 0)
    })
  }
  return entries
}

import type { SlashCommand } from './types'

/**
 * Codex slash commands Carbon can implement through the non-interactive SDK.
 *
 * The Codex TUI has more commands, but advertising those here would be
 * misleading: `@openai/codex-sdk` runs `codex exec`, so TUI-only actions such as
 * /fork, /resume, /theme, and /mcp are not available to an embedded client.
 */
export const CODEX_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'plan',
    description: 'Enter Plan mode, optionally with a request',
    argumentHint: '[request]'
  },
  {
    name: 'model',
    description: 'Show or change the Codex model',
    argumentHint: '[default|sol|terra|luna]'
  },
  {
    name: 'reasoning',
    description: 'Show or change reasoning effort',
    argumentHint: '[default|low|medium|high|xhigh|max|ultra]'
  },
  {
    name: 'permissions',
    description: 'Show or change the workspace permission mode',
    argumentHint: '[plan|ask|accept-edits|auto|full-access]'
  },
  {
    name: 'status',
    description: 'Show the current Codex session configuration'
  },
  {
    name: 'init',
    description: 'Create an AGENTS.md guide for this project'
  },
  {
    name: 'review',
    description: 'Review the current working tree without editing it',
    argumentHint: '[focus]'
  }
]

export type CodexSlashCommandName =
  | 'plan'
  | 'model'
  | 'reasoning'
  | 'permissions'
  | 'status'
  | 'init'
  | 'review'

export interface CodexSlashRequest {
  name: CodexSlashCommandName
  argument: string
  original: string
}

const CODEX_COMMAND_NAMES = new Set<CodexSlashCommandName>(
  CODEX_SLASH_COMMANDS.map((command) => command.name as CodexSlashCommandName)
)

/** Parse only commands Carbon owns; unknown `/foo` text remains a normal prompt. */
export function parseCodexSlashCommand(text: string): CodexSlashRequest | null {
  const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*?))?\s*$/.exec(text)
  if (!match) return null
  const name = match[1].toLowerCase() as CodexSlashCommandName
  if (!CODEX_COMMAND_NAMES.has(name)) return null
  return { name, argument: (match[2] ?? '').trim(), original: text.trim() }
}

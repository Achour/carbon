import type { SlashCommand } from './types'

/**
 * Codex slash commands backed by native Codex APIs in Carbon.
 *
 * Do not add prompt-simulated commands here. TUI-only presentation commands
 * such as /theme and /vim have no equivalent in an embedded client.
 */
export const CODEX_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'plan',
    description: 'Enter Plan mode, optionally with a request',
    argumentHint: '[request]'
  },
  {
    name: 'goal',
    description: 'Set, view, pause, resume, edit, or clear the Codex goal',
    argumentHint: '[objective|edit <objective>|pause|resume|clear]'
  },
  {
    name: 'mcp',
    description: 'Show native Codex MCP server status',
    argumentHint: '[verbose]'
  },
  {
    name: 'review',
    description: 'Open the native Codex review presets'
  },
  {
    name: 'status',
    description: 'Show the current Codex session configuration'
  },
  {
    name: 'usage',
    description: 'Show native Codex account usage limits'
  }
]

export type CodexSlashCommandName =
  | 'plan'
  | 'goal'
  | 'model'
  | 'reasoning'
  | 'fast'
  | 'permissions'
  | 'mcp'
  | 'review'
  | 'status'
  | 'usage'

export interface CodexSlashRequest {
  name: CodexSlashCommandName
  argument: string
  original: string
}

export type CodexGoalCommand =
  | { action: 'view' }
  | { action: 'clear' }
  | { action: 'status'; status: 'active' | 'paused' }
  | { action: 'set'; objective: string }
  | { action: 'error'; message: string }

/** Parse `/goal` arguments without turning objective prose into subcommands. */
export function parseCodexGoalCommand(argument: string): CodexGoalCommand {
  const value = argument.trim()
  if (!value) return { action: 'view' }
  const lower = value.toLowerCase()
  if (lower === 'clear') return { action: 'clear' }
  if (lower === 'pause') return { action: 'status', status: 'paused' }
  if (lower === 'resume') return { action: 'status', status: 'active' }
  if (lower === 'edit') {
    return { action: 'error', message: 'Use `/goal edit <objective>` to revise the current goal.' }
  }
  const objective = lower.startsWith('edit ') ? value.slice(5).trim() : value
  if (!objective) {
    return { action: 'error', message: 'Codex goal objectives must not be empty.' }
  }
  if (objective.length > 4_000) {
    return {
      action: 'error',
      message: 'Codex goal objectives must be at most 4,000 characters.'
    }
  }
  return { action: 'set', objective }
}

const CODEX_COMMAND_NAMES = new Set<CodexSlashCommandName>(
  [
    ...CODEX_SLASH_COMMANDS.map((command) => command.name as CodexSlashCommandName),
    // The composer owns these visible controls. Keep their typed commands for
    // CLI muscle memory without advertising duplicate pickers in autocomplete.
    'model',
    'reasoning',
    'fast',
    'permissions'
  ]
)

export type CodexComposerControl = 'model' | 'permissions'

/** Exact no-argument commands that open controls Carbon already keeps visible. */
export function codexComposerControl(text: string): CodexComposerControl | null {
  const match = /^\s*\/(model|permissions)\s*$/i.exec(text)
  return (match?.[1].toLowerCase() as CodexComposerControl | undefined) ?? null
}

/** Parse only commands Carbon owns; unknown `/foo` text remains a normal prompt. */
export function parseCodexSlashCommand(text: string): CodexSlashRequest | null {
  const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*?))?\s*$/.exec(text)
  if (!match) return null
  const name = match[1].toLowerCase() as CodexSlashCommandName
  if (!CODEX_COMMAND_NAMES.has(name)) return null
  return { name, argument: (match[2] ?? '').trim(), original: text.trim() }
}

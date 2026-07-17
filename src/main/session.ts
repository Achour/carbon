import type {
  AccountInfo,
  AgentInfo,
  Attachment,
  ChatEvent,
  McpServerInfo,
  ModelOption,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  RewindResult,
  UsageInfo
} from '@shared/types'

/** Sink for every main → renderer event, over the single `chat:event` channel. */
export type Emit = (ev: ChatEvent) => void

/**
 * The provider-agnostic surface `ChatManager` drives. Both `ClaudeSession`
 * (Agent SDK) and `CodexSession` (Codex SDK) implement it, so everything the
 * manager and IPC layer touch is identical regardless of which agent runs the
 * chat. Introspection methods a provider doesn't support return empty/no-op
 * values (e.g. Codex has no live MCP status or file checkpoints).
 */
export interface AgentSession {
  /** True once the underlying session is gone; the manager drops dead sessions. */
  readonly dead: boolean
  /** True when the wrapper has no running turn, prompt, permission, or background job. */
  readonly idle: boolean
  send(text: string, attachments?: Attachment[], label?: string): void
  interrupt(): Promise<void>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  stopBackgroundJob(taskId: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): void
  rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult>
  mcpStatus(): Promise<McpServerInfo[]>
  mcpReconnect(name: string): Promise<OpResult>
  mcpToggle(name: string, enabled: boolean): Promise<OpResult>
  listModels(): Promise<ModelOption[]>
  listAgents(): Promise<AgentInfo[]>
  accountInfo(): Promise<AccountInfo | null>
  usageInfo(): Promise<UsageInfo | null>
  dispose(): void
}

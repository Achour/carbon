/**
 * Sub-agent runs, folded out of the transcript.
 *
 * A spawned agent is already modelled as the `ToolPart` of the call that
 * spawned it: its stream lives in `children`, its vitals in `agent`. That is
 * the whole state — this module only *reads* it, so the panel, the transcript
 * card and the summary row can never disagree about how many agents are
 * working or what they have spent. Nothing here is provider-specific: Claude
 * spawns `Task`, Codex and Grok spawn `Agent`, and all three arrive as the same
 * part by the time they reach this fold.
 *
 * A run is recognised by carrying `agent`, *or* by its tool name — the second
 * clause is what keeps chats persisted before `AgentRun` existed from
 * disappearing out of the panel. Such a run has no `startedAt`, so it reports
 * no duration rather than a made-up one.
 *
 * Dependency-free at runtime (the only import is `import type`, which is erased)
 * so `node --test` can run the `.ts` directly.
 */

import type { AssistantPart, ChatMessage, ToolPart } from './types'

/** Tool names whose call spawns a sub-agent. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent'])

export type AgentRunStatus = 'running' | 'done' | 'failed'

/** One spawned agent, as every surface in the app draws it. */
export interface AgentRunView {
  /** The spawning call's `toolUseId` — stable for the life of the run. */
  id: string
  /** The assistant message holding the call, so a click can scroll to its card. */
  messageId: string
  /** Sub-agent type the provider named ('general-purpose', 'Codex'), if any. */
  type?: string
  /** What the agent was asked to do. */
  description: string
  status: AgentRunStatus
  /** Epoch ms of the spawn. Absent for runs recorded before agents were timed. */
  startedAt?: number
  endedAt?: number
  model?: string
  effort?: string
  tokens?: number
  /** Tool calls the agent has made so far. */
  tools: number
  /** The tool it is running right now, while it is running one. */
  current?: string
  /** 0 for a spawn the main agent made; 1+ for an agent's own spawns. */
  depth: number
}

export interface AgentTotals {
  /** Runs still working. */
  running: number
  total: number
  /** Tokens across every run that reported any. */
  tokens: number
}

/** Whether a tool call is a spawn — carries vitals, or is simply named like one. */
export function isAgentPart(part: ToolPart): boolean {
  return part.agent != null || AGENT_TOOLS.has(part.name)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Whether an agent is still working.
 *
 * The spawning call's own status is not enough: its `tool_result` can land
 * while the agent is mid-step — and for a backgrounded one it lands at spawn —
 * so a run whose children are still moving is still running. This is the same
 * rule the transcript card applies, kept in one place so the panel and the card
 * cannot show a tick and a spinner for the same agent.
 */
function childrenBusy(children: AssistantPart[] | undefined): boolean {
  if (!children) return false
  return children.some(
    (c) => c?.type === 'tool' && (c.status === 'running' || c.status === 'pending')
  )
}

function viewOf(part: ToolPart, messageId: string, depth: number): AgentRunView {
  const input = (part.input ?? {}) as Record<string, unknown>
  const children = (part.children ?? []).filter(Boolean)
  const tools = children.filter((c) => c.type === 'tool')
  const busy = part.status === 'pending' || part.status === 'running' || childrenBusy(children)
  // A denied or failed spawn is a failure even if a child happens to be open.
  const failed = part.status === 'error'
  const current = busy
    ? tools.filter((t) => t.status === 'running' || t.status === 'pending').pop()?.name
    : undefined
  return {
    id: part.toolUseId,
    messageId,
    type: text(input.subagent_type),
    description: text(input.description) ?? text(input.prompt) ?? '',
    status: failed ? 'failed' : busy ? 'running' : 'done',
    startedAt: part.agent?.startedAt,
    endedAt: part.agent?.endedAt,
    model: part.agent?.model,
    effort: part.agent?.effort,
    tokens: part.agent?.tokens,
    tools: tools.length,
    current,
    depth
  }
}

function collect(
  parts: readonly (AssistantPart | null | undefined)[],
  messageId: string,
  depth: number,
  out: AgentRunView[]
): void {
  for (const part of parts) {
    // Streamed arrays can be sparse; persisted ones turn the holes into null.
    if (!part || part.type !== 'tool') continue
    if (!isAgentPart(part)) continue
    out.push(viewOf(part, messageId, depth))
    // An agent that spawns agents: its own spawns are listed under it rather
    // than beside the main agent's, which is what `depth` carries.
    if (part.children) collect(part.children, messageId, depth + 1, out)
  }
}

/**
 * Every agent run in the loaded window, in transcript order.
 *
 * Order is the transcript's, not "running first": the panel is read beside the
 * conversation that spawned them, and a list that reorders itself as agents
 * finish is one you lose your place in — the same reason the sidebar stopped
 * sorting on `updatedAt` while a turn runs.
 */
export function foldAgentRuns(messages: readonly ChatMessage[]): AgentRunView[] {
  const out: AgentRunView[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    collect(message.parts, message.id, 0, out)
  }
  return out
}

function sameRun(a: AgentRunView, b: AgentRunView): boolean {
  return (
    a.id === b.id &&
    a.messageId === b.messageId &&
    a.type === b.type &&
    a.description === b.description &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.tokens === b.tokens &&
    a.tools === b.tools &&
    a.current === b.current &&
    a.depth === b.depth
  )
}

/**
 * Carry unchanged runs — and an unchanged list — forward *by identity*.
 *
 * The fold reruns on every streamed token, and it allocates: without this, a
 * chat with agents in its history would hand the panel a brand-new array 25
 * times a second and re-render every row for a list that did not move. Same
 * arrangement as `reconcileSnapshots` in the task-list fold, and the store's
 * identity guard is what turns it into a no-op.
 */
export function reconcileAgentRuns(
  prev: readonly AgentRunView[],
  next: AgentRunView[]
): AgentRunView[] {
  if (prev.length !== next.length) return next
  let changed = false
  const out = next.map((run, i) => {
    const before = prev[i]
    if (before && sameRun(before, run)) return before
    changed = true
    return run
  })
  return changed ? out : (prev as AgentRunView[])
}

export function agentTotals(runs: readonly AgentRunView[]): AgentTotals {
  let running = 0
  let tokens = 0
  for (const run of runs) {
    if (run.status === 'running') running++
    tokens += run.tokens ?? 0
  }
  return { running, total: runs.length, tokens }
}

/**
 * Totals for spawn calls sitting side by side — the transcript's collapsed
 * "3 agents" row, which has the parts but not the fold.
 *
 * It goes through the same `viewOf` the panel does rather than re-deriving
 * "still working" from the call's own status, which is the reading that reports
 * a backgrounded agent as finished the moment it starts.
 */
export function summarizeAgentParts(parts: readonly ToolPart[]): AgentTotals {
  return agentTotals(parts.map((part) => viewOf(part, '', 0)))
}

/**
 * Compact token count for a chip: `67.8k`, `1.2M`.
 *
 * Sub-agent totals are dominated by cached input and run to six figures, so the
 * exact number is noise in a 60px slot — but the magnitude is the whole signal.
 */
export function formatAgentTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) {
    const k = tokens / 1000
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** `1m 04s` / `58s` — an agent's wall time, from its own spawn stamp. */
export function formatAgentDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

import type {
  AppDefaults,
  ChatMessage,
  ChatMeta,
  Delegation,
  DelegationRecord,
  DelegationStatus,
  ModelOption,
  Provider
} from '../shared/types.ts'

/**
 * **Delegation: one chat's agent handing a task to another provider.**
 *
 * The parent calls `agents_delegate`; Carbon creates a side chat in the
 * parent's thread on the requested provider, sends it the task, and — when that
 * chat's turn ends — sends the outcome back to the parent as a turn of its own.
 * Everything here is the part with no Electron and no session in it: the tool
 * table, the argument checks, how an outcome is read off a transcript and how
 * it is worded for the parent. `ChatManager` is the host and owns the
 * lifecycle. See `docs/delegation.md`.
 *
 * Dependency-free on purpose — type imports only — so `node --test` runs it
 * straight off the `.ts`.
 */

export const AGENTS_TOOL_NAMES = ['delegate', 'send', 'status', 'cancel'] as const

export type AgentsToolName = (typeof AGENTS_TOOL_NAMES)[number]

/** How much of the child's own words reach the parent. */
export const DELEGATION_RESULT_CAP = 20_000

/** A task longer than this is a transcript, not a task. */
export const DELEGATION_TASK_CAP = 16_000

const PROVIDER_IDS: readonly Provider[] = ['claude', 'codex', 'grok', 'antigravity']

export type AgentsParam = {
  type: 'string'
  required?: boolean
  enum?: readonly string[]
  description: string
}

export const AGENTS_TOOL_INFO: Record<
  AgentsToolName,
  { description: string; readOnly: boolean; params: Record<string, AgentsParam> }
> = {
  delegate: {
    description:
      "Start a NEW coding agent — a different provider (Claude, Codex, Grok, Antigravity) running in this same project folder — on a self-contained task. Carbon adds it to this thread as a new chat, minimized until the user opens it to watch, and returns the agent's name (e.g. codex-a) immediately; the task runs in the background. When it ends, its outcome arrives in THIS conversation as a new message, so do not poll for it and do not wait: carry on with your own work or end your turn. The new agent sees ONLY the task text — none of this conversation — so write the task as a complete brief: what to do, which files or changes it concerns, and what to report back. To give more instructions to an agent you already started, use agents_send with its name instead of starting another. Any number of agents may run at once (two Codex reviewers on different files, say) — there is no limit, so start every one the work calls for rather than queuing; each is its own chat. They share the checkout, with this chat's permission mode, so do not have two of them edit the same files; for reviews and research ask them not to modify files. One level only: a delegate cannot delegate further.",
    readOnly: false,
    params: {
      task: {
        type: 'string',
        required: true,
        description:
          'The complete brief for the other agent: what to do, where, and what its final message should report. It sees nothing else from this conversation.'
      },
      provider: {
        type: 'string',
        required: true,
        enum: PROVIDER_IDS,
        description: 'Which agent runs the task.'
      },
      model: {
        type: 'string',
        description:
          "Which of that provider's models, as the user named it — an id, or a name like \"sol\" or \"opus\"; Carbon matches it to the provider's catalog. Omit for the provider's default."
      },
      role: {
        type: 'string',
        description:
          'A short role for the delegate, e.g. "review", "research", "implement". Shown to the user and given to the delegate.'
      },
      name: {
        type: 'string',
        description:
          'A short name to refer to this agent by later (letters, digits, hyphens), e.g. "math-reviewer". Omit for an automatic one like codex-a. Must not already be used in this conversation.'
      }
    }
  },
  send: {
    description:
      "Send a follow-up message to an agent you already started with agents_delegate, by its name (e.g. codex-a) — it continues that agent's own conversation, with everything it already knows. Use this, not agents_delegate, whenever the user says to tell, ask or instruct an existing agent (\"tell codex-b to also check X\", \"ask the reviewer why\"). If the agent is still working, the message is queued for it; if it had finished, it starts working again and its next outcome arrives in this conversation as a new message, like the first. Do not poll or wait.",
    readOnly: false,
    params: {
      agent: {
        type: 'string',
        required: true,
        description: 'The agent\'s name (as returned by agents_delegate or shown by agents_status) or its id.'
      },
      message: {
        type: 'string',
        required: true,
        description: 'What to tell it. It has its own context, so refer to its earlier work freely.'
      }
    }
  },
  status: {
    description:
      'List the agents this conversation started, by name, with each one\'s status (running, completed, failed, cancelled, interrupted) and, once finished, its latest result. Pass `agent` for one. Results are also delivered automatically when an agent finishes, so this is for checking on something, not for waiting.',
    readOnly: true,
    params: {
      agent: { type: 'string', description: 'An agent name or id. Omit to list all.' }
    }
  },
  cancel: {
    description:
      'Kill an agent this conversation started — use it whenever the user says to kill, stop, cancel, close or dismiss one ("kill codex-a", "stop all the agents"). A working agent is stopped (no outcome is delivered for that run); either way its chat is closed beside this one. Nothing is deleted: its card stays in this conversation, the user can reopen it, and agents_send can give it new work later. Pass "all" to kill every agent this conversation started.',
    readOnly: false,
    params: {
      agent: {
        type: 'string',
        required: true,
        description: 'The agent name or id to kill, or "all".'
      }
    }
  }
}

/**
 * Appended to the session rules when delegation is on, so the model knows the
 * tool exists before it goes looking — the tool description alone is read only
 * once a search surfaces it.
 */
export const DELEGATION_SESSION_RULES =
  'The `carbon` server can also run other coding agents for you. `agents_delegate` (task, provider, optional model, role and name) starts a NEW agent in a new chat beside this one on that provider (claude, codex, grok, antigravity) and returns its name — codex-a, codex-b, claude-a… unless you name it — at once; its outcome arrives later as a new message in this conversation, so never poll or sleep waiting for it. Several can run at once, each in its own chat. `agents_send` (agent, message) talks to one you already started, by name: it continues that agent\'s own conversation. When the user refers to an existing agent — by name ("tell codex-b…"), by provider when only one fits, or by what it is doing ("ask the math reviewer…") — use `agents_send`, never a new `agents_delegate`. `agents_status` lists your agents and their state; `agents_cancel` kills one ("kill codex-a") or all of them — it stops a working agent and closes its chat. Use delegation when the user asks for another agent or model ("ask Sol in Codex", "have Grok check this"), or when a second opinion from a different provider is clearly worth its cost. These are MCP tools (mcp__carbon__agents_delegate, mcp__carbon__agents_send, mcp__carbon__agents_status, mcp__carbon__agents_cancel); if they are deferred, load them by name rather than looking for another way to reach the agent.'

export type AgentsToolInput = {
  task?: string
  provider?: string
  model?: string
  role?: string
  name?: string
  agent?: string
  message?: string
  /** Accepted where `agent` is, for a model that reaches for the id field. */
  id?: string
}

/** One delegation as the parent sees it: the child chat's id is its id. */
export type DelegationView = DelegationRecord

export interface DelegateRequest {
  task: string
  provider: Provider
  model?: string
  role?: string
  name?: string
}

export type DelegateOutcome =
  | { ok: true; id: string; name: string; label: string }
  | { ok: false; error: string }

/** What `runAgentsTool` needs from `ChatManager`. `agent` is a name or an id. */
export interface AgentsToolHost {
  delegate(parentId: string, request: DelegateRequest): Promise<DelegateOutcome>
  send(parentId: string, agent: string, message: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  list(parentId: string): DelegationView[]
  cancel(parentId: string, agent: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>
}

/** A name as the model or the user might write it — "Codex B" — as stored: `codex-b`. */
export function slugName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
}

/**
 * The first free `<provider>-<letter>` among a parent's delegates: codex-a,
 * codex-b, …, then codex-aa. Per provider, so "codex-b" reads as "the second
 * Codex"; letters, so it is never mistaken for a column's number.
 */
export function autoName(provider: Provider, taken: readonly string[]): string {
  const used = new Set(taken)
  for (let i = 0; ; i++) {
    let n = i
    let letters = ''
    do {
      letters = String.fromCharCode(97 + (n % 26)) + letters
      n = Math.floor(n / 26) - 1
    } while (n >= 0)
    const name = `${provider}-${letters}`
    if (!used.has(name)) return name
  }
}

/**
 * Find one of a parent's delegates from what the model wrote: its id, or its
 * name in any reasonable spelling. A provider alone ("codex") resolves only
 * when exactly one delegate is on it — two would make it a guess.
 */
export function resolveDelegate(
  views: readonly DelegationView[],
  ref: string
): { ok: true; view: DelegationView } | { ok: false; error: string } {
  const raw = ref.trim()
  if (!raw) return { ok: false, error: 'agent is required.' }
  const byId = views.find((v) => v.id === raw)
  if (byId) return { ok: true, view: byId }
  const slug = slugName(raw)
  const byName = views.find((v) => v.name === slug)
  if (byName) return { ok: true, view: byName }
  if (isProvider(slug)) {
    const on = views.filter((v) => v.provider === slug)
    if (on.length === 1) return { ok: true, view: on[0] }
  }
  const names = views.map((v) => v.name)
  return {
    ok: false,
    error: names.length
      ? `No agent "${raw}" in this conversation. Its agents: ${names.join(', ')}.`
      : 'This conversation has not started any agents.'
  }
}

export type AgentsToolResult = { kind: 'text'; text: string; isError?: boolean }

function text(t: string, isError = false): AgentsToolResult {
  return isError ? { kind: 'text', text: t, isError } : { kind: 'text', text: t }
}

export function isAgentsToolName(value: string): value is AgentsToolName {
  return (AGENTS_TOOL_NAMES as readonly string[]).includes(value)
}

/** The tools plan mode refuses: both start or stop spending on another agent. */
export function isAgentsSideEffect(name: AgentsToolName): boolean {
  return name !== 'status'
}

/**
 * Whether a chat's sessions get the agents tools: never a delegate (one level
 * only — a delegate that could delegate is a fan-out nobody asked for), and
 * not while Settings → Chats turns delegation off. A chat with no id (a
 * throwaway probe) has nowhere for an outcome to land.
 */
export function canDelegate(
  chat: Pick<ChatMeta, 'id' | 'delegation' | 'surface'> | null | undefined,
  defaults: Pick<AppDefaults, 'allowDelegation'>
): boolean {
  return !!chat?.id && !chat.delegation && chat.surface !== 'terminal' && defaults.allowDelegation !== false
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Check a delegate call's arguments, before anything is created.
 *
 * `available` is the providers this machine can run right now (installed and
 * enabled); `providerOfModel` answers which provider a model id certainly
 * belongs to, or undefined when no catalog can place it — such an id is passed
 * through rather than refused, the rule `dropForeignModel` follows.
 */
export function validateDelegateRequest(
  input: AgentsToolInput,
  available: readonly Provider[],
  providerOfModel: (model: string) => Provider | undefined,
  /** Names already used by this parent's delegates. */
  taken: readonly string[] = []
): { ok: true; request: DelegateRequest & { name: string } } | { ok: false; error: string } {
  const task = (input.task ?? '').trim()
  if (!task) return { ok: false, error: 'task is required.' }
  if (task.length > DELEGATION_TASK_CAP) {
    return {
      ok: false,
      error: `task is ${task.length} characters; keep it under ${DELEGATION_TASK_CAP}. Point the delegate at files instead of pasting them.`
    }
  }
  const provider = (input.provider ?? '').trim().toLowerCase()
  if (!isProvider(provider)) {
    return { ok: false, error: `provider must be one of: ${PROVIDER_IDS.join(', ')}.` }
  }
  if (!available.includes(provider)) {
    return {
      ok: false,
      error: available.length
        ? `${provider} is not available on this machine (not installed, or turned off in Settings → Providers). Available: ${available.join(', ')}.`
        : `${provider} is not available on this machine.`
    }
  }
  const model = (input.model ?? '').trim() || undefined
  if (model) {
    const owner = providerOfModel(model)
    if (owner && owner !== provider) {
      return { ok: false, error: `Model ${model} belongs to ${owner}, not ${provider}.` }
    }
  }
  const role = (input.role ?? '').trim().slice(0, 40) || undefined
  let name: string
  if ((input.name ?? '').trim()) {
    name = slugName(input.name!)
    if (!name) return { ok: false, error: 'name must contain letters or digits.' }
    // Refused rather than suffixed: a model reusing a name almost always
    // meant the agent it already has.
    if (taken.includes(name)) {
      return {
        ok: false,
        error: `An agent named "${name}" already exists in this conversation. To give it more work, use agents_send with agent "${name}"; to start a different one, pick another name.`
      }
    }
  } else {
    name = autoName(provider, taken)
  }
  return { ok: true, request: { task, provider, model, role, name } }
}

/**
 * The context prepended to the child's first prompt (never shown in its
 * transcript, which shows the task alone): who asked, and that the final
 * message is what gets returned.
 */
/**
 * A model as the user or the parent named it — "Sol", "gpt 6.1 sol", "opus" —
 * as the id that provider's catalog lists.
 *
 * The parent has no catalog: it relays what the user said ("ask Sol in
 * Codex"), and a nickname sent as an id is a turn that fails on the other
 * side. So an exact id wins, then an id or label equal once spaces and case
 * are ignored, then the first catalog row whose id or label contains every
 * word — catalogs list a provider's newest model first, which is the one a
 * bare family name means. Nothing matching is an error naming the real ids, so
 * the parent can retry; an empty catalog (it could not be loaded) passes the
 * name through, the rule `dropForeignModel` follows for ids nothing can place.
 */
export function resolveModel(
  raw: string,
  provider: Provider,
  catalog: readonly ModelOption[]
): { ok: true; model: string } | { ok: false; error: string } {
  // An exact id is always good, default rows included (`codex-default` is a
  // real id the sessions read as "none"); only nicknames skip them.
  if (catalog.some((m) => m.provider === provider && m.id === raw)) return { ok: true, model: raw }
  const own = catalog.filter((m) => m.provider === provider && m.id && !m.id.endsWith('-default'))
  if (!own.length) return { ok: true, model: raw }
  const flat = (v: string): string => v.toLowerCase().replace(/[^a-z0-9.]+/g, '')
  const want = flat(raw)
  const exact = own.find((m) => flat(m.id) === want || flat(m.label) === want)
  if (exact) return { ok: true, model: exact.id }
  const words = raw.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)
  const hit = own.find((m) => {
    const hay = `${m.id} ${m.label}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  if (hit) return { ok: true, model: hit.id }
  return {
    ok: false,
    error: `No ${provider} model matches "${raw}". Its models: ${own.map((m) => m.id).join(', ')}. Omit model for its default.`
  }
}

/** The context riding a follow-up from the parent (`agents_send`). */
export function followUpBrief(from: string): string {
  return `A follow-up from ${from}, the agent that delegated your task. When you are done, end with a final message reporting the result — it is returned to that agent verbatim.`
}

export function delegateBrief(from: string, role?: string): string {
  return [
    `You are a delegate: ${from}, working in another chat in this same project, handed you the task below${role ? ` in the role of "${role}"` : ''}.`,
    'You see none of its conversation — the task is the whole brief. Work in this project directory.',
    'When you are done, end with a final message that reports your result: it is returned to that agent verbatim, so make it complete and self-contained (findings, file paths, what you changed or recommend).',
    role && /review|research|audit|investigat|analy/i.test(role)
      ? 'Do not modify files — report what you find.'
      : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/** Index just past the last user message — where the current turn's output starts. */
function turnStart(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i + 1
  }
  return 0
}

/**
 * Where a delegate's current round starts: just past the prompt that opened
 * it. A follow-up queued while it was working is part of the same round, so
 * reading from the *last* prompt would drop everything said before it.
 */
function roundStart(messages: readonly ChatMessage[], promptId?: string): number {
  if (promptId) {
    const at = messages.findIndex((m) => m.id === promptId)
    if (at >= 0) return at + 1
  }
  return turnStart(messages)
}

/**
 * The child's own words since its last prompt, capped.
 *
 * Every assistant message's text, not the last one's: a turn's final message
 * often ends on a tool call with no text at all, and the findings were written
 * one message earlier.
 */
export function delegationResult(
  messages: readonly ChatMessage[],
  cap = DELEGATION_RESULT_CAP,
  promptId?: string
): string {
  const chunks: string[] = []
  for (const m of messages.slice(roundStart(messages, promptId))) {
    if (m.role !== 'assistant') continue
    const t = m.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (t) chunks.push(t)
  }
  const all = chunks.join('\n\n')
  if (all.length <= cap) return all
  // Keep the end: a report is written last.
  return `…(truncated, ${all.length - cap} earlier characters omitted)\n${all.slice(all.length - cap)}`
}

/**
 * How a child's turn ended, read off its transcript once it is idle.
 *
 * `stopped` is the manager's knowledge that an interrupt landed — the
 * transcript cannot tell a stopped turn from a finished one. An error event
 * after the prompt is a failure; anything else with or without words is a
 * completion (an empty result says so in the delivery rather than pretending).
 */
export function delegationOutcome(
  messages: readonly ChatMessage[],
  stopped: boolean,
  promptId?: string
): { status: Exclude<DelegationStatus, 'running' | 'interrupted'>; result: string; error?: string } {
  const result = delegationResult(messages, DELEGATION_RESULT_CAP, promptId)
  if (stopped) return { status: 'cancelled', result }
  const tail = messages.slice(roundStart(messages, promptId))
  const errors = tail.filter(
    (m): m is Extract<ChatMessage, { role: 'event' }> => m.role === 'event' && m.kind === 'error'
  )
  // An error that the agent recovered from and then answered after is not the
  // turn's outcome; one with nothing said after it is.
  const lastError = errors[errors.length - 1]
  if (lastError) {
    const after = tail.slice(tail.indexOf(lastError) + 1)
    if (!after.some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.trim()))) {
      return { status: 'failed', result, error: lastError.text }
    }
  }
  return { status: 'completed', result }
}

/**
 * Whether the model answered the last prompt at all — any assistant output
 * after it. A turn that failed to start, or was stopped while a handoff brief
 * was still resolving, never put the prompt (or its hidden context) in front
 * of the model, so outcomes carried on it were not delivered.
 */
export function promptReached(messages: readonly ChatMessage[], promptId?: string): boolean {
  let from = turnStart(messages)
  let to = messages.length
  if (promptId !== undefined) {
    // That prompt's own turn: from it to the next prompt, so a later turn's
    // answer cannot vouch for an earlier prompt that never reached the model.
    const at = messages.findIndex((m) => m.id === promptId)
    if (at < 0) return false
    from = at + 1
    const next = messages.findIndex((m, i) => i >= from && m.role === 'user')
    if (next >= 0) to = next
  }
  return messages
    .slice(from, to)
    .some((m) => m.role === 'assistant' && m.parts.some((p) => p.type !== 'text' || p.text.trim()))
}

const STATUS_WORD: Record<Exclude<DelegationStatus, 'running'>, string> = {
  completed: 'finished',
  failed: 'failed',
  cancelled: 'was stopped',
  interrupted: 'was interrupted'
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The chip the parent's transcript shows in place of the delivered text. */
export function deliveryLabel(d: Pick<Delegation, 'status' | 'task' | 'name' | 'followUp'>): string {
  const word = d.status === 'running' ? 'is running' : STATUS_WORD[d.status]
  return `${d.name} ${word} · ${clip(d.followUp ?? d.task, 80)}`
}

/**
 * The text the parent's model receives. Opens with a sentence, never a path or
 * a slash — the label chip reads a leading `/` as a slash command.
 */
export function deliveryText(
  agent: string,
  view: Pick<DelegationView, 'id' | 'name' | 'status' | 'task' | 'result' | 'error' | 'role' | 'followUp'>
): string {
  const who = `${view.name} (${agent})`
  const head =
    view.status === 'completed'
      ? `Your agent ${who} has finished.`
      : view.status === 'failed'
        ? `Your agent ${who} failed.`
        : view.status === 'cancelled'
          ? `Your agent ${who} was stopped by the user before it finished.`
          : view.status === 'interrupted'
            ? `Your agent ${who} was interrupted: Carbon quit while it was running, so its work may be incomplete.`
            : `Your agent ${who} is still running.`
  const lines = [head, '', `Agent: ${view.name} (id ${view.id})`, `Task: ${view.task}`]
  if (view.followUp) lines.push(`Follow-up you sent it: ${view.followUp}`)
  if (view.role) lines.push(`Role: ${view.role}`)
  if (view.error) lines.push(`Error: ${view.error}`)
  lines.push('', view.result ? `${view.name}'s report:\n${view.result}` : `${view.name} wrote no report.`)
  lines.push('', `To give ${view.name} more work, use agents_send with agent "${view.name}".`)
  return lines.join('\n')
}

/** Several outcomes that ended while nothing could deliver them, for the next send. */
export function pendingDeliveriesContext(items: { agent: string; view: DelegationView }[]): string {
  if (!items.length) return ''
  return [
    'Agents from this conversation finished while Carbon could not report them:',
    ...items.map(({ agent, view }) => `\n---\n${deliveryText(agent, view)}`)
  ].join('\n')
}

function describe(agent: (v: DelegationView) => string, v: DelegationView): string {
  const lines = [
    `${v.name}\t${agent(v)}\t${v.status}${v.role ? `\t${v.role}` : ''}\t(id ${v.id})`,
    `  task: ${clip(v.task, 200)}`
  ]
  if (v.error) lines.push(`  error: ${v.error}`)
  if (v.status !== 'running') lines.push(v.result ? `  result:\n${v.result}` : '  result: (none)')
  return lines.join('\n')
}

/**
 * Run one agents tool. `chatId` is the calling chat, injected from the session
 * rather than taken from the model — a model able to name its parent could
 * read or cancel another conversation's delegates.
 */
export async function runAgentsTool(
  host: AgentsToolHost,
  ctx: { chatId?: string | null; agentLabel: (v: DelegationView) => string },
  name: AgentsToolName,
  input: AgentsToolInput = {}
): Promise<AgentsToolResult> {
  const parentId = ctx.chatId
  if (!parentId) return text('Delegation needs a chat; this session has none.', true)
  switch (name) {
    case 'delegate': {
      const outcome = await host.delegate(parentId, {
        task: input.task ?? '',
        provider: (input.provider ?? '') as Provider,
        model: input.model,
        role: input.role,
        name: input.name
      })
      if (!outcome.ok) return text(`Could not delegate: ${outcome.error}`, true)
      return text(
        `Started ${outcome.label} as "${outcome.name}" (id ${outcome.id}), in a new chat beside this one. Refer to it as ${outcome.name}: agents_send with agent "${outcome.name}" gives it more instructions. Its outcome will arrive in this conversation as a new message when it ends — do not poll or wait for it; continue with other work or end your turn.`
      )
    }
    case 'send': {
      const agent = (input.agent ?? input.id ?? '').trim()
      if (!agent) return text('agent is required.', true)
      const message = (input.message ?? '').trim()
      if (!message) return text('message is required.', true)
      if (message.length > DELEGATION_TASK_CAP) {
        return text(`message is ${message.length} characters; keep it under ${DELEGATION_TASK_CAP}.`, true)
      }
      const sent = await host.send(parentId, agent, message)
      return sent.ok ? text(sent.text) : text(sent.error, true)
    }
    case 'status': {
      const all = host.list(parentId)
      const ref = (input.agent ?? input.id ?? '').trim()
      if (!all.length) return text('This conversation has not started any agents.')
      if (ref) {
        const found = resolveDelegate(all, ref)
        return found.ok ? text(describe(ctx.agentLabel, found.view)) : text(found.error, true)
      }
      return text(all.map((v) => describe(ctx.agentLabel, v)).join('\n\n'))
    }
    case 'cancel': {
      const ref = (input.agent ?? input.id ?? '').trim()
      if (!ref) return text('agent is required.', true)
      const done = await host.cancel(parentId, ref)
      return done.ok ? text(done.text) : text(done.error, true)
    }
  }
}

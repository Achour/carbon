import type { ChatMeta, PermissionModeId, ScheduledTask } from '../shared/types.ts'
import {
  describeSchedule,
  formatMoment,
  parseCron,
  parseLocalDateTime,
  validateSchedule,
  type Schedule
} from '../shared/schedule.ts'

/**
 * **The agent's half of scheduled tasks**: `schedule_create` and friends on the
 * `carbon` server, so "check my PRs every morning" typed into a chat becomes a
 * task without a trip to the Scheduled page. The tool table, argument parsing
 * and the replies live here; `ChatManager` is the host and owns everything
 * with a side effect. See `docs/scheduled.md`.
 *
 * Dependency-free on purpose — type imports and `shared/schedule.ts` only — so
 * `node --test` runs it straight off the `.ts`.
 */

export const SCHEDULE_TOOL_NAMES = ['create', 'list', 'update', 'delete', 'run'] as const

export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number]

/** A prompt longer than this is a transcript, not a task. */
export const SCHEDULE_PROMPT_CAP = 16_000

const PERMISSION_IDS: readonly PermissionModeId[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions']

type Param = { type: 'string'; required?: boolean; enum?: readonly string[]; description: string }

const WHEN = {
  cron: {
    type: 'string',
    description:
      'A five-field cron expression in the user\'s LOCAL time: minute hour day-of-month month day-of-week. "0 9 * * 1-5" is weekdays at 9:00, "*/30 * * * *" every half hour, "0 18 * * 5" Fridays at 18:00. Use for anything that repeats.'
  },
  at: {
    type: 'string',
    description:
      'A one-off run at a LOCAL date-time, "YYYY-MM-DDTHH:MM" (e.g. "2026-10-15T09:00"). Use instead of cron for something that happens once.'
  },
  in_minutes: {
    type: 'string',
    description: 'A one-off run this many minutes from now ("remind me in an hour" is 60). Instead of cron or at.'
  }
} as const satisfies Record<string, Param>

export const SCHEDULE_TOOL_INFO: Record<
  ScheduleToolName,
  { description: string; readOnly: boolean; params: Record<string, Param> }
> = {
  create: {
    description:
      "Schedule a prompt for Carbon to send later or on a repeating schedule — each run starts a NEW chat in this project with that prompt, on the model and permission mode given (default: this chat's). Use it when the user wants something done later or regularly (\"every morning summarize new issues\", \"remind me in an hour to…\", \"each Friday at 5 review the week's commits\") — never a sleep, a loop or a system cron job. The run sees ONLY the prompt, none of this conversation, so write it as a complete brief: what to do, where, and what to report. Give exactly one of cron, at or in_minutes; times are the user's local time. Runs happen while Carbon is running (its window may be closed); a run missed while the app was quit or the Mac asleep happens once when it is back. The user manages tasks on Carbon's Scheduled page.",
    readOnly: false,
    params: {
      name: { type: 'string', required: true, description: 'A short name for the task, shown on the Scheduled page and as each run\'s chat title, e.g. "Morning PR check".' },
      prompt: { type: 'string', required: true, description: 'The complete prompt each run is sent. It sees nothing else from this conversation.' },
      ...WHEN,
      model: {
        type: 'string',
        description:
          'Which model runs it, as the user named it ("opus", "sol"); matched against this chat\'s provider. Omit for this chat\'s model.'
      },
      permission_mode: {
        type: 'string',
        enum: PERMISSION_IDS,
        description:
          "What the runs may do without asking. Never more than this chat's own mode. In 'default' (ask), a run that needs an approval waits for the user, so prefer a mode that lets the task finish alone when it edits files."
      },
      worktree: {
        type: 'string',
        enum: ['true', 'false'],
        description: 'Run each time in a fresh git worktree so the runs never touch the user\'s working copy. Default false.'
      }
    }
  },
  list: {
    description:
      'List the scheduled tasks — name, id, schedule, project, next run, whether paused, and how the last run went — plus the current local time.',
    readOnly: true,
    params: {}
  },
  update: {
    description:
      'Change a scheduled task: rename it, rewrite its prompt, move its schedule (cron, at or in_minutes), pause or resume it (enabled), or change its model, permission mode or worktree setting. Only the fields given change.',
    readOnly: false,
    params: {
      id: { type: 'string', required: true, description: "The task's id or its name." },
      name: { type: 'string', description: 'A new name.' },
      prompt: { type: 'string', description: 'A new prompt.' },
      ...WHEN,
      enabled: { type: 'string', enum: ['true', 'false'], description: '"false" pauses the task, "true" resumes it.' },
      model: { type: 'string', description: 'A different model, as the user named it.' },
      permission_mode: {
        type: 'string',
        enum: PERMISSION_IDS,
        description: "A different permission mode — never more than this chat's own."
      },
      worktree: { type: 'string', enum: ['true', 'false'], description: 'Run in a fresh worktree each time.' }
    }
  },
  delete: {
    description: 'Delete a scheduled task. Chats its earlier runs created are kept.',
    readOnly: false,
    params: {
      id: { type: 'string', required: true, description: "The task's id or its name." }
    }
  },
  run: {
    description:
      'Run a scheduled task now, once, in a new chat — to try it out, or because the user asked. Its schedule is unaffected. Returns at once; the run happens in its own chat.',
    readOnly: false,
    params: {
      id: { type: 'string', required: true, description: "The task's id or its name." }
    }
  }
}

/**
 * Appended to the session rules wherever the tools are offered, so the model
 * reaches for them before it reaches for `sleep` — the tool description alone
 * is read only once a search surfaces it.
 */
export const SCHEDULE_SESSION_RULES =
  'The `carbon` server can also schedule work: `schedule_create` (name, prompt, and a five-field cron in local time, an `at` date-time, or `in_minutes`) saves a prompt Carbon sends on that schedule, each run in a new chat in this project. Use it whenever the user wants something done later or repeatedly ("every morning…", "remind me in an hour…", "each Friday…") rather than sleeping, looping or installing a system cron job. A run sees only its prompt, so write it as a complete brief. `schedule_list`, `schedule_update`, `schedule_run` (once, now) and `schedule_delete` manage tasks. These are MCP tools (mcp__carbon__schedule_create, mcp__carbon__schedule_list, mcp__carbon__schedule_update, mcp__carbon__schedule_delete, mcp__carbon__schedule_run); if they are deferred, load them by name.'

export function isScheduleToolName(value: string): value is ScheduleToolName {
  return (SCHEDULE_TOOL_NAMES as readonly string[]).includes(value)
}

/** Plan mode refuses every one that creates, changes or starts something. */
export function isScheduleSideEffect(name: ScheduleToolName): boolean {
  return name !== 'list'
}

/**
 * Whether a chat's sessions get the schedule tools. Never a scheduled run's
 * own chat — a task that schedules a task on each run is a fan-out nobody
 * asked for — nor a delegate, for the one-level rule delegation keeps. A chat
 * with no id is a throwaway probe.
 */
export function canSchedule(chat: Pick<ChatMeta, 'id' | 'delegation' | 'scheduled' | 'surface'> | null | undefined): boolean {
  return !!chat?.id && !chat.delegation && !chat.scheduled && chat.surface !== 'terminal'
}

export type ScheduleToolInput = {
  id?: string
  name?: string
  prompt?: string
  cron?: string
  at?: string
  in_minutes?: string
  model?: string
  permission_mode?: string
  enabled?: string
  worktree?: string
}

/** The fields a create or an update carries, checked and parsed. */
export interface ScheduleRequest {
  name?: string
  prompt?: string
  schedule?: Schedule
  model?: string
  permissionMode?: PermissionModeId
  enabled?: boolean
  worktree?: boolean
}

export interface ScheduleToolHost {
  list(): ScheduledTask[]
  create(chatId: string, request: ScheduleRequest & { name: string; prompt: string; schedule: Schedule }): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>
  update(chatId: string, id: string, request: ScheduleRequest): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>
  delete(id: string): void
  run(chatId: string, id: string): Promise<{ ok: true; chatId: string } | { ok: false; error: string }>
}

export type ScheduleToolResult = { kind: 'text'; text: string; isError?: boolean }

const text = (t: string, isError = false): ScheduleToolResult =>
  isError ? { kind: 'text', text: t, isError } : { kind: 'text', text: t }

/**
 * The schedule a call names, from whichever of `cron`, `at` and `in_minutes`
 * it gave — exactly one, or none at all for an update that leaves it alone.
 */
export function scheduleFromInput(
  input: ScheduleToolInput,
  now: number
): { ok: true; schedule?: Schedule } | { ok: false; error: string } {
  const cron = input.cron?.trim()
  const at = input.at?.trim()
  const inMinutes = input.in_minutes?.trim()
  const given = [cron, at, inMinutes].filter(Boolean).length
  if (given > 1) return { ok: false, error: 'Give only one of cron, at and in_minutes.' }
  let schedule: Schedule | undefined
  if (cron) {
    const parsed = parseCron(cron)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    schedule = { kind: 'cron', cron }
  } else if (at) {
    const t = parseLocalDateTime(at)
    if (t === null) return { ok: false, error: `at must be a local date-time like "2026-10-15T09:00"; got "${at}".` }
    if (t <= now) return { ok: false, error: `${formatMoment(t, now)} has already passed (it is now ${formatMoment(now, now)}).` }
    schedule = { kind: 'once', at: t }
  } else if (inMinutes) {
    const minutes = Number(inMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'in_minutes must be a positive number.' }
    schedule = { kind: 'once', at: now + Math.round(minutes * 60_000) }
  }
  if (schedule) {
    const invalid = validateSchedule(schedule)
    if (invalid) return { ok: false, error: invalid }
  }
  return { ok: true, schedule }
}

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  return value.trim().toLowerCase() === 'true'
}

function parseRequest(input: ScheduleToolInput, now: number): { ok: true; request: ScheduleRequest } | { ok: false; error: string } {
  const when = scheduleFromInput(input, now)
  if (!when.ok) return when
  const mode = input.permission_mode?.trim()
  if (mode && !(PERMISSION_IDS as readonly string[]).includes(mode)) {
    return { ok: false, error: `permission_mode must be one of: ${PERMISSION_IDS.join(', ')}.` }
  }
  const prompt = input.prompt?.trim()
  if (prompt && prompt.length > SCHEDULE_PROMPT_CAP) {
    return { ok: false, error: `prompt is ${prompt.length} characters; keep it under ${SCHEDULE_PROMPT_CAP}. Point the run at files instead of pasting them.` }
  }
  return {
    ok: true,
    request: {
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}),
      ...(prompt ? { prompt } : {}),
      ...(when.schedule ? { schedule: when.schedule } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(mode ? { permissionMode: mode as PermissionModeId } : {}),
      ...(flag(input.enabled) !== undefined ? { enabled: flag(input.enabled) } : {}),
      ...(flag(input.worktree) !== undefined ? { worktree: flag(input.worktree) } : {})
    }
  }
}

/**
 * A task by id, or by name as the user says it — case and spacing aside. A
 * name two tasks share is refused with both ids, so the model asks rather
 * than guesses which one to delete.
 */
export function resolveTask(
  tasks: readonly ScheduledTask[],
  ref: string
): { ok: true; task: ScheduledTask } | { ok: false; error: string } {
  const want = ref.trim()
  if (!want) return { ok: false, error: 'id is required.' }
  const byId = tasks.find((t) => t.id === want)
  if (byId) return { ok: true, task: byId }
  const flat = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const named = tasks.filter((t) => flat(t.name) === flat(want))
  if (named.length === 1) return { ok: true, task: named[0] }
  if (named.length > 1) {
    return { ok: false, error: `${named.length} tasks are named "${want}": ${named.map((t) => t.id).join(', ')}. Pass the id.` }
  }
  return {
    ok: false,
    error: tasks.length
      ? `No scheduled task "${want}". Tasks: ${tasks.map((t) => `${t.name} (${t.id})`).join(', ')}.`
      : 'There are no scheduled tasks.'
  }
}

/** One task as the agent reads it. */
export function describeTask(task: ScheduledTask, now: number, lastStatus?: string): string {
  const next = !task.enabled
    ? 'paused'
    : task.nextRunAt === null
      ? 'no further runs'
      : `next run ${formatMoment(task.nextRunAt, now)}`
  return [
    `${task.name} (id ${task.id}) — ${describeSchedule(task.schedule)}; ${next}.`,
    `  Project: ${task.cwd}. ${task.provider}${task.model ? ` · ${task.model}` : ''} · ${task.permissionMode}${task.worktree ? ' · new worktree per run' : ''}.`,
    task.lastRunAt ? `  Last run ${formatMoment(task.lastRunAt, now)}${lastStatus ? `: ${lastStatus}` : ''}.` : '  Not run yet.',
    `  Prompt: ${task.prompt.length > 300 ? `${task.prompt.slice(0, 300)}…` : task.prompt}`
  ].join('\n')
}

/** "Now: Wed, Oct 14, 3:05 PM (Europe/Paris)" — what "at 9" is relative to. */
export function nowLine(now: number): string {
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    zone = ''
  }
  return `Now: ${formatMoment(now, now)}${zone ? ` (${zone})` : ''}.`
}

/**
 * Run one schedule tool. `chatId` is the calling chat, injected from the
 * session rather than taken from the model, like the agents tools'.
 */
export async function runScheduleTool(
  host: ScheduleToolHost,
  ctx: { chatId?: string | null; lastStatus?: (task: ScheduledTask) => string | undefined; now?: number },
  name: ScheduleToolName,
  input: ScheduleToolInput = {}
): Promise<ScheduleToolResult> {
  const chatId = ctx.chatId
  if (!chatId) return text('Scheduling needs a chat; this session has none.', true)
  const now = ctx.now ?? Date.now()
  switch (name) {
    case 'create': {
      const parsed = parseRequest(input, now)
      if (!parsed.ok) return text(parsed.error, true)
      const { request } = parsed
      if (!request.name) return text('name is required.', true)
      if (!request.prompt) return text('prompt is required.', true)
      if (!request.schedule) return text('Say when: give cron (repeating), at (a local date-time) or in_minutes.', true)
      const made = await host.create(chatId, {
        ...request,
        name: request.name,
        prompt: request.prompt,
        schedule: request.schedule
      })
      if (!made.ok) return text(`Could not schedule it: ${made.error}`, true)
      return text(`Scheduled.\n${describeTask(made.task, now)}\n${nowLine(now)}`)
    }
    case 'list': {
      const tasks = host.list()
      if (!tasks.length) return text(`There are no scheduled tasks. ${nowLine(now)}`)
      return text([nowLine(now), ...tasks.map((t) => describeTask(t, now, ctx.lastStatus?.(t)))].join('\n\n'))
    }
    case 'update': {
      const found = resolveTask(host.list(), input.id ?? '')
      if (!found.ok) return text(found.error, true)
      const parsed = parseRequest(input, now)
      if (!parsed.ok) return text(parsed.error, true)
      if (!Object.keys(parsed.request).length) return text('Nothing to change: pass at least one field.', true)
      const changed = await host.update(chatId, found.task.id, parsed.request)
      if (!changed.ok) return text(`Could not update it: ${changed.error}`, true)
      return text(`Updated.\n${describeTask(changed.task, now)}`)
    }
    case 'delete': {
      const found = resolveTask(host.list(), input.id ?? '')
      if (!found.ok) return text(found.error, true)
      host.delete(found.task.id)
      return text(`Deleted "${found.task.name}". Chats from its earlier runs are kept.`)
    }
    case 'run': {
      const found = resolveTask(host.list(), input.id ?? '')
      if (!found.ok) return text(found.error, true)
      const started = await host.run(chatId, found.task.id)
      if (!started.ok) return text(`Could not run it: ${started.error}`, true)
      return text(`Started "${found.task.name}" in a new chat (id ${started.chatId}). It runs on its own; nothing comes back to this conversation.`)
    }
  }
}

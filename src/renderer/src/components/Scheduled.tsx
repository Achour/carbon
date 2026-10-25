import * as React from 'react'
import {
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  FolderOpen,
  GitBranch,
  Pencil,
  Play,
  Plus,
  ShieldAlert,
  Trash2,
  X
} from 'lucide-react'
import {
  modelDisplayName,
  projectRoot,
  providerForRememberedModel,
  type ChatMeta,
  type ChatStatus,
  type EffortId,
  type PermissionModeId,
  type Provider,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ServiceTier
} from '@shared/types'
import {
  describeSchedule,
  formatMoment,
  nextRun,
  presetOf,
  presetSchedule,
  validateSchedule,
  type Schedule,
  type SchedulePreset
} from '@shared/schedule'
import { cn } from '@/lib/utils'
import { formatDuration, relativeTime } from '@/lib/format'
import { projectLabel, projectRoots } from '@/lib/projects'
import { PROVIDER_PERMISSION_MODES } from '@/lib/permissionModes'
import { useApp, visibleChats } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { WithTooltip } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { CompactSelect } from '@/components/ui/select'
import { SwitchPill } from '@/components/ui/switch-pill'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { PROVIDER_COLOR, ProviderMark } from '@/components/ui/provider-mark'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Composer } from '@/components/Composer'

/**
 * The Scheduled page: prompts Carbon sends on a schedule, each run in a chat
 * of its own. A page like Pull requests rather than a settings section,
 * because it is where the *runs* are found as well as the tasks — the sidebar
 * keeps only a task's latest run (`archiveEarlierRuns` in main), so this is the
 * history.
 *
 * The editor's prompt box is the composer itself, with the model, effort and
 * permission pickers a chat would have, and its send button saves the task:
 * a scheduled task *is* "this message, on this model, later", and a form
 * re-describing those controls in other words would be a second vocabulary
 * for one thing. See `docs/scheduled.md`.
 */

type Mode = { kind: 'view' } | { kind: 'new' } | { kind: 'edit'; id: string }

/** Survives the page closing, like the Pull requests page's cache. */
const cache: { selected: string | null } = { selected: null }

/** Re-render once a minute, so "in 4m" counts down and next-run times roll over. */
function useMinute(): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** "in 3h", "in 12m", "now" — the near side of `relativeTime`. */
function untilText(at: number, now: number): string {
  const min = Math.round((at - now) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `in ${min}m`
  const hours = Math.round(min / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

interface RunState {
  label: string
  icon: React.ReactNode
}

/** How one run stands — its record, read through the chat's live status. */
function runState(meta: ChatMeta | undefined, live: ChatStatus | undefined): RunState | null {
  const run = meta?.scheduled
  if (!run) return null
  switch (run.status) {
    case 'running':
      return live === 'waiting-permission'
        ? { label: 'Needs your approval', icon: <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-400" /> }
        : { label: 'Running', icon: <DotSpinner className="size-3.5" /> }
    case 'completed':
      return { label: 'Finished', icon: <CircleCheck className="size-3.5 text-success" /> }
    case 'failed':
      return { label: run.error ? `Failed: ${run.error}` : 'Failed', icon: <CircleX className="size-3.5 text-destructive" /> }
    case 'stopped':
      return { label: 'Stopped', icon: <CircleSlash className="size-3.5 text-muted-foreground" /> }
    case 'interrupted':
      return {
        label: 'Interrupted — Carbon quit while it ran',
        icon: <CircleDashed className="size-3.5 text-muted-foreground" />
      }
  }
}

function nextText(task: ScheduledTask, now: number): string {
  if (!task.enabled) return 'Paused'
  if (task.nextRunAt === null) return task.schedule.kind === 'once' ? 'Done' : 'No further runs'
  return untilText(task.nextRunAt, now)
}

/** Everything a save needs, from a task as it stands. */
function inputOf(task: ScheduledTask): ScheduledTaskInput {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    provider: task.provider,
    model: task.model,
    effort: task.effort,
    serviceTier: task.serviceTier,
    permissionMode: task.permissionMode,
    worktree: task.worktree,
    schedule: task.schedule,
    enabled: task.enabled
  }
}

export function Scheduled(): React.JSX.Element {
  const tasks = useApp((s) => s.scheduledTasks)
  const closeScheduled = useApp((s) => s.closeScheduled)
  const [selected, setSelectedState] = React.useState<string | null>(cache.selected)
  const [mode, setMode] = React.useState<Mode>({ kind: 'view' })
  const now = useMinute()

  const setSelected = (id: string | null): void => {
    cache.selected = id
    setSelectedState(id)
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [contenteditable], [role="menu"], [role="dialog"], [role="listbox"]')) return
      if (mode.kind !== 'view') setMode({ kind: 'view' })
      else closeScheduled()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeScheduled, mode.kind])

  const current = tasks.find((t) => t.id === selected) ?? tasks[0] ?? null
  const editing = mode.kind === 'edit' ? (tasks.find((t) => t.id === mode.id) ?? null) : null

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <PageHeader title="Scheduled">
          <Button
            size="sm"
            variant="ghost"
            className="no-drag h-7 gap-1.5 text-[13px]"
            onClick={() => setMode({ kind: 'new' })}
          >
            <Plus className="size-3.5" />
            New task
          </Button>
          <WithTooltip label="Close  esc">
            <Button size="icon-sm" variant="ghost" className="no-drag" aria-label="Close" onClick={closeScheduled}>
              <X />
            </Button>
          </WithTooltip>
      </PageHeader>

      {tasks.length === 0 && mode.kind === 'view' ? (
        <EmptyState onNew={() => setMode({ kind: 'new' })} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
              {mode.kind === 'new' && (
                <div className="mb-0.5 flex items-center gap-2.5 rounded-md bg-accent px-2.5 py-2 text-[13px]">
                  <Plus className="size-4 text-muted-foreground" />
                  New task
                </div>
              )}
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  active={mode.kind !== 'new' && current?.id === task.id}
                  onSelect={() => {
                    setSelected(task.id)
                    setMode({ kind: 'view' })
                  }}
                />
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {mode.kind === 'new' ? (
              <TaskEditor
                key="new"
                task={null}
                onDone={(saved) => {
                  if (saved) setSelected(saved.id)
                  setMode({ kind: 'view' })
                }}
              />
            ) : editing ? (
              <TaskEditor
                key={editing.id}
                task={editing}
                onDone={() => setMode({ kind: 'view' })}
              />
            ) : current ? (
              <TaskDetail
                key={current.id}
                task={current}
                now={now}
                onEdit={() => setMode({ kind: 'edit', id: current.id })}
                onDeleted={() => setSelected(null)}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <CalendarClock className="size-8 text-muted-foreground/60" />
        <div className="text-[15px] font-medium">No scheduled tasks</div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          A scheduled task is a prompt Carbon sends on a schedule — every weekday morning, every
          hour, once tomorrow at nine — each time in a new chat. You can also ask any chat’s agent
          to set one up: “every morning, summarize new issues”.
        </p>
        <Button size="sm" className="mt-1 gap-1.5" onClick={onNew}>
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>
    </div>
  )
}

function useProjectMark(root: string): { root: string; name: string; icon: string | null } {
  const projectNames = useApp((s) => s.projectNames)
  const icon = useApp((s) => s.projectIcons[root] ?? null)
  return { root, name: projectLabel(root, projectNames), icon }
}

function TaskRow({
  task,
  now,
  active,
  onSelect
}: {
  task: ScheduledTask
  now: number
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const mark = useProjectMark(task.cwd)
  const last = useApp((s) => (task.lastChatId ? s.chats.find((c) => c.id === task.lastChatId) : undefined))
  const live = useApp((s) => (task.lastChatId ? s.statuses[task.lastChatId] : undefined))
  const state = runState(last, live)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      <ProjectAvatar size="sm" root={mark.root} name={mark.name} icon={mark.icon} className="size-[22px] rounded-[7px]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate text-[13px]', !task.enabled && 'text-muted-foreground')}>{task.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {describeSchedule(task.schedule)} · {nextText(task, now)}
        </span>
      </span>
      {state && (
        <WithTooltip label={`Last run: ${state.label}`}>
          <span className="flex shrink-0 items-center">{state.icon}</span>
        </WithTooltip>
      )}
    </button>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-3 py-1 text-[13px]">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** How many runs the history shows before "Show more". */
const RUNS_PAGE = 30

function TaskDetail({
  task,
  now,
  onEdit,
  onDeleted
}: {
  task: ScheduledTask
  now: number
  onEdit: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const mark = useProjectMark(task.cwd)
  const models = useApp((s) => s.models)
  const chats = useApp((s) => s.chats)
  const statuses = useApp((s) => s.statuses)
  const unread = useApp((s) => s.unreadChats)
  const openChat = useApp((s) => s.openChat)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [shown, setShown] = React.useState(RUNS_PAGE)

  const runs = React.useMemo(
    () =>
      chats
        .filter((c) => c.scheduled?.taskId === task.id)
        .sort((a, b) => b.scheduled!.firedAt - a.scheduled!.firedAt),
    [chats, task.id]
  )
  const mode = PROVIDER_PERMISSION_MODES[task.provider]?.find((m) => m.id === task.permissionMode)

  const toggle = async (): Promise<void> => {
    setError(null)
    try {
      await window.api.saveScheduledTask({ ...inputOf(task), enabled: !task.enabled })
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const runNow = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const result = await window.api.runScheduledTask(task.id)
      if (!result.ok) setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{task.name}</h1>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            <ProjectAvatar size="sm" root={mark.root} name={mark.name} icon={mark.icon} />
            <span className="truncate">{mark.name}</span>
            <span className="text-border">·</span>
            <span className="flex items-center" style={{ color: PROVIDER_COLOR[task.provider] }}>
              <ProviderMark provider={task.provider} className="size-3" />
            </span>
            <span className="truncate">{modelDisplayName(task.model, task.provider, models)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="mr-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            {task.enabled ? 'On' : 'Paused'}
            <SwitchPill on={task.enabled} label={task.enabled ? 'Pause task' : 'Resume task'} onChange={() => void toggle()} />
          </span>
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[13px]" disabled={busy} onClick={() => void runNow()}>
            <Play className="size-3.5" />
            Run now
          </Button>
          <WithTooltip label="Edit">
            <Button size="icon-sm" variant="ghost" aria-label="Edit task" onClick={onEdit}>
              <Pencil />
            </Button>
          </WithTooltip>
          <WithTooltip label="Delete">
            <Button size="icon-sm" variant="ghost" aria-label="Delete task" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          </WithTooltip>
        </div>
      </div>
      {error && <p className="-mt-2 text-xs break-words text-destructive">{error}</p>}

      <div className="flex flex-col">
        <Fact label="Schedule">{describeSchedule(task.schedule)}</Fact>
        <Fact label="Next run">
          {!task.enabled
            ? 'Paused'
            : task.nextRunAt === null
              ? 'None'
              : `${formatMoment(task.nextRunAt, now)} · ${untilText(task.nextRunAt, now)}`}
        </Fact>
        <Fact label="Permissions">{mode?.label ?? task.permissionMode}</Fact>
        <Fact label="Runs in">
          {task.worktree ? (
            <span className="flex items-center gap-1.5">
              <GitBranch className="size-3.5 text-muted-foreground" />A new worktree each time
            </span>
          ) : (
            'The project’s checkout'
          )}
        </Fact>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">Prompt</div>
        <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
          {task.prompt}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
          Runs
          {runs.length > 0 && <span className="font-normal tabular-nums">{runs.length}</span>}
        </div>
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Not run yet{task.enabled && task.nextRunAt !== null ? ` — the first is ${untilText(task.nextRunAt, now)}` : ''}.
          </p>
        ) : (
          <div className="flex flex-col">
            {runs.slice(0, shown).map((chat) => {
              const run = chat.scheduled!
              const state = runState(chat, statuses[chat.id])
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => void openChat(chat.id)}
                  className="group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60"
                >
                  <WithTooltip label={state?.label ?? ''}>
                    <span className="flex w-4 shrink-0 items-center justify-center">{state?.icon}</span>
                  </WithTooltip>
                  <span className="min-w-0 truncate">{formatMoment(run.firedAt, now)}</span>
                  {run.manual && <span className="shrink-0 text-[11px] text-muted-foreground">run by hand</span>}
                  {run.dueAt && <span className="shrink-0 text-[11px] text-muted-foreground">caught up</span>}
                  {unread[chat.id] && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {run.finishedAt ? formatDuration(run.finishedAt - run.firedAt) : relativeTime(run.firedAt, now)}
                  </span>
                </button>
              )
            })}
            {runs.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + RUNS_PAGE)}
                className="self-start rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Show {Math.min(RUNS_PAGE, runs.length - shown)} more
              </button>
            )}
          </div>
        )}
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogTitle>Delete “{task.name}”?</DialogTitle>
          <DialogDescription>
            It will not run again. The chats its earlier runs created are kept.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false)
                onDeleted()
                void window.api.deleteScheduledTask(task.id)
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- Editor ----------

type PresetKind = SchedulePreset['kind']

const PRESET_OPTIONS: { value: PresetKind; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'once', label: 'Once' },
  { value: 'custom', label: 'Custom (cron)' }
]

const DAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
  (label, i) => ({ value: String(i), label })
)
const MINUTE_STEPS = [5, 10, 15, 20, 30]
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]
const HOUR_OFFSETS = [0, 5, 10, 15, 20, 30, 45]

const pad = (n: number): string => String(n).padStart(2, '0')

/** `<input type="datetime-local">`'s value for an epoch time. */
function localInputValue(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Tomorrow at nine — what "once" offers before anyone picks a time. */
function tomorrowAtNine(): number {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

/** Every field the editor's "when" controls hold, whichever preset is showing. */
interface WhenState {
  kind: PresetKind
  minutes: number
  hours: number
  /** Minutes past the hour for "every few hours" — `30 *\/4 * * *` keeps its :30. */
  hourMinute: number
  time: string
  day: number
  once: string
  cron: string
}

function whenStateOf(schedule: Schedule | undefined): WhenState {
  const base: WhenState = {
    kind: 'daily',
    minutes: 15,
    hours: 1,
    hourMinute: 0,
    time: '09:00',
    day: 1,
    once: localInputValue(tomorrowAtNine()),
    cron: '0 9 * * 1-5'
  }
  if (!schedule) return base
  const preset = presetOf(schedule)
  switch (preset.kind) {
    case 'minutes':
      return { ...base, kind: 'minutes', minutes: preset.every }
    case 'hours':
      return { ...base, kind: 'hours', hours: preset.every, hourMinute: preset.minute }
    case 'daily':
    case 'weekdays':
      return { ...base, kind: preset.kind, time: `${pad(preset.hour)}:${pad(preset.minute)}` }
    case 'weekly':
      return { ...base, kind: 'weekly', day: preset.day, time: `${pad(preset.hour)}:${pad(preset.minute)}` }
    case 'once':
      return { ...base, kind: 'once', once: localInputValue(preset.at) }
    case 'custom':
      return { ...base, kind: 'custom', cron: preset.cron }
  }
}

function scheduleOf(when: WhenState): Schedule | null {
  const [h, m] = when.time.split(':').map(Number)
  const time = { hour: Number.isFinite(h) ? h : 9, minute: Number.isFinite(m) ? m : 0 }
  switch (when.kind) {
    case 'minutes':
      return presetSchedule({ kind: 'minutes', every: when.minutes })
    case 'hours':
      return presetSchedule({ kind: 'hours', every: when.hours, minute: when.hourMinute })
    case 'daily':
      return presetSchedule({ kind: 'daily', ...time })
    case 'weekdays':
      return presetSchedule({ kind: 'weekdays', ...time })
    case 'weekly':
      return presetSchedule({ kind: 'weekly', day: when.day, ...time })
    case 'once': {
      const at = new Date(when.once).getTime()
      return Number.isFinite(at) ? { kind: 'once', at } : null
    }
    case 'custom':
      return when.cron.trim() ? { kind: 'cron', cron: when.cron.trim() } : null
  }
}

function TaskEditor({
  task,
  onDone
}: {
  task: ScheduledTask | null
  onDone: (saved?: ScheduledTask) => void
}): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const projectOrder = useApp((s) => s.projectOrder)
  const projectNames = useApp((s) => s.projectNames)
  const projectIcons = useApp((s) => s.projectIcons)
  const defaults = useApp((s) => s.defaults)
  const models = useApp((s) => s.models)

  const roots = React.useMemo(() => projectRoots(visibleChats(chats), projectOrder), [chats, projectOrder])
  const [cwd, setCwd] = React.useState<string | null>(() => {
    if (task) return task.cwd
    const s = useApp.getState()
    const active = s.chats.find((c) => c.id === s.activeId)
    return (active ? projectRoot(active) : null) ?? s.selectedCwd ?? roots[0] ?? null
  })
  const [extraRoot, setExtraRoot] = React.useState<string | null>(null)
  const projectOptions = [...new Set([...(cwd ? [cwd] : []), ...(extraRoot ? [extraRoot] : []), ...roots])]

  const [name, setName] = React.useState(task?.name ?? '')
  const [when, setWhen] = React.useState<WhenState>(() => whenStateOf(task?.schedule))
  const patchWhen = (patch: Partial<WhenState>): void => setWhen((w) => ({ ...w, ...patch }))
  const [worktree, setWorktree] = React.useState(!!task?.worktree)

  const [model, setModel] = React.useState(task ? (task.model ?? '') : (defaults?.model ?? ''))
  const [provider, setProvider] = React.useState<Provider>(() =>
    task ? task.provider : providerForRememberedModel(defaults?.model, defaults?.modelProvider, models)
  )
  const [effort, setEffort] = React.useState<EffortId | ''>(task ? (task.effort ?? '') : (defaults?.effort ?? ''))
  const [serviceTier, setServiceTier] = React.useState<ServiceTier>(
    task?.serviceTier ?? defaults?.serviceTier ?? 'standard'
  )
  // A new task starts in Accept edits rather than the chat default: nobody is
  // there to answer an approval when it runs, and "ask" would park the first
  // run on its first edit. It is still the user's pick, one click away.
  const [permissionMode, setPermissionMode] = React.useState<PermissionModeId>(
    task?.permissionMode ?? 'acceptEdits'
  )
  const [error, setError] = React.useState<string | null>(null)

  const schedule = scheduleOf(when)
  const now = Date.now()
  const invalid = schedule ? validateSchedule(schedule) : 'Pick when it runs.'
  const next = schedule && !invalid ? nextRun(schedule, now) : null

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (!dir) return
    setExtraRoot(dir)
    setCwd(dir)
  }

  const save = async (text: string, attachments: unknown[]): Promise<void> => {
    setError(null)
    const fail = (message: string): never => {
      setError(message)
      // Rejecting is what makes the composer put the prompt back.
      throw new Error(message)
    }
    if (attachments.length) fail('A scheduled prompt cannot carry attachments — refer to the files by path instead.')
    if (!cwd) fail('Pick the project the task runs in.')
    if (!schedule || invalid) fail(invalid ?? 'Pick when it runs.')
    if (schedule!.kind === 'once' && next === null) fail('That time has already passed.')
    try {
      const saved = await window.api.saveScheduledTask({
        ...(task ? { id: task.id, enabled: task.enabled } : {}),
        name: name.trim() || text.trim().split('\n')[0].slice(0, 60),
        prompt: text,
        cwd: cwd!,
        provider,
        model: model || undefined,
        effort: effort || undefined,
        serviceTier,
        permissionMode,
        worktree,
        schedule: schedule!
      })
      onDone(saved)
    } catch (err) {
      fail((err as Error).message)
    }
  }

  const timeInput = (
    <Input
      type="time"
      value={when.time}
      onChange={(e) => patchWhen({ time: e.target.value })}
      className="h-7 w-28 text-[13px]"
    />
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{task ? 'Edit task' : 'New scheduled task'}</h1>
        <Button size="sm" variant="ghost" className="h-7 text-[13px]" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3 text-[13px]">
          <span className="w-24 shrink-0 text-muted-foreground">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Morning PR check"
            className="h-8 max-w-sm text-[13px]"
          />
        </label>

        <div className="flex items-center gap-3 text-[13px]">
          <span className="w-24 shrink-0 text-muted-foreground">Project</span>
          <CompactSelect
            value={cwd ?? ''}
            onValueChange={(v) => (v === '__browse__' ? void browse() : setCwd(v))}
            side="bottom"
            className="h-8 border border-border px-2.5 text-[13px] font-normal text-foreground"
            options={[
              ...projectOptions.map((root) => ({
                value: root,
                label: projectLabel(root, projectNames),
                description: root,
                icon: (
                  <ProjectAvatar
                    size="sm"
                    root={root}
                    name={projectLabel(root, projectNames)}
                    icon={projectIcons[root] ?? null}
                    className="size-4 rounded-[5px]"
                  />
                )
              })),
              { value: '__browse__', label: 'Other folder…', icon: <FolderOpen className="size-3.5" /> }
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <span className="w-24 shrink-0 text-muted-foreground">When</span>
          <CompactSelect
            value={when.kind}
            onValueChange={(v) => patchWhen({ kind: v as PresetKind })}
            side="bottom"
            className="h-7 border border-border px-2.5 text-[13px] font-normal text-foreground"
            options={PRESET_OPTIONS}
          />
          {when.kind === 'minutes' && (
            <CompactSelect
              value={String(when.minutes)}
              onValueChange={(v) => patchWhen({ minutes: Number(v) })}
              side="bottom"
              className="h-7 border border-border px-2.5 text-[13px] font-normal text-foreground"
              options={MINUTE_STEPS.map((n) => ({ value: String(n), label: `every ${n} minutes` }))}
            />
          )}
          {when.kind === 'hours' && (
            <CompactSelect
              value={String(when.hours)}
              onValueChange={(v) => patchWhen({ hours: Number(v) })}
              side="bottom"
              className="h-7 border border-border px-2.5 text-[13px] font-normal text-foreground"
              options={HOUR_STEPS.map((n) => ({ value: String(n), label: n === 1 ? 'every hour' : `every ${n} hours` }))}
            />
          )}
          {when.kind === 'hours' && (
            <>
              <span className="text-muted-foreground">at</span>
              <CompactSelect
                value={String(when.hourMinute)}
                onValueChange={(v) => patchWhen({ hourMinute: Number(v) })}
                side="bottom"
                className="h-7 border border-border px-2.5 text-[13px] font-normal text-foreground"
                options={[...new Set([...HOUR_OFFSETS, when.hourMinute])]
                  .sort((a, b) => a - b)
                  .map((n) => ({ value: String(n), label: `:${pad(n)} past` }))}
              />
            </>
          )}
          {(when.kind === 'daily' || when.kind === 'weekdays') && (
            <>
              <span className="text-muted-foreground">at</span>
              {timeInput}
            </>
          )}
          {when.kind === 'weekly' && (
            <>
              <span className="text-muted-foreground">on</span>
              <CompactSelect
                value={String(when.day)}
                onValueChange={(v) => patchWhen({ day: Number(v) })}
                side="bottom"
                className="h-7 border border-border px-2.5 text-[13px] font-normal text-foreground"
                options={DAY_OPTIONS}
              />
              <span className="text-muted-foreground">at</span>
              {timeInput}
            </>
          )}
          {when.kind === 'once' && (
            <Input
              type="datetime-local"
              value={when.once}
              onChange={(e) => patchWhen({ once: e.target.value })}
              className="h-7 w-52 text-[13px]"
            />
          )}
          {when.kind === 'custom' && (
            <Input
              value={when.cron}
              onChange={(e) => patchWhen({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              className="h-7 w-44 font-mono text-[13px]"
            />
          )}
        </div>
        <p className={cn('-mt-1 pl-[108px] text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
          {invalid
            ? invalid
            : next === null
              ? 'That time has already passed.'
              : `Next run ${formatMoment(next, now)} · ${untilText(next, now)}`}
        </p>

        <div className="flex items-center gap-3 text-[13px]">
          <span className="w-24 shrink-0 text-muted-foreground">Worktree</span>
          <SwitchPill on={worktree} label="Run each time in a new worktree" onChange={() => setWorktree((v) => !v)} />
          <span className="text-muted-foreground">
            {worktree
              ? 'Each run gets a new worktree, so it never touches your checkout. They are kept.'
              : 'Runs work in the project’s checkout.'}
          </span>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">Prompt</div>
        <Composer
          onSend={(text, attachments) => save(text, attachments)}
          draft={task ? { text: task.prompt, attachments: [] } : undefined}
          model={model}
          onModelChange={(next, nextProvider) => {
            setModel(next)
            setProvider(nextProvider)
          }}
          effort={effort}
          onEffortChange={(next) => setEffort(next)}
          modelEfforts={defaults?.modelEfforts}
          modelServiceTiers={defaults?.modelServiceTiers}
          serviceTier={serviceTier}
          onServiceTierChange={(next) => setServiceTier(next)}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          provider={provider}
          cwd={cwd}
          placeholder="What should each run do? It sees only this prompt."
          submitLabel={task ? 'Save' : 'Schedule'}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Each run starts a new chat with this prompt, on this model and permission mode. Runs
          happen while Carbon is open, even with its window closed; a run missed while it was quit
          or the Mac was asleep happens once when it is back.
        </p>
        {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
      </div>
    </div>
  )
}

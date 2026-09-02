import * as React from 'react'
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  MousePointerClick,
  Paperclip,
  PencilLine,
  PenLine,
  ShieldOff,
  ShieldQuestion,
  Sparkles,
  Square,
  Zap,
  WandSparkles,
  type LucideIcon,
  X
} from 'lucide-react'
import {
  EFFORT_OPTIONS,
  PERMISSION_MODES,
  PROVIDER_EFFORTS,
  PROVIDER_LABELS,
  PROVIDER_SHORT_LABELS,
  SERVICE_TIER_OPTIONS,
  fastModeNote,
  resolvedModelName,
  type Attachment,
  type EffortId,
  type ModelOption,
  type PermissionModeId,
  type Provider,
  type ServiceTier,
  type SlashCommand
} from '@shared/types'
import { CHAT_BLEED_PAD, CHAT_FRAME } from '@/lib/chatColumn'
import { cn } from '@/lib/utils'
import { formatTokens } from '@/lib/format'
import type { ComposerDraft } from '@/lib/drafts'
import { FileIcon } from '@/lib/fileIcon'
import { availableProviders } from '@/lib/modelCatalog'
import { codexComposerControl } from '@shared/codexCommands'
import {
  assembleModelOptions,
  canonicalModelId,
  rememberedEffortForModel
} from '@/lib/models'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { CompactSelect } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'
import { SessionPanel } from '@/components/SessionPanel'

/**
 * How long typing pauses before the draft reaches the store. Long enough that a
 * burst of keystrokes is one write, short enough that anything but a switch made
 * mid-word is already saved before the unmount flush has to catch it.
 */
const DRAFT_DEBOUNCE_MS = 400

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// Codex App Server exposes native command, file and additional-permission
// approvals. Plan and Full Access remain non-interactive; Auto asks App Server's
// reviewer to classify approval requests before escalating them to the user.
const CODEX_PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan mode', description: 'Investigates and plans without making changes' },
  { id: 'default', label: 'Ask to approve', description: 'Prompts when work needs extra access' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edits in the project; asks on escalation' },
  { id: 'auto', label: 'Auto', description: 'Codex reviews approval requests before escalating' },
  { id: 'bypassPermissions', label: 'Full access', description: 'No sandbox — use with care' }
]

// Grok has no Accept-edits: its CLI treats `acceptEdits` as a Claude-compat
// alias of ask, so offering it would name a mode the session never enters. The
// rest map onto real baselines — `_meta.yoloMode`, `_meta.autoMode`, and the
// plan flag (see `grokPermissionMode`).
const GROK_PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan mode', description: 'Explores and writes a plan before building' },
  { id: 'default', label: 'Ask to approve', description: 'Prompts before sensitive actions' },
  // "Blocks" rather than "asks": in a non-interactive client a call the check
  // refuses fails and is reported to the model — it does not escalate to a
  // prompt the way Claude's Auto does.
  { id: 'auto', label: 'Auto', description: 'A safety check approves or blocks each action' },
  // Not Claude's "Never asks": Grok still applies deny rules, hooks and some
  // shell ask rules under always-approve.
  { id: 'bypassPermissions', label: 'Full access', description: 'Skips prompts — deny rules still apply' }
]

/**
 * Which permission modes each backend actually implements. A menu built from
 * the wrong provider's list offers modes that silently degrade — Grok served
 * Claude's list would advertise Accept edits and get ask.
 */
const PROVIDER_PERMISSION_MODES: Record<
  Provider,
  { id: PermissionModeId; label: string; description: string }[]
> = {
  claude: PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES,
  grok: GROK_PERMISSION_MODES
}

function codexPermissionValue(mode: PermissionModeId): PermissionModeId {
  return mode
}

type PermissionAppearance = {
  Icon: LucideIcon
  iconClassName: string
  triggerClassName: string
}

/** A consistent icon and semantic accent for permission modes across providers. */
function permissionAppearance(
  mode: PermissionModeId,
  isCodex: boolean
): PermissionAppearance {
  switch (mode) {
    case 'plan':
      return {
        Icon: ClipboardList,
        iconClassName: 'text-sky-600 dark:text-sky-400',
        triggerClassName:
          'text-sky-700 hover:text-sky-700 data-[popup-open]:text-sky-700 dark:text-sky-400 dark:hover:text-sky-400 dark:data-[popup-open]:text-sky-400'
      }
    case 'acceptEdits':
      return {
        Icon: FileCheck2,
        iconClassName: 'text-emerald-600 dark:text-emerald-400',
        triggerClassName:
          'text-emerald-700 hover:text-emerald-700 data-[popup-open]:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400 dark:data-[popup-open]:text-emerald-400'
      }
    case 'auto':
      return {
        Icon: WandSparkles,
        iconClassName: 'text-violet-600 dark:text-violet-400',
        triggerClassName:
          'text-violet-700 hover:text-violet-700 data-[popup-open]:text-violet-700 dark:text-violet-400 dark:hover:text-violet-400 dark:data-[popup-open]:text-violet-400'
      }
    case 'bypassPermissions':
      return {
        Icon: ShieldOff,
        iconClassName: 'text-amber-600 dark:text-amber-400',
        triggerClassName:
          'text-amber-700 hover:text-amber-700 data-[popup-open]:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400 dark:data-[popup-open]:text-amber-400'
      }
    default:
      return {
        Icon: isCodex ? PencilLine : ShieldQuestion,
        iconClassName: 'text-muted-foreground',
        triggerClassName: ''
      }
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Turns picked/dropped/pasted Files into attachments; unusable ones are skipped. */
async function toAttachments(files: Iterable<File>): Promise<{
  attachments: Attachment[]
  skipped: string[]
}> {
  const attachments: Attachment[] = []
  const skipped: string[] = []
  for (const file of files) {
    if (IMAGE_TYPES.has(file.type)) {
      if (file.size > MAX_IMAGE_BYTES) {
        skipped.push(`${file.name || 'image'} is over 10 MB`)
        continue
      }
      attachments.push({
        id: crypto.randomUUID(),
        kind: 'image',
        name: file.name || 'image.png',
        mediaType: file.type,
        data: await readAsBase64(file)
      })
    } else {
      // Non-image files are referenced by absolute path; pasted blobs have none.
      const path = window.api.pathForFile(file)
      if (path) {
        attachments.push({ id: crypto.randomUUID(), kind: 'file', name: file.name, path })
      } else {
        skipped.push(`${file.name || 'file'} has no path (unsupported type)`)
      }
    }
  }
  return { attachments, skipped }
}

function AttachmentChip({
  att,
  onRemove
}: {
  att: Attachment
  onRemove: () => void
}): React.JSX.Element {
  const elementTitle =
    att.kind === 'element' && att.element
      ? [att.element.source?.file, att.element.selector].filter(Boolean).join('\n')
      : undefined
  const sel = att.kind === 'selection' ? att.selection : undefined
  const canvas = att.kind === 'canvas' ? att.canvas : undefined
  return (
    <div className="group/att relative shrink-0">
      {att.kind === 'image' ? (
        <img
          src={`data:${att.mediaType};base64,${att.data}`}
          alt={att.name}
          title={att.name}
          className="h-14 w-14 rounded-lg border border-border object-cover"
        />
      ) : att.kind === 'element' ? (
        <div
          title={elementTitle}
          className="flex h-8 max-w-52 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5"
        >
          {att.data ? (
            <img
              src={`data:${att.mediaType};base64,${att.data}`}
              alt=""
              className="-ml-1 h-6 w-6 rounded border border-border object-cover"
            />
          ) : (
            <MousePointerClick className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="truncate font-mono text-[11px]">{att.name}</span>
        </div>
      ) : sel ? (
        // The snippet goes in the tooltip rather than the chip: a chip sized to
        // its lines would push the composer's own controls off the row.
        <div
          title={`${sel.rel ?? sel.path}\n\n${sel.text}`}
          className="flex h-8 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
        >
          <FileIcon path={sel.path} />
          <span className="truncate font-mono text-[11px]">{att.name}</span>
        </div>
      ) : canvas ? (
        // Prose face, not mono: a canvas title is a name someone wrote, where a
        // path and a selection are code. `PenLine` is the canvas glyph
        // everywhere else in the app — the tool rows, the list, the tab.
        <div
          title={canvas.text.slice(0, 400)}
          className="flex h-8 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
        >
          <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs">{att.name}</span>
        </div>
      ) : (
        <div
          title={att.path}
          className="flex h-8 max-w-44 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
        >
          <FileIcon path={att.name} />
          <span className="truncate text-xs">{att.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${att.name}`}
        className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-popover p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/att:opacity-100 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function fmtContextWindow(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`
}

/**
 * The popover's body. A separate component so its subscription and its markup
 * belong to the popup, not to the composer: `PopoverContent`'s children are
 * built at the trigger's render time, and the composer re-renders on every
 * coalesced delta mid-turn. Nothing here runs until the popup is open.
 */
function ContextDetail({
  used,
  window: win,
  name
}: {
  used: number
  window: number
  name: string
}): React.JSX.Element {
  const usage = useApp((s) => s.contextUsage)
  const pct = Math.min(1, used / win)
  const rows = usage?.overhead ?? []
  const shown = rows.slice(0, 5)
  const rest = rows.slice(5).reduce((n, row) => n + row.tokens, 0)
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">Context window</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(pct * 100)}% used
        </span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct > 0.9 ? 'bg-destructive' : pct > 0.7 ? 'bg-amber-500' : 'bg-primary'
          )}
          style={{ width: `${Math.max(2, pct * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{formatTokens(used)} used</span>
        <span>
          {formatTokens(Math.max(0, win - used))} free of {formatTokens(win)}
        </span>
      </div>
      {/* Being over has no other symptom until a turn stalls compacting, so it
          is said out loud while it is still just a number. */}
      {usage?.overLimit && (
        <p className="mt-2 rounded-md bg-secondary px-2 py-1.5 text-[11px] leading-relaxed text-amber-500">
          {formatTokens(usage.overLimit.tokensOver)} over{' '}
          {usage.overLimit.kind === 'hard_limit'
            ? 'the hard limit — the next request would be rejected.'
            : 'the compaction threshold — the next turn compacts first.'}
        </p>
      )}
      {shown.length > 0 && (
        <div className="mt-2.5 border-t border-border pt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Always loaded</div>
          {shown.map((row) => (
            <div
              key={`${row.detail}:${row.label}`}
              className="flex items-baseline justify-between gap-2 py-px text-[11px]"
            >
              <span className="truncate text-muted-foreground" title={row.label}>
                {row.label}
                <span className="ml-1 text-muted-foreground/60">{row.detail}</span>
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatTokens(row.tokens)}
              </span>
            </div>
          ))}
          {rest > 0 && (
            <div className="flex items-baseline justify-between gap-2 py-px text-[11px] text-muted-foreground/60">
              <span>+{rows.length - shown.length} more</span>
              <span className="tabular-nums">{formatTokens(rest)}</span>
            </div>
          )}
        </div>
      )}
      <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
        How much of the conversation {name} can hold at once. When it fills up, older messages are
        compacted automatically so the chat can continue.
      </p>
    </>
  )
}

function ContextRing({
  used,
  window: win,
  provider
}: {
  used: number
  window: number
  provider: Provider
}): React.JSX.Element {
  const name = PROVIDER_SHORT_LABELS[provider]
  const pct = Math.min(1, used / win)
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Context window usage"
        className={cn(
          'no-drag flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-accent data-[popup-open]:bg-accent',
          pct > 0.9 ? 'text-destructive' : pct > 0.7 ? 'text-amber-500' : 'text-muted-foreground'
        )}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90">
          <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="7"
            cy="7"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${c * pct} ${c}`}
          />
        </svg>
        <span className="text-[10px] tabular-nums">{Math.round(pct * 100)}%</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64">
        <ContextDetail used={used} window={win} name={name} />
      </PopoverContent>
    </Popover>
  )
}

function ModelSettingsPicker({
  model,
  onModelChange,
  models,
  effort,
  onEffortChange,
  efforts,
  serviceTier,
  onServiceTierChange,
  serviceTiers,
  fastNote,
  disabled,
  open: controlledOpen,
  onOpenChange
}: {
  model: string
  onModelChange: (model: string, provider: Provider) => void
  models: ModelOption[]
  effort: EffortId | ''
  onEffortChange: (effort: EffortId | '') => void
  efforts: typeof EFFORT_OPTIONS
  serviceTier: ServiceTier
  onServiceTierChange?: (serviceTier: ServiceTier) => void
  serviceTiers: typeof SERVICE_TIER_OPTIONS
  /** Why the provider isn't serving Fast, when it says so; null when it is. */
  fastNote?: string | null
  disabled?: boolean
  /** Controlled by Composer so `/model` can open the existing native picker. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const [effortOpen, setEffortOpen] = React.useState(false)
  const [speedOpen, setSpeedOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [controlledOpen, onOpenChange]
  )
  const selected = models.find((option) => option.id === model)
  // The chip has room for one name, so show the model actually in use rather
  // than the provider's "Default" wrapper — the menu is where that row's
  // status is worth stating. Every explicit row already carries its real name.
  const selectedName = resolvedModelName(selected?.resolvedModel) ?? selected?.label ?? model
  const selectedEffort = efforts.find((option) => option.id === effort)
  const selectedTier = serviceTiers.find((option) => option.id === serviceTier)
  const groups = (['claude', 'codex', 'grok'] as Provider[])
    .map((group) => ({ group, models: models.filter((option) => option.provider === group) }))
    .filter(({ models: options }) => options.length > 0)

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setEffortOpen(false)
          setSpeedOpen(false)
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        title={fastNote ?? undefined}
        aria-label={`${selectedName}, ${selectedEffort?.label ?? effort}${
          serviceTier === 'fast' ? (fastNote ? `, Fast unavailable: ${fastNote}` : ', Fast') : ''
        }`}
        className="no-drag inline-flex h-7 min-w-0 max-w-full select-none items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground disabled:opacity-50"
      >
        <Sparkles className="size-3 shrink-0" />
        <span className="max-w-32 truncate">{selectedName}</span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="shrink-0">{selectedEffort?.label ?? effort}</span>
        {serviceTier === 'fast' && (
          <>
            <span className="shrink-0 text-muted-foreground/50">·</span>
            {/* Struck through, not hidden: Fast is still what's selected — the
                provider just isn't serving it, and silently showing Standard
                would make the picker look broken. */}
            <span
              className={cn(
                'shrink-0',
                fastNote ? 'text-muted-foreground/60 line-through' : 'text-violet-400'
              )}
            >
              Fast
            </span>
          </>
        )}
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      {/* w-80, not w-72: the Default row carries a label, the model it resolves
          to, and a context badge, which truncates the label at the narrower width. */}
      <PopoverContent side="top" align="start" className="w-80 overflow-hidden p-0">
        {/* px-1 with no *top* padding: the headers are sticky, and a padded
            scrollport is a band above the pinned header that rows scroll
            through in plain sight. The first header's own pt-2 replaces it. */}
        <div className="max-h-72 overflow-y-auto px-1 pb-1">
          {groups.map(({ group, models: options }, gi) => (
            // The rule is the separator, and it belongs to the *group* rather
            // than to its header: on the header it would pin along with it and
            // sit as a stray line across the top of the list.
            <div key={group} className={cn(gi > 0 && 'mt-1.5 border-t border-border pt-1.5')}>
              {/* The mark on its own tinted plate, as in the sidebar and
                  Settings — three lists of bare model names are told apart by
                  these headers alone, and a 10px uppercase label reads as
                  spacing before it reads as a word. Squared off rather than the
                  avatar's disc: this labels a section, and a circle here would
                  read as another chat row.

                  Sticky because the list scrolls to about twice its height, so
                  the header naming what you're looking at is the first thing to
                  leave. */}
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover px-1.5 pt-2 pb-1.5">
                <ProviderAvatar provider={group} className="rounded-md" />
                <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {PROVIDER_LABELS[group]}
                </span>
              </div>
              {options.map((option) => {
                // Only ever set on the "Default" row: every other row's label
                // already *is* its resolved name, so this stays out of the way.
                const resolved = resolvedModelName(option.resolvedModel)
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={option.disabled}
                    title={option.description}
                    aria-pressed={option.id === model}
                    onMouseEnter={() => {
                      setEffortOpen(false)
                      setSpeedOpen(false)
                    }}
                    onClick={() => {
                      onModelChange(option.id, option.provider)
                      setOpen(false)
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-45"
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {resolved && resolved !== option.label && (
                      <span className="shrink-0 text-[11px] text-muted-foreground/70">
                        {resolved}
                      </span>
                    )}
                    {option.contextWindow && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {fmtContextWindow(option.contextWindow)}
                      </span>
                    )}
                    {option.id === model && <Check className="size-3.5 shrink-0" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="border-t border-border p-1">
          <Popover open={effortOpen} onOpenChange={setEffortOpen}>
            <PopoverTrigger
              onMouseEnter={() => {
                setSpeedOpen(false)
                setEffortOpen(true)
              }}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[popup-open]:bg-accent"
            >
              <Brain className="size-3.5 text-muted-foreground" />
              <span className="flex-1 text-left">Reasoning</span>
              <span className="text-xs text-muted-foreground">
                {selectedEffort?.label ?? effort}
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-44 p-1">
              {efforts.map((option) => (
                <button
                  key={option.id || 'default'}
                  type="button"
                  title={option.description}
                  aria-pressed={option.id === effort}
                  onClick={() => {
                    onEffortChange(option.id)
                    setEffortOpen(false)
                    setOpen(false)
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                >
                  <span className="flex-1 text-left">{option.label}</span>
                  {option.id === effort && <Check className="size-3.5" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {onServiceTierChange && (
            <Popover open={speedOpen} onOpenChange={setSpeedOpen}>
              <PopoverTrigger
                onMouseEnter={() => {
                  setEffortOpen(false)
                  setSpeedOpen(true)
                }}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[popup-open]:bg-accent"
              >
                <Zap className="size-3.5 text-muted-foreground" />
                <span className="flex-1 text-left">Speed</span>
                <span className="text-xs text-muted-foreground">
                  {fastNote && serviceTier === 'fast'
                    ? 'Standard'
                    : (selectedTier?.label ?? serviceTier)}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent side="right" align="end" className="w-52 p-1">
                {serviceTiers.map((option) => {
                  // Only the Fast row can be refused, and only say so where the
                  // user is looking at the choice itself.
                  const note = option.id === 'fast' ? fastNote : null
                  return (
                    <button
                      key={option.id}
                      type="button"
                      title={note ?? option.description}
                      aria-pressed={option.id === serviceTier}
                      onClick={() => {
                        onServiceTierChange(option.id)
                        setSpeedOpen(false)
                        setOpen(false)
                      }}
                      className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="flex min-w-0 flex-1 flex-col text-left">
                        <span className="truncate">{option.label}</span>
                        {note && (
                          <span className="text-[10px] leading-tight text-muted-foreground">
                            {note}
                          </span>
                        )}
                      </span>
                      {option.id === serviceTier && <Check className="size-3.5 shrink-0" />}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function Composer({
  onSend,
  streaming = false,
  onStop,
  model,
  onModelChange,
  effort,
  onEffortChange,
  modelEfforts,
  serviceTier = 'standard',
  onServiceTierChange,
  permissionMode,
  onPermissionModeChange,
  contextTokens,
  contextWindow,
  provider = 'claude',
  cwd = null,
  commands = [],
  disabled = false,
  switchingNote,
  placeholder = 'Ask Claude Code anything…',
  autoFocus = true,
  draft,
  onDraftChange,
  clearToken = 0,
  header
}: {
  /** May be async; if it rejects, the composer restores the draft. */
  onSend: (text: string, attachments: Attachment[]) => void | Promise<void>
  streaming?: boolean
  onStop?: () => void
  model: string
  onModelChange: (model: string, provider: Provider) => void
  effort: EffortId | ''
  /** `remember: false` marks an app-generated correction — see `ChatOptionsPatch`. */
  onEffortChange: (effort: EffortId | '', opts?: { remember?: boolean }) => void
  /** Last effort chosen per model; selecting a model restores its value. */
  modelEfforts?: Record<string, EffortId | ''>
  serviceTier?: ServiceTier
  onServiceTierChange?: (serviceTier: ServiceTier, opts?: { remember?: boolean }) => void
  permissionMode: PermissionModeId
  onPermissionModeChange: (mode: PermissionModeId) => void
  contextTokens?: number
  contextWindow?: number
  /** Which agent backs this chat; switches the pickers/labels to its reality. */
  provider?: Provider
  /** Project folder used for @-file mentions; null disables them. */
  cwd?: string | null
  /** Slash commands available in this project, for the / autocomplete. */
  commands?: SlashCommand[]
  disabled?: boolean
  /**
   * Set while a just-sent provider switch is generating its handoff context.
   * Locks the composer (Stop stays available) and replaces the placeholder,
   * so the wait has a visible reason instead of a silent spinner.
   */
  switchingNote?: string
  placeholder?: string
  autoFocus?: boolean
  /**
   * Unsent text to open with. Read **once**, at mount — callers pass a snapshot
   * taken imperatively rather than a subscribed value, so a keystroke can't
   * re-render the transcript above. Mount the composer under a `key` naming the
   * chat or project it belongs to and this stays correct by construction.
   */
  draft?: ComposerDraft
  /** Debounced while typing, and flushed on unmount. */
  onDraftChange?: (draft: ComposerDraft) => void
  /**
   * Empties the box whenever it changes. The sidebar can discard the draft of
   * the project you are looking at, and deleting the stored copy alone would be
   * undone by the very next debounce — the text lives here.
   */
  clearToken?: number
  /**
   * A section rendered at the top of the composer's own box, above the input —
   * the task dock. It goes *inside* the border rather than above it because the
   * border is one outline: the composer's changes colour on focus and on a file
   * drag, and a sibling box carrying its own would disagree with it at exactly
   * those moments. It rounds its own top corners, since the root cannot clip
   * (that would take the slash/@ popovers with it).
   */
  header?: React.ReactNode
}): React.JSX.Element {
  const [text, setText] = React.useState(() => draft?.text ?? '')
  const [attachments, setAttachments] = React.useState<Attachment[]>(() => draft?.attachments ?? [])
  const [attachError, setAttachError] = React.useState<string | null>(null)
  const [modelSettingsOpen, setModelSettingsOpen] = React.useState(false)
  const [permissionOpen, setPermissionOpen] = React.useState(false)
  const locked = disabled || switchingNote !== undefined

  // ---- Draft persistence ----
  // Text stays in local state: typing has to be instant, and routing every
  // keystroke through the store would re-render every subscriber of it. The
  // store only sees a debounced copy — plus one final write on unmount, which
  // is the write that actually matters, since a chat switch remounts this
  // component and would otherwise take the last few keystrokes with it.
  const liveDraft = React.useRef<ComposerDraft>({ text, attachments })
  liveDraft.current = { text, attachments }
  const emitDraft = React.useRef(onDraftChange)
  emitDraft.current = onDraftChange
  React.useEffect(() => {
    const timer = setTimeout(() => emitDraft.current?.(liveDraft.current), DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, attachments])
  React.useEffect(() => () => emitDraft.current?.(liveDraft.current), [])
  // Skips the mount run: the initial token is not a discard, and clearing here
  // would throw away the draft we were just handed.
  const mountedToken = React.useRef(clearToken)
  React.useEffect(() => {
    if (mountedToken.current === clearToken) return
    mountedToken.current = clearToken
    setText('')
    setAttachments([])
  }, [clearToken])

  // Attachments handed in from elsewhere (e.g. an element picked in the browser
  // preview) land in a store inbox; pull them into the composer and clear it.
  // Models reported by the live session, when loaded; otherwise the static list.
  // The dynamic list already includes its own "Default" row (normalized to the
  // empty id in main), so use it as-is and just append the non-Claude (Codex)
  // placeholders the static list carries.
  const dynamicModels = useApp((s) => s.models)
  const codexConfigModel = useApp((s) => s.codexConfigModel)
  const providerClis = useApp((s) => s.providerClis)
  const loadCodexConfigModel = useApp((s) => s.loadCodexConfigModel)
  const loadModels = useApp((s) => s.loadModels)
  React.useEffect(() => {
    void loadCodexConfigModel()
  }, [loadCodexConfigModel])
  // Fetch the real Claude list up front rather than waiting for a first turn:
  // the static fallback's "Default" row can't name the model it resolves to, so
  // the chip would read "Default" where Codex's already reads its real model.
  React.useEffect(() => {
    void loadModels(undefined, cwd ?? undefined)
  }, [loadModels, cwd])
  // Every *available* provider's models are offered — picking one from another
  // provider switches the chat's backend mid-conversation, and main hands the
  // context over via a handoff brief (see ChatManager.startHandoffBrief). A
  // provider whose CLI isn't installed contributes nothing, since its rows
  // could only fail on send; Settings → Providers is where that is fixed.
  const available = availableProviders(providerClis)
  const modelOptions = assembleModelOptions(dynamicModels, codexConfigModel, available)

  const selectedModel = React.useMemo(
    () => canonicalModelId(model, modelOptions),
    [modelOptions, model]
  )

  // Effort support is model-specific where the provider reports it (Codex and
  // Grok both do), since a CLI's global config accepts more values than any one
  // model necessarily advertises. `PROVIDER_EFFORTS` is the provider-wide union
  // and the right fallback when the selected model says nothing.
  const isCodex = provider === 'codex'
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel)
  const supported = new Set(selectedModelOption?.supportedEfforts ?? PROVIDER_EFFORTS[provider])
  const effortOptions = EFFORT_OPTIONS.filter(
    (e) => e.id === '' || supported.has(e.id as EffortId)
  ).map((e) => (e.id === '' ? { ...e, description: `Uses your ${PROVIDER_LABELS[provider]} config` } : e))
  const invalidEffort = effort !== '' && !effortOptions.some((option) => option.id === effort)
  const effortValue = invalidEffort ? '' : effort
  // Selecting a model also restores the effort last used with it, so flipping
  // between models doesn't force the user to re-pick effort every time. Falls
  // back to leaving effort as-is when the target model has no remembered value.
  const handleModelChange = React.useCallback(
    (next: string, nextProvider: Provider) => {
      onModelChange(next, nextProvider)
      // `remember: false`: the value is already stored for this model — replaying
      // it only applies it to the chat, and must not be re-keyed to the model we
      // just switched away from.
      const remembered = rememberedEffortForModel(modelEfforts, next, modelOptions)
      if (remembered !== undefined && remembered !== effort)
        onEffortChange(remembered, { remember: false })
    },
    [onModelChange, onEffortChange, modelEfforts, modelOptions, effort]
  )
  // Capability flags only become authoritative once this provider's live
  // catalog has loaded. Static fallbacks may omit them, so keep Fast available
  // in that case rather than hiding a working option.
  const knowsFastSupport = dynamicModels.some((option) => option.provider === provider)
  const serviceTierOptions =
    knowsFastSupport && selectedModelOption?.supportsFastMode !== true
      ? SERVICE_TIER_OPTIONS.filter((tier) => tier.id === 'standard')
      : SERVICE_TIER_OPTIONS
  const invalidServiceTier = !serviceTierOptions.some((option) => option.id === serviceTier)
  const serviceTierValue = invalidServiceTier ? 'standard' : serviceTier
  // Offering Fast (above) and *getting* it are different questions: the account
  // may not allow the extra usage it bills to, or a rate limit may have paused
  // it. The live session answers the second one; until it has, say nothing.
  // Codex never answers it — its SDK surfaces no equivalent field.
  const fastStatus = useApp((s) => (s.activeId ? s.fastMode[s.activeId] : undefined))
  const fastNote = serviceTierValue === 'fast' ? fastModeNote(fastStatus) : null

  // New-chat can switch providers with an effort already selected, and a model
  // may not offer Fast. Normalize immediately so the hidden stale value cannot
  // be submitted to the SDK — but as `remember: false`, since the user didn't
  // pick these and they must not become the defaults for every future chat.
  React.useEffect(() => {
    if (invalidEffort) onEffortChange('', { remember: false })
  }, [invalidEffort, onEffortChange])
  React.useEffect(() => {
    if (invalidServiceTier) onServiceTierChange?.('standard', { remember: false })
  }, [invalidServiceTier, onServiceTierChange])
  const permissionOptions = PROVIDER_PERMISSION_MODES[provider]
  const requestedPermission = isCodex ? codexPermissionValue(permissionMode) : permissionMode
  // A chat can arrive carrying a mode this provider does not have — switching a
  // Claude chat on Accept edits over to Grok. Show what the backend will
  // actually do (its ask baseline) rather than leaving the chip blank.
  const permissionValue = permissionOptions.some((option) => option.id === requestedPermission)
    ? requestedPermission
    : 'default'
  const selectedPermissionAppearance = permissionAppearance(permissionValue, isCodex)

  const inbox = useApp((s) => s.attachmentInbox)
  React.useEffect(() => {
    if (inbox.length === 0) return
    setAttachments((prev) => {
      // Dedupe on path as well as id: the same file can be sent here more than
      // once (tree menu, repeatedly) and should stay a single chip. A canvas
      // dedupes on *its* id for the same reason — it deliberately sets no
      // `path`, and the attachment id is minted fresh on every click, so
      // without this the list button stacks a chip per press.
      const seen = new Set(prev.map((a) => a.id))
      const paths = new Set(prev.flatMap((a) => (a.path ? [a.path] : [])))
      const canvasIds = new Set(prev.flatMap((a) => (a.canvas ? [a.canvas.id] : [])))
      const fresh: Attachment[] = []
      for (const att of inbox) {
        if (seen.has(att.id) || (att.path && paths.has(att.path))) continue
        if (att.canvas && canvasIds.has(att.canvas.id)) continue
        seen.add(att.id)
        if (att.path) paths.add(att.path)
        if (att.canvas) canvasIds.add(att.canvas.id)
        fresh.push(att)
      }
      return fresh.length === 0 ? prev : [...prev, ...fresh]
    })
    useApp.getState().clearAttachmentInbox()
    ref.current?.focus()
  }, [inbox])
  const [dragOver, setDragOver] = React.useState(false)
  const dragDepth = React.useRef(0)
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // ---- @-file mentions ----
  // `atPos` is the index just after the '@' that opened the popover.
  const [mention, setMention] = React.useState<{ query: string; atPos: number } | null>(null)
  const [mentionResults, setMentionResults] = React.useState<{ rel: string; path: string }[]>([])
  const [mentionIdx, setMentionIdx] = React.useState(0)

  const updateMention = (value: string, caret: number): void => {
    if (!cwd) return
    const m = /(^|\s)@([\w./-]*)$/.exec(value.slice(0, caret))
    setMention(m ? { query: m[2], atPos: caret - m[2].length } : null)
  }

  React.useEffect(() => {
    if (!mention || !cwd) {
      setMentionResults([])
      return undefined
    }
    let alive = true
    const timer = setTimeout(() => {
      void window.api.searchFiles(cwd, mention.query).then((res) => {
        if (alive) {
          setMentionResults(res)
          setMentionIdx(0)
        }
      })
    }, 80)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mention, cwd])

  const pickMention = (r: { rel: string; path: string }): void => {
    if (!mention) return
    const el = ref.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mention.atPos) // ends with the '@'
    const next = `${before}${r.rel} ${text.slice(caret)}`
    const name = r.rel.split('/').pop() ?? r.rel
    setText(next)
    setMention(null)
    setAttachments((prev) =>
      prev.some((a) => a.path === r.path)
        ? prev
        : [...prev, { id: crypto.randomUUID(), kind: 'file', name, path: r.path }]
    )
    requestAnimationFrame(() => {
      const pos = before.length + r.rel.length + 1
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  // ---- /-slash commands ----
  // Only while typing the command name at the very start of the message (before
  // any space); once arguments begin, the menu closes.
  const [slashQuery, setSlashQuery] = React.useState<string | null>(null)
  const [slashIdx, setSlashIdx] = React.useState(0)

  const updateSlash = (value: string, caret: number): void => {
    const m = /^\/([\w:-]*)$/.exec(value.slice(0, caret))
    setSlashQuery(m ? m[1] : null)
  }

  const slashResults = React.useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const matches = (c: SlashCommand): boolean =>
      c.name.toLowerCase().includes(q) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    return commands
      .filter(matches)
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return ap - bp || a.name.localeCompare(b.name)
      })
      .slice(0, 50)
  }, [slashQuery, commands])

  React.useEffect(() => setSlashIdx(0), [slashQuery])

  const pickSlash = (c: SlashCommand | undefined): void => {
    if (!c) return
    const el = ref.current
    const caret = el?.selectionStart ?? text.length
    const commandText = `/${c.name}`
    const tail = text.slice(caret)
    // A command with no argument shape is complete when selected. Codex's TUI
    // executes `/review` on that Enter; requiring another Enter made the exact
    // command look inert, especially on the new-chat screen.
    if (!c.argumentHint && !tail.trim() && attachments.length === 0 && !locked) {
      setText('')
      setAttachError(null)
      setSlashQuery(null)
      void Promise.resolve(onSend(commandText, [])).catch(() => setText(commandText))
      return
    }
    const next = `${commandText} ${tail}`
    setText(next)
    setSlashQuery(null)
    requestAnimationFrame(() => {
      const pos = c.name.length + 2 // '/' + name + ' '
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const { attachments: added, skipped } = await toAttachments(files)
    if (added.length) setAttachments((prev) => [...prev, ...added])
    setAttachError(skipped.length ? `Skipped: ${skipped.join(', ')}` : null)
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !locked

  const submit = (): void => {
    if (!canSend) return
    const sentText = text.trim()
    const composerControl = isCodex ? codexComposerControl(sentText) : null
    if (composerControl) {
      setText('')
      setAttachError(null)
      setSlashQuery(null)
      if (composerControl === 'model') setModelSettingsOpen(true)
      else setPermissionOpen(true)
      return
    }
    const sentAttachments = attachments
    setText('')
    setAttachments([])
    setAttachError(null)
    // Starting a chat can fail (e.g. creating its worktree) — put the draft back
    // rather than silently swallowing what the user typed.
    void Promise.resolve(onSend(sentText, sentAttachments)).catch(() => {
      setText(sentText)
      setAttachments(sentAttachments)
    })
  }

  const hasFileDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  return (
    <div
      data-composer
      onDragEnter={(e) => {
        if (!hasFileDrag(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (hasFileDrag(e)) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!hasFileDrag(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        void addFiles(e.dataTransfer.files)
      }}
      className={cn(
        // The frame is shared with the sent prompt above it (`CHAT_FRAME`);
        // what is added here is only what is true of the composer alone.
        CHAT_FRAME,
        'relative transition-colors focus-within:border-ring/60',
        dragOver && 'border-primary/60 ring-2 ring-primary/25',
        locked && 'opacity-60'
      )}
    >
      {header}
      {/* /-slash command picker */}
      {slashQuery !== null && slashResults.length > 0 && (
        <div
          data-slash-popover
          className="absolute bottom-full left-3 z-30 mb-2 max-h-80 w-[440px] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
        >
          <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground/50 uppercase">
            Commands
          </div>
          {slashResults.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickSlash(c)}
              onMouseEnter={() => setSlashIdx(i)}
              className={cn(
                'flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                i === slashIdx ? 'bg-accent' : undefined
              )}
            >
              <span
                className={cn(
                  'shrink-0 font-mono text-[13px]',
                  i === slashIdx ? 'text-primary' : 'text-foreground'
                )}
              >
                /{c.name}
              </span>
              {c.argumentHint && (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
                  {c.argumentHint}
                </span>
              )}
              {c.description && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
                  {c.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* @-mention file picker */}
      {mention && mentionResults.length > 0 && (
        <div
          data-mention-popover
          className="absolute bottom-full left-3 z-30 mb-2 max-h-64 w-96 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
        >
          {mentionResults.map((r, i) => {
            const name = r.rel.split('/').pop() ?? r.rel
            const dir = r.rel.slice(0, r.rel.length - name.length).replace(/\/$/, '')
            return (
              <button
                key={r.path}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(r)}
                onMouseEnter={() => setMentionIdx(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                  i === mentionIdx ? 'bg-accent' : undefined
                )}
              >
                <FileIcon path={r.rel} />
                <span className="min-w-0 truncate text-xs">
                  <span className="text-foreground">{name}</span>
                  {dir && <span className="ml-1.5 text-muted-foreground/70">{dir}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {attachments.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-2 pt-3', CHAT_BLEED_PAD)}>
          {attachments.map((att) => (
            <AttachmentChip
              key={att.id}
              att={att}
              onRemove={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
            />
          ))}
        </div>
      )}
      {attachError && (
        <div className={cn('pt-2 text-[11px] text-warning', CHAT_BLEED_PAD)}>{attachError}</div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const caret = e.target.selectionStart ?? e.target.value.length
          updateMention(e.target.value, caret)
          updateSlash(e.target.value, caret)
        }}
        onSelect={(e) => {
          const el = e.currentTarget
          const caret = el.selectionStart ?? el.value.length
          updateMention(el.value, caret)
          updateSlash(el.value, caret)
        }}
        onBlur={() =>
          setTimeout(() => {
            setMention(null)
            setSlashQuery(null)
          }, 200)
        }
        onKeyDown={(e) => {
          if (slashQuery !== null && slashResults.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSlashIdx((i) => (i + 1) % slashResults.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSlashIdx((i) => (i - 1 + slashResults.length) % slashResults.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              // slashIdx can lag behind a shrunk result list (commands load
              // async while the menu is open) — clamp to a real entry.
              pickSlash(slashResults[slashIdx] ?? slashResults[0])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSlashQuery(null)
              return
            }
          }
          if (mention && mentionResults.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMentionIdx((i) => (i + 1) % mentionResults.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMentionIdx((i) => (i - 1 + mentionResults.length) % mentionResults.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pickMention(mentionResults[mentionIdx])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setMention(null)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length > 0) {
            e.preventDefault()
            void addFiles(e.clipboardData.files)
          }
        }}
        placeholder={
          switchingNote ?? (streaming ? 'Queue a message for when this turn ends…' : placeholder)
        }
        disabled={locked}
        rows={1}
        className={cn(
          // The horizontal padding is the composer's bleed, so the placeholder
          // and the prompt land on the same column as every assistant
          // paragraph. Anything else here and the text misses it.
          CHAT_BLEED_PAD,
          'no-drag block max-h-[220px] w-full resize-none bg-transparent pt-3.5 pb-1 text-[14px] leading-relaxed outline-none select-text placeholder:text-muted-foreground/60'
        )}
      />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <WithTooltip label="Attach images or files">
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={locked}
            aria-label="Attach files"
          >
            <Paperclip />
          </Button>
        </WithTooltip>
        {/* Model owns its related inference controls; permissions remains a
            separate safety decision. This keeps the footer compact. */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <ModelSettingsPicker
            model={selectedModel}
            onModelChange={handleModelChange}
            models={modelOptions}
            effort={effortValue}
            onEffortChange={onEffortChange}
            efforts={effortOptions}
            serviceTier={serviceTierValue}
            onServiceTierChange={onServiceTierChange}
            serviceTiers={serviceTierOptions}
            fastNote={fastNote}
            disabled={locked}
            open={modelSettingsOpen}
            onOpenChange={setModelSettingsOpen}
          />
          <CompactSelect
            value={permissionValue}
            onValueChange={(v) => onPermissionModeChange(v as PermissionModeId)}
            options={permissionOptions.map((m) => {
              const appearance = permissionAppearance(m.id, isCodex)
              return {
                value: m.id,
                label: m.label,
                description: m.description,
                icon: <appearance.Icon className={cn('size-3.5', appearance.iconClassName)} />
              }
            })}
            icon={<selectedPermissionAppearance.Icon className="size-3.5" />}
            className={cn('min-w-0', selectedPermissionAppearance.triggerClassName)}
            open={permissionOpen}
            onOpenChange={setPermissionOpen}
          />
        </div>
        <SessionPanel />
        {contextTokens != null && contextTokens > 0 && (
          <ContextRing used={contextTokens} window={contextWindow ?? 200_000} provider={provider} />
        )}
        {streaming && onStop ? (
          <WithTooltip label="Stop generating">
            <Button
              size="icon"
              variant="destructive"
              onClick={onStop}
              className="shrink-0 rounded-full [&_svg]:size-3"
              aria-label="Stop generating"
            >
              <Square className="fill-current" />
            </Button>
          </WithTooltip>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={!canSend}
            className="shrink-0 rounded-full"
            aria-label="Send message"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </Button>
        )}
      </div>
    </div>
  )
}

import * as React from 'react'
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  CornerDownRight,
  MessageSquareQuote,
  MousePointerClick,
  Plus,
  PenLine,
  Square,
  Search,
  Zap,
  X
} from 'lucide-react'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PROVIDERS,
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
import { CODEX_SLASH_COMMANDS, codexComposerControl } from '@shared/codexCommands'
import { withBtw } from '@shared/btw'
import {
  assembleModelOptions,
  canonicalModelId,
  effortOptionsFor,
  matchesModelQuery,
  modelKey,
  rememberedEffortForModel,
  rememberedServiceTierForModel,
  serviceTierOptionsFor,
  visibleModelOptions
} from '@/lib/models'
import {
  PROVIDER_PERMISSION_MODES,
  codexPermissionValue,
  permissionAppearance
} from '@/lib/permissionModes'
import { useApp } from '@/store'
import { ContextDetail } from '@/components/ContextDetail'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProviderAvatar } from '@/components/ui/provider-mark'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * How long typing pauses before the draft reaches the store. Long enough that a
 * burst of keystrokes is one write, short enough that anything but a switch made
 * mid-word is already saved before the unmount flush has to catch it.
 */
const DRAFT_DEBOUNCE_MS = 400

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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

/** Whether the chips go on one shrinking row rather than wrapping. */
function fitAttachments(attachments: Attachment[]): boolean {
  return attachments.length <= 3 && attachments.every((a) => a.kind !== 'image')
}

function AttachmentChip({
  att,
  fit = false,
  onRemove
}: {
  att: Attachment
  /** On a shared row that shrinks to fit (`fitAttachments`). */
  fit?: boolean
  onRemove: () => void
}): React.JSX.Element {
  const elementTitle =
    att.kind === 'element' && att.element
      ? [att.element.source?.file, att.element.selector].filter(Boolean).join('\n')
      : undefined
  const sel = att.kind === 'selection' ? att.selection : undefined
  const canvas = att.kind === 'canvas' ? att.canvas : undefined
  const quote = att.kind === 'quote' ? att.quote : undefined
  return (
    <div className={cn('group/att relative', fit ? 'min-w-0 shrink' : 'shrink-0')}>
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
          className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2"
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
          className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2"
        >
          <FileIcon path={sel.path} />
          <span className="truncate font-mono text-[11px]">{att.name}</span>
        </div>
      ) : quote ? (
        // A passage, not code: prose face, and the label is one flat line of it
        // (`quoteLabel`) rather than a name someone chose — which is why the
        // whole quote goes in the tooltip, where a selection puts its snippet.
        <div
          title={quote.text.slice(0, 400)}
          className="flex h-7 max-w-48 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2"
        >
          <MessageSquareQuote className="size-3.5 shrink-0 text-muted-foreground" />
          {/* In quotation marks, outside the truncation: the label is the
              passage's own words, often cut mid-word where the drag ended, and
              without them a fragment reads as a broken name. */}
          <span className="flex min-w-0 text-xs">
            <span className="text-muted-foreground">“</span>
            <span className="truncate">{att.name}</span>
            <span className="text-muted-foreground">”</span>
          </span>
        </div>
      ) : canvas ? (
        // Prose face, not mono: a canvas title is a name someone wrote, where a
        // path and a selection are code. `PenLine` is the canvas glyph
        // everywhere else in the app — the tool rows, the list, the tab.
        <div
          title={canvas.text.slice(0, 400)}
          className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2"
        >
          <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs">{att.name}</span>
        </div>
      ) : (
        <div
          title={att.path}
          className="flex h-7 max-w-44 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2"
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

function ContextRing({
  used,
  window: win,
  provider,
  chatId
}: {
  used: number
  window: number
  provider: Provider
  chatId: string | null
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
        {pct > 0.7 && <span className="text-[10px] tabular-nums">{Math.round(pct * 100)}%</span>}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64">
        <ContextDetail used={used} window={win} name={name} chatId={chatId} />
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
  compact = false,
  open: controlledOpen,
  onOpenChange,
  permission,
  permissionOpen: controlledPermissionOpen,
  onPermissionOpenChange
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
  /**
   * The model's name alone — for the folded composer, where the chip shares one
   * line with the input. The effort and Fast stay one click away in the popover.
   */
  compact?: boolean
  /** Controlled by Composer so `/model` can open the existing native picker. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * What the agent may do, as a third row beside Reasoning and Speed — one
   * control for everything about the turn, rather than a second picker on the
   * bar. Its icon rides the trigger whenever it is not the ask baseline.
   */
  permission?: {
    value: PermissionModeId
    options: { id: PermissionModeId; label: string; description: string }[]
    onChange: (mode: PermissionModeId) => void
    isCodex: boolean
  }
  /** Controlled so `/permissions` can open the picker straight onto that row. */
  permissionOpen?: boolean
  onPermissionOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // The keyboard's row in the filtered list; the mouse moves it too, so the
  // highlight is always the row Enter would pick.
  const [active, setActive] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [effortOpen, setEffortOpen] = React.useState(false)
  const [speedOpen, setSpeedOpen] = React.useState(false)
  const [uncontrolledPermissionOpen, setUncontrolledPermissionOpen] = React.useState(false)
  const permissionMenuOpen = controlledPermissionOpen ?? uncontrolledPermissionOpen
  const setPermissionMenuOpen = (next: boolean): void => {
    if (controlledPermissionOpen === undefined) setUncontrolledPermissionOpen(next)
    onPermissionOpenChange?.(next)
  }
  const permissionLook = permission
    ? permissionAppearance(permission.value, permission.isCodex)
    : undefined
  const selectedPermission = permission?.options.find((o) => o.id === permission.value)
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
  // The live list names the resolved model better than any static table when
  // it carries a row for it (Antigravity's Default → "Gemini 3.8 Flash (High)").
  const resolvedRow = selected?.resolvedModel
    ? models.find(
        (option) => option.id === selected.resolvedModel && option.provider === selected.provider
      )
    : undefined
  const selectedName =
    resolvedRow?.label ??
    resolvedModelName(selected?.resolvedModel) ??
    selected?.label ??
    // Before a live-only catalog (Grok, Antigravity) arrives, a remembered
    // Default row is still in the static table under its own name.
    MODEL_OPTIONS.find((option) => option.id === model)?.label ??
    model
  const selectedEffort = efforts.find((option) => option.id === effort)
  const selectedTier = serviceTiers.find((option) => option.id === serviceTier)
  const groups = PROVIDERS
    .map((group) => ({
      group,
      models: models.filter(
        (option) => option.provider === group && matchesModelQuery(option, query)
      )
    }))
    .filter(({ models: options }) => options.length > 0)
  // The rows in the order they are drawn, for the arrow keys. Disabled rows are
  // drawn but never landed on.
  const flat = groups.flatMap(({ models: options }) => options).filter((o) => !o.disabled)
  const activeOption = flat[Math.min(active, flat.length - 1)]
  const pick = (option: ModelOption): void => {
    onModelChange(option.id, option.provider)
    setOpen(false)
  }
  // Every open starts on a clear search, at the selected model — keyed on
  // `open` rather than done in `onOpenChange`, since `/model` opens it too.
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    const at = models
      .filter((o) => !o.disabled)
      .sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider))
      .findIndex((o) => o.id === model)
    setActive(Math.max(0, at))
    // Only the moment of opening; the list changing under an open menu must
    // not throw away what is being typed.
  }, [open])
  React.useEffect(() => {
    if (!activeOption) return
    listRef.current
      ?.querySelector(`[data-model-key="${CSS.escape(modelKey(activeOption.provider, activeOption.id))}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeOption])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setEffortOpen(false)
          setSpeedOpen(false)
          setPermissionMenuOpen(false)
          setQuery('')
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        title={fastNote ?? undefined}
        aria-label={`${selectedName}, ${selectedEffort?.label ?? effort}${
          serviceTier === 'fast' ? (fastNote ? `, Fast unavailable: ${fastNote}` : ', Fast') : ''
        }${selectedPermission ? `, ${selectedPermission.label}` : ''}`}
        className="no-drag inline-flex h-7 min-w-0 max-w-full select-none items-center gap-1 overflow-hidden rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground disabled:opacity-50"
      >
        <span className="max-w-32 truncate text-foreground">{selectedName}</span>
        {/* The effort is the first thing a narrow column gives up: the model
            name says which backend answers, and the popover still shows both. */}
        {!compact && efforts.length > 1 && (
          <>
            <span className="shrink-0 font-normal @max-[400px]:hidden">
              {selectedEffort?.label ?? effort}
            </span>
          </>
        )}
        {serviceTier === 'fast' && !compact && (
          <>
            <span className="shrink-0 text-muted-foreground/50 @max-[400px]:hidden">·</span>
            {/* Struck through, not hidden: Fast is still what's selected — the
                provider just isn't serving it, and silently showing Standard
                would make the picker look broken. */}
            <span
              className={cn(
                'shrink-0 @max-[400px]:hidden',
                fastNote ? 'text-muted-foreground/60 line-through' : 'text-violet-400'
              )}
            >
              Fast
            </span>
          </>
        )}
        {/* Ask is the baseline and says nothing; any mode that lets the agent
            do more, or plans instead of acting, keeps its coloured mark here
            in every shape, the one-line one included. */}
        {permissionLook && permission?.value !== 'default' && (
          <permissionLook.Icon
            className={cn('ml-0.5 size-3.5 shrink-0', permissionLook.iconClassName)}
          />
        )}
      </PopoverTrigger>
      {/* w-80, not w-72: the Default row carries a label, the model it resolves
          to, and a context badge, which truncates the label at the narrower width. */}
      <PopoverContent
        side="top"
        align="start"
        className="w-80 overflow-hidden p-0"
        initialFocus={searchRef}
      >
        {/* Outside the scrolling list, so it stays put while the list moves. */}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!flat.length) return
                const step = e.key === 'ArrowDown' ? 1 : -1
                setActive((i) => (Math.min(i, flat.length - 1) + step + flat.length) % flat.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (activeOption) pick(activeOption)
              }
            }}
            placeholder="Search models"
            aria-label="Search models"
            spellCheck={false}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/* px-1 with no *top* padding: the headers are sticky, and a padded
            scrollport is a band above the pinned header that rows scroll
            through in plain sight. The first header's own pt-2 replaces it. */}
        <div ref={listRef} className="max-h-72 overflow-y-auto px-1 pb-1">
          {groups.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No models match “{query.trim()}”
            </div>
          )}
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
                    data-model-key={modelKey(option.provider, option.id)}
                    onMouseEnter={() => {
                      setEffortOpen(false)
                      setSpeedOpen(false)
                      const at = flat.indexOf(option)
                      if (at >= 0) setActive(at)
                    }}
                    onClick={() => pick(option)}
                    className={cn(
                      'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:bg-accent disabled:opacity-45',
                      option === activeOption && 'bg-accent'
                    )}
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

        {/* A provider whose effort lives in the model id (Antigravity's
            `…-high` rows) has only the Default row here, and a menu of one
            choice is not a choice. */}
        {(efforts.length > 1 || onServiceTierChange || permission) && (
          <div className="border-t border-border p-1">
            {efforts.length > 1 && (
              <Popover open={effortOpen} onOpenChange={setEffortOpen}>
                <PopoverTrigger
                  onMouseEnter={() => {
                    setSpeedOpen(false)
                    setPermissionMenuOpen(false)
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
            )}

            {onServiceTierChange && (
              <Popover open={speedOpen} onOpenChange={setSpeedOpen}>
                <PopoverTrigger
                  onMouseEnter={() => {
                    setEffortOpen(false)
                    setPermissionMenuOpen(false)
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

            {permission && permissionLook && (
              <Popover open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen}>
                <PopoverTrigger
                  onMouseEnter={() => {
                    setEffortOpen(false)
                    setSpeedOpen(false)
                    setPermissionMenuOpen(true)
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[popup-open]:bg-accent"
                >
                  <permissionLook.Icon className={cn('size-3.5', permissionLook.iconClassName)} />
                  <span className="flex-1 text-left">Permissions</span>
                  <span className="text-xs text-muted-foreground">
                    {selectedPermission?.label ?? permission.value}
                  </span>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </PopoverTrigger>
                <PopoverContent side="right" align="end" className="w-64 p-1">
                  {permission.options.map((option) => {
                    const look = permissionAppearance(option.id, permission.isCodex)
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={option.id === permission.value}
                        onClick={() => {
                          permission.onChange(option.id)
                          setPermissionMenuOpen(false)
                          setOpen(false)
                        }}
                        className="flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                      >
                        <look.Icon className={cn('mt-0.5 size-3.5 shrink-0', look.iconClassName)} />
                        <span className="flex min-w-0 flex-1 flex-col text-left">
                          <span className="truncate">{option.label}</span>
                          <span className="text-[11px] leading-snug text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                        {option.id === permission.value && (
                          <Check className="mt-0.5 size-3.5 shrink-0" />
                        )}
                      </button>
                    )
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}
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
  modelServiceTiers,
  serviceTier = 'standard',
  onServiceTierChange,
  permissionMode,
  onPermissionModeChange,
  contextTokens,
  contextWindow,
  provider = 'claude',
  chatId = null,
  cwd = null,
  commands = [],
  disabled = false,
  switchingNote,
  placeholder = 'Ask Claude Code anything…',
  autoFocus = true,
  draft,
  onDraftChange,
  clearToken = 0,
  header,
  collapsible = false,
  floating = false,
  submitLabel
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
  /** Last speed chosen per model; selecting a model restores it, else Standard. */
  modelServiceTiers?: Record<string, ServiceTier>
  serviceTier?: ServiceTier
  onServiceTierChange?: (serviceTier: ServiceTier, opts?: { remember?: boolean }) => void
  permissionMode: PermissionModeId
  onPermissionModeChange: (mode: PermissionModeId) => void
  contextTokens?: number
  contextWindow?: number
  /** Which agent backs this chat; switches the pickers/labels to its reality. */
  provider?: Provider
  /**
   * The chat this composer belongs to. Null on the home screen, where no chat
   * exists yet.
   *
   * Everything else here arrives as a prop, which is what made this component
   * reusable for a side chat almost unchanged — but three reads went to the
   * store for the *active* chat's answer, and a side chat is never the active
   * one. Passing the id is what keeps a side chat's Fast reading, its context
   * breakdown and the attachment inbox pointing at the right conversation.
   */
  chatId?: string | null
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
  /**
   * Fold down to its input line while nothing is being written here: several
   * chats share the screen, and four composers at full height took a third of
   * each column. See `collapsed` below for what counts as writing.
   */
  collapsible?: boolean
  /** Drawn over the transcript, which scrolls under it: the frame goes translucent. */
  floating?: boolean
  /**
   * Words on the send button instead of the arrow, for a composer whose send
   * is not a message — the Scheduled page's, where it saves the task.
   */
  submitLabel?: string
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
  // Settings → Models trims the menu; the chat's own model always stays in it.
  const hiddenModels = useApp((s) => s.defaults?.hiddenModels)
  const pickerModels = React.useMemo(
    () => visibleModelOptions(modelOptions, hiddenModels, [selectedModel]),
    [modelOptions, hiddenModels, selectedModel]
  )

  const isCodex = provider === 'codex'
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel)
  const effortOptions = effortOptionsFor(selectedModelOption, provider)
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
      // Speed has no fallback to carry: Fast was picked for the model being
      // left, so a model with no remembered tier starts Standard.
      const tier =
        rememberedServiceTierForModel(modelServiceTiers, next, modelOptions) ?? 'standard'
      if (tier !== serviceTier) onServiceTierChange?.(tier, { remember: false })
    },
    [
      onModelChange,
      onEffortChange,
      onServiceTierChange,
      modelEfforts,
      modelServiceTiers,
      modelOptions,
      effort,
      serviceTier
    ]
  )
  const serviceTierOptions = serviceTierOptionsFor(selectedModelOption, provider, dynamicModels)
  const invalidServiceTier = !serviceTierOptions.some((option) => option.id === serviceTier)
  const serviceTierValue = invalidServiceTier ? 'standard' : serviceTier
  // Offering Fast (above) and *getting* it are different questions: the account
  // may not allow the extra usage it bills to, or a rate limit may have paused
  // it. The live session answers the second one; until it has, say nothing.
  // Codex never answers it — its SDK surfaces no equivalent field.
  const fastStatus = useApp((s) => (chatId ? s.fastMode[chatId] : undefined))
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

  // The inbox is app-global — one queue fed by the editor's "Add to chat" pill,
  // the canvas list, the browser's element picker and the transcript's quote
  // bar — so with several composers mounted the first effect to run would
  // consume whatever was in it. An entry goes to the **focused** column's
  // composer: the panel those gestures are made in is shared by the whole
  // thread, and the column you were last in is the one you are adding context
  // to. An entry that names a chat goes to *that* one however long its column
  // takes to arrive, which is the case focus cannot answer — see
  // `attachmentInbox`.
  const isFocusedComposer = useApp((s) => !!chatId && s.focusedChatId === chatId)
  const inbox = useApp((s) => s.attachmentInbox)
  React.useEffect(() => {
    if (inbox.length === 0) return
    const mine = inbox.filter((e) => (e.to ? e.to === chatId : isFocusedComposer)).map((e) => e.att)
    if (mine.length === 0) return
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
      for (const att of mine) {
        if (seen.has(att.id) || (att.path && paths.has(att.path))) continue
        if (att.canvas && canvasIds.has(att.canvas.id)) continue
        seen.add(att.id)
        if (att.path) paths.add(att.path)
        if (att.canvas) canvasIds.add(att.canvas.id)
        fresh.push(att)
      }
      return fresh.length === 0 ? prev : [...prev, ...fresh]
    })
    useApp.getState().takeAttachments(mine.map((a) => a.id))
    ref.current?.focus()
  }, [isFocusedComposer, inbox, chatId])
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
  // The shared command cache can still belong to another provider after a
  // model switch, or to another column in a side-chat thread. Codex's native
  // commands are fixed: use this composer's provider rather than that cache,
  // so Enter on /review cannot select a Claude command such as /code-review.
  // `/btw` is Carbon's own and every provider's, so it joins here rather than
  // in a provider's list — but only beside a conversation to ask about.
  const slashCommands = React.useMemo(() => {
    const own = isCodex ? CODEX_SLASH_COMMANDS : commands
    return chatId ? withBtw(own) : own
  }, [isCodex, commands, chatId])

  const updateSlash = (value: string, caret: number): void => {
    const m = /^\/([\w:-]*)$/.exec(value.slice(0, caret))
    setSlashQuery(m ? m[1] : null)
  }

  const slashResults = React.useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const matches = (c: SlashCommand): boolean =>
      c.name.toLowerCase().includes(q) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    return slashCommands
      .filter(matches)
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return ap - bp || a.name.localeCompare(b.name)
      })
      .slice(0, 50)
  }, [slashQuery, slashCommands])

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
      setModelSettingsOpen(true)
      if (composerControl !== 'model') setPermissionOpen(true)
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

  // ---- Collapsing ----
  // Folded, the composer is one line: the input, and beside it the model and
  // permission pickers, attach, context and send. Engaged (the full composer)
  // from the moment the *input* takes focus or a click, until focus or a click
  // lands outside the composer; a popup it opened portals out of it, so a click
  // in one still counts as inside. Only the input engages it: the pickers and
  // buttons work folded, so using them must not move them under the pointer.
  // Folded only while there is nothing to lose sight of: no text, no
  // attachments, no slash or mention menu.
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [engaged, setEngaged] = React.useState(false)
  React.useEffect(() => {
    if (!engaged) return
    const leave = (e: Event): void => {
      const target = e.target instanceof Element ? e.target : null
      if (!target || rootRef.current?.contains(target)) return
      if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return
      setEngaged(false)
    }
    document.addEventListener('pointerdown', leave, true)
    document.addEventListener('focusin', leave, true)
    return () => {
      document.removeEventListener('pointerdown', leave, true)
      document.removeEventListener('focusin', leave, true)
    }
  }, [engaged])
  const collapsed =
    collapsible &&
    !engaged &&
    !dragOver &&
    text.trim() === '' &&
    attachments.length === 0 &&
    slashQuery === null &&
    mention === null
  const engage = (): void => setEngaged(true)
  // One line only while the input is not in use: the input and the toolbar
  // share a row — the folded shape, without the folding. Focus or a click in
  // the input opens it (`engaged`, the fold's own notion of in use), as does a
  // draft that has outgrown the line, a line break or a chip. A long draft is
  // sticky until the input empties, so deleting back under the edge does not
  // flip the layout under the caret on every keystroke.
  const [stacked, setStacked] = React.useState(false)
  const inline =
    collapsed || (!engaged && !stacked && attachments.length === 0 && !text.includes('\n'))

  // The provider's own guess at the next message (Claude's and Grok's): a chip
  // at the head of the empty composer, taken by Tab or a click into the input
  // to send or edit. It was the input's placeholder first, and read as one —
  // grey text in an empty box is what every placeholder is, so nobody saw it.
  // Folded, there is no room for a row, and the placeholder is all there is.
  // Anything typed, a live turn or a pending switch hides it.
  const suggestion = useApp((s) => (chatId ? s.suggestions[chatId] : undefined))
  const hasBtw = useApp((s) => !!(chatId && s.btw[chatId]?.length))
  const dismissBtw = useApp((s) => s.dismissBtw)
  const ghost =
    suggestion && !streaming && !locked && !switchingNote && text === '' && attachments.length === 0
      ? suggestion
      : undefined
  const takeSuggestion = (): void => {
    if (!ghost) return
    setText(ghost)
    requestAnimationFrame(() => {
      const el = ref.current
      el?.focus()
      el?.setSelectionRange(ghost.length, ghost.length)
      fitInput()
    })
  }
  const inputPlaceholder =
    switchingNote ??
    (streaming ? 'Queue a message for when this turn ends…' : ((collapsed ? ghost : undefined) ?? placeholder))
  const fitInput = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    // A scrollbar only at the cap: `scrollHeight` is rounded, and three lines
    // of a 22.75px line-height overflow the height it reports by a fraction —
    // enough to draw a full-length track beside text that fits.
    el.style.overflowY = el.scrollHeight > 220 ? 'auto' : 'hidden'
  }, [])
  // Folding changes the input's padding and wrapping, and an empty input is as
  // tall as its placeholder wraps, so all three are measured again rather than
  // kept from the previous shape.
  React.useLayoutEffect(fitInput, [fitInput, text, inline, inputPlaceholder])
  // Read after the input is fitted: on one line it does not wrap, so a draft
  // that has outgrown the line is one wider than the box.
  React.useLayoutEffect(() => {
    if (text === '') {
      if (stacked) setStacked(false)
      return
    }
    const el = ref.current
    if (el && inline && !collapsed && el.scrollWidth > el.clientWidth + 1) setStacked(true)
  }, [text, inline, collapsed, stacked])
  // So is a change of width — the panel, the sidebar, a thread column, the
  // window. Measured only on text changes, an input sized while its column was
  // narrow (a wrapped placeholder, a long draft) kept that height after the
  // column widened: an empty composer four lines tall.
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      // fitInput's own height write fires this too; only a width change counts.
      if (el.clientWidth === width) return
      width = el.clientWidth
      fitInput()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitInput])

  // The fold is one frame changing shape — a line becoming a textarea over a
  // toolbar — which no CSS transition can interpolate. So the frame's height
  // is animated from what it was to what it now is (the previous render's
  // height is recorded by the effect below it), clipped while it moves, and the
  // toolbar fades into its new place.
  const frameRef = React.useRef<HTMLDivElement>(null)
  const barRef = React.useRef<HTMLDivElement>(null)
  const lastHeight = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    const el = frameRef.current
    const from = lastHeight.current
    if (!el || from === null) return
    const to = el.getBoundingClientRect().height
    if (Math.abs(to - from) < 1) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.style.overflow = 'hidden'
    const grow = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 220,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
    })
    barRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
    const release = (): void => {
      el.style.overflow = ''
    }
    grow.onfinish = release
    grow.oncancel = release
    // Only the change of shape animates — the fold, and the line becoming a box.
  }, [inline])
  React.useLayoutEffect(() => {
    lastHeight.current = frameRef.current?.getBoundingClientRect().height ?? null
  })

  const fileInput = (
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
  )
  const attachButton = (
    <WithTooltip label="Attach images or files">
      <Button
        size="icon-sm"
        variant="ghost"
        // First in every shape: on one line it leads the row, ahead of the
        // input; open, it leads the toolbar under it.
        className={cn('shrink-0 text-muted-foreground', inline && 'ml-1.5')}
        onClick={() => fileInputRef.current?.click()}
        disabled={locked}
        aria-label="Attach files"
      >
        <Plus />
      </Button>
    </WithTooltip>
  )
  // Model owns its related inference controls; permissions remains a separate
  // safety decision. This keeps the footer compact.
  const modelPicker = (
    <ModelSettingsPicker
      model={selectedModel}
      onModelChange={handleModelChange}
      models={pickerModels}
      effort={effortValue}
      onEffortChange={onEffortChange}
      efforts={effortOptions}
      serviceTier={serviceTierValue}
      onServiceTierChange={onServiceTierChange}
      serviceTiers={serviceTierOptions}
      fastNote={fastNote}
      disabled={locked}
      compact={inline}
      open={modelSettingsOpen}
      onOpenChange={setModelSettingsOpen}
      permission={{
        value: permissionValue,
        options: permissionOptions,
        onChange: onPermissionModeChange,
        isCodex
      }}
      permissionOpen={permissionOpen}
      onPermissionOpenChange={setPermissionOpen}
    />
  )
  const contextRing =
    contextTokens != null && contextTokens > 0 ? (
      <div className={cn('flex shrink-0', inline && 'order-1')}>
        <ContextRing
          used={contextTokens}
          window={contextWindow ?? 200_000}
          provider={provider}
          chatId={chatId}
        />
      </div>
    ) : null
  const sendButton =
    streaming && onStop ? (
      <WithTooltip label="Stop generating">
        <Button
          size="icon-sm"
          variant="destructive"
          onClick={onStop}
          className={cn('size-8 shrink-0 rounded-full [&_svg]:size-3', inline && 'order-2')}
          aria-label="Stop generating"
        >
          <Square className="fill-current" />
        </Button>
      </WithTooltip>
    ) : submitLabel ? (
      <Button
        size="sm"
        onClick={submit}
        disabled={!canSend}
        className={cn('h-7 shrink-0 rounded-full px-3', inline && 'order-2')}
      >
        {submitLabel}
      </Button>
    ) : (
      <Button
        size="icon-sm"
        onClick={submit}
        disabled={!canSend}
        className={cn('size-8 shrink-0 rounded-full', inline && 'order-2')}
        aria-label="Send message"
      >
        <ArrowUp className="size-4" strokeWidth={2.5} />
      </Button>
    )

  return (
    <div ref={rootRef}>
      {fileInput}
      <div
        ref={frameRef}
        data-composer
        data-collapsed={collapsed || undefined}
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
          // Over the transcript, the frame lets it through — blurred, so the
          // words passing under it never compete with the ones being typed.
          floating && 'bg-card/60 backdrop-blur-md backdrop-saturate-150',
          // A wrapping row, so folding is only a change of basis: folded, the
          // input and the toolbar share one line; open, each takes its own.
          // The container is the frame, since a content-sized toolbar cannot
          // be one (inline-size containment would collapse it to nothing).
          '@container relative flex flex-wrap items-center transition-colors focus-within:border-ring/60',
          dragOver && 'border-primary/60 ring-2 ring-primary/25',
          locked && 'opacity-60'
        )}
      >
        {header !== undefined && <div className="min-w-0 basis-full">{header}</div>}
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
          <div
            className={cn(
              'flex min-w-0 basis-full items-center gap-1.5 pt-3',
              // A few text chips share one row and shrink to fit it — their
              // labels truncate, and a second row of them pushed the input
              // down for three short quotes. Images and longer sets wrap.
              fitAttachments(attachments) ? 'flex-nowrap' : 'flex-wrap',
              CHAT_BLEED_PAD
            )}
          >
            {attachments.map((att) => (
              <AttachmentChip
                key={att.id}
                att={att}
                fit={fitAttachments(attachments)}
                onRemove={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
              />
            ))}
          </div>
        )}
        {attachError && (
          <div className={cn('basis-full pt-2 text-[11px] text-warning', CHAT_BLEED_PAD)}>{attachError}</div>
        )}
        {ghost && !collapsed && (
          <div className={cn('basis-full pt-3', CHAT_BLEED_PAD)}>
            <button
              type="button"
              data-suggestion
              onMouseDown={(e) => e.preventDefault()}
              onClick={takeSuggestion}
              title="Suggested reply — Tab to use it"
              className="inline-flex max-w-full animate-enter items-center gap-2 rounded-lg border border-border bg-secondary/60 py-1 pr-1.5 pl-2.5 text-[13px] text-foreground transition-colors hover:bg-accent"
            >
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{ghost}</span>
              <kbd className="shrink-0 rounded border border-border bg-background px-1 font-sans text-[10.5px] text-muted-foreground">
                Tab
              </kbd>
            </button>
          </div>
        )}
        {/* Outside the toolbar while on one line, since the toolbar sits after
            the input there and this belongs before it. A stateless button, so
            moving it between the two places costs nothing. */}
        {inline && attachButton}
        <textarea
          ref={ref}
          onFocus={engage}
          onPointerDown={engage}
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
            // An open `/btw` card closes before anything under it answers the
            // key: it is the newest thing on screen, and the one Escape leaves
            // no trace of. Only from an empty input, which a draft never is.
            if (e.key === 'Escape' && chatId && hasBtw && text === '' && attachments.length === 0) {
              e.preventDefault()
              dismissBtw(chatId)
              return
            }
            if (e.key === 'Tab' && !e.shiftKey && ghost) {
              e.preventDefault()
              takeSuggestion()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          // Named, because "the composer's input" stopped being answerable by
          // `closest('[data-composer]')` the moment the review picker moved
          // inside this box: its custom-instructions textarea is in there too,
          // and `keyMayAnswer` would have read an empty one as an empty message
          // and let Enter allow the permission underneath it.
          data-composer-input
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault()
              void addFiles(e.clipboardData.files)
            }
          }}
          placeholder={inputPlaceholder}
          disabled={locked}
          rows={1}
          className={cn(
            // The horizontal padding is the composer's bleed, so the placeholder
            // and the prompt land on the same column as every assistant
            // paragraph. Anything else here and the text misses it.
            CHAT_BLEED_PAD,
            'no-drag block max-h-[220px] w-full resize-none bg-transparent text-[14px] leading-relaxed outline-none select-text placeholder:text-muted-foreground/60',
            // On one line the placeholder stays on it: a column-width input
            // wrapped "Queue a message for when this turn ends…" onto a second.
            inline
              ? 'min-w-0 flex-1 basis-0 overflow-hidden py-2.5 pl-1.5 whitespace-nowrap placeholder:text-ellipsis'
              : 'basis-full pt-3.5 pb-1.5'
          )}
        />
        {/* One toolbar in both shapes, so nothing remounts when the composer
            folds: open, a row of its own under the input; folded, sized to its
            content at the end of the input's line. */}
        <div
          ref={barRef}
          data-composer-bar
          className={cn(
            'flex items-center gap-0.5',
            inline ? 'flex-none pr-1.5' : 'basis-full px-2 pb-2'
          )}
        >
          {/* Attach alone on the left; the settings for the turn sit with the
              send they apply to. */}
          {!inline && attachButton}
          <div
            className={cn(
              'flex min-w-0 items-center gap-0.5',
              inline ? 'flex-none' : 'flex-1 justify-end'
            )}
          >
            {modelPicker}
          </div>
          {contextRing}
          {sendButton}
        </div>
      </div>
    </div>
  )
}

import * as React from 'react'
import {
  ArrowUp,
  Brain,
  FileText,
  MousePointerClick,
  Paperclip,
  Shield,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  PROVIDER_LABELS,
  type Attachment,
  type EffortId,
  type PermissionModeId,
  type Provider,
  type SlashCommand
} from '@shared/types'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { CompactSelect } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WithTooltip } from '@/components/ui/tooltip'
import { SessionPanel } from '@/components/SessionPanel'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// Codex runs non-interactively (its SDK has no per-tool approval callback), so
// most Codex permission choices are sandbox policies rather than Claude-style
// approval modes. Plan combines a planning collaboration instruction with the
// read-only sandbox; the other two map directly to Codex sandbox policies.
const CODEX_PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan mode', description: 'Investigates and plans without making changes' },
  { id: 'default', label: 'Workspace write', description: 'Edits within the project — Codex won’t prompt' },
  { id: 'bypassPermissions', label: 'Full access', description: 'No sandbox — use with care' }
]

/** Collapse Codex's equivalent modes (accept-edits / auto) onto 'workspace write'. */
function codexPermissionValue(mode: PermissionModeId): PermissionModeId {
  return mode === 'plan' || mode === 'bypassPermissions' ? mode : 'default'
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
      ) : (
        <div
          title={att.path}
          className="flex h-8 max-w-44 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
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

function ContextRing({
  used,
  window: win,
  provider
}: {
  used: number
  window: number
  provider: Provider
}): React.JSX.Element {
  const name = provider === 'codex' ? 'Codex' : 'Claude'
  const pct = Math.min(1, used / win)
  const left = Math.max(0, win - used)
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Context window usage"
        className={cn(
          'no-drag flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-accent data-[popup-open]:bg-accent',
          pct > 0.9
            ? 'text-destructive'
            : pct > 0.7
              ? 'text-amber-500'
              : 'text-muted-foreground'
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
          <span>{fmtTokens(used)} used</span>
          <span>{fmtTokens(left)} free of {fmtTokens(win)}</span>
        </div>
        <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          How much of the conversation {name} can hold at once. When it fills up, older
          messages are compacted automatically so the chat can continue.
        </p>
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
  permissionMode,
  onPermissionModeChange,
  contextTokens,
  contextWindow,
  provider = 'claude',
  lockProvider = false,
  cwd = null,
  commands = [],
  disabled = false,
  placeholder = 'Ask Claude Code anything…',
  autoFocus = true
}: {
  onSend: (text: string, attachments: Attachment[]) => void
  streaming?: boolean
  onStop?: () => void
  model: string
  onModelChange: (model: string) => void
  effort: EffortId | ''
  onEffortChange: (effort: EffortId | '') => void
  permissionMode: PermissionModeId
  onPermissionModeChange: (mode: PermissionModeId) => void
  contextTokens?: number
  contextWindow?: number
  /** Which agent backs this chat; switches the pickers/labels to its reality. */
  provider?: Provider
  /**
   * Lock the model picker to `provider`'s models (an existing chat). Provider is
   * a create-time choice — switching it mid-chat would silently drop the
   * conversation context, since the two backends don't share sessions. New-chat
   * screens leave this false so either provider can be chosen up front.
   */
  lockProvider?: boolean
  /** Project folder used for @-file mentions; null disables them. */
  cwd?: string | null
  /** Slash commands available in this project, for the / autocomplete. */
  commands?: SlashCommand[]
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [attachError, setAttachError] = React.useState<string | null>(null)

  // Attachments handed in from elsewhere (e.g. an element picked in the browser
  // preview) land in a store inbox; pull them into the composer and clear it.
  // Models reported by the live session, when loaded; otherwise the static list.
  // The dynamic list already includes its own "Default" row (normalized to the
  // empty id in main), so use it as-is and just append the non-Claude (Codex)
  // placeholders the static list carries.
  const dynamicModels = useApp((s) => s.models)
  const allModelOptions =
    dynamicModels.length > 0
      ? [...dynamicModels, ...MODEL_OPTIONS.filter((m) => m.provider !== 'claude')]
      : MODEL_OPTIONS
  // An existing chat only offers its own provider's models — provider is fixed
  // once the chat is created (see the lockProvider doc).
  const modelOptions = lockProvider
    ? allModelOptions.filter((m) => m.provider === provider)
    : allModelOptions

  // A chat pinned to an older static id (e.g. 'claude-sonnet-5') won't equal the
  // SDK's alias value ('sonnet'), so resolve it to the covering row (matching on
  // `resolvedModel`, ignoring the '[1m]' suffix) to keep the picker highlighted.
  const canonModel = (s?: string): string => (s ?? '').replace(/\[1m\]$/i, '')
  const selectedModel = React.useMemo(() => {
    if (modelOptions.some((o) => o.id === model)) return model
    const match = modelOptions.find(
      (o) =>
        o.id !== '' &&
        (canonModel(o.id) === canonModel(model) ||
          canonModel(o.resolvedModel) === canonModel(model))
    )
    return match ? match.id : model
  }, [modelOptions, model])

  // Codex effort support is model-specific. The CLI's global config accepts
  // more values than any one model necessarily advertises, so do not build this
  // menu from the provider-wide SDK union.
  const isCodex = provider === 'codex'
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel)
  const codexEfforts = new Set(
    selectedModelOption?.supportedEfforts ?? ['low', 'medium', 'high', 'xhigh']
  )
  const effortOptions = isCodex
    ? EFFORT_OPTIONS.filter((e) => e.id === '' || codexEfforts.has(e.id as EffortId)).map((e) =>
        e.id === '' ? { ...e, description: 'Uses your Codex config' } : e
      )
    : EFFORT_OPTIONS.filter((e) => e.id !== 'minimal' && e.id !== 'ultra').map((e) =>
        e.id === '' ? { ...e, description: 'Uses your Claude Code config' } : e
      )
  const invalidEffort = effort !== '' && !effortOptions.some((option) => option.id === effort)
  const effortValue = invalidEffort ? '' : effort

  // New-chat can switch providers with an effort already selected. Normalize
  // immediately so the hidden stale value cannot be submitted to the other SDK.
  React.useEffect(() => {
    if (invalidEffort) onEffortChange('')
  }, [invalidEffort, onEffortChange])
  const permissionOptions = isCodex ? CODEX_PERMISSION_MODES : PERMISSION_MODES
  const permissionValue = isCodex ? codexPermissionValue(permissionMode) : permissionMode

  const inbox = useApp((s) => s.attachmentInbox)
  React.useEffect(() => {
    if (inbox.length === 0) return
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.id))
      return [...prev, ...inbox.filter((a) => !seen.has(a.id))]
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
    const next = `/${c.name} ${text.slice(caret)}`
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

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled

  const submit = (): void => {
    if (!canSend) return
    onSend(text.trim(), attachments)
    setText('')
    setAttachments([])
    setAttachError(null)
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
        'relative rounded-2xl border border-border bg-card shadow-lg shadow-black/5 transition-colors focus-within:border-ring/60 dark:shadow-black/20',
        dragOver && 'border-primary/60 ring-2 ring-primary/25',
        disabled && 'opacity-60'
      )}
    >
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
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
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
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
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
        <div className="px-4 pt-2 text-[11px] text-warning">{attachError}</div>
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
        placeholder={streaming ? 'Queue a message for when this turn ends…' : placeholder}
        disabled={disabled}
        rows={1}
        className="no-drag block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none select-text placeholder:text-muted-foreground/60"
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
            disabled={disabled}
            aria-label="Attach files"
          >
            <Paperclip />
          </Button>
        </WithTooltip>
        {/* The selects share the slack and truncate first, so the ring and
            send button never get pushed out of the box on a narrow column. */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <CompactSelect
            value={selectedModel}
            onValueChange={onModelChange}
            options={modelOptions.map((m) => ({
              value: m.id,
              label: m.label,
              description: m.description,
              group: PROVIDER_LABELS[m.provider],
              disabled: m.disabled
            }))}
            icon={<Sparkles className="size-3" />}
            className="min-w-0"
          />
          <CompactSelect
            value={effortValue}
            onValueChange={(v) => onEffortChange(v as EffortId | '')}
            options={effortOptions.map((e) => ({
              value: e.id,
              label: e.label,
              description: e.description
            }))}
            icon={<Brain className="size-3" />}
            className="min-w-0"
          />
          <CompactSelect
            value={permissionValue}
            onValueChange={(v) => onPermissionModeChange(v as PermissionModeId)}
            options={permissionOptions.map((m) => ({
              value: m.id,
              label: m.label,
              description: m.description
            }))}
            icon={<Shield className="size-3" />}
            className="min-w-0"
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

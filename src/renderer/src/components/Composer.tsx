import * as React from 'react'
import { ArrowUp, Brain, FileText, Paperclip, Shield, Sparkles, Square, X } from 'lucide-react'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  PROVIDER_LABELS,
  type Attachment,
  type EffortId,
  type PermissionModeId
} from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CompactSelect } from '@/components/ui/select'
import { WithTooltip } from '@/components/ui/tooltip'

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

function AttachmentChip({
  att,
  onRemove
}: {
  att: Attachment
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="group/att relative shrink-0">
      {att.kind === 'image' ? (
        <img
          src={`data:${att.mediaType};base64,${att.data}`}
          alt={att.name}
          title={att.name}
          className="h-14 w-14 rounded-lg border border-border object-cover"
        />
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

function ContextRing({ used, window }: { used: number; window: number }): React.JSX.Element {
  const pct = Math.min(1, used / window)
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <WithTooltip
      label={`Context: ${fmtTokens(used)} of ${fmtTokens(window)} tokens (${Math.round(pct * 100)}%)`}
    >
      <div
        className={cn(
          'flex items-center gap-1 px-1',
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
      </div>
    </WithTooltip>
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
  cwd = null,
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
  /** Project folder used for @-file mentions; null disables them. */
  cwd?: string | null
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [attachError, setAttachError] = React.useState<string | null>(null)
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
          updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={(e) => {
          const el = e.currentTarget
          updateMention(el.value, el.selectionStart ?? el.value.length)
        }}
        onBlur={() => setTimeout(() => setMention(null), 200)}
        onKeyDown={(e) => {
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
        placeholder={placeholder}
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
            className="text-muted-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Attach files"
          >
            <Paperclip />
          </Button>
        </WithTooltip>
        <CompactSelect
          value={model}
          onValueChange={onModelChange}
          options={MODEL_OPTIONS.map((m) => ({
            value: m.id,
            label: m.label,
            description: m.description,
            group: PROVIDER_LABELS[m.provider],
            disabled: m.disabled
          }))}
          icon={<Sparkles className="size-3" />}
        />
        <CompactSelect
          value={effort}
          onValueChange={(v) => onEffortChange(v as EffortId | '')}
          options={EFFORT_OPTIONS.map((e) => ({
            value: e.id,
            label: e.label,
            description: e.description
          }))}
          icon={<Brain className="size-3" />}
        />
        <CompactSelect
          value={permissionMode}
          onValueChange={(v) => onPermissionModeChange(v as PermissionModeId)}
          options={PERMISSION_MODES.map((m) => ({
            value: m.id,
            label: m.label,
            description: m.description
          }))}
          icon={<Shield className="size-3" />}
        />
        <div className="flex-1" />
        {contextTokens != null && contextTokens > 0 && (
          <ContextRing used={contextTokens} window={contextWindow ?? 200_000} />
        )}
        {streaming && onStop ? (
          <WithTooltip label="Stop generating">
            <Button
              size="icon"
              variant="secondary"
              onClick={onStop}
              className="rounded-full border-destructive/30 text-destructive hover:bg-destructive/10"
              aria-label="Stop generating"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          </WithTooltip>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={!canSend}
            className="rounded-full"
            aria-label="Send message"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </Button>
        )}
      </div>
    </div>
  )
}

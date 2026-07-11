import * as React from 'react'
import { ArrowUp, Brain, Shield, Sparkles, Square } from 'lucide-react'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  PROVIDER_LABELS,
  type EffortId,
  type PermissionModeId
} from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CompactSelect } from '@/components/ui/select'
import { WithTooltip } from '@/components/ui/tooltip'

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
  disabled = false,
  placeholder = 'Ask Claude Code anything…',
  autoFocus = true
}: {
  onSend: (text: string) => void
  streaming?: boolean
  onStop?: () => void
  model: string
  onModelChange: (model: string) => void
  effort: EffortId | ''
  onEffortChange: (effort: EffortId | '') => void
  permissionMode: PermissionModeId
  onPermissionModeChange: (mode: PermissionModeId) => void
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const ref = React.useRef<HTMLTextAreaElement>(null)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const canSend = text.trim().length > 0 && !disabled

  const submit = (): void => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card shadow-lg shadow-black/5 transition-colors focus-within:border-ring/60 dark:shadow-black/20',
        disabled && 'opacity-60'
      )}
    >
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="no-drag block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none select-text placeholder:text-muted-foreground/60"
      />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
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

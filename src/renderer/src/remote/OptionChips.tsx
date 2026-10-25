import * as React from 'react'
import { ChevronDown, Search, Sparkles, Zap } from 'lucide-react'
import type { PermissionModeId } from '@shared/types'
import { matchesModelQuery, modelKey } from '@/lib/models'
import { permissionAppearance } from '@/lib/permissionModes'
import { ProviderMark, PROVIDER_COLOR } from '@/components/ui/provider-mark'
import { cn } from '@/lib/utils'
import { groupByProvider, usePickers, type OptionValues } from './options'
import { Sheet, SheetRow, SheetSection } from './Sheet'
import { isNative, useNativePickers } from './native'

/**
 * The composer's pickers, shaped like the desktop's: one chip for the model
 * and its effort ("✦ Opus 5.5 · High", "· Fast" when it is), one for the
 * permission mode. Each opens a sheet; the model sheet carries effort and
 * speed above the list, as the desktop's popover carries them beside it.
 *
 * `onChange` carries `remember`: false for the effort and speed a model pick
 * *replays*, exactly as the desktop composer sends them.
 */
export function OptionChips({
  values,
  onChange
}: {
  values: OptionValues
  onChange: (patch: Partial<OptionValues>, remember: boolean) => void
}): React.JSX.Element {
  const p = usePickers(values)
  const [sheet, setSheet] = React.useState<'model' | 'mode' | null>(null)
  const close = (): void => setSheet(null)
  const mode = permissionAppearance(p.permissionMode, values.provider === 'codex')
  const effortLabel = p.efforts.find((e) => e.id === p.effort)?.label
  const tinted = p.permissionMode !== 'default'
  // Inside the iOS app the chips and their sheets are native (`native.ts`).
  useNativePickers(values, p, onChange)
  if (isNative) return <></>

  return (
    <>
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <Chip onClick={() => setSheet('model')}>
          <Sparkles className="size-3.5 shrink-0" />
          <span className="max-w-[8.5rem] truncate">{p.modelLabel}</span>
          {p.efforts.length > 1 && effortLabel && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="shrink-0">{effortLabel}</span>
            </>
          )}
          {p.serviceTier === 'fast' && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="shrink-0 text-violet-500 dark:text-violet-400">Fast</span>
            </>
          )}
        </Chip>
        <Chip onClick={() => setSheet('mode')} className={tinted ? mode.iconClassName : undefined}>
          <mode.Icon className={cn('size-3.5 shrink-0', mode.iconClassName)} />
          <span className="shrink-0">{SHORT_MODE[p.permissionMode] ?? 'Ask'}</span>
        </Chip>
      </div>

      <ModelSheet open={sheet === 'model'} onClose={close} values={values} onChange={onChange} />

      <Sheet open={sheet === 'mode'} onClose={close} title="Permissions">
        {p.modes.map((m) => {
          const look = permissionAppearance(m.id, values.provider === 'codex')
          return (
            <SheetRow
              key={m.id}
              selected={m.id === p.permissionMode}
              icon={<look.Icon className={cn('size-4', look.iconClassName)} />}
              label={m.label}
              description={m.description}
              onClick={() => {
                onChange({ permissionMode: m.id }, true)
                close()
              }}
            />
          )
        })}
      </Sheet>
    </>
  )
}

/**
 * The chip's word for each mode; the sheet carries the full names. One word
 * each, because the footer also holds the model chip, the context ring and
 * send, and at a phone's width "Full access" was the one that got cut off. The
 * mode's icon and tint carry the rest.
 */
const SHORT_MODE: Partial<Record<PermissionModeId, string>> = {
  default: 'Ask',
  acceptEdits: 'Edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Full'
}

function Chip({
  onClick,
  className,
  children
}: {
  onClick: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13.5px] font-medium text-muted-foreground active:bg-accent',
        className
      )}
    >
      {children}
      <ChevronDown className="size-3 shrink-0 opacity-60" />
    </button>
  )
}

function ModelSheet({
  open,
  onClose,
  values,
  onChange
}: {
  open: boolean
  onClose: () => void
  values: OptionValues
  onChange: (patch: Partial<OptionValues>, remember: boolean) => void
}): React.JSX.Element {
  const p = usePickers(values)
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const groups = groupByProvider(p.models.filter((m) => matchesModelQuery(m, query)))

  return (
    <Sheet open={open} onClose={onClose}>
      {/* Effort, speed and search stay put while the models scroll under
          them — the list opens on the model in use, and these are the
          controls most often reached for alongside it. */}
      <div className="sticky top-0 z-10 -mx-2 bg-popover px-2 pb-1">
      {!query && p.efforts.length > 1 && (
        <SheetSection label="Effort">
          <Segmented
            options={p.efforts.map((e) => ({ id: e.id, label: e.label }))}
            value={p.effort}
            onChange={(id) => onChange({ effort: id as OptionValues['effort'] }, true)}
          />
        </SheetSection>
      )}
      {!query && p.tiers.length > 1 && (
        <SheetSection label="Speed">
          <Segmented
            options={p.tiers.map((t) => ({
              id: t.id,
              label: t.label,
              icon: t.id === 'fast' ? <Zap className="size-3.5 fill-current text-violet-500 dark:text-violet-400" /> : undefined
            }))}
            value={p.serviceTier}
            onChange={(id) => onChange({ serviceTier: id as OptionValues['serviceTier'] }, true)}
          />
        </SheetSection>
      )}
      <label className="mx-1 mt-3 mb-1 flex h-10 items-center gap-2 rounded-xl bg-muted px-3 text-muted-foreground">
        <Search className="size-4" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      </div>
      {groups.map((g) => (
        <SheetSection
          key={g.provider}
          label={g.label}
          icon={
            <span style={{ color: PROVIDER_COLOR[g.provider] }} className="flex">
              <ProviderMark provider={g.provider} className="size-3" />
            </span>
          }
        >
          {g.rows.map((m) => (
            <SheetRow
              key={modelKey(m.provider, m.id)}
              selected={m.provider === values.provider && m.id === p.selectedModel}
              label={m.label}
              description={m.description ?? m.resolvedModel}
              onClick={() => {
                const { replayed, ...pick } = p.pickModel(m)
                onChange(pick, true)
                if (Object.keys(replayed).length) onChange(replayed, false)
                onClose()
              }}
            />
          ))}
        </SheetSection>
      ))}
      {groups.length === 0 && <div className="px-4 py-6 text-center text-[14px] text-muted-foreground">No models match.</div>}
    </Sheet>
  )
}

/** A row of options, one picked — effort's levels, speed's two tiers. */
function Segmented({
  options,
  value,
  onChange
}: {
  options: { id: string; label: string; icon?: React.ReactNode }[]
  value: string
  onChange: (id: string) => void
}): React.JSX.Element {
  return (
    // Every option in view, sharing the width: a level scrolled off the edge
    // is a level nobody knows is there.
    <div className="mx-1 flex gap-0.5 rounded-xl bg-muted p-1">
      {options.map((o) => (
        <button
          key={o.id || 'default'}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'flex h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1 text-[13.5px] font-medium whitespace-nowrap transition-colors',
            o.id === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

import * as React from 'react'
import { LayoutList, Minus, Monitor, Moon, Plus, Rows3, Sun } from 'lucide-react'
import { THEMES, type ThemeMode } from '@/lib/themes'
import { MiniWindow } from '@/components/ThemePreview'
import { cn } from '@/lib/utils'
import {
  CHATS_PER_PROJECT_DEFAULT,
  CHATS_PER_PROJECT_MAX,
  CHATS_PER_PROJECT_MIN,
  CODE_DEFAULT,
  CODE_MAX,
  CODE_MIN,
  TEXT_SIZES,
  usePrefs,
  type SidebarDensity
} from './prefs'
import { Sheet, SheetSection } from './Sheet'

const DENSITIES: { id: SidebarDensity; label: string; icon: typeof Sun }[] = [
  { id: 'compact', label: 'Compact', icon: Rows3 },
  { id: 'detailed', label: 'Detailed', icon: LayoutList }
]

const MODES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor }
]

/**
 * This phone's own display settings (`prefs.ts`): text size, code size, the
 * sidebar's shape, color mode and palette. A sheet off the sidebar's footer, since every other picker
 * on the phone is one, and each change applies as it is made — the chat
 * behind the sheet is the rest of the preview.
 */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const p = usePrefs()
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="px-1 pb-3">
        <SheetSection label="Text">
          <StepRow
            label="Text size"
            value={`${Math.round(TEXT_SIZES[p.textSize] * 100)}%`}
            canDown={p.textSize > 0}
            canUp={p.textSize < TEXT_SIZES.length - 1}
            onDown={() => p.setTextSize(p.textSize - 1)}
            onUp={() => p.setTextSize(p.textSize + 1)}
            onReset={() => p.setTextSize(TEXT_SIZES.indexOf(1))}
          />
          <StepRow
            label="Code size"
            value={`${p.codeSize}px`}
            canDown={p.codeSize > CODE_MIN}
            canUp={p.codeSize < CODE_MAX}
            onDown={() => p.setCodeSize(p.codeSize - 1)}
            onUp={() => p.setCodeSize(p.codeSize + 1)}
            onReset={() => p.setCodeSize(CODE_DEFAULT)}
          />
          {/* Drawn the way a reply is, at the size just picked. */}
          <div className="mx-3 mt-1 overflow-hidden rounded-xl border border-border bg-background px-3.5 py-3">
            <div className="reading-zoom markdown select-none text-foreground">
              <p className="m-0">
                Updated the parser so <code>parseConfig</code> accepts comments.
              </p>
              <pre className="mb-0">
                <code>{'const config = parseConfig(text)'}</code>
              </pre>
            </div>
          </div>
        </SheetSection>

        <SheetSection label="Sidebar">
          <Segmented label="Sidebar rows" options={DENSITIES} value={p.sidebarDensity} onChange={p.setSidebarDensity} />
          <p className="mx-3 mt-2 mb-1 text-[12.5px] leading-snug text-muted-foreground">
            {p.sidebarDensity === 'detailed'
              ? 'One list in your order. Each row names its project, branch and backend.'
              : 'Chats grouped under their projects, one line each.'}
          </p>
          {/* Only the compact shape folds per project; the detailed list folds by batch. */}
          {p.sidebarDensity === 'compact' && (
            <StepRow
              label="Chats per project"
              value={String(p.chatsPerProject)}
              canDown={p.chatsPerProject > CHATS_PER_PROJECT_MIN}
              canUp={p.chatsPerProject < CHATS_PER_PROJECT_MAX}
              onDown={() => p.setChatsPerProject(p.chatsPerProject - 1)}
              onUp={() => p.setChatsPerProject(p.chatsPerProject + 1)}
              onReset={() => p.setChatsPerProject(CHATS_PER_PROJECT_DEFAULT)}
            />
          )}
        </SheetSection>

        <SheetSection label="Appearance">
          <Segmented label="Color mode" options={MODES} value={p.themeMode} onChange={p.setThemeMode} />
          <div role="group" aria-label="Theme" className="mx-3 mt-3 grid grid-cols-3 gap-2">
            {THEMES.map((t) => {
              const selected = t.id === p.themeId
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => p.setTheme(t.id)}
                  className={cn(
                    'flex flex-col gap-1.5 rounded-xl border p-1.5 text-left transition-colors',
                    selected ? 'border-primary/70 bg-accent/50' : 'border-border active:bg-accent/40'
                  )}
                >
                  {/* Light on the left, dark on the right — the desktop's card. */}
                  <div aria-hidden className="flex h-[52px] overflow-hidden rounded-lg border border-border">
                    <div className="w-1/2 border-r border-border">
                      <MiniWindow vars={t.lightVars} />
                    </div>
                    <div className="w-1/2">
                      <MiniWindow vars={t.vars} />
                    </div>
                  </div>
                  <span className="truncate px-0.5 text-[13px] font-medium">{t.name}</span>
                </button>
              )
            })}
          </div>
          <p className="mx-3 mt-2.5 mb-0 text-[12.5px] leading-snug text-muted-foreground">
            Kept on this phone, separate from your Mac. Themes imported on the Mac stay there.
          </p>
        </SheetSection>
      </div>
    </Sheet>
  )
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: { id: T; label: string; icon: typeof Sun }[]
  value: T
  onChange: (id: T) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="mx-3 mt-1 grid gap-1 rounded-xl bg-secondary p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex h-10 items-center justify-center gap-1.5 rounded-lg text-[14px] font-medium transition-colors',
            value === o.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          )}
        >
          <o.icon className="size-4" />
          {o.label}
        </button>
      ))}
    </div>
  )
}

function StepRow({
  label,
  value,
  canDown,
  canUp,
  onDown,
  onUp,
  onReset
}: {
  label: string
  value: string
  canDown: boolean
  canUp: boolean
  onDown: () => void
  onUp: () => void
  onReset: () => void
}): React.JSX.Element {
  const step =
    'flex size-10 items-center justify-center rounded-full text-foreground active:bg-accent disabled:opacity-30'
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1 text-[15px]">{label}</span>
      <button type="button" aria-label={`Smaller ${label.toLowerCase()}`} disabled={!canDown} onClick={onDown} className={step}>
        <Minus className="size-4" />
      </button>
      {/* Tapping the value puts it back to the default. */}
      <button
        type="button"
        aria-label={`Reset ${label.toLowerCase()}`}
        onClick={onReset}
        className="w-14 text-center text-[14px] text-muted-foreground tabular-nums"
      >
        {value}
      </button>
      <button type="button" aria-label={`Larger ${label.toLowerCase()}`} disabled={!canUp} onClick={onUp} className={step}>
        <Plus className="size-4" />
      </button>
    </div>
  )
}

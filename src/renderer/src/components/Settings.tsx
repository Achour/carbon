import * as React from 'react'
import { Check, Moon, Palette, Sun, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { THEMES, type ThemeDef } from '@/lib/themes'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

/** Miniature app mock rendered with the theme's own palette. */
function ThemePreview({ theme }: { theme: ThemeDef }): React.JSX.Element {
  const v = (name: string): string => theme.vars[name]
  return (
    <div
      className="pointer-events-none h-24 w-full overflow-hidden rounded-lg border"
      style={{ background: v('background'), borderColor: v('border') }}
    >
      <div className="flex h-full">
        <div className="flex w-[30%] flex-col gap-1.5 p-2" style={{ background: v('sidebar') }}>
          <div
            className="h-1.5 w-3/4 rounded-full"
            style={{ background: v('sidebar-foreground'), opacity: 0.55 }}
          />
          <div
            className="h-1.5 w-1/2 rounded-full"
            style={{ background: v('sidebar-foreground'), opacity: 0.3 }}
          />
          <div className="mt-auto h-4 rounded" style={{ background: v('sidebar-accent') }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
          <div className="h-2.5 w-2/5 self-end rounded-full" style={{ background: v('secondary') }} />
          <div
            className="h-1.5 w-4/5 rounded-full"
            style={{ background: v('foreground'), opacity: 0.75 }}
          />
          <div
            className="h-1.5 w-3/5 rounded-full"
            style={{ background: v('muted-foreground'), opacity: 0.6 }}
          />
          <div
            className="mt-auto flex h-6 items-center justify-between rounded-md border px-1.5"
            style={{ background: v('card'), borderColor: v('border') }}
          >
            <div
              className="h-1 w-1/3 rounded-full"
              style={{ background: v('muted-foreground'), opacity: 0.5 }}
            />
            <div className="size-3 rounded-full" style={{ background: v('primary') }} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeCard({
  theme,
  selected,
  onSelect
}: {
  theme: ThemeDef
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'rounded-xl border p-1.5 text-left transition-all',
        selected
          ? 'border-primary/60 ring-2 ring-primary/25'
          : 'border-border hover:border-muted-foreground/40'
      )}
    >
      <ThemePreview theme={theme} />
      <div className="flex items-center gap-1.5 px-1 pt-1.5 pb-0.5">
        {theme.appearance === 'dark' ? (
          <Moon className="size-3 text-muted-foreground" />
        ) : (
          <Sun className="size-3 text-muted-foreground" />
        )}
        <span className="text-xs font-medium">{theme.name}</span>
        {selected && <Check className="ml-auto size-3.5 text-primary" strokeWidth={2.5} />}
      </div>
    </button>
  )
}

function ThemeGroup({
  label,
  themes,
  current,
  onSelect
}: {
  label: string
  themes: ThemeDef[]
  current: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {themes.map((t) => (
          <ThemeCard key={t.id} theme={t} selected={t.id === current} onSelect={() => onSelect(t.id)} />
        ))}
      </div>
    </div>
  )
}

export function Settings(): React.JSX.Element {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const closeSettings = useApp((s) => s.closeSettings)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold">Settings</span>
        <WithTooltip label="Close settings  esc">
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag"
            aria-label="Close settings"
            onClick={closeSettings}
          >
            <X />
          </Button>
        </WithTooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
          <section>
            <div className="flex items-center gap-2">
              <Palette className="size-4 text-primary" />
              <h2 className="text-[15px] font-semibold">Appearance</h2>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Pick a theme for the whole app. Changes apply instantly.
            </p>
            <div className="mt-5 space-y-6">
              <ThemeGroup
                label="Dark"
                themes={THEMES.filter((t) => t.appearance === 'dark')}
                current={theme}
                onSelect={setTheme}
              />
              <ThemeGroup
                label="Light"
                themes={THEMES.filter((t) => t.appearance === 'light')}
                current={theme}
                onSelect={setTheme}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

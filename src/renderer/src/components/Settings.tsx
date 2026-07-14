import * as React from 'react'
import { Bell, Check, Info, MessageSquare, Minus, Moon, Palette, Plus, Sun, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CODE_FONT_DEFAULT, CODE_FONT_MAX, CODE_FONT_MIN, THEMES, type ThemeDef } from '@/lib/themes'
import { playChime } from '@/lib/notify'
import {
  CHATS_PER_PROJECT_DEFAULT,
  CHATS_PER_PROJECT_MAX,
  CHATS_PER_PROJECT_MIN,
  useApp
} from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'about', label: 'About', icon: Info }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function SectionHeader({
  icon: Icon,
  title,
  description
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="mb-5 px-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-primary" />
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}

function Row({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 px-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  )
}

function Stepper({
  value,
  min,
  max,
  suffix = '',
  onChange,
  onReset
}: {
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (v: number) => void
  onReset?: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        size="icon-sm"
        variant="outline"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus />
      </Button>
      <button
        type="button"
        onClick={onReset}
        title={onReset ? 'Reset to default' : undefined}
        className="w-12 rounded-md py-1 text-center text-xs tabular-nums transition-colors hover:bg-accent"
      >
        {value}
        {suffix}
      </button>
      <Button
        size="icon-sm"
        variant="outline"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus />
      </Button>
    </div>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-4 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-accent/40"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <span
        className={cn(
          'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-secondary'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] left-[2px] size-3.5 rounded-full bg-background shadow-sm transition-transform',
            checked && 'translate-x-[14px]'
          )}
        />
      </span>
    </button>
  )
}

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
  const notifyPrefs = useApp((s) => s.notifyPrefs)
  const setNotifyPrefs = useApp((s) => s.setNotifyPrefs)
  const codeFontSize = useApp((s) => s.codeFontSize)
  const setCodeFontSize = useApp((s) => s.setCodeFontSize)
  const translucentSidebar = useApp((s) => s.translucentSidebar)
  const setTranslucentSidebar = useApp((s) => s.setTranslucentSidebar)
  const chatsPerProject = useApp((s) => s.chatsPerProject)
  const setChatsPerProject = useApp((s) => s.setChatsPerProject)

  const [section, setSection] = React.useState<SectionId>('appearance')

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-[38px] shrink-0 items-center justify-between border-b border-border px-4">
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

      <div className="flex min-h-0 flex-1">
        {/* Section nav */}
        <nav className="w-52 shrink-0 overflow-y-auto border-r border-border p-2.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors [&_svg]:size-4',
                section === s.id
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <s.icon />
              {s.label}
            </button>
          ))}
        </nav>

        {/* Section content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            {section === 'appearance' && (
              <section>
                <SectionHeader
                  icon={Palette}
                  title="Appearance"
                  description="Pick a theme for the whole app. Changes apply instantly."
                />
                <div className="space-y-6 px-2">
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

                {window.api.platform === 'darwin' && (
                  <div className="mt-7">
                    <Toggle
                      label="Translucent sidebar"
                      description="Frost the sidebar so the desktop blurs through behind it"
                      checked={translucentSidebar}
                      onChange={setTranslucentSidebar}
                    />
                  </div>
                )}

                <div className="mt-8">
                  <Row label="Code font size" description="Code blocks, the file viewer and diffs">
                    <Stepper
                      value={codeFontSize}
                      min={CODE_FONT_MIN}
                      max={CODE_FONT_MAX}
                      suffix="px"
                      onChange={setCodeFontSize}
                      onReset={() => setCodeFontSize(CODE_FONT_DEFAULT)}
                    />
                  </Row>
                  <pre className="mx-2 mt-1 overflow-x-auto rounded-lg border border-border bg-code px-3.5 py-2.5 font-mono leading-relaxed text-[length:var(--code-font-size)]">
                    {'const answer = compute(42)  // preview'}
                  </pre>
                </div>
              </section>
            )}

            {section === 'chats' && (
              <section>
                <SectionHeader
                  icon={MessageSquare}
                  title="Chats"
                  description="How chats are organised in the sidebar."
                />
                <Row
                  label="Recent chats per project"
                  description="Each project shows this many recent chats. Find older ones with search."
                >
                  <Stepper
                    value={chatsPerProject}
                    min={CHATS_PER_PROJECT_MIN}
                    max={CHATS_PER_PROJECT_MAX}
                    onChange={setChatsPerProject}
                    onReset={() => setChatsPerProject(CHATS_PER_PROJECT_DEFAULT)}
                  />
                </Row>
              </section>
            )}

            {section === 'notifications' && (
              <section>
                <SectionHeader
                  icon={Bell}
                  title="Notifications"
                  description="Stay on top of long-running turns while you work elsewhere."
                />
                <div className="space-y-0.5">
                  <Toggle
                    label="Turn complete alerts"
                    description="Notify when the agent finishes while the app is in the background"
                    checked={notifyPrefs.finish}
                    onChange={(finish) => setNotifyPrefs({ finish })}
                  />
                  <Toggle
                    label="Approval alerts"
                    description="Notify when the agent is waiting for your permission or plan review"
                    checked={notifyPrefs.permission}
                    onChange={(permission) => setNotifyPrefs({ permission })}
                  />
                  <Toggle
                    label="Sound"
                    description="Play a soft chime when a turn finishes or the agent needs your input"
                    checked={notifyPrefs.sound}
                    onChange={(sound) => {
                      setNotifyPrefs({ sound })
                      if (sound) playChime()
                    }}
                  />
                </div>
              </section>
            )}

            {section === 'about' && (
              <section>
                <SectionHeader
                  icon={Info}
                  title="About"
                  description="Karbun — a desktop GUI for coding agents."
                />
                <div className="space-y-2 px-2 text-[13px] text-muted-foreground">
                  <p>
                    Sessions run through your existing Claude Code or Codex login, in whatever
                    project folder you pick — each chat uses whichever agent you chose when you
                    started it.
                  </p>
                  <p>
                    Chats are stored locally on your machine — nothing is uploaded beyond the
                    conversation itself.
                  </p>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

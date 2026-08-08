import * as React from 'react'
import {
  ArrowDownToLine,
  Bell,
  Info,
  LayoutList,
  Loader2,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  Rows3,
  Sun,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CODE_FONT_DEFAULT,
  CODE_FONT_MAX,
  CODE_FONT_MIN,
  THEMES,
  type ThemeDef,
  type ThemeMode
} from '@/lib/themes'
import { playChime } from '@/lib/notify'
import {
  CHATS_PER_PROJECT_DEFAULT,
  CHATS_PER_PROJECT_MAX,
  CHATS_PER_PROJECT_MIN,
  type SidebarDensity,
  useApp
} from '@/store'
import {
  CopyUpdateCommand,
  UPDATE_FROM_SOURCE,
  UPDATE_VIA_HOMEBREW
} from '@/components/UpdateBanner'
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

/**
 * The version line, and the manual half of the update story.
 *
 * The sidebar banner is the automatic half — it appears on its own when a
 * release lands. This is where someone goes to ask *now*, or to find the
 * download again after dismissing the banner, and it's the only place that
 * answers "am I up to date?" out loud when the answer is yes.
 */
function UpdateRow(): React.JSX.Element {
  const update = useApp((s) => s.update)
  const checkForUpdate = useApp((s) => s.checkForUpdate)
  const brew = window.api.installedViaHomebrew
  const [checking, setChecking] = React.useState(false)
  // Distinguishes "checked, nothing there" from "never asked" — without it the
  // button would look inert on an up-to-date install.
  const [checked, setChecked] = React.useState(false)

  const run = async (): Promise<void> => {
    setChecking(true)
    try {
      await checkForUpdate()
    } finally {
      setChecking(false)
      setChecked(true)
    }
  }

  const status = checking
    ? 'Checking…'
    : update
      ? `Version ${update.version} is available`
      : checked
        ? 'Carbon is up to date'
        : 'Checked automatically on launch and every 6 hours'

  return (
    <div className="px-2 py-2.5">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Version {window.api.appVersion}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{status}</div>
        </div>
        {update && !brew ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void window.api.openExternal(update.downloadUrl ?? update.releaseUrl)}
          >
            <ArrowDownToLine />
            {update.downloadUrl ? 'Download' : 'View release'}
          </Button>
        ) : (
          // A brew install has nothing to download, so the check button stays —
          // re-checking is the only button-shaped action left to it.
          <Button size="sm" variant="secondary" disabled={checking} onClick={() => void run()}>
            {checking && <Loader2 className="animate-spin" />}
            Check for updates
          </Button>
        )}
      </div>
      {update && (
        // Brew upgrades in place; everyone else gets the .dmg, which arrives
        // quarantined, so anyone who built from a clone should update the way
        // they installed and skip that.
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
          <div className="mb-1 text-xs text-muted-foreground">
            {brew
              ? 'Installed with Homebrew — upgrade in place:'
              : 'Installed from source? Update the same way — no Gatekeeper prompt:'}
          </div>
          <CopyUpdateCommand
            className="text-[11px]"
            command={brew ? UPDATE_VIA_HOMEBREW : UPDATE_FROM_SOURCE}
          />
        </div>
      )}
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

const THEME_MODES = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor }
] as const

const SIDEBAR_DENSITIES = [
  { id: 'compact', label: 'Compact', icon: Rows3 },
  { id: 'detailed', label: 'Detailed', icon: LayoutList }
] as const

/**
 * Compact vs detailed sidebar rows. No preview here on purpose — the sidebar is
 * open next to this control, so it previews itself the moment you click.
 */
function SidebarDensityPicker({
  value,
  onChange
}: {
  value: SidebarDensity
  onChange: (density: SidebarDensity) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Sidebar rows"
      className="grid shrink-0 grid-cols-2 gap-1 rounded-xl bg-secondary p-1"
    >
      {SIDEBAR_DENSITIES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
            value === option.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <option.icon className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ThemeModePicker({
  value,
  onChange
}: {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Color mode"
      className="grid grid-cols-3 gap-1 rounded-xl bg-secondary p-1"
    >
      {THEME_MODES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
            value === option.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <option.icon className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A scale model of Carbon's own window in one palette: sidebar, a line of text,
 * a code block, and the composer with the accent on the send button.
 *
 * These palettes are built as a *surface ladder* (sidebar → background → card →
 * code), so the ladder is what the picker should show. A single color chip says
 * nothing about the chrome that color has to live on, which is exactly how the
 * old registry shipped 22 themes that turned out to share a light mode.
 */
function MiniWindow({ vars }: { vars: Record<string, string> }): React.JSX.Element {
  const v = (name: string): string => vars[name]
  return (
    <div className="flex h-full w-full" style={{ background: v('background') }}>
      <div
        className="flex w-[30%] shrink-0 flex-col gap-1 p-1.5"
        style={{ background: v('sidebar') }}
      >
        <div
          className="h-[3px] w-4/5 rounded-full"
          style={{ background: v('sidebar-foreground'), opacity: 0.5 }}
        />
        <div
          className="h-[3px] w-3/5 rounded-full"
          style={{ background: v('sidebar-foreground'), opacity: 0.28 }}
        />
        <div className="h-2 w-full rounded-sm" style={{ background: v('sidebar-accent') }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        <div
          className="h-[3px] w-3/4 rounded-full"
          style={{ background: v('foreground'), opacity: 0.72 }}
        />
        <div
          className="h-[3px] w-1/2 rounded-full"
          style={{ background: v('muted-foreground'), opacity: 0.6 }}
        />
        <div className="h-3 w-full rounded-sm" style={{ background: v('code-bg') }} />
        <div
          className="mt-auto flex h-3 items-center justify-end rounded-sm border px-1"
          style={{ background: v('card'), borderColor: v('border') }}
        >
          <div className="size-1.5 rounded-full" style={{ background: v('primary') }} />
        </div>
      </div>
    </div>
  )
}

/**
 * The two modes as facing pages of one window, joined at a seam — so a card
 * shows what the theme actually looks like in both, without a badge or a legend.
 * Light sits on the left in every card, so the column reads as one comparison
 * rather than six unrelated pictures.
 */
function ThemeCard({
  theme,
  selected,
  onSelect
}: {
  theme: ThemeDef
  selected: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(theme.id)}
      className={cn(
        'group flex flex-col items-stretch gap-2 rounded-xl border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary/70 bg-accent/50'
          : 'border-border bg-card/40 hover:bg-accent/30'
      )}
    >
      <div
        className="flex h-[74px] w-full overflow-hidden rounded-lg border border-border"
        aria-hidden="true"
      >
        <div className="w-1/2 border-r border-border">
          <MiniWindow vars={theme.lightVars} />
        </div>
        <div className="w-1/2">
          <MiniWindow vars={theme.vars} />
        </div>
      </div>
      <span className="px-0.5 text-[13px] font-medium">{theme.name}</span>
    </button>
  )
}

/**
 * A grid rather than a dropdown: comparing themes side by side *is* the job of
 * a theme picker, and at six they all fit at once.
 */
function ThemeGrid({
  selected,
  onSelect
}: {
  selected: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div role="group" aria-label="App theme" className="grid grid-cols-3 gap-2.5">
      {THEMES.map((candidate) => (
        <ThemeCard
          key={candidate.id}
          theme={candidate}
          selected={candidate.id === selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export function Settings(): React.JSX.Element {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const themeMode = useApp((s) => s.themeMode)
  const setThemeMode = useApp((s) => s.setThemeMode)
  const closeSettings = useApp((s) => s.closeSettings)
  const notifyPrefs = useApp((s) => s.notifyPrefs)
  const setNotifyPrefs = useApp((s) => s.setNotifyPrefs)
  const codeFontSize = useApp((s) => s.codeFontSize)
  const setCodeFontSize = useApp((s) => s.setCodeFontSize)
  const translucentSidebar = useApp((s) => s.translucentSidebar)
  const setTranslucentSidebar = useApp((s) => s.setTranslucentSidebar)
  const chatsPerProject = useApp((s) => s.chatsPerProject)
  const setChatsPerProject = useApp((s) => s.setChatsPerProject)
  const sidebarDensity = useApp((s) => s.sidebarDensity)
  const setSidebarDensity = useApp((s) => s.setSidebarDensity)

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
                  description="Choose a color mode and theme. Changes apply instantly."
                />
                <div className="mx-2 rounded-2xl border border-border bg-card/35 p-3">
                  <div className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">Color mode</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        System follows your device appearance
                      </div>
                    </div>
                    <ThemeModePicker value={themeMode} onChange={setThemeMode} />
                  </div>
                  <div className="my-3 h-px bg-border" />
                  <div className="mb-3">
                    <div className="text-[13px] font-medium">App theme</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Six palettes, each designed for both light and dark
                    </div>
                  </div>
                  <ThemeGrid selected={theme} onSelect={setTheme} />
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
                  label="Sidebar rows"
                  description="Detailed rows also show the backend answering and the branch — or the folder, outside a repo."
                >
                  <SidebarDensityPicker
                    value={sidebarDensity}
                    onChange={setSidebarDensity}
                  />
                </Row>
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
                  description="Carbon — a desktop GUI for coding agents."
                />
                <div className="mb-3 border-b border-border pb-2">
                  <UpdateRow />
                </div>
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

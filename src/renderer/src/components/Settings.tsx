import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import {
  Archive,
  ArrowDownToLine,
  Bell,
  Brain,
  FolderGit2,
  History,
  Info,
  LayoutList,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Palette,
  Pin,
  Plus,
  RefreshCw,
  Rows3,
  Sparkles,
  Sun,
  Terminal,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon
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
import { playCue, SOUND_PACKS, type CueKind, type SoundPackId } from '@/lib/sounds'
import {
  CHATS_PER_PROJECT_DEFAULT,
  CHATS_PER_PROJECT_MAX,
  CHATS_PER_PROJECT_MIN,
  type SettingsSectionId,
  type SidebarDensity,
  useApp
} from '@/store'
import {
  CopyUpdateCommand,
  UPDATE_FROM_SOURCE,
  UPDATE_VIA_HOMEBREW
} from '@/components/UpdateBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProviderAvatar, ProviderMark } from '@/components/ui/provider-mark'
import { SwitchPill } from '@/components/ui/switch-pill'
import { ArchiveSection } from '@/components/SettingsArchive'
import { ProjectsSection } from '@/components/SettingsProjects'
import { WithTooltip } from '@/components/ui/tooltip'
import {
  PROVIDERS,
  PROVIDER_LABELS,
  modelDisplayName,
  providerForRememberedModel,
  resolvedModelName,
  type EffortId,
  type ModelOption,
  type PermissionModeId,
  type Provider,
  type ProviderCli,
  type ServiceTier
} from '@shared/types'
import { CompactSelect } from '@/components/ui/select'
import { availableProviders } from '@/lib/modelCatalog'
import {
  assembleModelOptions,
  canonicalModelId,
  effortOptionsFor,
  modelKey,
  matchesModelQuery,
  rememberedEffortForModel,
  serviceTierOptionsFor,
  visibleModelOptions
} from '@/lib/models'
import { PROVIDER_PERMISSION_MODES, permissionAppearance } from '@/lib/permissionModes'

const SECTIONS: { id: SettingsSectionId; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'providers', label: 'Providers', icon: Terminal },
  { id: 'models', label: 'Models', icon: Sparkles },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'about', label: 'About', icon: Info }
]

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
            {checking && <DotSpinner />}
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
      <Button
        variant="ghost"
        size="sm"
        onClick={onReset}
        title={onReset ? 'Reset to default' : undefined}
        className="w-12 rounded-md px-0 font-normal tabular-nums"
      >
        {value}
        {suffix}
      </Button>
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

/**
 * A provider's capability switches.
 *
 * Fetched on mount rather than with the CLI list, because Codex's costs an
 * app-server spawn and the great majority of visits to this page are about
 * something else. Nothing renders while the answer is outstanding and nothing
 * renders when it comes back empty — Grok has no such API, and neither does a
 * provider that isn't installed, so an empty row is the correct amount of
 * chrome for "there is nothing to configure here".
 */
function ProviderFeatures({ provider }: { provider: Provider }): React.JSX.Element | null {
  const features = useApp((s) => s.providerFeatures[provider])
  const loadProviderFeatures = useApp((s) => s.loadProviderFeatures)
  const setProviderFeature = useApp((s) => s.setProviderFeature)

  React.useEffect(() => {
    void loadProviderFeatures(provider)
  }, [loadProviderFeatures, provider])

  if (!features?.length) return null

  return (
    <div className="mt-3 space-y-2.5 border-t border-border pt-3">
      {features.map((f) => (
        <div key={f.id} className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{f.label}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {f.description}
            </div>
            {/* An environment variable the user set themselves outranks this
                switch — see `resolveFeature`. Saying so beats a control that
                silently does nothing. */}
            {f.overriddenBy && (
              <div className="mt-1 font-mono text-[10px] text-warning">
                Set by {f.overriddenBy} in your environment
              </div>
            )}
          </div>
          <SwitchPill
            on={f.enabled}
            disabled={!!f.overriddenBy}
            label={f.label}
            onChange={() => void setProviderFeature(provider, f.id, !f.enabled)}
          />
        </div>
      ))}
      <div className="text-[11px] text-muted-foreground">
        Applies to new sessions. A chat that is mid-turn finishes under the old settings.
      </div>
    </div>
  )
}

/**
 * One provider's CLI: whether it's there, which binary, which version.
 *
 * Carbon drives the providers' real command-line tools and runs the ones the
 * user installed rather than shipping copies of them — so "is it installed?" is
 * a question the app genuinely has to answer, and this is where it answers it.
 * The alternative was bundling a second, frozen copy of each CLI inside the
 * app, which would pin the agent's version to Carbon's release cadence.
 *
 * The switch is separate from the install on purpose: turning a provider off is
 * how someone with all three installed keeps the model picker down to the ones
 * they actually use, and it reads identically to "not installed" everywhere
 * downstream — no rows in any picker.
 */
function ProviderDetail({ cli }: { cli: ProviderCli }): React.JSX.Element {
  const setProviderCli = useApp((s) => s.setProviderCli)
  const [copied, setCopied] = React.useState(false)

  const missing = !cli.installed
  const label = PROVIDER_LABELS[cli.provider]

  const copyInstall = (): void => {
    void navigator.clipboard.writeText(cli.installCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3">
        <div className="flex items-center gap-2.5">
          <ProviderAvatar provider={cli.provider} className="rounded-md" />
          <h2 className="text-[15px] font-semibold">{label}</h2>
          {cli.version && (
            <span className="rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground tabular-nums">
              {cli.version}
            </span>
          )}
          <div className="flex-1" />
          <SwitchPill
            on={cli.enabled}
            disabled={missing}
            label={`Use ${label}`}
            onChange={() => void setProviderCli(cli.provider, { enabled: !cli.enabled })}
          />
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {missing
            ? 'Not installed on this machine, so it offers no models.'
            : cli.enabled
              ? 'Installed and on. Its models are in the model picker.'
              : 'Turned off. It offers no models until you switch it back on.'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="rounded-lg border border-border px-3 py-3">
          <div className="text-xs font-medium">Binary</div>
          <div className="mt-0.5 break-all text-[11px] leading-relaxed text-muted-foreground">
            {!missing ? (
              <span className="font-mono">{cli.path}</span>
            ) : cli.path ? (
              // Only an env override can put a path here that doesn't run.
              // Naming it beats "Not installed", which would send someone
              // hunting for an install they already have.
              <span className="text-warning">
                Not executable: <span className="font-mono">{cli.path}</span>
              </span>
            ) : (
              'Not installed'
            )}
          </div>

          {/* Carbon installs this one itself, so the next step is a button. */}
          {missing && !cli.path && cli.installable && <ManagedInstall provider={cli.provider} />}

          {/* The install command, shown only when it's the thing to do next — so
              not when an env override resolved to a path that simply won't run. */}
          {missing && !cli.path && !cli.installable && (
            <div className="mt-2.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-secondary px-2 py-1.5 font-mono text-[11px]">
                {cli.installCommand}
              </code>
              <Button size="sm" variant="secondary" onClick={copyInstall}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}

          {/* Below the floor Carbon's adapter was written against — a warning,
              not a block: the turn may work fine, and refusing to run it would
              be the app overruling a version the user chose to keep. */}
          {cli.outdated && cli.version && (
            <div className="mt-2.5 flex items-start gap-2 text-xs text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>
                Carbon expects {cli.minVersion} or newer; this is {cli.version}. Some features may
                not work.
              </span>
            </div>
          )}

          {/* A provider with its own sign-in (Antigravity): its account lives
              here, because there is no CLI of its own to sign in from. */}
          {!missing && cli.enabled && cli.installable && (
            <ProviderAccount provider={cli.provider} />
          )}

          {/* Only for a provider that can actually run: the switches below are
              about what a session may do, and there are no sessions without a
              binary. `providerFeatures` answers `[]` for one anyway. */}
          {!missing && cli.enabled && <ProviderFeatures provider={cli.provider} />}
        </div>
      </div>
    </div>
  )
}

/** The one-line status under a provider's name in the list. */
function providerStatus(cli: ProviderCli): { text: string; warn: boolean } {
  if (!cli.installed) return { text: cli.path ? 'Not executable' : 'Not installed', warn: !!cli.path }
  if (!cli.enabled) return { text: 'Off', warn: false }
  if (cli.outdated) return { text: `${cli.version} · update`, warn: true }
  return { text: cli.version ?? 'Installed', warn: false }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`
}

/**
 * Install for a provider Carbon manages itself. Antigravity's ACP server has no
 * package or installer behind it — Google publishes it as a registry archive —
 * so the row downloads it into Carbon's data folder rather than naming a
 * command to run. The bar is the download; unpacking follows in a second.
 */
function ManagedInstall({ provider }: { provider: Provider }): React.JSX.Element {
  const installProvider = useApp((s) => s.installProvider)
  const progress = useApp((s) => s.providerInstall[provider])
  const [error, setError] = React.useState<string | null>(null)
  const busy = !!progress && progress.phase !== 'error'

  const install = async (): Promise<void> => {
    setError(null)
    const result = await installProvider(provider)
    if (!result.ok) setError(result.error ?? 'Install failed.')
  }

  const fraction = progress && progress.total > 0 ? progress.received / progress.total : null
  const status = !busy
    ? 'Google’s Antigravity agent server, from the ACP registry (about 110 MB). It keeps its own Google sign-in.'
    : progress.phase === 'extract'
      ? 'Unpacking…'
      : fraction !== null
        ? `Downloading… ${formatMegabytes(progress.received)} of ${formatMegabytes(progress.total)}`
        : `Downloading… ${formatMegabytes(progress.received)}`
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {status}
        </div>
        <Button size="sm" variant="secondary" onClick={() => void install()} disabled={busy}>
          {busy ? <DotSpinner /> : <ArrowDownToLine />}
          Install
        </Button>
      </div>
      {busy && (
        <div className="h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width]',
              fraction === null && 'w-1/3 animate-pulse'
            )}
            style={fraction !== null ? { width: `${Math.round(fraction * 100)}%` } : undefined}
          />
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The account of a provider that signs in on its own. Antigravity's server
 * keeps a Google login separate from the `agy` CLI's, so it is the one row
 * whose login Carbon has to offer rather than find. Signing in opens the
 * browser and the button waits on it; the server's own deadline is five
 * minutes.
 */
function ProviderAccount({ provider }: { provider: Provider }): React.JSX.Element {
  const auth = useApp((s) => s.providerAuth[provider])
  const loadProviderAuth = useApp((s) => s.loadProviderAuth)
  const signInProvider = useApp((s) => s.signInProvider)
  const signOutProvider = useApp((s) => s.signOutProvider)
  const [busy, setBusy] = React.useState<'in' | 'out' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void loadProviderAuth(provider)
  }, [loadProviderAuth, provider])

  const run = async (kind: 'in' | 'out'): Promise<void> => {
    setBusy(kind)
    setError(null)
    const result = kind === 'in' ? await signInProvider(provider) : await signOutProvider(provider)
    if (!result.ok) setError(result.error ?? 'That didn’t work.')
    setBusy(null)
  }

  const status =
    busy === 'in'
      ? 'Finish signing in in your browser…'
      : auth === 'signed-in'
        ? 'Signed in. Models come from your Google account.'
        : auth === 'signed-out'
          ? 'Not signed in. Sign in to use Antigravity’s models.'
          : auth === 'unavailable'
            ? 'Couldn’t reach the Antigravity server.'
            : 'Checking…'
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Google account</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{status}</div>
        </div>
        {auth === 'signed-in' ? (
          <Button size="sm" variant="secondary" onClick={() => void run('out')} disabled={!!busy}>
            {busy === 'out' && <DotSpinner />}
            Sign out
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void run('in')}
            disabled={!!busy || !auth}
          >
            {busy === 'in' && <DotSpinner />}
            Sign in with Google
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The Providers section. Nothing here is required reading: with the CLIs
 * installed the app finds them and this page only confirms it. It earns its
 * place the moment one is missing, sits somewhere unusual, or should be hidden
 * from the model picker.
 */
/**
 * Which rows the model pickers offer, laid out like Projects: providers down
 * the left, the picked one's models on the right, each row a switch. Off hides
 * a model from the composer, the plan review's "Build with" and the new-chat
 * default — never from a chat already running on it (`visibleModelOptions`).
 */
function ModelsSection(): React.JSX.Element {
  const defaults = useApp((s) => s.defaults)
  const setDefaults = useApp((s) => s.setDefaults)
  const dynamicModels = useApp((s) => s.models)
  const codexConfigModel = useApp((s) => s.codexConfigModel)
  const providerClis = useApp((s) => s.providerClis)
  const loadModels = useApp((s) => s.loadModels)
  const loadCodexConfigModel = useApp((s) => s.loadCodexConfigModel)
  const selectedCwd = useApp((s) => s.selectedCwd)
  const openSettings = useApp((s) => s.openSettings)
  const [picked, setPicked] = React.useState<Provider | null>(null)
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    void loadCodexConfigModel()
    void loadModels(undefined, selectedCwd ?? undefined)
  }, [loadCodexConfigModel, loadModels, selectedCwd])

  const models = assembleModelOptions(
    dynamicModels,
    codexConfigModel,
    availableProviders(providerClis)
  )
  const hidden = new Set(defaults?.hiddenModels ?? [])
  const write = (next: Set<string>): void => void setDefaults({ hiddenModels: [...next] })
  const groups = PROVIDERS.map((provider) => ({
    provider,
    rows: models.filter((o) => o.provider === provider)
  })).filter((g) => g.rows.length > 0)
  const shownOf = (rows: ModelOption[]): number =>
    rows.filter((o) => !hidden.has(modelKey(o.provider, o.id))).length

  // Falls back rather than being stored, as in Projects: a provider can be
  // switched off under the selection.
  const selected = groups.find((g) => g.provider === picked) ?? groups[0]
  const rows = selected ? selected.rows.filter((o) => matchesModelQuery(o, query)) : []
  const keys = selected ? selected.rows.map((o) => modelKey(o.provider, o.id)) : []

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-[264px] shrink-0 flex-col border-r border-border">
        <h2 className="px-4 pt-4 pb-2.5 text-[12px] font-medium text-muted-foreground">
          {groups.length} {groups.length === 1 ? 'provider' : 'providers'}
        </h2>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {groups.map((g) => {
            const shown = shownOf(g.rows)
            return (
              <button
                key={g.provider}
                type="button"
                aria-pressed={g === selected}
                onClick={() => {
                  setPicked(g.provider)
                  setQuery('')
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  g === selected ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                <ProviderAvatar provider={g.provider} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {PROVIDER_LABELS[g.provider]}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {shown === g.rows.length
                      ? `${g.rows.length} models`
                      : `${shown} of ${g.rows.length} shown`}
                  </div>
                </div>
              </button>
            )
          })}
          {groups.length === 0 && (
            <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">
              No provider is available.
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-border px-3 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            onClick={() => openSettings('providers')}
          >
            <Terminal />
            Manage providers
          </Button>
        </div>
      </div>

      {selected ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 px-6 pt-5 pb-3">
            <div className="flex items-center gap-2.5">
              <ProviderAvatar provider={selected.provider} className="rounded-md" />
              <h2 className="flex-1 text-[15px] font-semibold">
                {PROVIDER_LABELS[selected.provider]}
              </h2>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs"
                disabled={shownOf(selected.rows) === selected.rows.length}
                onClick={() => write(new Set([...hidden].filter((k) => !keys.includes(k))))}
              >
                Show all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs"
                disabled={shownOf(selected.rows) === 0}
                onClick={() => write(new Set([...hidden, ...keys]))}
              >
                Hide all
              </Button>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Switch a model off to keep it out of the model picker. A chat already on it keeps it.
            </p>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter models"
              className="mt-3 h-8 text-[13px]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <div className="overflow-hidden rounded-lg border border-border">
              {rows.map((o, i) => {
                const key = modelKey(o.provider, o.id)
                const on = !hidden.has(key)
                const resolved = resolvedModelName(o.resolvedModel)
                const toggle = (): void => {
                  const next = new Set(hidden)
                  if (on) next.add(key)
                  else next.delete(key)
                  write(next)
                }
                return (
                  <div
                    key={key}
                    onClick={toggle}
                    className={cn(
                      'flex cursor-default items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40',
                      i > 0 && 'border-t border-border'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 text-[13px]">
                        <span className={cn('truncate', !on && 'text-muted-foreground')}>
                          {o.label}
                        </span>
                        {resolved && resolved !== o.label && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/70">
                            {resolved}
                          </span>
                        )}
                      </div>
                      {o.description && (
                        <div className="truncate text-xs text-muted-foreground">
                          {o.description}
                        </div>
                      )}
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      <SwitchPill
                        on={on}
                        label={`Show ${o.label} in the model picker`}
                        onChange={toggle}
                      />
                    </div>
                  </div>
                )
              })}
              {rows.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  Nothing matches “{query}”.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <div className="max-w-sm text-center">
            <Sparkles className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-3 text-[13px] font-medium">No provider available</p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Install or turn on a provider in Providers and its models appear here.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The Providers section: the backends on the left, the picked one's install,
 * account and capability switches on the right — the same list-and-detail as
 * Models, because four providers each with a stack of switches made one long
 * column where the one you came for was below the fold.
 */
function ProvidersSection(): React.JSX.Element {
  const providerClis = useApp((s) => s.providerClis)
  const loadProviderClis = useApp((s) => s.loadProviderClis)
  const [rechecking, setRechecking] = React.useState(false)
  const [picked, setPicked] = React.useState<Provider | null>(null)

  // Re-probe on open: the common reason to be here is having just installed
  // something in a terminal next to the app, and asking the user to press a
  // button for an answer the app can fetch on its own would be the wrong
  // default. The button stays for the case of installing *while* looking at it.
  React.useEffect(() => {
    void loadProviderClis(true)
  }, [loadProviderClis])

  const recheck = async (): Promise<void> => {
    setRechecking(true)
    await loadProviderClis(true)
    setRechecking(false)
  }

  const none = providerClis.length > 0 && providerClis.every((cli) => !cli.installed)
  const selected = providerClis.find((cli) => cli.provider === picked) ?? providerClis[0]

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-[264px] shrink-0 flex-col border-r border-border">
        <h2 className="px-4 pt-4 pb-2.5 text-[12px] font-medium text-muted-foreground">
          {providerClis.length} {providerClis.length === 1 ? 'provider' : 'providers'}
        </h2>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {providerClis.map((cli) => {
            const status = providerStatus(cli)
            return (
              <button
                key={cli.provider}
                type="button"
                aria-pressed={cli === selected}
                onClick={() => setPicked(cli.provider)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  cli === selected ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                <ProviderAvatar
                  provider={cli.provider}
                  className={cn(!cli.installed || !cli.enabled ? 'opacity-50' : undefined)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {PROVIDER_LABELS[cli.provider]}
                  </div>
                  <div
                    className={cn(
                      'truncate text-[11px]',
                      status.warn ? 'text-warning' : 'text-muted-foreground'
                    )}
                  >
                    {status.text}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div className="shrink-0 space-y-1.5 border-t border-border px-3 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            onClick={() => void recheck()}
            disabled={rechecking}
          >
            {rechecking ? <DotSpinner /> : <RefreshCw />}
            Recheck installs
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {none && (
          <div className="mx-6 mt-5 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>
              None of the agent CLIs were found, so there is nothing to chat with yet. Install
              one, then Recheck.
            </span>
          </div>
        )}
        {selected ? (
          <ProviderDetail key={selected.provider} cli={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <DotSpinner />
          </div>
        )}
      </div>
    </div>
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
/** New-chat defaults: remembered from the last pick, or fixed here. */
const DEFAULTS_MODES: { id: 'last' | 'fixed'; label: string; icon: LucideIcon }[] = [
  { id: 'last', label: 'Last used', icon: History },
  { id: 'fixed', label: 'Fixed', icon: Pin }
]

const pickerTrigger =
  'h-8 max-w-56 border border-border bg-background px-2.5 text-foreground hover:bg-accent'

/**
 * What a new chat — and a thread's new column — starts on. The same four
 * choices the composer offers, written straight into `AppDefaults`. In "Last
 * used" they still move with every pick in a chat, so this is also where the
 * current defaults can be read; "Fixed" stops that (see `AppDefaults.fixed`).
 */
function NewChatDefaults(): React.JSX.Element | null {
  const defaults = useApp((s) => s.defaults)
  const setDefaults = useApp((s) => s.setDefaults)
  const dynamicModels = useApp((s) => s.models)
  const codexConfigModel = useApp((s) => s.codexConfigModel)
  const providerClis = useApp((s) => s.providerClis)
  const loadModels = useApp((s) => s.loadModels)
  const loadCodexConfigModel = useApp((s) => s.loadCodexConfigModel)
  const selectedCwd = useApp((s) => s.selectedCwd)
  React.useEffect(() => {
    void loadCodexConfigModel()
    void loadModels(undefined, selectedCwd ?? undefined)
  }, [loadCodexConfigModel, loadModels, selectedCwd])

  if (!defaults) return null
  const models = assembleModelOptions(
    dynamicModels,
    codexConfigModel,
    availableProviders(providerClis)
  )
  const provider = providerForRememberedModel(defaults.model, defaults.modelProvider, dynamicModels)
  const model = canonicalModelId(defaults.model ?? '', models)
  const option = models.find((o) => o.provider === provider && o.id === model)
  // Ids are unique only within a provider (`''` is Claude's Default row), and
  // a select value of `''` reads as empty — so key every row by both.
  const key = (p: Provider, id: string): string => `${p}:${id}`
  const modelOptions = visibleModelOptions(models, defaults.hiddenModels, [model]).map((o) => ({
    value: key(o.provider, o.id),
    label: o.label,
    description: resolvedModelName(o.resolvedModel) ?? o.description,
    group: PROVIDER_LABELS[o.provider]
  }))
  // A default on a provider since switched off still has to read as itself.
  if (!option) {
    modelOptions.unshift({
      value: key(provider, model),
      label: modelDisplayName(model, provider, models),
      description: 'Not available — check Settings → Providers',
      group: PROVIDER_LABELS[provider]
    })
  }

  const efforts = effortOptionsFor(option, provider)
  const effort = efforts.some((e) => e.id === defaults.effort) ? (defaults.effort ?? '') : ''
  const tiers = serviceTierOptionsFor(option, provider, dynamicModels)
  const tier = tiers.some((t) => t.id === defaults.serviceTier) ? defaults.serviceTier! : 'standard'
  const permissions = PROVIDER_PERMISSION_MODES[provider]
  const permission = permissions.some((m) => m.id === defaults.permissionMode)
    ? defaults.permissionMode
    : 'default'
  const permissionLook = permissionAppearance(permission, provider === 'codex')

  // One patch per pick, and a model pick carries everything it invalidates: the
  // provider always, plus an effort, speed or mode the new model lacks.
  const changeModel = (value: string): void => {
    const next = models.find((o) => key(o.provider, o.id) === value)
    if (!next) return
    const nextEfforts = effortOptionsFor(next, next.provider)
    const remembered = rememberedEffortForModel(defaults.modelEfforts, next.id, models)
    const nextEffort =
      remembered !== undefined && nextEfforts.some((e) => e.id === remembered)
        ? remembered
        : nextEfforts.some((e) => e.id === effort)
          ? effort
          : ''
    const nextTiers = serviceTierOptionsFor(next, next.provider, dynamicModels)
    const nextPermissions = PROVIDER_PERMISSION_MODES[next.provider]
    void setDefaults({
      model: next.id,
      modelProvider: next.provider,
      effort: nextEffort,
      serviceTier: nextTiers.some((t) => t.id === tier) ? tier : 'standard',
      permissionMode: nextPermissions.some((m) => m.id === permission) ? permission : 'default'
    })
  }

  const fixed = !!defaults.fixed
  return (
    <>
      <Row
        label="New chats start with"
        description={
          fixed
            ? 'Always the choices below. A pick in a chat stays in that chat.'
            : 'Whatever you picked last. Change it here or from any chat.'
        }
      >
        <div
          role="group"
          aria-label="New chat defaults"
          className="grid shrink-0 grid-cols-2 gap-1 rounded-xl bg-secondary p-1"
        >
          {DEFAULTS_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={(m.id === 'fixed') === fixed}
              onClick={() => void setDefaults({ fixed: m.id === 'fixed' })}
              className={cn(
                'flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
                (m.id === 'fixed') === fixed
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <m.icon className="size-3.5" />
              {m.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Model" description="The model, and so the provider, a new chat runs on.">
        <CompactSelect
          side="bottom"
          value={key(provider, model)}
          onValueChange={changeModel}
          options={modelOptions}
          icon={<ProviderMark provider={provider} className="size-3.5" />}
          className={pickerTrigger}
        />
      </Row>
      <Row label="Reasoning" description="How hard the model thinks before it answers.">
        <CompactSelect
          side="bottom"
          value={effort || 'default'}
          onValueChange={(v) => void setDefaults({ effort: v === 'default' ? '' : (v as EffortId) })}
          options={efforts.map((e) => ({
            value: e.id || 'default',
            label: e.label,
            description: e.description
          }))}
          icon={<Brain className="size-3.5" />}
          className={pickerTrigger}
        />
      </Row>
      {tiers.length > 1 && (
        <Row label="Speed" description="Fast answers sooner and uses more of your plan.">
          <CompactSelect
            side="bottom"
            value={tier}
            onValueChange={(v) => void setDefaults({ serviceTier: v as ServiceTier })}
            options={tiers.map((t) => ({ value: t.id, label: t.label, description: t.description }))}
            icon={<Zap className="size-3.5" />}
            className={pickerTrigger}
          />
        </Row>
      )}
      <Row label="Permissions" description="What the agent may do without asking first.">
        <CompactSelect
          side="bottom"
          value={permission}
          onValueChange={(v) => void setDefaults({ permissionMode: v as PermissionModeId })}
          options={permissions.map((m) => {
            const look = permissionAppearance(m.id, provider === 'codex')
            return {
              value: m.id,
              label: m.label,
              description: m.description,
              icon: <look.Icon className={cn('size-3.5', look.iconClassName)} />
            }
          })}
          icon={<permissionLook.Icon className={cn('size-3.5', permissionLook.iconClassName)} />}
          className={pickerTrigger}
        />
      </Row>
    </>
  )
}

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

/**
 * The voice the alerts are played in.
 *
 * A grid of names rather than a dropdown, for `ThemeGrid`'s reason at one
 * remove: you cannot compare sounds side by side, so the next best thing is
 * having every one of them a single click away. Selecting *is* the preview —
 * a separate play button beside each name would be a second control for the
 * one question the row exists to answer.
 *
 * The three cues are auditionable separately because the pack is only half the
 * choice: what a user actually wants to know is whether "finished" and "needs
 * you" are far enough apart to tell from the next room, and that is a question
 * about the pair.
 */
function SoundPicker({
  pack,
  enabled,
  onSelect
}: {
  pack: SoundPackId
  enabled: boolean
  onSelect: (id: SoundPackId) => void
}): React.JSX.Element {
  const cues: { kind: CueKind; label: string }[] = [
    { kind: 'complete', label: 'Finished' },
    { kind: 'attention', label: 'Needs you' },
    { kind: 'error', label: 'Failed' }
  ]
  return (
    // Dimmed rather than disabled when sound is off: a click here is an
    // explicit request to hear something, and refusing it would leave the only
    // way to audition a pack behind a toggle you have to flip first.
    <div className={cn('px-2 pb-2.5', !enabled && 'opacity-60')}>
      <div className="text-[13px] font-medium">Alert sound</div>
      <div className="mt-0.5 mb-2 text-xs text-muted-foreground">
        The voice for every cue — click one to hear it
      </div>
      <div role="group" aria-label="Alert sound" className="grid grid-cols-2 gap-2">
        {SOUND_PACKS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            aria-pressed={candidate.id === pack}
            onClick={() => {
              onSelect(candidate.id)
              playCue('complete', candidate.id)
            }}
            className={cn(
              'rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              candidate.id === pack
                ? 'border-primary/70 bg-accent/50'
                : 'border-border bg-card/40 hover:bg-accent/30'
            )}
          >
            <div className="text-[13px] font-medium">{candidate.name}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{candidate.description}</div>
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Hear:</span>
        {cues.map((cue) => (
          <button
            key={cue.kind}
            type="button"
            onClick={() => playCue(cue.kind, pack)}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            {cue.label}
          </button>
        ))}
      </div>
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
  const keepAwake = useApp((s) => !!s.defaults?.keepAwake)
  const setDefaults = useApp((s) => s.setDefaults)

  // Which section is open lives in the store: the sidebar's project menu and
  // the dev E2E harness both open Settings *at* a section, and neither can
  // reach a `useState` in here. Remembered across opens, so reopening lands
  // where you were.
  const settingsSection = useApp((s) => s.settingsSection)
  const setSection = useApp((s) => s.setSettingsSection)
  const section = settingsSection ?? 'appearance'

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
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

        {/* Section content.
            Projects (like Models and Providers) is not a column of settings but a
            *collection* — it takes the whole area and splits it into its own
            list and detail, each half scrolling independently. Everything else
            keeps the reading measure, which is the right width for a stack of
            labelled rows and the wrong one for a list of repositories. */}
        {section === 'projects' ? (
          <ProjectsSection />
        ) : section === 'models' ? (
          <ModelsSection />
        ) : section === 'providers' ? (
          <ProvidersSection />
        ) : (
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
                        label="Translucent chrome"
                        description="Frost the sidebar and the chat so the desktop blurs through behind them"
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
                    description="What a new chat starts with, and how chats are organised in the sidebar."
                  />
                  <NewChatDefaults />
                  <div className="mx-2 my-3 border-t border-border" />
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
                  <div className="mx-2 my-3 border-t border-border" />
                  <Toggle
                    label="Keep computer awake"
                    description="Stop the Mac from idle-sleeping while an agent is working. The display can still turn off, and closing the lid still sleeps it."
                    checked={keepAwake}
                    onChange={(on) => void setDefaults({ keepAwake: on })}
                  />
                </section>
              )}

              {/* The archive keeps the reading measure: an archived chat is a
                  row of four facts, not a collection with a detail pane like a
                  project. See `SettingsArchive`. */}
              {section === 'archive' && <ArchiveSection />}


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
                      description="Play a cue when a turn finishes, fails, or the agent needs your input"
                      checked={notifyPrefs.sound}
                      onChange={(sound) => {
                        setNotifyPrefs({ sound })
                        if (sound) playCue('complete', notifyPrefs.pack)
                      }}
                    />
                    <SoundPicker
                      pack={notifyPrefs.pack}
                      enabled={notifyPrefs.sound}
                      onSelect={(pack) => setNotifyPrefs({ pack })}
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
        )}
      </div>
    </div>
  )
}

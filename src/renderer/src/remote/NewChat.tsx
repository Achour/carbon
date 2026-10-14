import * as React from 'react'
import { Bell, ChevronDown, Folder } from 'lucide-react'
import { projectRoot, providerForRememberedModel, type Attachment } from '@shared/types'
import { rememberedEffortForModel, rememberedServiceTierForModel } from '@/lib/models'
import { greeting } from '@/lib/format'
import { ProjectAvatar } from '@/components/ui/project-avatar'
import { useRemote } from './state'
import { Header } from './App'
import { baseName } from './format'
import { Composer } from './Composer'
import { usePush } from './push'
import { OptionChips } from './OptionChips'
import { useAllModels, type OptionValues } from './options'
import { Sheet, SheetRow } from './Sheet'

/**
 * The home screen — the desktop's: a greeting, "What are we building?", the
 * project chip, and the composer with the same pickers the chat has. The
 * projects on offer are the Mac's recent folders, then every project a chat
 * already lives in — a phone has no folder picker that can see the Mac's disk.
 */
export function NewChatScreen({ initialCwd }: { initialCwd: string | null }): React.JSX.Element {
  const defaults = useRemote((s) => s.defaults)
  const chats = useRemote((s) => s.chats)
  const available = useRemote((s) => s.available)
  const icons = useRemote((s) => s.icons)
  const createChat = useRemote((s) => s.createChat)
  const all = useAllModels()

  const projects = React.useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (dir: string): void => {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
    if (initialCwd) add(initialCwd)
    for (const dir of defaults?.recentDirs ?? []) add(dir)
    for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.ephemeral && c.surface !== 'terminal') add(projectRoot(c))
    }
    return out
  }, [defaults, chats, initialCwd])

  const [cwd, setCwd] = React.useState<string | null>(initialCwd)
  const selected = cwd ?? projects[0] ?? null
  const [picking, setPicking] = React.useState(false)

  // Seeded from the Mac's New-chat defaults, the way its own screen is: the
  // remembered model, with the effort and speed last used on that model. A
  // provider that is not installed here is swapped for the first that is.
  const seed = React.useMemo((): OptionValues | null => {
    if (!defaults) return null
    let model = defaults.model ?? ''
    let provider = providerForRememberedModel(model, defaults.modelProvider, all)
    if (available.length && !available.includes(provider)) {
      const first = all[0]
      if (first) {
        provider = first.provider
        model = first.id
      }
    }
    return {
      provider,
      model,
      effort: rememberedEffortForModel(defaults.modelEfforts, model, all) ?? defaults.effort ?? '',
      serviceTier: rememberedServiceTierForModel(defaults.modelServiceTiers, model, all) ?? 'standard',
      permissionMode: defaults.permissionMode
    }
  }, [defaults, all, available])
  const [picked, setPicked] = React.useState<Partial<OptionValues>>({})
  const values = seed ? { ...seed, ...picked } : null
  const name = selected ? baseName(selected) : ''

  return (
    <div className="flex h-full flex-col">
      <Header title={null} />
      <div className="flex min-h-0 flex-1 flex-col justify-center px-6 pb-4">
        <div className="mb-1 text-center text-[15px] font-medium text-muted-foreground">{greeting()}</div>
        <h1 className="text-center text-[27px] font-semibold tracking-tight">What are we building?</h1>
        {!selected && (
          <p className="mt-4 text-center text-[14px] text-muted-foreground">
            Open a project in Carbon on your Mac first; it will appear here.
          </p>
        )}
        <NotifyCard />
      </div>
      {selected && values && (
        <Composer
          placeholder={`Start working in ${name}…`}
          above={
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="mb-2 flex h-9 max-w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-[14px] text-muted-foreground active:bg-accent"
            >
              <Folder className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-foreground">{name}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60" />
            </button>
          }
          tools={<OptionChips values={values} onChange={(patch) => setPicked((prev) => ({ ...prev, ...patch }))} />}
          onSubmit={async (text: string, attachments: Attachment[]) => {
            const id = await createChat({ cwd: selected, ...values }, text, attachments)
            // Replaced, not pushed: the new chat takes this screen's place.
            location.replace(`#/c/${encodeURIComponent(id)}`)
          }}
        />
      )}
      <Sheet open={picking} onClose={() => setPicking(false)} title="Project">
        {projects.map((dir) => (
          <SheetRow
            key={dir}
            selected={dir === selected}
            icon={<ProjectAvatar root={dir} name={baseName(dir)} icon={icons[dir] ?? null} size="sm" className="size-5" />}
            label={baseName(dir)}
            description={dir.replace(/^\/Users\/[^/]+/, '~')}
            onClick={() => {
              setCwd(dir)
              setPicking(false)
            }}
          />
        ))}
      </Sheet>
    </div>
  )
}

const NOTIFY_DISMISSED = 'carbon.remote.notifyDismissed'

/**
 * The offer to turn notifications on, once, where the app opens. iOS shows
 * its permission prompt only in answer to a tap, so the page cannot ask on
 * its own — this card is the tap. It appears only where turning them on can
 * work (`off`), and "Not now" puts it away for good; the sidebar's bell stays.
 */
function NotifyCard(): React.JSX.Element | null {
  const { state, busy, toggle } = usePush()
  const setError = useRemote((s) => s.setError)
  const [dismissed, setDismissed] = React.useState(() => {
    try {
      return localStorage.getItem(NOTIFY_DISMISSED) === '1'
    } catch {
      return false
    }
  })
  if (state !== 'off' || dismissed) return null
  const dismiss = (): void => {
    setDismissed(true)
    try {
      localStorage.setItem(NOTIFY_DISMISSED, '1')
    } catch {
      /* shown again next launch, which is harmless */
    }
  }
  return (
    <div className="mx-auto mt-8 w-full max-w-sm animate-in rounded-2xl border border-border bg-card p-4 fade-in">
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium">Get notified on this phone</div>
          <div className="mt-0.5 text-[13.5px] leading-snug text-muted-foreground">
            When an agent finishes, or needs your approval.
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="h-9 rounded-xl px-3 text-[14px] text-muted-foreground active:bg-accent"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle().catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          className="h-9 rounded-xl bg-primary px-3.5 text-[14px] font-medium text-primary-foreground active:opacity-80 disabled:opacity-50"
        >
          Turn on
        </button>
      </div>
    </div>
  )
}

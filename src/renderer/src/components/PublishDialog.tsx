import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Plus,
  TriangleAlert
} from 'lucide-react'
import type { PublishInfo } from '@shared/types'
import { cn } from '@/lib/utils'
import { defaultRepoName, sanitizeRepoName } from '@/lib/publish'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/**
 * GitHub's mark, from simple-icons (CC0) — inlined for the same reason
 * `ProviderMark`'s are: one `d` string does not need a package. lucide dropped
 * its brand icons in v1, and a generic cloud in the provider card would be the
 * one place in the dialog that doesn't say *which* host it means.
 */
function GitHubMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={cn('size-5', className)}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

type Step = 'provider' | 'repo' | 'summary'

const STEPS: { id: Step; label: string }[] = [
  { id: 'provider', label: 'Provider' },
  { id: 'repo', label: 'Repository' },
  { id: 'summary', label: 'Summary' }
]

/**
 * The three-step rail across the top. Steps behind the current one are
 * clickable — going back to change the name after reading the summary is the
 * whole reason a summary step exists — while steps ahead are not, since they
 * would skip the answer the current one is asking for.
 */
function StepRail({
  current,
  provider,
  onPick
}: {
  current: Step
  /** Names the provider once it's been chosen, the way step 1's own label does. */
  provider: string | null
  onPick: (step: Step) => void
}): React.JSX.Element {
  const index = STEPS.findIndex((s) => s.id === current)
  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      {STEPS.map((s, i) => {
        const active = s.id === current
        const done = i < index
        return (
          <button
            key={s.id}
            type="button"
            disabled={!done}
            onClick={() => onPick(s.id)}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
              active
                ? 'border-primary/60 bg-primary/10'
                : 'border-border/60 bg-secondary/40 disabled:opacity-70',
              done && 'hover:bg-accent/60'
            )}
          >
            {done ? (
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-2.5" />
              </span>
            ) : (
              <span
                className={cn(
                  'size-4 shrink-0 rounded-full border-2',
                  active ? 'border-primary' : 'border-muted-foreground/40'
                )}
              />
            )}
            <span className="min-w-0">
              <span className="block text-[9.5px] font-semibold tracking-wider text-muted-foreground uppercase">
                Step {i + 1}
              </span>
              <span className="block truncate text-[12.5px] font-semibold">
                {s.id === 'provider' && provider ? `Provider: ${provider}` : s.label}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A framed, selectable choice — the visibility pair and the provider card. */
function Choice({
  selected,
  onClick,
  icon,
  title,
  hint,
  tag,
  disabled
}: {
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  hint?: string
  tag?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary/60 bg-primary/10' : 'border-border/60 hover:bg-accent/50',
        disabled && 'opacity-60'
      )}
    >
      <span className="shrink-0 text-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        {hint && <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>}
      </span>
      {tag && <span className="shrink-0 text-[11px] text-warning">{tag}</span>}
    </button>
  )
}

function CheckRow({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

/** One line of "here is what Publish will do". */
function SummaryRow({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * "Publish repository" — the `publish-github` rung of the source-control ladder,
 * which is the state a freshly initialized project lands in.
 *
 * It is a dialog rather than an agent prompt because the three things it needs
 * are decisions, not work: who owns the repository, what it is called, and
 * whether the world can read it. Delegating them meant an agent invented a name
 * and quietly chose private — a reasonable guess, made silently, about the one
 * step that is irreversible from inside the app.
 *
 * The steps are the reference shape (provider → repository → summary) and the
 * provider step earns its place even with one provider on it: a missing `gh`
 * or a missing login is a fact about the machine, and this is where it is said,
 * with the command that fixes it and a terminal to run it in.
 */
export function PublishDialog(): React.JSX.Element | null {
  const open = useApp((s) => s.publishOpen)
  const setOpen = useApp((s) => s.setPublishOpen)
  const cwd = useApp((s) => s.selectedCwd)
  const github = useApp((s) => s.github)
  const git = useApp((s) => s.git)
  const refreshGithub = useApp((s) => s.refreshGithub)
  const publishRepo = useApp((s) => s.publishRepo)
  const openTerminal = useApp((s) => s.openTerminal)

  const [step, setStep] = React.useState<Step>('provider')
  const [info, setInfo] = React.useState<PublishInfo | null>(null)
  const [owner, setOwner] = React.useState('')
  const [name, setName] = React.useState('')
  const [isPrivate, setPrivate] = React.useState(true)
  const [description, setDescription] = React.useState('')
  const [advanced, setAdvanced] = React.useState(false)
  const [commitAll, setCommitAll] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  const dirty = git?.changes.length ?? 0

  // Everything resets on open: the dialog is cheap to reopen and a stale owner
  // or name from a different project would be worse than a blank field.
  React.useEffect(() => {
    if (!open) return
    setStep('provider')
    setInfo(null)
    setOwner('')
    setName(cwd ? defaultRepoName(cwd) : '')
    setPrivate(true)
    setDescription('')
    setAdvanced(false)
    setBusy(false)
    setError(null)
    setDone(null)
    void refreshGithub()
    if (!cwd) return
    let cancelled = false
    void window.api.githubPublishInfo(cwd).then((i) => {
      if (cancelled) return
      setInfo(i)
      setOwner(i.login)
      // Checked only when there is genuinely nothing committed to push: a repo
      // with real history keeps its staging exactly as the user left it.
      setCommitAll(i.empty)
    })
    return () => {
      cancelled = true
    }
  }, [open, cwd, refreshGithub])

  if (!open) return null

  // Only the gh handshake gates the first step. `info` is what fills the owner
  // in on the *second* one, and waiting for two more round-trips before Next
  // lights up made a ready machine feel like a broken one.
  const loading = !github
  const installed = github?.installed ?? false
  const authed = github?.authed ?? false
  const ready = installed && authed
  const owners = info ? [info.login, ...info.orgs].filter(Boolean) : []
  const fullName = `${owner ? `${owner}/` : ''}${name}`
  const commits = (info?.commits ?? 0) + (commitAll ? 1 : 0)
  const branch = info?.branch || git?.branch || 'the current branch'

  const setup = !installed
    ? {
        text: 'The GitHub CLI is what creates the repository, and it is not installed.',
        command: 'brew install gh'
      }
    : !authed
      ? {
          text: 'The GitHub CLI is installed but not signed in to an account.',
          command: 'gh auth login'
        }
      : null

  const publish = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await publishRepo({
      owner,
      name,
      private: isPrivate,
      description,
      commitAll: commitAll && dirty > 0
    })
    setBusy(false)
    if (res.ok) setDone(res.url)
    else setError(res.error)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && setOpen(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Publish repository</DialogTitle>
        <DialogDescription>
          {done
            ? 'This project now lives on GitHub.'
            : 'Create a repository for this project and push it there.'}
        </DialogDescription>

        {done ? (
          <>
            <div className="mt-5 flex items-center gap-2.5 rounded-lg border border-border/60 px-3 py-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                <Check className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{fullName}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  Pushed {branch} · {isPrivate ? 'Private' : 'Public'}
                </span>
              </span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => void window.api.openExternal(done)}>
                <ExternalLink /> Open on GitHub
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <StepRail
              current={step}
              provider={step === 'provider' ? null : 'GitHub'}
              onPick={setStep}
            />

            <div className="mt-5 min-h-38">
              {step === 'provider' && (
                <>
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Provider</p>
                  <Choice
                    selected
                    onClick={() => {}}
                    icon={<GitHubMark />}
                    title="GitHub"
                    hint={
                      loading
                        ? 'Checking the GitHub CLI…'
                        : ready
                          ? `Signed in${info?.login ? ` as ${info.login}` : ''}`
                          : undefined
                    }
                    tag={!loading && !ready ? 'Setup required' : undefined}
                  />
                  {setup && !loading && (
                    <div className="mt-3 rounded-lg border border-border/60 bg-secondary/40 p-3">
                      <p className="text-[12px] text-muted-foreground">{setup.text}</p>
                      <code className="mt-2 block rounded bg-background/60 px-2 py-1 font-mono text-[11.5px]">
                        {setup.command}
                      </code>
                      <div className="mt-2.5 flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            openTerminal({
                              cwd: cwd ?? undefined,
                              command: setup.command,
                              label: 'GitHub'
                            })
                            setOpen(false)
                          }}
                        >
                          Run in terminal
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void refreshGithub()}>
                          Check again
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {step === 'repo' && (
                <>
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Repository</p>
                  <div className="flex items-stretch overflow-hidden rounded-lg border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                    <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-secondary/60 px-2.5 font-mono text-[12px] text-muted-foreground">
                      <GitHubMark className="size-3.5" />
                      github.com/
                    </span>
                    {!info ? (
                      <span className="flex shrink-0 items-center pl-2 font-mono text-[13px] text-muted-foreground">
                        <span className="shimmer-text">…</span>
                      </span>
                    ) : owners.length > 1 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              className="flex shrink-0 items-center gap-0.5 px-2 font-mono text-[13px] transition-colors hover:bg-accent/60"
                            >
                              {owner}/
                              <ChevronDown className="size-3 opacity-60" />
                            </button>
                          }
                        />
                        <DropdownMenuContent align="start">
                          {owners.map((o) => (
                            <DropdownMenuItem key={o} onClick={() => setOwner(o)}>
                              <span className="flex-1">{o}</span>
                              {o === owner && <Check className="opacity-70" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      owner && (
                        <span className="flex shrink-0 items-center pl-2 font-mono text-[13px]">
                          {owner}/
                        </span>
                      )
                    )}
                    <Input
                      autoFocus
                      value={name}
                      spellCheck={false}
                      placeholder="repository-name"
                      onChange={(e) => setName(sanitizeRepoName(e.target.value))}
                      className="h-9 rounded-none border-0 font-mono focus-visible:ring-0"
                    />
                  </div>

                  <p className="mt-4 mb-1.5 text-[11px] font-medium text-muted-foreground">
                    Visibility
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Choice
                      selected={isPrivate}
                      onClick={() => setPrivate(true)}
                      icon={<Lock className="size-4" />}
                      title="Private"
                      hint="Only invited people"
                    />
                    <Choice
                      selected={!isPrivate}
                      onClick={() => setPrivate(false)}
                      icon={<Globe className="size-4" />}
                      title="Public"
                      hint="Anyone on the web"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setAdvanced((a) => !a)}
                    className="mt-3 flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronRight className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} />
                    Advanced
                  </button>
                  {advanced && (
                    <Input
                      value={description}
                      placeholder="Description (optional)"
                      onChange={(e) => setDescription(e.target.value)}
                      className="mt-2"
                    />
                  )}
                </>
              )}

              {step === 'summary' && (
                <>
                  <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                    <SummaryRow icon={<Plus className="size-3.5" />}>
                      Create <span className="font-mono">{fullName}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        · {isPrivate ? 'Private' : 'Public'}
                      </span>
                    </SummaryRow>
                    <SummaryRow icon={<GitBranch className="size-3.5" />}>
                      Add it as <span className="font-mono">origin</span>
                    </SummaryRow>
                    <SummaryRow icon={<CloudUpload className="size-3.5" />}>
                      Push <span className="font-mono">{branch}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        · {commits} commit{commits === 1 ? '' : 's'}
                      </span>
                    </SummaryRow>
                  </div>

                  {dirty > 0 && (
                    <div className="mt-2.5">
                      <CheckRow
                        checked={commitAll}
                        onChange={setCommitAll}
                        label={`Commit all ${dirty} changed file${dirty === 1 ? '' : 's'} first`}
                        hint={
                          commitAll
                            ? 'Everything in the folder is committed, then published.'
                            : 'Leave this off and only committed work is published — the rest stays on this Mac.'
                        }
                      />
                    </div>
                  )}
                  {info?.empty && !commitAll && (
                    <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] text-warning">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" />
                      Nothing has been committed yet, so this publishes an empty repository.
                    </p>
                  )}
                  {error && (
                    <p className="mt-2.5 rounded-md bg-secondary/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-destructive">
                      {error}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (step === 'provider') setOpen(false)
                  else setStep(step === 'summary' ? 'repo' : 'provider')
                }}
              >
                {step === 'provider' ? 'Cancel' : 'Back'}
              </Button>
              {step === 'summary' ? (
                <Button disabled={busy || !name} onClick={() => void publish()}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {busy ? 'Publishing…' : 'Publish'}
                </Button>
              ) : (
                <Button
                  disabled={step === 'provider' ? loading || !ready : !name}
                  onClick={() => setStep(step === 'provider' ? 'repo' : 'summary')}
                >
                  Next
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

import * as React from 'react'
import {
  FileDiff,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  Loader2,
  PanelLeft,
  PanelRight,
  SquareTerminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerForModel } from '@shared/types'
import type {
  Attachment,
  EffortId,
  PermissionModeId,
  Provider,
  ServiceTier,
  WorktreeTarget
} from '@shared/types'
import { basename, greeting } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Composer } from '@/components/Composer'
import { ContextStrip } from '@/components/ContextStrip'
import { WorktreePicker } from '@/components/WorktreePicker'

/** One row in the home-screen quick-launch rail. */
function RailAction({
  icon,
  label,
  onClick,
  disabled = false,
  children
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors [&_svg]:size-4',
        disabled
          ? 'cursor-default text-muted-foreground/40'
          : 'text-foreground hover:bg-accent'
      )}
    >
      <span className={cn('shrink-0', !disabled && 'text-muted-foreground')}>{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
      {children}
    </button>
  )
}

export function NewChat(): React.JSX.Element {
  const defaults = useApp((s) => s.defaults)
  const cwd = useApp((s) => s.selectedCwd)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const newChat = useApp((s) => s.newChat)
  const togglePanel = useApp((s) => s.togglePanel)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const browseFiles = useApp((s) => s.browseFiles)
  const openTerminal = useApp((s) => s.openTerminal)
  const openPreview = useApp((s) => s.openPreview)
  const panelOpen = useApp((s) => s.panelOpen)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const git = useApp((s) => s.git)
  const commands = useApp((s) => s.commands)

  const [model, setModel] = React.useState(defaults?.model ?? '')
  const [modelProvider, setModelProvider] = React.useState<Provider>(
    defaults?.modelProvider ?? providerForModel(defaults?.model ?? '')
  )
  const changeModel = (next: string, provider: Provider): void => {
    setModel(next)
    setModelProvider(provider)
  }
  const [effort, setEffort] = React.useState<EffortId | ''>(defaults?.effort ?? '')
  // Per-model effort memory for this compose session, seeded from the persisted
  // defaults. Switching models restores each one's last effort (via the
  // composer); a genuine pick updates the map, keyed by the current model. An
  // app correction (`remember: false`) applies but isn't recorded.
  const [modelEfforts, setModelEfforts] = React.useState<Record<string, EffortId | ''>>(
    defaults?.modelEfforts ?? {}
  )
  const changeEffort = (next: EffortId | '', opts?: { remember?: boolean }): void => {
    setEffort(next)
    if (opts?.remember === false) return
    setModelEfforts((prev) => {
      const map = { ...prev }
      map[model] = next
      return map
    })
  }
  const [serviceTier, setServiceTier] = React.useState<ServiceTier>(
    defaults?.serviceTier ?? 'standard'
  )
  // Creating a chat also records its options as the defaults. A tier the
  // composer *corrected* (Fast on a model that lacks it) isn't a user choice, so
  // it's sent as undefined — the chat still starts Standard, but the stored
  // preference survives for the next chat on a model that does support Fast.
  const tierCorrected = React.useRef(false)
  const changeServiceTier = (next: ServiceTier, opts?: { remember?: boolean }): void => {
    tierCorrected.current = opts?.remember === false
    setServiceTier(next)
  }
  const [permissionMode, setPermissionMode] = React.useState<PermissionModeId>(
    defaults?.permissionMode ?? 'default'
  )
  // Scope the worktree choice to the project it was made in. NewChat stays
  // mounted while the sidebar switches projects, so a bare `target` state would
  // otherwise carry an existing worktree from project A into project B.
  const [targetSelection, setTargetSelection] = React.useState<{
    cwd: string | null
    target: WorktreeTarget
  }>({ cwd, target: { kind: 'local' } })
  const target: WorktreeTarget =
    targetSelection.cwd === cwd ? targetSelection.target : { kind: 'local' }
  const setTarget = React.useCallback(
    (next: WorktreeTarget) => setTargetSelection({ cwd, target: next }),
    [cwd]
  )
  // Creating a worktree is a full checkout — it can take seconds on a big repo,
  // and it can fail. Both need to be visible or sending looks like a no-op.
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const pendingTarget = useApp((s) => s.pendingTarget)
  const clearPendingTarget = useApp((s) => s.clearPendingTarget)

  // "New chat in this worktree" (sidebar) preselects the worktree in the picker,
  // so both entry points run through the same target state. Consume-and-clear:
  // the target owns the selection from here on.
  React.useEffect(() => {
    if (!pendingTarget) return
    setTarget(pendingTarget)
    clearPendingTarget()
  }, [pendingTarget, clearPendingTarget])

  // The rail shows its own compact changes affordance, separate from the strip.
  const hasChanges = !!git?.isRepo && git.changes.length > 0

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setSelectedCwd(dir)
  }

  const start = async (text: string, attachments: Attachment[]): Promise<void> => {
    if (!cwd) return
    // The picker's target decides the chat's directory; branch names for new
    // worktrees are generated main-side. Creation is scoped to the project the
    // worktree branched from, so recents and sidebar grouping track the project
    // rather than the worktree — which matters when the selected cwd IS a
    // worktree (arrived from the sidebar).
    const root = target.kind === 'existing' ? target.repoRoot : cwd
    setStartError(null)
    setStarting(true)
    try {
      await newChat(root, text, {
        provider: modelProvider,
        model: model || undefined,
        effort: effort || undefined,
        serviceTier: tierCorrected.current ? undefined : serviceTier,
        permissionMode,
        attachments: attachments.length ? attachments : undefined,
        worktree: target.kind === 'local' ? undefined : target
      })
    } catch (err) {
      // The preload bridge already unwraps Electron's IPC error envelope, so
      // this is git's own message.
      setStartError((err as Error)?.message || String(err))
      // Rethrow so the composer restores the draft instead of losing it.
      throw err
    } finally {
      setStarting(false)
    }
  }

  return (
    <div data-newchat className="@container relative flex h-full min-w-[420px] flex-1 flex-col">
      <header
        className={cn(
          'drag flex h-[38px] shrink-0 items-center gap-2 px-4',
          !sidebarOpen && 'pl-[84px]'
        )}
      >
        {!sidebarOpen && (
          <WithTooltip label="Show sidebar  ⌘B">
            <Button size="icon-sm" variant="ghost" onClick={toggleSidebar} aria-label="Show sidebar">
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <div className="flex-1" />
        {/* When the panel is open its own header hosts the collapse button. */}
        {cwd && !panelOpen && (
          <WithTooltip label="Show files">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={togglePanel}
              aria-label="Show file panel"
            >
              <PanelRight />
            </Button>
          </WithTooltip>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="w-full max-w-2xl animate-enter pb-24">
            <div className="mb-1 text-center text-[15px] font-medium text-muted-foreground">
              {greeting()}
            </div>
            <h1 className="mb-8 text-center text-[28px] font-semibold tracking-tight">
              What are we building?
            </h1>

            {cwd ? (
              <>
                {/* Always shown, like ChatView's — the project you're about to
                    work in shouldn't disappear just because the quick-launch
                    rail also names it. */}
                <ContextStrip
                  cwd={cwd}
                  git={git}
                  // A worktree target shows its own branch, not the checkout's.
                  branch={target.kind === 'existing' ? target.branch : undefined}
                  onReviewChanges={() => void reviewChanges()}
                >
                  {git?.isRepo && (
                    <WorktreePicker
                      cwd={cwd}
                      value={target}
                      onChange={setTarget}
                      disabled={starting}
                    />
                  )}
                </ContextStrip>
                <Composer
                  // Returned, not voided: the composer needs the promise so it
                  // can put the draft back if starting the chat fails.
                  onSend={(text, attachments) => start(text, attachments)}
                  model={model}
                  onModelChange={changeModel}
                  effort={effort}
                  onEffortChange={changeEffort}
                  modelEfforts={modelEfforts}
                  serviceTier={serviceTier}
                  onServiceTierChange={changeServiceTier}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  provider={modelProvider}
                  cwd={cwd}
                  commands={commands}
                  placeholder={`Start working in ${basename(cwd)}…`}
                  disabled={starting}
                />
                {starting && target.kind === 'new' && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Creating worktree…
                  </p>
                )}
                {startError && (
                  <p className="mt-2 text-xs break-words text-destructive">{startError}</p>
                )}
              </>
            ) : (
              <div className="flex justify-center">
                <Button onClick={() => void browse()}>
                  <FolderOpen /> Open a project…
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Quick-launch rail, Cursor/Codex-style — only when width allows and no
            panel is open (the panel provides the same tools once it's up). */}
        {cwd && !panelOpen && (
          <aside
            data-quick-rail
            className="hidden w-64 shrink-0 flex-col gap-0.5 overflow-y-auto p-3 @min-[62rem]:flex"
          >
            <WithTooltip label={cwd}>
              <div className="mb-2 flex items-center gap-1.5 px-2 text-xs text-muted-foreground/70">
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{basename(cwd)}</span>
                {git?.isRepo && git.branch && (
                  <>
                    <span className="text-border">/</span>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{git.branch}</span>
                  </>
                )}
              </div>
            </WithTooltip>
            <RailAction
              icon={<FileDiff />}
              label="Review changes"
              onClick={() => void reviewChanges()}
              disabled={!hasChanges}
            >
              {hasChanges && (
                <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-[11px] whitespace-nowrap tabular-nums">
                  {git!.additions === 0 && git!.deletions === 0 ? (
                    <span className="text-muted-foreground">{git!.changes.length}</span>
                  ) : (
                    <>
                      <span className="text-success">+{git!.additions}</span>
                      <span className="text-destructive">−{git!.deletions}</span>
                    </>
                  )}
                </span>
              )}
            </RailAction>
            <RailAction icon={<FolderTree />} label="Files" onClick={browseFiles} />
            <RailAction icon={<SquareTerminal />} label="Terminal" onClick={() => openTerminal()} />
            <RailAction icon={<Globe />} label="Browser preview" onClick={() => openPreview()} />
          </aside>
        )}
      </div>
    </div>
  )
}

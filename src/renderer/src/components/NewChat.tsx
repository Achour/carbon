import * as React from 'react'
import {
  FileDiff,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  PanelLeft,
  PanelRight,
  SquareTerminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerForModel } from '@shared/types'
import type { Attachment, EffortId, PermissionModeId } from '@shared/types'
import { basename, greeting } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Composer } from '@/components/Composer'

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
  const [effort, setEffort] = React.useState<EffortId | ''>(defaults?.effort ?? '')
  const [permissionMode, setPermissionMode] = React.useState<PermissionModeId>(
    defaults?.permissionMode ?? 'default'
  )

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setSelectedCwd(dir)
  }

  const start = async (text: string, attachments: Attachment[]): Promise<void> => {
    if (!cwd) return
    await newChat(cwd, text, {
      provider: providerForModel(model),
      model: model || undefined,
      effort: effort || undefined,
      permissionMode,
      attachments: attachments.length ? attachments : undefined
    })
  }

  const hasChanges = !!git?.isRepo && git.changes.length > 0

  // Repo · branch · changes — the same context strip ChatView keeps above the
  // composer. On the home screen it only appears when the quick-launch rail is
  // hidden (narrow window); when the rail shows, that info lives there instead.
  const contextStrip = (
    <>
      <WithTooltip label={cwd ?? ''}>
        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground">
          <Folder className="size-3 shrink-0" />
          <span className="max-w-44 truncate">{cwd ? basename(cwd) : ''}</span>
          {git?.isRepo && git.branch && (
            <>
              <span className="text-border">/</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{git.branch}</span>
            </>
          )}
        </div>
      </WithTooltip>
      {hasChanges && (
        <WithTooltip
          label={`Review changes — ${git!.changes.length} file${git!.changes.length === 1 ? '' : 's'}`}
        >
          <button
            type="button"
            onClick={() => void reviewChanges()}
            aria-label="Review changes"
            className="flex items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileDiff className="size-3 text-muted-foreground" />
            {git!.additions === 0 && git!.deletions === 0 ? (
              <span className="text-muted-foreground">{git!.changes.length}</span>
            ) : (
              <>
                <span className="text-success">+{git!.additions}</span>
                <span className="text-destructive">−{git!.deletions}</span>
              </>
            )}
          </button>
        </WithTooltip>
      )}
    </>
  )

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
                {/* Context strip — only when the rail is hidden (narrow window),
                    so the repo/branch/changes info is never lost. */}
                <div
                  data-context-strip
                  className="mb-2 flex items-center gap-2 @min-[62rem]:hidden"
                >
                  {contextStrip}
                </div>
                <Composer
                  onSend={(text, attachments) => void start(text, attachments)}
                  model={model}
                  onModelChange={setModel}
                  effort={effort}
                  onEffortChange={setEffort}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  provider={providerForModel(model)}
                  cwd={cwd}
                  commands={commands}
                  placeholder={`Start working in ${basename(cwd)}…`}
                />
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
            <RailAction icon={<SquareTerminal />} label="Terminal" onClick={openTerminal} />
            <RailAction icon={<Globe />} label="Browser preview" onClick={() => openPreview()} />
          </aside>
        )}
      </div>
    </div>
  )
}

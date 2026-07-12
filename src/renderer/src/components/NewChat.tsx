import * as React from 'react'
import { Folder, FolderOpen, GitBranch, PanelLeft, PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Attachment, EffortId, PermissionModeId } from '@shared/types'
import { basename, greeting } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { Composer } from '@/components/Composer'

export function NewChat(): React.JSX.Element {
  const defaults = useApp((s) => s.defaults)
  const cwd = useApp((s) => s.selectedCwd)
  const setSelectedCwd = useApp((s) => s.setSelectedCwd)
  const newChat = useApp((s) => s.newChat)
  const togglePanel = useApp((s) => s.togglePanel)
  const panelOpen = useApp((s) => s.panelOpen)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const git = useApp((s) => s.git)

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
      model: model || undefined,
      effort: effort || undefined,
      permissionMode,
      attachments: attachments.length ? attachments : undefined
    })
  }

  return (
    <div className="relative flex h-full min-w-[420px] flex-1 flex-col">
      <header
        className={cn(
          'drag flex h-[52px] shrink-0 items-center gap-2 px-4',
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
        {cwd && (
          <WithTooltip label={cwd}>
            <div className="no-drag flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-1 text-xs text-muted-foreground">
              <Folder className="size-3" />
              <span className="max-w-44 truncate">{basename(cwd)}</span>
              {git?.isRepo && git.branch && (
                <>
                  <span className="text-border">/</span>
                  <GitBranch className="size-3" />
                  <span className="max-w-32 truncate">{git.branch}</span>
                </>
              )}
            </div>
          </WithTooltip>
        )}
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
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6">
        <div className="w-full max-w-2xl animate-enter pb-24">
          <div className="mb-1 text-center text-[15px] font-medium text-muted-foreground">
            {greeting()}
          </div>
          <h1 className="mb-8 text-center text-[28px] font-semibold tracking-tight">
            What are we building?
          </h1>

          {cwd ? (
            <Composer
              onSend={(text, attachments) => void start(text, attachments)}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              cwd={cwd}
              placeholder={`Start working in ${basename(cwd)}…`}
            />
          ) : (
            <div className="flex justify-center">
              <Button onClick={() => void browse()}>
                <FolderOpen /> Open a project…
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

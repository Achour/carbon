import * as React from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

function TreeNode({ dir, depth }: { dir: string; depth: number }): React.JSX.Element | null {
  const entries = useApp((s) => s.filesByDir[dir])
  const expandedDirs = useApp((s) => s.expandedDirs)
  const toggleDir = useApp((s) => s.toggleDir)
  const openFile = useApp((s) => s.openFile)
  const activeTab = useApp((s) => s.activeTab)

  if (!entries) {
    return (
      <div
        className="py-1 text-[11px] text-muted-foreground/60"
        style={{ paddingLeft: 14 + depth * 14 }}
      >
        Loading…
      </div>
    )
  }

  if (entries.length === 0 && depth === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</div>
  }

  return (
    <>
      {entries.map((entry) => {
        const expanded = entry.kind === 'dir' && expandedDirs[entry.path]
        const dotfile = entry.name.startsWith('.')
        return (
          <React.Fragment key={entry.path}>
            <button
              type="button"
              onClick={() =>
                entry.kind === 'dir'
                  ? toggleDir(entry.path)
                  : void openFile(entry.path, { preview: true })
              }
              onDoubleClick={() => {
                if (entry.kind === 'file') void openFile(entry.path)
              }}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] transition-colors hover:bg-accent/60',
                activeTab === entry.path && 'bg-accent',
                dotfile && 'opacity-60'
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {entry.kind === 'dir' ? (
                <>
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150',
                      expanded && 'rotate-90'
                    )}
                  />
                  {expanded ? (
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileText className="size-3.5 shrink-0 text-muted-foreground/80" />
                </>
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {expanded && <TreeNode dir={entry.path} depth={depth + 1} />}
          </React.Fragment>
        )
      })}
    </>
  )
}

export function FileTree(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const loaded = useApp((s) => (s.selectedCwd ? Boolean(s.filesByDir[s.selectedCwd]) : false))
  const loadDir = useApp((s) => s.loadDir)
  const refreshFiles = useApp((s) => s.refreshFiles)
  const [refreshing, setRefreshing] = React.useState(false)

  React.useEffect(() => {
    if (cwd && !loaded) void loadDir(cwd)
  }, [cwd, loaded, loadDir])

  if (!cwd) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        Open a project to browse its files.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5">
        <span className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {basename(cwd)}
        </span>
        <div className="flex-1" />
        <WithTooltip label="Refresh files">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="Refresh files"
            onClick={() => {
              setRefreshing(true)
              void refreshFiles().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </WithTooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <TreeNode dir={cwd} depth={0} />
      </div>
    </div>
  )
}

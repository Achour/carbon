import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronRight, FileDiff, Folder, Loader2, RotateCcw } from 'lucide-react'
import type { AssistantMessage, GitFileChange, RewindResult } from '@shared/types'
import { cn } from '@/lib/utils'
import { changedPathsFromParts, groupChanges, type ChangedFile } from '@/lib/turnChanges'
import { FileIcon } from '@/lib/fileIcon'
import { useApp } from '@/store'
import { LineDeltas } from '@/components/GitPanel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function summarize(paths: string[], changes: GitFileChange[]): ChangedFile[] {
  return paths.map((path) => {
    const rows = changes.filter((change) => change.path === path)
    return {
      path,
      additions: rows.reduce((sum, row) => sum + (row.additions ?? 0), 0),
      deletions: rows.reduce((sum, row) => sum + (row.deletions ?? 0), 0)
    }
  })
}

/** A file row: its name, then the directory it sits in, dimmed — the way every
 *  other file list in the app names one. Inside a directory group the prefix is
 *  already the row above, so `dir` is omitted there. */
function FileRow({
  file,
  dir,
  depth,
  onOpen
}: {
  file: ChangedFile
  dir?: string
  depth: number
  onOpen: (path: string) => void
}): React.JSX.Element {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <button
      type="button"
      title={`Open ${file.path}`}
      onClick={() => onOpen(file.path)}
      className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs transition-colors hover:bg-accent/50"
      style={{ paddingLeft: 6 + depth * 16 }}
    >
      <FileIcon path={file.path} className="size-3.5 shrink-0" />
      <span className="truncate text-foreground/90 group-hover:text-foreground">{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{dir}</span>}
      {!dir && <span className="flex-1" />}
      <LineDeltas additions={file.additions} deletions={file.deletions} className="text-xs" />
    </button>
  )
}

export const TurnChangesCard = React.memo(function TurnChangesCard({
  message,
  cwd,
  userMessageId
}: {
  message: AssistantMessage
  cwd: string
  userMessageId: string
}): React.JSX.Element | null {
  const git = useApp((state) => state.git)
  const reviewChanges = useApp((state) => state.reviewChanges)
  const rewindFiles = useApp((state) => state.rewindFiles)
  const openDiff = useApp((state) => state.openDiff)
  const openFile = useApp((state) => state.openFile)
  const paths = React.useMemo(() => changedPathsFromParts(message.parts, cwd), [message.parts, cwd])
  const files = React.useMemo(
    () => message.fileChanges ?? summarize(paths, git?.changes ?? []),
    [message.fileChanges, paths, git?.changes]
  )
  const entries = React.useMemo(() => groupChanges(files), [files])
  const [open, setOpen] = React.useState(true)
  const [closedDirs, setClosedDirs] = React.useState<Record<string, boolean>>({})
  const [undoOpen, setUndoOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<RewindResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [undone, setUndone] = React.useState(false)

  React.useEffect(() => {
    if (!undoOpen) {
      setPreview(null)
      return
    }
    let alive = true
    setBusy(true)
    void rewindFiles(userMessageId, true).then((result) => {
      if (alive) {
        setPreview(result)
        setBusy(false)
      }
    })
    return () => {
      alive = false
    }
  }, [undoOpen, rewindFiles, userMessageId])

  // A row opens that file's diff while the change is still in the working tree;
  // once it is committed (or the card is scrolled back to from an older turn)
  // there is no diff left to show, so fall back to opening the file itself.
  const openChange = React.useCallback(
    (path: string): void => {
      const changes = git?.changes ?? []
      const change = changes.find((c) => c.path === path && !c.staged) ?? changes.find((c) => c.path === path)
      if (change) void openDiff(change, { preview: true })
      else void openFile(path.startsWith('/') ? path : `${cwd}/${path}`, { preview: true })
    },
    [git?.changes, openDiff, openFile, cwd]
  )

  if (files.length === 0) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)

  const applyUndo = async (): Promise<void> => {
    setBusy(true)
    const result = await rewindFiles(userMessageId, false)
    setBusy(false)
    setPreview(result)
    if (result.canRewind) {
      setUndone(true)
      setUndoOpen(false)
    }
  }

  return (
    <Collapsible.Root
      open={open && !undone}
      onOpenChange={setOpen}
      className="animate-enter overflow-hidden rounded-xl border border-border bg-card/60"
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Collapsible.Trigger
          disabled={undone}
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 text-left outline-none disabled:cursor-default"
        >
          {!undone && (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
          )}
          <span className="shrink-0 text-[13px] font-medium">
            {undone
              ? 'Changes undone'
              : `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
          </span>
          {!undone && <LineDeltas additions={additions} deletions={deletions} className="text-xs" />}
        </Collapsible.Trigger>
        {!undone && (
          <>
            <Popover open={undoOpen} onOpenChange={setUndoOpen}>
              <PopoverTrigger
                render={
                  <Button size="sm" variant="ghost">
                    <RotateCcw /> Undo
                  </Button>
                }
              />
              <PopoverContent side="top" align="end" className="w-72">
                <div className="text-[13px] font-medium">Undo this turn’s file changes?</div>
                {busy && !preview ? (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Checking workspace…
                  </div>
                ) : preview?.canRewind ? (
                  <>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Restore {preview.filesChanged?.length ?? files.length} files to their state
                      before this turn.
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setUndoOpen(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void applyUndo()}>
                        {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Undo changes
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="mt-1.5 text-xs leading-relaxed text-destructive">
                    {preview?.error ?? 'These changes cannot be undone safely.'}
                  </p>
                )}
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="secondary" onClick={() => void reviewChanges()}>
              <FileDiff /> Open diff
            </Button>
          </>
        )}
      </div>

      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="border-t border-border/70 px-2 py-1">
          {entries.map((entry) => {
            if (entry.kind === 'file') {
              const cut = entry.file.path.lastIndexOf('/')
              return (
                <FileRow
                  key={entry.file.path}
                  file={entry.file}
                  dir={cut > 0 ? entry.file.path.slice(0, cut) : undefined}
                  depth={0}
                  onOpen={openChange}
                />
              )
            }
            const dirOpen = !closedDirs[entry.dir]
            return (
              <div key={entry.dir}>
                <button
                  type="button"
                  onClick={() => setClosedDirs((prev) => ({ ...prev, [entry.dir]: !prev[entry.dir] }))}
                  className="flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1 text-left text-xs transition-colors hover:bg-accent/40"
                  title={entry.dir}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground/60 transition-transform',
                      dirOpen && 'rotate-90'
                    )}
                  />
                  <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <span className="truncate text-muted-foreground">{entry.dir}</span>
                  <span className="flex-1" />
                  <LineDeltas
                    additions={entry.additions}
                    deletions={entry.deletions}
                    className="text-xs"
                  />
                </button>
                {dirOpen &&
                  entry.files.map((file) => (
                    <FileRow key={file.path} file={file} depth={1} onOpen={openChange} />
                  ))}
              </div>
            )
          })}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
})

import * as React from 'react'
import { ChevronDown, FileDiff, Loader2, RotateCcw } from 'lucide-react'
import type { AssistantMessage, GitFileChange, RewindResult } from '@shared/types'
import { cn } from '@/lib/utils'
import { changedPathsFromParts } from '@/lib/turnChanges'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface FileSummary {
  path: string
  additions: number
  deletions: number
}

function summarize(paths: string[], changes: GitFileChange[]): FileSummary[] {
  return paths.map((path) => {
    const rows = changes.filter((change) => change.path === path)
    return {
      path,
      additions: rows.reduce((sum, row) => sum + (row.additions ?? 0), 0),
      deletions: rows.reduce((sum, row) => sum + (row.deletions ?? 0), 0)
    }
  })
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
  const [expanded, setExpanded] = React.useState(false)
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
  const visible = expanded ? files : files.slice(0, 3)
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
    <div className="animate-enter overflow-hidden rounded-xl border border-border bg-card/60">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-code">
          <FileDiff className="size-4.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {undone ? 'Changes undone' : `Edited ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </div>
          {!undone && (additions > 0 || deletions > 0) && (
            <div className="mt-0.5 flex gap-1.5 text-xs tabular-nums">
              <span className="text-success">+{additions}</span>
              <span className="text-destructive">−{deletions}</span>
            </div>
          )}
        </div>
        {!undone && (
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
                    Restore {preview.filesChanged?.length ?? files.length} files to their state before this turn.
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
        )}
        <Button size="sm" variant="secondary" onClick={() => void reviewChanges()}>
          Review
        </Button>
      </div>

      {!undone && (
        <div className="border-t border-border/70 px-3.5 py-1.5">
          {visible.map((file) => (
            <button
              key={file.path}
              type="button"
              title={`Open ${file.path}`}
              onClick={() => openChange(file.path)}
              className="group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-3 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
                {file.path}
              </span>
              {(file.additions > 0 || file.deletions > 0) && (
                <span className="flex shrink-0 gap-1.5 tabular-nums">
                  <span className="text-success">+{file.additions}</span>
                  <span className="text-destructive">−{file.deletions}</span>
                </span>
              )}
            </button>
          ))}
          {files.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="flex items-center gap-1 py-1.5 text-xs font-medium text-foreground hover:text-primary"
            >
              {expanded ? 'Show less' : `Show ${files.length - 3} more ${files.length - 3 === 1 ? 'file' : 'files'}`}
              <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
            </button>
          )}
        </div>
      )}
    </div>
  )
})

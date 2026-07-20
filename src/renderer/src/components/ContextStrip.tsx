import * as React from 'react'
import { FileDiff, Folder, GitBranch } from 'lucide-react'
import type { GitStatus } from '@shared/types'
import { basename } from '@/lib/format'
import { cn, contextPill, contextPillAction } from '@/lib/utils'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * Repo · branch · working-tree changes — context for what you're about to send,
 * sitting with the composer instead of the crowded top bar. Shared by the
 * new-chat screen and an open chat so the two never drift; `branch` lets the
 * new-chat screen show the branch of a worktree it's about to start in, and
 * `children` takes any extra chips (the where-it-runs picker).
 */
export function ContextStrip({
  cwd,
  git,
  branch,
  onReviewChanges,
  children
}: {
  cwd: string
  git: GitStatus | null
  /** Overrides the working tree's own branch. Defaults to `git.branch`. */
  branch?: string
  onReviewChanges: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const shown = branch ?? git?.branch
  const changes = git?.isRepo ? git.changes.length : 0
  return (
    <div data-context-strip className="mb-2 flex items-center gap-2">
      <WithTooltip label={cwd}>
        <div className={contextPill}>
          <Folder className="size-3 shrink-0" />
          <span className="max-w-44 truncate">{basename(cwd)}</span>
          {git?.isRepo && shown && (
            <>
              <span className="text-border">/</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{shown}</span>
            </>
          )}
        </div>
      </WithTooltip>
      {children}
      {changes > 0 && git && (
        <WithTooltip label={`Review changes — ${changes} file${changes === 1 ? '' : 's'}`}>
          <button
            type="button"
            onClick={onReviewChanges}
            aria-label="Review changes"
            className={cn(contextPillAction, 'tabular-nums')}
          >
            <FileDiff className="size-3 text-muted-foreground" />
            {git.additions === 0 && git.deletions === 0 ? (
              <span className="text-muted-foreground">{changes}</span>
            ) : (
              <>
                <span className="text-success">+{git.additions}</span>
                <span className="text-destructive">−{git.deletions}</span>
              </>
            )}
          </button>
        </WithTooltip>
      )}
    </div>
  )
}

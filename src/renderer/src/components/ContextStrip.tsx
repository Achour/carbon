import * as React from 'react'
import { ArrowDown, FileDiff, Folder, GitBranch } from 'lucide-react'
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
  project,
  onReviewChanges,
  onUpdateFromDefault,
  children
}: {
  cwd: string
  git: GitStatus | null
  /** Overrides the working tree's own branch. Defaults to `git.branch`. */
  branch?: string
  /**
   * Repo the chat belongs to, when that isn't `cwd` itself. A worktree's
   * directory is named after its branch, so labelling the pill with `cwd`
   * would print the branch twice and drop the project name entirely.
   */
  project?: string
  onReviewChanges: () => void
  /**
   * Runs the agent's "Update from main". Given only where there's a chat to run
   * it in, which is what turns the staleness marker from a label into a fix.
   */
  onUpdateFromDefault?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const shown = branch ?? git?.branch
  const changes = git?.isRepo ? git.changes.length : 0
  // Only meaningful for the branch actually checked out here: `branch` is an
  // override the new-chat screen passes for a worktree it hasn't started in.
  const behind = branch ? 0 : (git?.behindDefault ?? 0)
  const base = git?.defaultBranch ?? 'main'
  return (
    <div data-context-strip className="mb-2 flex items-center gap-2">
      <WithTooltip label={cwd}>
        <div className={contextPill}>
          <Folder className="size-3 shrink-0" />
          <span className="max-w-44 truncate">{basename(project ?? cwd)}</span>
          {git?.isRepo && shown && (
            <>
              <span className="text-border">/</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{shown}</span>
            </>
          )}
        </div>
      </WithTooltip>
      {/* Drifting behind the default branch has no other symptom until it
          surfaces as a conflict, so it gets said out loud while it's cheap
          to fix. */}
      {behind > 0 && (
        <WithTooltip
          label={`${shown} is ${behind} commit${behind === 1 ? '' : 's'} behind ${base}${
            onUpdateFromDefault ? ' — merge it in' : ''
          }`}
        >
          <button
            type="button"
            onClick={onUpdateFromDefault}
            disabled={!onUpdateFromDefault}
            aria-label={`Update from ${base}`}
            className={cn(
              onUpdateFromDefault ? contextPillAction : contextPill,
              'tabular-nums text-muted-foreground'
            )}
          >
            <ArrowDown className="size-3" />
            <span>{behind}</span>
          </button>
        </WithTooltip>
      )}
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

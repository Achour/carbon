import * as React from 'react'
import { ArrowLeftRight, FileDiff, GitBranch, Loader2, Settings2 } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { basename } from '@/lib/format'
import { cn, contextPillAction } from '@/lib/utils'
import { useApp } from '@/store'
import { resolveGitActions } from '@/lib/gitActions'
import { Button } from '@/components/ui/button'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/**
 * Everything you can do to the chat's environment, in one menu beside the
 * repo/branch chip: review changes, hand a worktree back to the main checkout,
 * and the source-control ladder. The git actions come from `resolveGitActions`,
 * the same resolver the source-control button uses, so their labels and
 * availability track repo state without a second set of rules here.
 */
export function EnvironmentMenu({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const git = useApp((s) => s.git)
  const github = useApp((s) => s.github)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const runGitAction = useApp((s) => s.runGitAction)
  const handOffToLocal = useApp((s) => s.handOffToLocal)

  const [confirmHandoff, setConfirmHandoff] = React.useState(false)
  const [handingOff, setHandingOff] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const { primary, rungs } = React.useMemo(() => resolveGitActions(git, github), [git, github])
  const actions = primary ? [primary, ...rungs] : rungs
  const changes = git?.isRepo ? git.changes.length : 0

  const handOff = async (): Promise<void> => {
    setHandingOff(true)
    const res = await handOffToLocal(chat.id)
    setHandingOff(false)
    setConfirmHandoff(false)
    if (!res.ok) setError(res.error)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Environment"
              className={cn(contextPillAction, 'no-drag [&>svg]:size-3 [&>svg]:shrink-0')}
            >
              <Settings2 />
              <span>Environment</span>
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => void reviewChanges()} disabled={changes === 0}>
            <FileDiff />
            <span className="flex-1">Changes</span>
            {git && changes > 0 && (
              <span className="flex shrink-0 items-center gap-1 pl-3 text-[11px] tabular-nums">
                <span className="text-success">+{git.additions}</span>
                <span className="text-destructive">−{git.deletions}</span>
              </span>
            )}
          </DropdownMenuItem>

          {chat.worktree && (
            <DropdownMenuItem onClick={() => setConfirmHandoff(true)}>
              <ArrowLeftRight />
              <span className="flex-1">Continue in local checkout</span>
            </DropdownMenuItem>
          )}

          {actions.length > 0 && <DropdownMenuSeparator />}
          {actions.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => void runGitAction(a.id)}>
              <GitBranch />
              <span className="flex-1">{a.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Hand off to the main checkout. */}
      <Dialog open={confirmHandoff} onOpenChange={(o) => !o && setConfirmHandoff(false)}>
        <DialogContent>
          <DialogTitle>Continue in local checkout</DialogTitle>
          <DialogDescription>
            Check out{' '}
            <span className="font-medium text-foreground">{chat.worktree?.branch}</span> in{' '}
            <span className="font-medium text-foreground">
              {chat.worktree ? basename(chat.worktree.repoRoot) : ''}
            </span>{' '}
            and remove the worktree. This chat continues there; its next message
            starts a fresh session in the new folder.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmHandoff(false)} disabled={handingOff}>
              Cancel
            </Button>
            <Button onClick={() => void handOff()} disabled={handingOff}>
              {handingOff && <Loader2 className="size-3 animate-spin" />}
              Hand off
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={error !== null} onOpenChange={(o) => !o && setError(null)}>
        <DialogContent>
          <DialogTitle>Couldn’t hand off</DialogTitle>
          <DialogDescription>The chat stayed in its worktree. Git said:</DialogDescription>
          <p className="mt-3 rounded-md bg-secondary/50 p-2 font-mono text-[11px] break-words text-destructive">
            {error}
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}


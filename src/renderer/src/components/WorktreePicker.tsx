import * as React from 'react'
import { Check, ChevronDown, GitBranch, Laptop, Plus } from 'lucide-react'
import type { WorktreeRef, WorktreeTarget } from '@shared/types'
import { cn, contextPillAction } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/**
 * Trigger labels. These name the *kind* of location, never the branch — the
 * branch chip beside this one already shows that, and repeating it read as a
 * duplicate when a worktree was selected.
 */
const TARGET_LABEL: Record<WorktreeTarget['kind'], string> = {
  local: 'This Mac',
  new: 'New worktree',
  existing: 'Worktree'
}

/**
 * Where the next chat runs — the main checkout, an existing worktree, or a new
 * one. Sits above the composer as a borderless chip so the composer's own
 * controls row stays uncrowded.
 */
export function WorktreePicker({
  cwd,
  value,
  onChange,
  disabled
}: {
  /** Any directory in the repo; every worktree of that repo is listed. */
  cwd: string
  value: WorktreeTarget
  onChange: (target: WorktreeTarget) => void
  disabled?: boolean
}): React.JSX.Element {
  const [worktrees, setWorktrees] = React.useState<WorktreeRef[]>([])
  const [open, setOpen] = React.useState(false)

  // Only the popup reads this list, and the home screen mounts on every visit —
  // so pay for the git spawn when the menu opens, not on mount.
  React.useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    void window.api.listWorktrees(cwd).then((list) => {
      if (!cancelled) setWorktrees(list)
    })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

  // The main checkout is "This Mac"; the rest are selectable worktrees. Its
  // path is the repo root a selected worktree belongs to.
  const repoRoot = worktrees.find((w) => w.isMain)?.path ?? cwd
  const linked = worktrees.filter((w) => !w.isMain)
  const isLocal = value.kind === 'local'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label="Where this chat runs"
            className={cn(contextPillAction, 'no-drag [&>svg]:size-3 [&>svg]:shrink-0')}
          >
            {isLocal ? <Laptop /> : <GitBranch />}
            <span className="max-w-40 truncate">{TARGET_LABEL[value.kind]}</span>
            <ChevronDown className="opacity-60" />
          </button>
        }
      />
      <DropdownMenuContent align="start" side="bottom">
        <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Run on</div>
        <DropdownMenuItem onClick={() => onChange({ kind: 'local' })}>
          <Laptop />
          <span className="flex-1">This Mac</span>
          {isLocal && <Check className="opacity-70" />}
        </DropdownMenuItem>
        {linked.map((w) => (
          <DropdownMenuItem
            key={w.path}
            onClick={() => onChange({ kind: 'existing', path: w.path, branch: w.branch, repoRoot })}
          >
            <GitBranch />
            <span className="max-w-52 flex-1 truncate">{w.branch}</span>
            {value.kind === 'existing' && value.path === w.path && <Check className="opacity-70" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onChange({ kind: 'new' })}>
          <Plus />
          <span className="flex-1">New worktree</span>
          {value.kind === 'new' && <Check className="opacity-70" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

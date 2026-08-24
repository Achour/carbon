import * as React from 'react'
import { Check, ChevronDown, GitBranch, Laptop, Plus } from 'lucide-react'
import { createsWorktree } from '@shared/types'
import type { WorktreeRef, WorktreeTarget } from '@shared/types'
import { contextPillButton } from '@/lib/utils'
import { GitErrorDialog } from '@/components/BranchActions'
import { BranchPicker } from '@/components/BranchPicker'
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
  // A branch target is a worktree too — it differs only in where the branch came
  // from, which is the *branch* chip's business, not this one's.
  branch: 'New worktree',
  existing: 'Worktree'
}

/**
 * Where the next chat runs — the main checkout, an existing worktree, or a new
 * one. Sits above the composer as a borderless chip so the composer's own
 * controls row stays uncrowded.
 *
 * A new worktree brings a second chip with it: *which branch*. It is a separate
 * control rather than a submenu because it is a separate question, and it only
 * has an answer in that one case — This Mac runs on whatever is checked out
 * (switching it would mutate a directory every other chat and the editor
 * share), and an existing worktree's branch is a fact about it.
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
  // Keep results tagged with their project so the previous project's worktrees
  // disappear synchronously on a cwd change, before the next git read finishes.
  const [loaded, setLoaded] = React.useState<{ cwd: string; refs: WorktreeRef[] }>({
    cwd: '',
    refs: []
  })
  const worktrees = loaded.cwd === cwd ? loaded.refs : []
  const [open, setOpen] = React.useState(false)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const remove = async (path: string): Promise<void> => {
    setRemoving(path)
    const res = await window.api.worktreeRemove(path)
    setRemoving(null)
    if (!res.ok) {
      setError(res.error ?? 'Removal failed.')
      return
    }
    setLoaded((l) => ({ ...l, refs: l.refs.filter((r) => r.path !== path) }))
  }

  // Only the popup reads this list, and the home screen mounts on every visit —
  // so pay for the git spawn when the menu opens, not on mount.
  React.useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    void window.api.listWorktrees(cwd).then((list) => {
      if (!cancelled) setLoaded({ cwd, refs: list })
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
  const creating = createsWorktree(value)

  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label="Where this chat runs"
            className={contextPillButton}
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
            {/* Merged means the work already landed — without saying so, finished
                worktrees pile up here indistinguishable from live ones. */}
            {w.merged && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(w.path)
                }}
                title={`${w.branch} is merged — remove this worktree`}
                className="shrink-0 rounded px-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {removing === w.path ? 'removing…' : 'merged · remove'}
              </button>
            )}
            {value.kind === 'existing' && value.path === w.path && <Check className="opacity-70" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Picking this leaves the branch unset, which the chip beside it reads
            as "name it for me" — the answer that needs no further clicks. */}
        <DropdownMenuItem onClick={() => onChange({ kind: 'new' })}>
          <Plus />
          <span className="flex-1">New worktree</span>
          {creating && <Check className="opacity-70" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    {creating && (
      <BranchPicker cwd={cwd} value={value} onChange={onChange} disabled={disabled} />
    )}

    {/* Removal is unforced, so git's refusal is the message worth showing. */}
    <GitErrorDialog
      title="Couldn’t remove the worktree"
      detail="It’s still there. Git said:"
      error={error}
      onDismiss={() => setError(null)}
    />
    </>
  )
}

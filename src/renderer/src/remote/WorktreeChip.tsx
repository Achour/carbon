import * as React from 'react'
import { ArrowLeft, ChevronDown, GitBranch, Laptop, Plus, Sparkles } from 'lucide-react'
import { createsWorktree, type BranchRef, type WorktreeRef, type WorktreeTarget } from '@shared/types'
import { generatedBranchHint } from '@shared/branchName'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { invoke } from './api'
import { Sheet, SheetRow, SheetSection } from './Sheet'
import { useRemote } from './state'

/** The kind of place, as the desktop's `WorktreePicker` names it. */
const TARGET_LABEL: Record<WorktreeTarget['kind'], string> = {
  local: 'This Mac',
  new: 'New worktree',
  branch: 'New worktree',
  existing: 'Worktree'
}

/** The branch the chip names beside the kind, when there is one to name. */
function targetBranch(t: WorktreeTarget): string | null {
  if (t.kind === 'existing' || t.kind === 'branch') return t.branch
  if (t.kind === 'new') return t.branch ?? null
  return null
}

/**
 * Where the next chat runs — the desktop's `WorktreePicker` and `BranchPicker`
 * as one sheet. "Run on" lists the main checkout and every linked worktree;
 * New worktree turns the sheet to the branch question, where typing filters
 * the branches you have and names the one you don't, the combobox's rule:
 * "is `fix-login` already a branch?" is answered by the keystrokes that would
 * create it.
 *
 * Removing a merged worktree, which the desktop menu offers, is left out: a
 * delete stays a Mac act on the phone.
 *
 * Drawn only for a repository. `worktree:list` answers `[]` for a folder that
 * is not one, which is how the chip knows; the list also clears a restored
 * target whose worktree has since been removed, so a draft cannot start a
 * chat in a directory that is gone.
 */
export function WorktreeChip({
  cwd,
  value,
  onChange,
  disabled,
  refresh
}: {
  cwd: string
  value: WorktreeTarget
  onChange: (target: WorktreeTarget) => void
  disabled?: boolean
  /** Bumped to re-read the list — after a failed start, which may mean the worktree is gone. */
  refresh?: number
}): React.JSX.Element | null {
  const home = useRemote((s) => s.home)
  // Tagged with their project, so a cwd change drops the last one's at once.
  const [loaded, setLoaded] = React.useState<{ cwd: string; refs: WorktreeRef[] } | null>(null)
  const [open, setOpen] = React.useState(false)
  // Counts openings, so the list is re-read as the sheet opens and not again as it closes.
  const [opened, setOpened] = React.useState(0)
  const [screen, setScreen] = React.useState<'where' | 'branch'>('where')

  React.useEffect(() => {
    let alive = true
    void invoke<WorktreeRef[]>('worktree:list', cwd)
      .then((refs) => alive && setLoaded({ cwd, refs }))
      .catch(() => alive && setLoaded({ cwd, refs: [] }))
    return () => {
      alive = false
    }
    // Re-read each time the sheet opens: a worktree made on the Mac meanwhile
    // belongs in the list.
  }, [cwd, opened, refresh])

  const refs = loaded?.cwd === cwd ? loaded.refs : null
  React.useEffect(() => {
    if (!refs || value.kind !== 'existing') return
    if (!refs.some((r) => r.path === value.path)) onChange({ kind: 'local' })
  }, [refs, value, onChange])

  if (!refs?.length) return null
  const repoRoot = refs.find((r) => r.isMain)?.path ?? cwd
  const linked = refs.filter((r) => !r.isMain)
  const branch = targetBranch(value)
  const close = (): void => {
    setOpen(false)
    setScreen('where')
  }
  const pick = (next: WorktreeTarget): void => {
    onChange(next)
    close()
  }
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(true)
          setOpened((n) => n + 1)
        }}
        aria-label="Where this chat runs"
        className="mb-2 flex h-9 max-w-full shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-3 text-[14px] text-muted-foreground active:bg-accent disabled:opacity-50"
      >
        {value.kind === 'local' ? <Laptop className="size-4 shrink-0" /> : <GitBranch className="size-4 shrink-0" />}
        <span className="shrink-0 text-foreground">{TARGET_LABEL[value.kind]}</span>
        {branch && <span className="min-w-0 truncate">{branch}</span>}
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </button>
      <Sheet
        open={open}
        onClose={close}
        title={
          screen === 'where' ? (
            'Run on'
          ) : (
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Back"
                onClick={() => setScreen('where')}
                className="-ml-2 flex size-8 items-center justify-center rounded-full active:bg-accent"
              >
                <ArrowLeft className="size-[18px]" />
              </button>
              Branch for the new worktree
            </span>
          )
        }
      >
        {screen === 'where' ? (
          <div className="pb-2">
            <SheetRow
              selected={value.kind === 'local'}
              icon={<Laptop className="size-[18px]" />}
              label="This Mac"
              description="The project’s own checkout"
              onClick={() => pick({ kind: 'local' })}
            />
            {linked.length > 0 && (
              <SheetSection label="Worktrees">
                {linked.map((w) => (
                  <SheetRow
                    key={w.path}
                    selected={value.kind === 'existing' && value.path === w.path}
                    icon={<GitBranch className="size-[18px]" />}
                    label={w.branch}
                    description={`${w.merged ? 'Merged · ' : ''}${short(w.path)}`}
                    onClick={() => pick({ kind: 'existing', path: w.path, branch: w.branch, repoRoot })}
                  />
                ))}
              </SheetSection>
            )}
            <SheetRow
              selected={createsWorktree(value)}
              icon={<Plus className="size-[18px]" />}
              label="New worktree"
              description={createsWorktree(value) && branch ? branch : 'On a new or existing branch'}
              onClick={() => setScreen('branch')}
            />
          </div>
        ) : (
          <BranchList cwd={cwd} value={value} onPick={pick} />
        )}
      </Sheet>
    </>
  )
}

/** The branch question: name it for me, a name you type, or a branch you have. */
function BranchList({
  cwd,
  value,
  onPick
}: {
  cwd: string
  value: WorktreeTarget
  onPick: (target: WorktreeTarget) => void
}): React.JSX.Element {
  const [branches, setBranches] = React.useState<BranchRef[] | null>(null)
  const [query, setQuery] = React.useState(value.kind === 'new' ? (value.branch ?? '') : '')

  React.useEffect(() => {
    let alive = true
    void invoke<BranchRef[]>('git:local-branches', cwd)
      .then((refs) => alive && setBranches(refs))
      .catch(() => alive && setBranches([]))
    return () => {
      alive = false
    }
  }, [cwd])

  const typed = query.trim()
  const q = typed.toLowerCase()
  // A branch something already has checked out cannot get a worktree of its
  // own — git refuses — so it is neither offered nor creatable by name.
  const free = (branches ?? []).filter((b) => !b.checkedOut)
  const shown = q ? free.filter((b) => b.name.toLowerCase().includes(q)) : free
  const exact = (branches ?? []).find((b) => b.name === typed)
  const fresh = value.kind === 'new'

  return (
    <div className="pb-2">
      <div className="px-3 pt-1 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !typed || exact?.checkedOut) return
            e.preventDefault()
            onPick(exact ? { kind: 'branch', branch: exact.name } : { kind: 'new', branch: typed })
          }}
          placeholder="Search or name a new branch"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="h-11 w-full rounded-xl border border-border bg-card px-3 text-[16px] outline-none focus:border-primary/60"
        />
      </div>
      {!typed && (
        <SheetRow
          selected={fresh && !value.branch}
          icon={<Sparkles className="size-[18px]" />}
          label="Name it for me"
          description={`A new branch, ${generatedBranchHint()}`}
          onClick={() => onPick({ kind: 'new' })}
        />
      )}
      {typed && !exact && (
        <SheetRow
          selected={fresh && value.branch === typed}
          icon={<Plus className="size-[18px]" />}
          label={`Create ${typed}`}
          description="A new branch from the checked-out commit"
          onClick={() => onPick({ kind: 'new', branch: typed })}
        />
      )}
      {exact?.checkedOut && (
        <p className="px-4 py-2 text-[13.5px] text-muted-foreground">
          {exact.name} is already checked out. Pick it under Run on, or name another branch.
        </p>
      )}
      {branches === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[14px] text-muted-foreground">
          <DotSpinner className="size-3.5" /> Loading branches…
        </div>
      ) : (
        shown.length > 0 && (
          <SheetSection label="Existing branches">
            {shown.map((b) => (
              <SheetRow
                key={b.name}
                selected={value.kind === 'branch' && value.branch === b.name}
                icon={<GitBranch className="size-[18px]" />}
                label={b.name}
                onClick={() => onPick({ kind: 'branch', branch: b.name })}
              />
            ))}
          </SheetSection>
        )
      )}
    </div>
  )
}

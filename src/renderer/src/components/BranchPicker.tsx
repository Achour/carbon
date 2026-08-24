import * as React from 'react'
import { Check, GitBranch, Plus, Sparkles } from 'lucide-react'
import type { BranchRef, WorktreeTarget } from '@shared/types'
import { generatedBranchHint, sanitizeBranch } from '@shared/branchName'
import { worktreeTargetKey } from '@/lib/drafts'
import { cn, contextPillButton } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'

/** What the trigger says for each shape of branch choice. */
function triggerLabel(value: WorktreeTarget): string {
  if (value.kind === 'branch') return value.branch
  if (value.kind === 'new' && value.branch) return value.branch
  return 'Name it for me'
}

/** One row of the popup. A `<button>`, not a menu item — this is not a menu. */
function Row({
  active,
  selected,
  children,
  onSelect,
  onHover
}: {
  active: boolean
  selected: boolean
  children: React.ReactNode
  onSelect: () => void
  onHover: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      // Keeping focus in the input is the whole point of a combobox: the arrow
      // keys and Enter belong to the list, every other key to the filter.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        active && 'bg-accent'
      )}
    >
      {children}
      {selected && <Check className="opacity-70" />}
    </button>
  )
}

/**
 * Which branch the next chat's worktree runs on: one it creates (named, or left
 * to the generator) or one that already exists.
 *
 * It is a combobox rather than a menu because the two answers are one question.
 * Typing filters the branches you have *and* composes the name of the one you
 * don't, so "is `fix-login` already a branch?" is answered by the same
 * keystrokes that would create it — which is the mistake worth designing out,
 * since git's own answer arrives only after a checkout.
 *
 * A Popover, deliberately, not the DropdownMenu the sibling chip uses: Base
 * UI's Menu owns arrow keys and typeahead for its items, and a text input
 * inside one fights it for every keystroke.
 */
export function BranchPicker({
  cwd,
  value,
  onChange,
  disabled
}: {
  /** Any directory in the repo whose branches are offered. */
  cwd: string
  /** The current target; only `new` and `branch` reach this control. */
  value: WorktreeTarget
  onChange: (target: WorktreeTarget) => void
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  // Tagged with its project for the same reason WorktreePicker's list is: the
  // previous project's branches must not survive a cwd change even for a frame.
  const [loaded, setLoaded] = React.useState<{ cwd: string; refs: BranchRef[] }>({
    cwd: '',
    refs: []
  })
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)

  // Only the popup reads the list, and the branch set moves whenever the agent
  // commits — so pay for the git spawn each time the popup opens, not on mount.
  React.useEffect(() => {
    if (!open || !cwd) return undefined
    let cancelled = false
    void window.api.gitLocalBranches(cwd).then((refs) => {
      if (!cancelled) setLoaded({ cwd, refs })
    })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

  // The list answers for *this* project, or it hasn't arrived yet — the two are
  // one question, and separating them is what makes the guard in `canCreate`
  // below look redundant when it is load-bearing.
  const ready = loaded.cwd === cwd
  // A branch some worktree already holds is not offerable: `git worktree add`
  // refuses it outright, and the "Run on" chip beside this one already reaches
  // every one of them. Listing them would be an invitation to an error.
  const branches = ready ? loaded.refs.filter((b) => !b.checkedOut) : []
  const trimmed = query.trim()
  const matches = trimmed
    ? branches.filter((b) => b.name.toLowerCase().includes(trimmed.toLowerCase()))
    : branches
  // The name git would actually make — previewed rather than echoed, so the row
  // can't promise a branch that turns into something else on creation.
  const proposed = sanitizeBranch(query)
  // An exact hit is the existing branch, which the list below already offers;
  // proposing to create it too would be two rows for one outcome and one of
  // them an error. `ready` gates it because an unloaded list is empty, so the
  // scan would vacuously pass and flash a create row for a branch that exists.
  const canCreate = !!proposed && ready && !branches.some((b) => b.name === proposed)

  // Keyed off the target itself rather than a literal per row: the check mark
  // is drawn where a row's key equals the selection's, so a key spelled twice is
  // a tick that silently stops appearing. Same argument as `sameOptions`, and
  // the same function.
  type Choice = { target: WorktreeTarget; node: React.ReactNode }
  const choices: Choice[] = []
  if (!trimmed) {
    choices.push({
      target: { kind: 'new' },
      node: (
        <>
          <Sparkles />
          <span className="flex-1">Name it for me</span>
        </>
      )
    })
  }
  for (const b of matches) {
    choices.push({
      target: { kind: 'branch', branch: b.name },
      node: (
        <>
          <GitBranch />
          <span className="min-w-0 flex-1 truncate">{b.name}</span>
        </>
      )
    })
  }
  // Creating comes *after* the branches it might be confused with, so Enter
  // takes the existing one. Typing `grok` where `grok-build` exists is far more
  // often a search that hasn't finished than a request for a second branch
  // called `grok` — and with nothing matching, this is the only row anyway, so
  // naming a branch outright is still type-and-Enter.
  if (canCreate) {
    choices.push({
      target: { kind: 'new', branch: proposed },
      node: (
        <>
          <Plus />
          <span className="min-w-0 flex-1 truncate">
            Create <span className="font-medium text-foreground">{proposed}</span>
          </span>
        </>
      )
    })
  }

  const selectedKey = worktreeTargetKey(value)

  const choose = (target: WorktreeTarget): void => {
    onChange(target)
    setOpen(false)
  }

  // Enter takes the highlighted row, which is the first one until you move —
  // so typing a name and pressing Enter creates it, and typing an existing
  // branch and pressing Enter selects it. Both are one gesture.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, choices.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = choices[active]
      if (pick) choose(pick.target)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening on the last search would show a filtered list with no sign
        // that it was filtered, which reads as "this repo has one branch".
        if (next) {
          setQuery('')
          setActive(0)
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label="Branch this chat runs on"
            className={contextPillButton}
          >
            <GitBranch />
            <span
              className={cn(
                'max-w-44 truncate',
                value.kind === 'new' && !value.branch && 'text-muted-foreground/70 italic'
              )}
            >
              {triggerLabel(value)}
            </span>
          </button>
        }
      />
      <PopoverContent align="start" side="bottom" className="w-72 p-1">
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={`Find or name a branch — ${generatedBranchHint()}`}
          className="mb-1 h-8 border-0 focus-visible:border-0 focus-visible:ring-0"
        />
        <div className="max-h-64 overflow-y-auto">
          {choices.map((c, i) => (
            <Row
              key={worktreeTargetKey(c.target)}
              active={i === active}
              selected={worktreeTargetKey(c.target) === selectedKey}
              onHover={() => setActive(i)}
              onSelect={() => choose(c.target)}
            >
              {c.node}
            </Row>
          ))}
          {choices.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {branches.length === 0 && ready
                ? 'Every branch here is already checked out.'
                : 'No branch matches — that name can’t be used.'}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

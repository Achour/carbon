# Git worktrees and publishing

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Git worktrees (`src/main/worktree.ts`)

A chat can run in an isolated worktree. **The app creates the worktree itself** (`git worktree add`) rather than delegating to Claude Code's `.claude/worktrees/` or Codex's equivalent — a worktree is just a directory, so owning creation is what makes the feature provider-neutral. `chat.cwd` points at the worktree and `chat.worktree` carries the metadata (`repoRoot`, `branch`); **the provider adapters are untouched**, since both already take `chat.cwd`. Preserve that property: cwd is the only seam.

The entry point is a Cursor-style "Run on" chip **above** the composer (`WorktreePicker.tsx`) — This Mac / an existing worktree / New worktree — paired with a branch chip that tracks the selection. It sits above the composer deliberately: the composer's own controls row (model, effort, permission mode) is already tight.

**Which branch is a second question, and it went unasked for a long time.**
`createWorktree(repoRoot, branch?)` and `sanitizeBranch` ("coerce a
*user-supplied* name") were written to take one from the start, and no caller
ever passed it: every worktree got `karbun/aug24-k3xq`, and a branch that
already existed could be reached only if some worktree happened to hold it.
`BranchPicker.tsx` is the missing half, and `WorktreeTarget` grew the two shapes
it needs — `{kind:'new', branch?}` and `{kind:'branch', branch}`.

- **It is one combobox, not two controls**, because "does `fix-login` already
  exist?" and "make me a branch called `fix-login`" are the same keystrokes.
  Typing filters the branches you have *and* composes the name of the one you
  don't; git's own answer to the first question otherwise arrives only after a
  checkout. It is a **Popover**, deliberately not the `DropdownMenu` the sibling
  chip uses: Base UI's `Menu` owns arrow keys and typeahead for its items, and a
  text input inside one fights it for every keystroke.
- **Create is the *last* row, not the first.** Typing `grok` where `grok-build`
  exists is far more often a search that hasn't finished than a request for a
  second branch called `grok`, so Enter takes the existing match. With nothing
  matching, the create row is the only row — so naming a branch outright is
  still type-and-Enter.
- **The name is sanitized in the preview, not just on the way to git.**
  `sanitizeBranch` therefore moved to `@shared/branchName`: a picker that says
  `Fix Login` while git makes `fix-login` is showing a branch that won't exist,
  and the draft would persist the un-coerced one. Same reason
  `generatedBranchHint` elides the random half rather than rolling it — main
  draws the real suffix at creation.
- **A branch some worktree already holds is not offered.** `git worktree add`
  refuses those outright, and the "Run on" rows plus This Mac already reach
  every one of them — `%(worktreepath)` on the `for-each-ref` answers it for
  free (`localBranches`, `git.ts`). A race still fails, which is git's refusal
  to make and not ours to work around.
- **The collision retry no longer renames a branch the user named.**
  `createWorktree` retries under a fresh generated name when the first one
  collides — correct for a name that means nothing to anyone, wrong the moment
  one is typed: asking for `fix-login` and silently getting `karbun/aug24-k3xq`
  is a worse answer than the error. `checkoutWorktree` has no retry at all, for
  the same reason at full strength.
- **This Mac deliberately cannot switch branch.** A checkout at chat start would
  mutate a directory every other chat and the editor share, and can fail on a
  dirty tree. Branch choice is worktree territory; This Mac reports what's
  there. `ContextStrip`'s `branch` accordingly takes `null` — the branch chip
  owns the segment whenever a worktree is about to be made, and printing the
  checkout's branch beside it would name the one place the chat is *not* about
  to run.
- **Two questions about the union, each with one answer.**
  `createsWorktree` (`shared/types.ts`) is "is the branch chip up" — the chip's
  own existence, the strip standing its branch segment down, and the
  "Creating worktree…" spinner were three spellings of one set.
  `worktreeTargetKey` (`lib/drafts.ts`) is target *identity* — it folded in
  `kind` alone, so a typed name never marked the draft dirty and was gone by the
  next visit, and the picker keys its rows on it so a row's tick can't drift
  from the selection. Both are exhaustive with no `default` arm, so the next
  variant stops compiling rather than being silently mishandled. The key sits
  with the drafts rather than beside the union because `test/drafts.test.ts`
  loads that module under `node --test`, which resolves no `@shared` alias.

Worktrees live in `~/.karbun/worktrees/<repo>-<hash>/<branch>` (outside the repo so they never dirty git status, outside `userData` whose path contains a space that breaks build scripts). `KARBUN_WORKTREES_DIR` overrides the root — tests set it so they don't write to a real `$HOME`.

A fresh worktree has no gitignored files (`node_modules`, `.env`). Like Claude Code and Codex, we don't copy them: the project ships a committed `.karbun/setup.sh` (falling back to Codex's `.codex/setup.sh`, with `CODEX_WORKDIR` exported), run in a visible terminal tab on creation. It is deliberately not awaited — the agent starts while the install races alongside it.

Removal mirrors Claude Code: unforced `git worktree remove` + `branch -d`, so git itself refuses to destroy uncommitted or unmerged work; the confirm dialog reports what's at risk and only then offers a force. A worktree shared by more than one chat is never removed with one of them.

Because everything is cwd-parameterized, the existing GitPanel ladder (commit → push → `gh pr create`) already works from inside a worktree.

The environment is chosen at chat start and only *displayed* afterwards (the read-only folder/branch pill in `ContextStrip` — same convention as Cursor and the Codex app). Mid-chat actions live where they're used: the diff chip opens the review, whose GitPanel dock carries the `resolveGitActions` ladder, and the chat's ⋯ menu carries the worktree lifecycle — everything you can do to a worktree once it exists:

- **Update from main** — a delegated `resolveGitActions` rung (`update-from-main`), not an app-executed merge, *because* of conflicts: the point of updating early is having the agent resolve them here rather than at landing time. It runs in the chat's own cwd, so it needs no sandbox concessions and is offered to any chat on a non-default branch, worktree or not — both go stale against main the same way.
- **Merge into main** — the ending for work that never becomes a PR, offered from any chat that isn't already on the default branch. One menu item, two implementations, because from the user's side it is one thing ("put this in main") and what differs is only whose directory changes. A worktree chat runs `mergeWorktree`: merge into the default branch in `repoRoot`, then remove the worktree and branch. The app executes this one itself because the merge must happen in `repoRoot`, outside the agent's cwd and Codex's sandbox. A plain chat runs `gitMergeIntoDefault`, which switches, merges and deletes the branch *in the chat's own directory* — so it's offered only while the chat is idle, and the dialog says the folder is about to change. Both refuse on a dirty tree and undo a conflicting merge (restoring the original branch), so a refusal always leaves the directory exactly as it was found. Both also end **on** the default branch, which is safe precisely because `resolveGitActions`' first rung from there is "Create Branch & Commit" — the next piece of work branches off again instead of piling onto main.
- **Continue in local checkout** (`handOffWorktree`) — remove the worktree and check its branch out in `repoRoot`; order is forced, since git won't check out a branch another worktree holds. Refuses while dirty, because removal would take uncommitted work with it.
- **Remove worktree** (`finishWorktree`) — the *pull request* ending, where the merge already happened on the remote and only cleanup is left: drop the worktree and branch, move the chat to `repoRoot`. This exists because `sync-cleanup`, the ladder's equivalent for a plain checkout, switches to the default branch — which git refuses inside a worktree, since the main checkout holds it. `resolveGitActions` therefore takes `opts.worktree` and offers no rung at all for a merged PR there. The branch deletion is allowed to fail without failing the operation: a squash-merged PR leaves commits git can't see in the default branch, so `-d` refuses even though the work is safely merged — and by then the worktree is gone, so the chat must move regardless.

Both exits relocate the chat, so main disposes the session and the next send respawns in the new cwd — the same reason an effort change disposes.

`branchVsDefault` (git.ts) is the *single* implementation of "where does this branch stand vs main" — one `for-each-ref` + one `rev-list --left-right`. `gitStatus` puts its answer on `GitStatus.defaultBranch` / `behindDefault` / `aheadDefault` (started before the numstat reads so it overlaps them instead of adding a round trip); `worktreeStatus` derives `unmergedCommits` from the same call; the merge guards read it directly. Everything user-facing — the `↓n` staleness chip in `ContextStrip` (click runs "Update from main"), the ⋯ menu labels, the merge dialog's counts — reads the `GitStatus` copy, so the chip, the menu and the dialog can never disagree. Staleness has no other symptom until it surfaces as a conflicted merge, which is why the chip says it out loud while it's still cheap to fix. Note `behindDefault` is *not* `GitStatus.behind`, which is measured against the branch's own upstream. `listWorktrees` tags each ref `merged` from a single `branch --merged`, which is what lets the picker mark a finished worktree and offer to remove it instead of accumulating dead ones. It also **drops the refs git calls `prunable`**: a worktree deleted outside the app keeps being reported until something prunes it, and offering one starts a chat in a directory that isn't there. The stale metadata behind it is cleared only when *every* prunable entry is app-managed — `prune` takes no path filter, and while `~/.karbun/worktrees` sits under `$HOME` and is always mounted (so missing there means gone), someone else's worktree on an unplugged disk is merely *absent*, and pruning it would destroy the record they need to plug the disk back in. The filtering is what fixes the picker; the prune is only housekeeping, and `prunable` stays a main-local field (`ParsedWorktree`) rather than joining the shared `WorktreeRef`, since those refs are dropped before anything crosses IPC. The renderer-side half of the same blind spot is **`GitStatus.missing`**: git fails identically for a folder that isn't a repo and one that isn't *there*, so a vanished worktree read as "not a git repo" and sent you looking in the wrong place. The stat that separates them sits in `gitStatus`'s existing `catch` — the only path that can be missing, so the normal case pays nothing — rather than beside it in the renderer, which would have been a second field to keep in sync and a second round trip on all 21 `refreshGit` call sites. It rides `GitStatus` for the reason everything else user-facing does: one answer, so no two views can disagree. A fresh worktree with no setup script also says so in the chat (`worktreeNotice`, kind `setup-missing`); the silence used to read as "installed", and the agent would just start failing on missing dependencies.

### Publishing a project (`src/main/github.ts`, `PublishDialog.tsx`)

A project with no remote gets one rung — **Publish repository** — and it opens a
dialog rather than prompting the agent. The three things it needs are decisions,
not work: who owns the repository, what it is called, and whether the world can
read it. Delegated, an agent invented a name and quietly chose private, which is
a reasonable guess made silently about the one step the app cannot take back.

- **The rung is offered whether or not `gh` is ready.** Every other GitHub rung
  hides itself without a login; this one's first step is *where the login is
  explained*, with the command (`brew install gh` / `gh auth login`) and a
  terminal tab to run it in. Hiding it left a project with nowhere to push
  looking exactly like one with nothing to do.
- **`publishRepo` is ordered by what is recoverable.** Everything local happens
  before the remote exists, so a refusal leaves nothing to undo; the push is
  last because it is the only step whose failure leaves a real repository
  behind, which is why that one message says so instead of reading like the
  whole thing failed.
- **The push runs under gh's credential helper, injected for that one command.**
  `gh auth login` normally installs it globally; someone who skipped that step
  would otherwise create a repository and immediately fail to push to it, and
  writing to their global git config to fix that is not ours to do. The
  preceding `-c credential.helper=` clears the inherited list, so the answer
  comes from the account that just created the repo.
- **`commitAll` is asked, not guessed.** Publishing pushes *commits*, so a
  project whose files have never been committed publishes an empty repository —
  correct and useless. The checkbox defaults on exactly when `hasEmptyTree` says
  nothing has ever been committed; a repo with real history never has its
  staging decided for it.

**`ensureRootCommit` (`git.ts`) is the shared floor under both this and
worktrees.** A folder that was only just `git init`ed has no commit, and both
`git worktree add … HEAD` and `git push` fail outright on an unborn HEAD — the
first thing a new project hit after Initialize repo was `fatal: invalid
reference: HEAD`. It is written with plumbing (`commit-tree` against the hashed
empty tree, `update-ref` following the HEAD symref) rather than `git commit
--allow-empty`, which would sweep whatever is already staged into a commit the
user never asked for. Nothing in the index or the working tree moves; only the
missing base appears, on the branch the repo already believes it is on, so a
worktree has something to branch from *and* something to merge back into —
which `git worktree add --orphan` would not have given it.

That base is empty, so a worktree made from a project with nothing committed is
an empty checkout while the project folder still has files. `WorktreeNotice`
says so in the chat (`empty-base`, outranking `setup-missing` — absent
dependencies do not matter in a checkout with no code in it), because the
alternative was an agent opening on an empty folder with nothing on screen to
explain why.

# Pull requests

The sidebar's **Pull requests** row opens a full-window page (`pullsOpen`, exclusive
with Usage and Settings) listing every open PR the viewer authored or was asked to
review, across every repository — not just the open project's, which is the reason
it is a page and not a right-panel tab.

- **Everything is `gh`** (`main/pulls.ts`), run from the home directory with the
  repository named explicitly. The list is one GraphQL call carrying two searches
  (`author:@me`, `review-requested:@me`) because `gh search prs --json` has neither
  diff size nor check state, and the rows draw both. `mergeRows` folds a PR present
  in both searches into one row with both roles; under *All* it is listed once,
  under Review requested.
- **The data is the page's, not the store's.** A module-level cache in
  `PullRequests.tsx` keeps a reopen instant while every open refetches behind it.
  A PR merged from the page drops out of the open-only list on the refresh that
  follows; its cached detail keeps it on screen showing the outcome.
- **Code tab** splits `gh pr diff` per file (`lib/prDiff.ts`) and renders each with
  `DiffTable` inside `LazyDiffBody`, like the review view. It scrolls itself, so
  the detail pane does not scroll around it.
- **Merge** offers only the methods the repository allows, the viewer's default
  first, and never passes `--delete-branch`: gh would also delete the *local*
  branch and switch a checkout, and a worktree chat may be sitting on it.
- **Chat** needs a local project with the repository as *any* remote (a fork's
  checkout has it as `upstream`), found by `pullProjects`. `pullCheckout` sends the
  chat to wherever the head branch is already checked out — git refuses a second
  checkout — and otherwise fetches `refs/pull/N/head` (present for forks too) into
  a local branch for a new worktree, fast-forwarding an existing branch only when
  that is all it takes. `chatAboutPull` then opens the home screen there with the
  PR named in the box, writing only into an empty draft.
- **Known gap:** when the branch is already checked out, the worktree is used as it
  is — no fetch, no fast-forward — and a new chat starts even if an existing chat
  runs in that worktree.

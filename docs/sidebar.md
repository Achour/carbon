# Sidebar modes

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Sidebar modes (`Sidebar.tsx`, `SidebarDensity`)

The sidebar has two shapes, chosen in Settings → Chats and persisted in
`localStorage`. They are not two skins of one list — the row format and the
organising principle change together, because each only makes sense with the
other:

- **Compact** — one line per chat, **grouped by project**, collapsible, ordered
  by the user's saved project order.
- **Detailed** — provider mark, title, and a second line naming the project and
  branch (or the folder path, outside a repo) — in one **flat, newest-first
  list** bucketed by date. Grouping by project here would print the same folder,
  and in a repo where nothing is isolated the same branch, once per row; the
  date buckets structure the list by what actually varies down it. "Today" goes
  unlabelled — the top of a newest-first list is today by definition.

**The order is the array, and the array moves once per turn.** `chats` in the
renderer store is held *in sidebar order*: seeded newest-first by `listChats`,
then mutated only when a chat is created, deleted, or **starts a turn**
(`hoistChat` — to the front, timestamp bumped with it so a row can't sit above a
newer one carrying an older date bucket). Re-sorting on `updatedAt` as messages
arrived meant a running turn reordered the sidebar several times a second, and
two streaming chats simply traded places forever. Compact mode hid most of it —
a bump only shuffled within a project, and the project order was already
pinned — but detailed mode is one flat list, so every bump crossed the whole
sidebar. `updatedAt` still tracks the last message: it is what a row's timestamp
shows and how the next launch seeds the order. It just no longer decides
position while you're looking at it.

**A `status` event is therefore a promise, and main is the only side that can
keep it: a chat may publish one exactly when a turn starts.** The renderer has
no way to tell a real turn from a faked one, so a control-plane request that
borrows turn state moves a row the user never touched. `codexGoalGet` did:
`CodexGoalBar`'s mount effect reads the goal on every open of a Codex chat that
has a thread, and the read was wrapped in the same `beginGoalControl` /
`finishGoalControl` as the two mutators — so opening a chat from yesterday
hoisted it to the top of the sidebar stamped "now", and paid for an `idle`
transition on the way out (queue drain, a usage read spawning a CLI process per
provider, branches, git). A read publishes nothing; the mutators keep both
halves, because those are the user's own gesture in the open chat. Nothing was
persisted either way — main never bumped `updatedAt`, so a relaunch always
healed the order, which is what made it look like a rendering bug rather than a
lie told upstream. Fix it at the source: a guard in the renderer would be a
second source of truth for a question the event already answers.

The **project filter** (`All projects ▾`) heads the list in **both** modes. It
was detailed-only at first, on the reasoning that compact's project rows already
are the filter — but "show me one project" is not a question only a flat list
asks, and compact's answer to it was collapsing the other nine rows by hand. The
two modes were also already sharing the state: `sidebarProject` persists, and
the Pinned section scopes off it either way, so a filter set in detailed used to
quietly scope compact's pins with no control on screen to clear it. It is a
control, not the section label it replaced, so it is sized like the chat titles
below it rather than like a divider.

**A filtered compact list drops its project row.** The header already names the
project; a row repeating it 30px lower is the sidebar saying it twice, its
collapse toggle would empty the sidebar, and its drag handle has nothing to
trade places with. The two things it does carry — "New chat here" and the
project actions (rename/reveal/archive/hide/delete) — move onto the chat rows'
right-click menu via `projectMenu`, which is the mechanism detailed mode already
uses for having no project rows either; the chats then sit flush, since the
indent was that row's hanging indent. `ProjectMenuItems` is the single
definition all three sites render.

**Starting a chat asks which project** (`NewChatDialog`, `startNewChat`) — the
sidebar's New chat row and ⌘N both open it, in both modes. That question was
always there and never asked: a new chat landed in whatever folder happened to
be selected, which is invisible state, and compact mode's per-project ＋ was the
only place the answer was ever explicit. The dialog is the same palette shape as
the chat search, ordered by *recency* rather than the sidebar's manual project
order, so ⌘N-Enter is the common case. The instant paths survive where the
project is already on screen: the sidebar project filter (the chip names it),
compact's per-project ＋, and "New chat here" on a detailed row's menu.

That dialog is also where projects get **pruned**, because it is the only place
the whole list appears as rows — detailed mode has no project rows, so removal
otherwise means hunting for a chat that happens to belong to the project you
want gone. A ✕ on the selected row (⌘⌫ from the keyboard) hands off to the same
confirm the sidebar menu opens; a palette where Enter starts a chat has no
business deleting on one click. Rows whose folder no longer exists are tagged
`missing` — one `statPath` each, on open rather than in the store, since a
folder can vanish between two openings — and typing "missing" filters to exactly
that set, which is the state the list is usually opened in.

Per-chat branches come from `git:branches` → `branchesAt` (`git.ts`), which
reads `.git/HEAD` directly rather than spawning `rev-parse` per row, and follows
a worktree's `.git` *pointer file* so a worktree reports its own branch. The
read is skipped entirely in compact mode (`refreshChatBranches` guards on the
density), and refreshes when the folder set changes or any chat's turn ends —
any chat, not just the active one, since a turn can create a branch.

`--brand-claude` / `--brand-codex` (`index.css`) color the provider marks and are
**not** `--chart-claude` / `--chart-codex`. The chart pair are *assigned* hues, a
legend for two series, free to be warm/cool because a chart's colors only have to
be told apart. A logo's color is a fact about the brand: Claude's is that orange,
OpenAI's mark is monochrome (so it flips near-black → near-white by mode), and a
blue Codex badge would be wrong however well it paired.

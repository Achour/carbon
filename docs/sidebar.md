# Sidebar modes

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### One measure for the whole column

**Two numbers, written once: an 8px gutter on every block and an 8px inset on
every row.** So a row's hover pill always runs from 8 to the far gutter and its
icon column always starts at 16 — the New chat / Search / project-filter rows
and the chat rows are the same shape, in both densities.

They were not. The nav block sat on `px-2` + `px-2` and the lists on `px-3` +
`px-2.5`: four pixels narrower a side, six pixels further in. Nothing about it
was deliberate — the two halves were written at different times and neither
knew the other's numbers — and the symptom was not "the padding differs", it was
that **the chats looked squeezed** against the three rows above them, which they
were. Section labels (`Drafts`, `Yesterday`, `Archived`) were on a third set of
numbers again, landing between the pill edge and the content column; they now
sit on the content column, which is the thing they label.

The compact hanging indent falls out of it for free: `ml-[24px]` was chosen
against the old measure and missed by four, so a project's name and its chats'
titles were on 42 and 46. Both are on 40 now.

Not included, deliberately: the window's drag strip and the status footer keep
their own padding. Neither is a row in the list, and the footer's icon buttons
hug the right edge on purpose.

### Sidebar modes (`Sidebar.tsx`, `SidebarDensity`)

The sidebar has two shapes, chosen in Settings → Chats and persisted in
`localStorage`. They are not two skins of one list — the row format and the
organising principle change together, because each only makes sense with the
other:

- **Compact** — one line per chat, **grouped by project**, collapsible, ordered
  by the user's saved project order.
- **Detailed** — three lines: the project and the time, then the title as the
  row's headline, then the branch (or the folder path, outside a repo) with the
  row's marks — in one **flat, newest-first list** bucketed by date. Grouping by project here would
  print the same folder, and in a repo where nothing is isolated the same
  branch, once per row; the date buckets structure the list by what actually
  varies down it. "Today" goes unlabelled — the top of a newest-first list is
  today by definition.

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

The **project filter** (`All projects ▾`) applies in **both** modes. It was
detailed-only at first, on the reasoning that compact's project rows already are
the filter — but "show me one project" is not a question only a flat list asks,
and compact's answer to it was collapsing the other nine rows by hand. The two
modes were also already sharing the state: `sidebarProject` persists, and the
Pinned section scopes off it either way, so a filter set in detailed used to
quietly scope compact's pins with no control on screen to clear it.

**It is the third primary row, under New chat and Search** — not a heading over
the list. It began as the section label it replaced and never stopped looking
like one: sized against the rows beneath it, carrying the add-a-folder button,
and sitting *below* the drafts and the pins that it scopes. As a row it reads as
what it is — "which project am I looking at", beside "new chat" and "search" —
and everything it filters is underneath it.

Its icon column is the other two rows' column, so "all projects" is a **line
icon** at their size, not a tile: that state is a state of the *control*, not a
project with a mark of its own. A chosen project brings its own tile into the
same 16px box, which is the point of the column and shifts nothing. Two buttons ride its right edge, because
they are two different verbs: `FolderPlus` opens a folder the app has never
seen, and the gear opens **Settings → Projects**, the page that answers every
other question about a project. A gear rather than sliders: sliders beside a
filter read as "filter options".

**At `--ui-row` and regular weight, with an icon in both of its states.** It was
13px `font-medium` back when it was a heading, which is the failure
`docs/chat-layout.md` names outright —
*font-medium at one size reads as a larger size* — so the loudest type in the
sidebar was announcing its smallest decision while matching nothing around it.
Dropping to 11px was the wrong correction and is recorded here because it is the
tempting one: the control is not a label, and shrinking it made it disagree with
the sidebar in the other direction. Its *menu* was a second half of the same
problem — `DropdownMenuItem` and `ContextMenuItem` were `text-sm`, so every menu
in the app hung 14px rows off a 13px surface, and this control changed size
depending on whether it was open. Both carry `--ui-row` now.

The icon is the other half: drawing one only for a chosen project meant picking
a filter grew a tile and shoved the name sideways, and clearing it shrank back —
a control that moves when you use it. Both states fill the same box now, and the
menu's own "All projects" row carries the same glyph so its two columns line up.

**The pins sit under the filter, and say so on the row rather than over the
block.** They used to head the sidebar above it, which had the control that
*scopes them* — `pinnedShown` is filtered — sitting below the section it
governs. And the heading was the wrong place for what it said: being pinned is a
property of a chat, not of a group, so a label could only announce it for a
block whose membership is otherwise invisible — move a pin and the only thing
that changes is which side of a divider a row is on. `PinMark` travels with the
chat instead, beside the project on a detailed row's context line and beside the
mark on a compact one, which also means a pinned chat is recognizable anywhere
it is drawn. The block stays outside the list's own scroller: the point of a pin
is to be reachable however far down you have scrolled.

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

### A project you can recognize instead of read (`ui/project-avatar.tsx`)

Every project in this sidebar used to be a word. The compact mode's rows all
carried the same folder glyph — a picture identical on every row, which is a
glyph carrying nothing — and detailed mode's rows named their project in 11px
grey on the second line, which is the line you read *after* deciding the row is
the one you want. So the sidebar had no answer at a glance to "which project is
this chat in", on the one surface that is on screen the whole time.

The mark is the project's own icon where the repo ships one and two letters on
a hashed hue where it doesn't (`docs/projects.md` has the resolution order, the
byte cap and the ink measurement). It appears wherever a project is listed,
under one rule: *a row wears its project's mark where nothing else on screen says which
project it is in.* Four of those places are the sidebar proper:

- **Compact's project rows** wear it in the slot the folder glyph had, and the
  hover→chevron swap survives it. Hiding a generic folder on hover was free;
  hiding the project's own identity is not — but the row being hovered is the
  one row whose name you are already reading, and it is where the collapse
  affordance has to appear. The slot grew 14px → 16px, so the children's
  hanging indent went 22px → 24px with it.
- **Compact's Pinned section** is the one list in that mode spanning every
  project, and it had no project context at all: a pinned chat is lifted out of
  its group, so the row above it belongs to someone else. It now leads with the
  mark, and the `ml-[22px]` indent is gone — that indent was aligning the rows
  under the project row's icon column, and they now *have* that column. The mark
  is the row's only project label here, so it carries a tooltip — which is what
  turned up that **a tooltip whose trigger is a component only works if that
  component forwards its rest props.** Base UI's `Tooltip.Trigger render={child}`
  merges its handlers, id and ref onto the child as props, and both avatars named
  the props they wanted and dropped the rest, so the trigger anchored nothing and
  never opened. Nothing about it renders differently — `ProviderAvatar`'s tooltip
  had been dead since it was written, in the row right above this one — so the
  check is for `data-base-ui-tooltip-trigger` on the element that should have it,
  not for anything a screenshot could show.
- **Detailed rows** went to **three lines**, and the order is the point:
  *context, headline, location.* A small muted line carries the project's mark,
  its name and the time; the title then gets a line to itself at full width and
  a step brighter than anything around it; the branch closes the row with the
  marks right-aligned beside it.

  **Every arrangement before this one led with the title, and that was the
  mistake.** Leading with it means it shares its line with the timestamp, and
  on a 264px sidebar that is a third of the only thing the row is for — so
  titles truncated on almost every row while the line beneath ran out of text
  after "ai-gui · main" and left half its width empty. Two intermediate
  versions chased it: one moved the thread count, terminal mark and provider
  down to a second line (better, still truncating), and one split into three
  lines title-first (better again, still sharing line one with the clock).
  Putting the context *above* is what actually frees the title, because a
  timestamp belongs with the context it dates, not with the sentence it was
  crowding.

  It also dissolves the avatar column. The mark rides the context line instead
  of sitting in a gutter, so the title and the branch start at the row's own
  left edge and get its full width — which is the second half of why nothing
  truncates any more.

  A row is ~18px taller, so about a third fewer chats fit on screen. That is
  the trade detailed mode exists to make — compact is one line per chat and
  unchanged.

  **Two arrangements were built and shot before this one, and both failed the
  same way: two avatar-shaped objects per row.** The first put the provider on
  an 18px disc at the left and the project on a 14px chip inline on the meta
  line — two marks, two sizes, two columns, and the colour landed on the
  *quiet* line so every row's second line outweighed its title. Worse, the chip
  sat 2px before the project's own name, so half the list read "PU pulse": a
  mark and a word saying one thing twice. A mark beside its name in the same
  text flow is a badge; a mark and a name in *different columns* is how every
  contact list has ever worked, which is the arrangement here.

  The second kept one column by tucking the provider into the project tile's
  bottom-right corner. At 22px there is corner to spare, and it still read as a
  bite taken out of the project's icon — punched out of the sidebar's own
  ground it cannot help looking like damage, and OpenAI's knot at 9px is a
  smudge. The badge is the wrong shape for a mark that has no room to be small.
  Out at the end of the title nothing is occluded and nothing is shrunk past
  legibility, and the rank is right: the project is *which list this row is in*,
  the backend is a property of the row.

  **The mark does not go away under a filter.** It did at first, on the
  reasoning that the control at the head of the list had already named the
  project — true of the *word* and false of the column: every row swapped its
  mark for the provider's the moment a filter went on, so the one fixed point in
  the list became the thing that moved. Repeating a mark down a filtered list
  costs nothing. A column that changes what it depicts costs the reader the
  habit they were building.

  **A draft row is laid out identically**, because it sits directly above the
  chats: the project takes the avatar column and the pencil — the mark that says
  what *kind* of row this is — goes where a chat row keeps its provider. Drop the
  project (a filtered list) and there is no second line, so the pencil leads
  again.
- **The filter** wears the selected project's mark, because filtered the control
  *is* that project; "All projects" is not a project and gets none, since a
  stack of miniatures there would be decoration standing for nothing. Its menu
  rows each wear one, after the tick rather than instead of it — the tick is the
  only thing on that row that says *selected*, and a mark asked to mean both
  would mean neither.

The other three are the lists that span every project at once: the ⌘N picker,
the drafts section, and the chat search — whose results group by nothing at all,
so its project caption is the one thing telling two similarly-titled chats
apart, and a caption is *read* where a mark is recognized. The first two were
drawing the generic folder this change exists to remove. A draft in a folder
with no chats in it yet keeps its initials, since `projectRoots` derives the
list from chats; it resolves as soon as the folder has one, which is the same
moment it becomes a project by every other definition in the app.

**Marks arrive after the sidebar does.** They are fetched by `projectIcons`
(`main/projects.ts`), which is the overview's one field that costs no git — and
even so it is asked for on the first idle frame, `preloadHeavy`'s idiom, keyed
on the project set the way `branchKey` is. Nothing waits for it: a row with no
icon yet draws its initials, which is the same mark a project with no icon
keeps. Only roots the store has no answer for are requested, because main's
cache makes the *walk* free but every root asked for still ships its base64 URI
across IPC — re-asking for the whole list each time a project appears re-sends
every icon the sidebar already has.

The mark travels to a row as a prop rather than being read per row: forty rows
over five projects would be forty store subscriptions for a field that changes
once, where the sidebar already holds the map with one. It is therefore in
`ChatItem`'s hand-written memo comparator (`sameMark`), which that component's
doc warns about — a prop added and not compared is a prop that silently never
repaints, and "icons never appear until something else re-renders the row" is
exactly how that would have shown up.

### Archive (`SettingsArchive.tsx`, `ChatMeta.archivedAt`, `listedChats`)

A chat had two endings: stay in the list forever, or be deleted. Archiving is
the one in between — the row leaves, the conversation does not — and it is only
a feature if the way back is somewhere, so it comes in two halves: `Archive` on
a chat row's menu, and **Settings → Archive**, which is the only surface that
draws an archived chat.

**Two predicates, split by who deletes what.** `visibleChats` answers "is this
history?" and keeps its callers: Settings → Projects derives a project from it,
and `ProjectDialogs`' "Remove project deletes N chats" counts with it — because
`removeProject` deletes every chat in the folder, archived ones included, and a
confirm that quoted the shorter number would under-report what it destroys.
`listedChats` answers "does this belong on screen now?", and is called at exactly
one place: the top of `Sidebar`. That single call is what takes an archived chat
out of the groups, the pins, the date buckets, the chat search, ⌘N's project list
and the drafts, and it is the reason they cannot disagree about it.

**Archived is stored the way pinned is** — `archivedAt`, a timestamp on the meta,
written through `chats:set-archived` — because it is the same kind of fact: a
*position*, not a state of the conversation. Main is the only writer, archiving
drops `pinnedAt` on both sides (a pin is a place in a list this chat has left),
and `listChats` returns archived chats like any other, so the renderer holds one
array and filters it once. A chat can be archived mid-turn; nothing blocks it,
and the Archive row is then the only place that turn is visible, so it says so.

**Opening an archived chat restores it, and that rule lives in `openChat`.** The
alternative is a chat on screen with no row anywhere — not in the sidebar, not in
search, with a composer still willing to send into it, and `hoistChat` reordering
a list it is not in. Putting the rule at the page's button would leave the two
other ways in (a notification's click, a thread column) reaching exactly that
state. Archiving the chat you are *reading* therefore drops to the home screen — and so
does a `meta` event archiving it, which is the one way the pair could arrive from
outside this window: the database is shared, so a second instance can archive the
chat this one has open.

The page keeps the settings **reading column** rather than Projects' list/detail
split. That layout exists because a project has a remote, branches and worktrees
to show and its list was the navigation; an archived chat is four facts and two
buttons, and a detail pane would be a pane built to hold what the row already
says. Its heading is the count for the reason Projects' is — the nav says
"Archive" 130px to the left — and both actions stay drawn instead of appearing on
hover, since a page whose whole purpose is two buttons should not hide them.

**The delete confirm is shared, not rewritten** (`ChatDeleteDialog`). It was
`Sidebar.tsx`'s while the sidebar was the only place a chat could be deleted
from; it is the one dialog in the app that can also destroy a worktree, and what
it would destroy is a live `worktreeStatus` read rather than a sentence. A second
copy beside the Archive is how two confirmations end up saying different things
about the same click — the reasoning that moved the four project dialogs into
`ProjectDialogs.tsx`, with more to lose.

`demo/e2e/archive.js` drives the whole thing: it archives two seeded chats, shoots
the sidebar without them and the page that holds them, then opens one and reports
that it came back — the two rules no screenshot can show.

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

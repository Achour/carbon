# Projects

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### What a project was, and what it is now

A project has been a real concept since the sidebar first grouped by it —
`projectRoot(chat)` (`shared/types.ts`) is the key the sidebar groups on, the
chat search labels with, ⌘N picks from and `removeProject` deletes by — but it
has never been a thing you could *look at*. It existed only as the folder some
chats happened to share, carrying three annotations (`projectNames`,
`hiddenProjects`, `archivedProjects`) reachable only by right-clicking a row
that happened to be on screen.

That left one state genuinely unreachable: **hiding a project hid the only
control that could unhide it.** The way back was to re-open the folder from the
directory picker (`setSelectedCwd` un-hides), which means knowing which of the
folders on disk was the one you hid. Settings → Projects
(`components/SettingsProjects.tsx`) is where a project is a row.

Three things it says that nothing else in the app could:

- **The folder is gone.** A chat keeps working against a directory that was
  moved or deleted — main writes to it, git fails, and the failure surfaces as
  whatever the current turn happened to be doing. Here it is a fact on the row.
- **Hidden and archived are two different states**, visible *as* states rather
  than as actions you once took.
- **What the repository is**: branch, remote, worktrees. The worktrees
  especially — they are created per chat and outlive it, so the set of them is
  exactly the thing no single chat can show you.

### A list and a pane, not a page of cards

Every other settings section is a short column of settings, so the page's
`max-w-2xl` reading measure is right for them. Projects is not a settings list —
it is a **collection**, of unbounded length, whose members each have far more to
say than fits on a row. The first build stacked expandable cards down that
column and made all of it the reader's problem: a folder eleven projects down
took eleven scrolls to reach, expanding one pushed the rest off screen, and the
measure left half of a wide window empty while the worktree paths inside it
wrapped.

So the section takes the whole content area (`Settings.tsx` renders it outside
the reading column — the one section that does) and splits it the way a manager
of a collection does: **pick on the left, read on the right.** The list stays put
while the detail changes, which makes comparing two projects a click rather than
a scroll; the filter belongs to the list, because the list is now the
navigation; and the detail has the width to lay a repo's facts out in a grid
instead of a wrapped sentence.

Three consequences worth stating:

- **The pane's heading is the count, not the word "Projects."** The settings nav
  says that, highlighted, 130px to the left. A label repeating the one beside it
  is chrome; `12 projects` is a fact you did not have.
- **The selection falls back rather than persisting.** It is derived from the
  filtered list each render, so a project that is removed or filtered out from
  under the pane cannot leave the pane showing something the list no longer
  contains. The pane is keyed on the project, so a worktree row's error or busy
  flag cannot survive a change of selection and be read as the new project's.
- **Hidden and archived became switches.** They were verbs in a context menu,
  which is exactly why hiding a project hid the only control that could unhide
  it. A switch states what is true now and offers the way back in one gesture.
  Turning either *on* still asks first — both take a whole project off the
  sidebar in one click — while turning it off is the undo and asks nothing.
  `SwitchPill` moved out of `Settings.tsx` to `ui/switch-pill.tsx` for this: a
  switch is read by shape before it is read by label, so two drawn a pixel apart
  would be the page contradicting itself.

### The derivation is shared, because two lists that disagree are worse than one

`lib/projects.ts` holds `projectGroups` / `projectRoots` / `projectLabel`, and
both the sidebar and this page read them. A project is **a folder some chat
lives in**, and nothing else is one — not a key left behind in `projectNames`
(deleting a project deliberately keeps its name, so re-adding the folder finds
it again), and not `recentDirs`, which is where the *picker* has been.

Lifting `archivedProjects` and `projectOrder` out of `Sidebar.tsx`'s `useState`
and into the store was not optional. One `localStorage` key behind two
components' `useState` is two copies that drift the moment either writes, and
the symptom — the sidebar ignoring a switch until it remounts — reads as the
switch not working.

The four project dialogs moved too. `ProjectDialogs.tsx` hosts rename, archive,
hide and remove, and the sidebar and this page both render it: a second
"Remove project?" is how two confirmations end up saying different things about
what gets deleted. The chat count they quote comes from the store rather than
from either host's own list, for the same reason.

### Cost decides the split, not subject (`main/projects.ts`)

`projectsOverview(roots)` is a `stat`, a cached icon read, `branchAt` (a file
read, not a process) and three short git commands per project.
`projectDetail(root)` is every worktree, every branch, a `branch --merged`, and
a `status --porcelain` per tree. Answering both at once would make opening a
settings page spawn four-plus processes per project — fifteen projects is
sixty — for rows nobody expanded. The page pays for the list, then for whatever
is opened. `pool` bounds it at four in flight, because this runs on the machine
that is also running the user's agents.

**`projectIcons(roots)` is a third call below both, and it exists because the
sidebar draws marks at first paint.** It is the overview's one field that costs
no git: a `stat` of the folder, a walk of `ICON_CANDIDATES` (and, only if that
finds nothing, the tiers below it), one `readFile`, all of it cached for the
life of the process. Reusing `projectsOverview` for it
would put two or three subprocesses per project between the click on the dock
icon and a window — the exact cost that made the overview a *settings page's*
call in the first place — and it would ship a branch, a remote and two counts
that nothing on that surface draws. The **same `icons` map answers both**, so
the sidebar and the settings page cannot disagree about what a project looks
like, and Recheck (`clearIconCache`) reaches a mark the sidebar is drawing.

**The remote is read from `git remote`, not from the `gh` CLI.** `ghState`
spawns a subprocess with a 20 s timeout and needs a login; that is the wrong
price for a *list*, and "is a repository connected?" is a question the remote
answers for every host, logged in or not. The cost is that nothing here knows
about pull requests — the chat's own GitHub layer still does, and that is where
it belongs. `parseRemoteUrl` is pure and tested: scp-style, `ssh://`, `https://`,
nested GitLab groups (last segment is the repo, everything before it is one
owner), and a host with no dot — an SSH alias out of `~/.ssh/config` — which
gets its name printed and no link, because it resolves nowhere in a browser. A
remote with no host at all is a real remote (a clone of a folder) and answers
null, so the row prints the raw string rather than inventing an owner.

**A stale worktree is listed here and nowhere else.** `listWorktrees` drops
worktrees whose directory is gone — correct for a picker that would start a chat
in one, wrong here, where clearing it is the only thing left to do with it. So
`projectDetail` parses `worktree list --porcelain` itself, keeps the missing
ones and marks them. git's own `prunable` is trusted when set, but a `stat` is
the answer that is always current, so both are checked.

**The checkout is not a worktree, and counting it as one made the pane disagree
with itself.** git's `worktree list` leads with the main checkout, so the
section drew two rows while the summary grid beside it said one — the grid
counting *linked* worktrees, which is what anyone means by the word. The list is
the linked ones only now, and both numbers come from the same set by
construction. The checkout's row carried exactly one fact that was nowhere else
on the page — how many files are uncommitted in it — so that moved into the grid
beside the branch it belongs to; its path, branch and chats were already the
header's and the grid's.

Removing one from this page needed two fixes and one refusal, and the shape of
each is the point:

- **A worktree whose directory is gone cannot answer for itself.**
  `resolveWorktree` asks the worktree (`git -C <path> rev-parse`), so the row
  that most needs identifying resolved to null and `worktree:remove` answered
  "Not a git worktree." `resolveStaleWorktree` asks the *repo*, which still
  lists the entry; `repoRoot` is a hint from the renderer and is **verified**
  against that repo's own listing rather than trusted, so a wrong root resolves
  nothing instead of aiming a removal at another repository. `git worktree
  remove` then settles a prunable entry without `--force`, so nothing else
  changed.
- **The comparison is on realpaths, and neither side can be resolved.** git
  echoes the resolved path, so a symlink above either side makes a literal
  compare silently false — `isManagedWorktree` documents exactly this, and
  `$TMPDIR` on a mac is the case. But `realpathSync` throws on a missing leaf,
  which is every path this function is asked about, so `resolvedThrough`
  resolves the nearest ancestor that exists and puts the remainder back on. The
  test for this is what found it: without it the function returned null for the
  one input it exists to answer.
- **A chat living in the worktree blocks removal — unless the directory is
  already gone.** The `hasOtherChatIn` guard stops a removal stranding a chat,
  and the chat's own delete flow is the supported way. A directory that is
  *gone* strands nothing further: the chat is orphaned either way, and refusing
  there would make git's stale entry unclearable without first deleting a chat,
  which is the state this page exists to help out of. The row says which case it
  is before the click rather than answering with an error, and main stays the
  authority — only it sees chats this window never loaded.
- **A worktree Carbon did not create gets no button at all.** `removeWorktree`
  refuses those outright, and `listWorktrees` will not prune even a *stale* one,
  on reasoning already written there: someone else's worktree on an unplugged
  disk is merely absent, and pruning it destroys the record they need to plug
  the disk back in. So `ProjectWorktreeInfo.managed` carries
  `isManagedWorktree`'s answer to the row, which then states the fact instead of
  offering a button whose only outcome is a refusal.

**Nothing in the module throws.** Every field degrades to `false` / `null` /
`[]`: the whole point of the page is to be readable when a project is broken.

### Relocating a missing folder is deliberately not offered

It means rewriting `cwd` — and `worktree.repoRoot` — on every chat in the
project, while provider sessions hold `this.chat` by reference for their whole
lifetime and mutate it in place (see Persistence in `CLAUDE.md`). That is a real
change with a real failure mode, and not one this feature needs: the row states
the fact, stands down every action that would touch the disk, and names the two
ways out that the user can take. Rename and Remove stay available, because
neither reads the folder.

### The mark

**The project's own icon is preferred because it is the project's answer, not
ours.** A repo that ships a favicon or an app icon has already decided what it
looks like. `ICON_CANDIDATES` is a long ordered list rather than a short clever
one: a miss costs one `stat`, and the order is *what the thing calls itself* —
a packaged app's icon, then a favicon, then a logo. SVG is preferred within each
family: it survives the byte cap and is the only format here that stays sharp at
28px.

#### Exact paths are the fast path, not the whole answer

A list of exact filenames answers for every repo that named its icon the way its
framework's template did, and for nothing else. A repo carrying
`public/favicon-v5-64x64.png`, `public/favicon-32x32.png` and a `manifest.json`
naming both has a mark on disk, declares it twice, and drew two grey letters —
which is not an exotic shape, it is what happens to any project that ever
revised its favicon.

So four tiers sit under the exact list (`main/iconCandidates.ts`, pinned by
`test/iconCandidates.test.ts`), ordered by **how much the project meant it**:

1. **A web app manifest** — `public/manifest.json` and its spellings. `icons[]`
   is the project stating, in a file whose only job is to state it, which image
   represents it.
2. **`<link rel="icon">` in an `index.html`** — the same statement for the whole
   Vite/plain-web class, which ships no manifest. `parseIconLinks` is the
   favicon fetcher's own parser, reused whole.
3. **`favicon.ico`** — a weak asset at this size but a named decision, so it
   outranks the scan below it.
4. **A directory scan** of the folders icons live in — one `readdir` apiece, no
   recursion, names anchored on `favicon`/`icon`/`logo`. A guess, which is why
   it is last before the leftovers, and it is the tier that catches the size and
   version suffixes nobody standardized.
5. **Framework leftovers** (`vite.svg`, `next.svg`), which identify the
   *framework* and would otherwise give three unrelated projects the same mark.

Each tier runs only when everything above it found nothing, so a repo with
`public/favicon.svg` still costs the handful of `stat`s it always did and never
opens a directory — measured at 0.3 ms for Carbon's own repo against 1.7 ms for
one that falls through to its manifest.

**The ranking wants 128px, where `faviconCache`'s wants 32.** Same question,
different picture: a favicon beside a link is 16 CSS px, and a project's mark is
drawn at up to 44 — 88 device px on a retina panel — so the 32px `.ico` that is
perfect for a link is visibly soft here. Anything at or above 96px is *good* and
then ranked by **bytes rather than pixels**, which is why a 192px PNG beats the
512px one beside it. A `maskable` manifest icon is demoted rather than dropped:
it is drawn to be cropped, so up to 20% of each edge is padding, and rendered
whole it is a small mark floating in space — but a manifest that declares
nothing else should still resolve.

That size rule is also why the `.ico` entries left `ICON_CANDIDATES`. An `.ico`
is a stack topping out at 32 or 48 pixels and Chromium picks a frame without
being asked; a repo that has one nearly always has something better beside it.
create-react-app ships `public/favicon.ico` **and** `public/logo192.png`, and
the `.ico` won purely because it was an exact path while the PNG was only
declared — so a CRA project was represented by its worst copy. It drops below
the two *declared* tiers and no further: a file a project named `favicon.ico` is
a decision, where a name merely starting with `logo` is a guess. Under the scan,
every create-next-app repo with a themed logo pair would resolve to
`logo-light.svg` — invisible on a light theme, since `classifyInk` only inverts
marks that are dark.

`ICON_MAX_BYTES` (128 KB) is a *transport* limit before it is a taste one —
every hit is base64'd into a `data:` URI and shipped with the rest of the list.
Carbon's own `build/icon-1024.png` is 979 KB and is correctly skipped in favour
of the 1.7 KB `build/icon.svg` beside it, so the cap and the ranking agree. The
file is **sniffed**, not trusted: `public/favicon.ico` is very often a PNG, or a
committed HTML 404, and a `data:` URI carrying markup draws nothing while
looking exactly like a broken icon. `imageMime` is the favicon fetcher's own
gate, reused whole.

The cache re-validates a **hit** against its source file's mtime, so replacing
an icon shows up without a restart, and does not re-validate a **miss** — there
is no file to watch, and re-walking forty candidate paths per render is what the
cache exists to avoid. Recheck (`clearIconCache`) is the answer for a project
that has just been given one, which is why the button says what it says.

#### The scan is a default, not a verdict (`main/projectIconStore.ts`)

It is right about almost every repo and unfixably wrong about a few — a monorepo
root with no icon anywhere under it, a repo whose only image is a placeholder
nobody replaced, a client project whose mark lives in a design file. So the
header avatar in Settings → Projects is itself the control (the ⋯ menu carries
the same items, for anyone who doesn't try clicking the icon), offering three
states: choose an image, use the initials, or go back to what is in the folder.

**"Use the initials" is a state, not the absence of one.** A project whose
folder *does* contain an icon the user does not want drawn has to be able to say
so, and merely clearing the override would hand that icon straight back. It is a
`<key>.none` sentinel file, which is why `ProjectOverview` carries `customIcon`
beside `icon`: a null mark with the flag set is a deliberate choice, and only
then is there something to revert.

**The directory is the record.** `userData/project-icons/<hash of root>.<ext>`
exists, or the project has no override — no second copy of that fact in
`settings.json` to drift out of step with it, no migration when the shape
changes, and `rm -rf` on the folder is a complete reset. Data URIs in
`settings.json` was the alternative and is startup-parse weight, per project,
for a file read at launch.

The chosen file is **copied, not referenced**: a path into `~/Downloads` is a
mark that vanishes the next time the user tidies up, and one inside the repo
vanishes on the next branch switch — neither failure would say anything, the
mark would just be two grey letters again. A raster is re-encoded only when it
has to be (over the cap, or wider than 512px, which is the common case of
picking a 2048px brand PNG); a 3 KB 64px favicon is stored exactly as it is
rather than upscaled into a blurry 256px one.

The override is read **above the `exists` gate** and above the cache: it is not
in the project's folder, so a project whose directory was moved or deleted keeps
the icon its owner chose. `projectIconStore.ts` is `node:*`-only and takes its
directory by injection — the scan imports it, `test/projectIdentity.test.ts`
imports the scan, and one `import … from 'electron'` underneath stops that test
at a SyntaxError. The dialog and the resizer live in `projectIconPicker.ts`, the
same split `favicons.ts` keeps against `faviconCache.ts`.

**The fallback is two letters and one hue** (`lib/projectIdentity.ts`,
`ui/project-avatar.tsx`). It must be stable — the same project draws the same
mark forever, across launches and machines — and distinguishable, which rules
out both a random colour and a colour stored anywhere: a mark you have to
persist is a mark that can go missing. So the hue is hashed (FNV-1a) rather than
counted, and it is keyed on the **path** while the letters are keyed on the
**display name**: renaming a project is a label change, and repainting its mark
at the same moment would make one gesture look like two.

The hues are **twelve spaced values, not `h % 360`**. Hashing to a continuous
hue is one line shorter and routinely puts two projects four degrees apart,
which reads as a mistake rather than as two colours — worse than an outright
repeat, because a repeat is obviously "two things I have to read the letters on"
while a near miss looks like the app failed to tell them apart. Lightness and
chroma are `--project-ink-*` in `index.css`, re-stepped for dark mode, so one
number per project covers both grounds instead of twenty-four constants to keep
in step.

**An icon is measured before it is drawn.** A favicon is made for the site's own
background, and a dark monochrome glyph on transparency — the house style for
developer projects, and what `build/icon.svg` is — is an invisible mark on
Carbon's dark sheet. `classifyInk` (`lib/faviconInk.ts`) is the same verdict the
transcript's link marks use, keyed here on the project root so it is computed
once per project rather than once per render.

That module now also **dedups measurements in flight**, which it did not need
to while every caller was one row on a settings page. `verdicts` only answers
after the decode resolves, so forty sidebar rows over five projects — all
mounting in the same tick as the icons land — each started their own `Image`
and their own canvas for an answer four of their neighbours were already
computing. One promise per key, deleted when it settles.

**The mark is drawn at four sizes, and a size is one thing.** `SIZES` in
`ui/project-avatar.tsx` sets box, radius and initials together (`xs` inline on a
meta line, `sm` a row's leading glyph, `md` a list row, `lg` the page header),
because they do not move independently: a call site that overrode `size-7`
alone kept 11px letters inside a 16px disc, and a 12px corner that reads as a
rounded square at 44px reads as a circle at 14px. Where each one appears in the
sidebar, and why, is in `docs/sidebar.md`.

### Shooting it

`demo/e2e/projects.js` opens the page at its own section — the store holds
`settingsSection` precisely so something outside the component can name one —
selects the project that has a worktree, and reports what main actually resolved
per row, so a run says whether main answered rather than only whether the page
drew. `demo/setup.sh` gives two of the three demo repos an `origin` and leaves
the third without one, since a project with no remote is a state worth shooting
too; nothing is ever pushed, because the remote is only a string git holds,
which is exactly what the row reads.

`demo/e2e/project-marks.js` is the sidebar's half: six frames from one launch
— compact, detailed, the filter open, filtered to one project, the ⌘N picker
and the chat search — because the mark is one answer drawn six ways, and a run
that shot them separately could catch six different states of the icon cache.
Density, the filter and both dialogs are driven through the store rather than
clicked: the first two persist, so a click is a *toggle* against whatever the
last run left, and the dialogs open on shortcuts no screenshot can press. The
script puts everything back before it resolves. The demo profile is built for this by accident and kept that way on
purpose: `nimbus` ships a `public/favicon.svg` and the other two ship nothing,
so one run covers the icon and the initials.

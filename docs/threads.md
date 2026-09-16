# Threads

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Threads (`ThreadView`, `ChatMeta.sideOf`, `sideColumns`, `focusedChatId`)

A chat in the sidebar is a **thread**: its own conversation plus up to three
more opened beside it (`MAX_THREAD_CHATS`), drawn as columns that share one
right panel. Each column is a whole `ChatView` — its own transcript, prompts,
checklist and composer, on whatever model was picked for it — so one thread can
have Claude building, Codex reviewing and Grok sketching, all in the same folder
and reading the same preview and working tree.

This replaced **side chats as panel tabs**. A side chat was a second
conversation in a right-panel tab, and it lost to everything else that wanted
the panel: reading one meant the diff, the preview or the file you were checking
it against was no longer on screen. The conversations are the work; the panel is
what they share. So the conversations became columns and the panel became
something that floats over them.

**The data did not change.** A thread's other chats are exactly the side chats
the tab version created — `ChatMeta.sideOf` names the thread, `ephemeral` keeps
them out of `listChats` — so every row an older build wrote opens as a column
here, and main needed no new concept. What changed is where they are drawn and
what "the active chat" means in the renderer.

- **A side chat is a real chat wearing a flag, not a lighter kind of session.**
  It goes through `chats:create`, `ChatManager` and the same persistence; a
  parallel session type would have meant a second implementation of resume,
  permissions, tools and streaming. `ephemeral` rides the JSON `meta` blob, so
  there is no migration — which matters because `userData` is shared between
  builds and an older one has to open this database — and the field keeps its
  name although nothing about it is ephemeral any more: renaming would cost
  compatibility code to say the same thing.
- **The thread's own chat is the first column and keeps the store's bare
  fields** (`messages`, `hiddenBefore`, …); every other column is a keyed
  `SideChatSlot` in `sideChats`. `onScreen` / `surfaceOf` / `patchTranscript`
  are the one set of helpers every streamed event routes through, so the columns
  cannot disagree about how a `tool-update` lands — and `demo/e2e/threads.js`
  asserts a turn in one column leaves every other column's `messages` at the
  **same reference**, not merely the same length, since a fresh array with
  identical contents still re-renders that whole transcript on every delta.
  `messagesOf(s, id)` is the allocation-free read for a selector.
- **The thread's own chat owns everything that acts on the thread**: the title,
  the ⋯ menu (rename, delete, merge, the worktree exits) and its dialogs moved
  out of `ChatView` into `ThreadView`'s header. So do the folder, branch and
  changes chips (`ContextStrip`) while several chats show: they describe the
  thread, which every column shares, and drawn in the first column alone they
  read as that chat's — the others looked like they had no branch and no
  changes. With one conversation showing (a single chat, or one expanded) they
  sit above that composer, as a chat's always have.
  With a single chat the header is the one the chat always had plus the `+`
  that adds a column, so a chat that never grew one looks as it did.
- **`listChats` is where side chats are hidden, and `listSideChats` is the
  second read that brings them back at launch.** `listChats` seeds the sidebar's
  order, the chat search, ⌘N's project list and Recents, and filtering at each of
  them means the next one added forgets. The metas live in the renderer's
  `chats` beside every other chat's (a title landing, a model change and a turn
  starting all patch that array by id), and `visibleChats` filters at the single
  place that draws history. `pruneChatDrafts` gets the union, or the launch that
  restores a side chat drops its draft.
- **It leaves no trace in the app's defaults.** `chats:create` skips
  `rememberOptions`/`rememberDir` for an ephemeral chat and `setChatOptions`
  skips the renderer's mirror of them. Both halves are needed or the defaults
  flip back on relaunch — and without either, trying a cheaper model in one
  column silently makes it the model the next New-chat screen offers.
- **No AI title.** The adapters' `maybeGenerateTitle` still bails on
  `ephemeral`; the placeholder `send` derives from the first message is what a
  column's header and pill show.

### Columns are stashed, persisted and restored with their thread

`sideColumns` is the active thread's open columns in order; `sideColumnsByChat`
holds every other thread's (`columnsOf` reads either). `chatSwitchPatch` stashes
and restores them at the same seam as `openFiles`/`activeTab`, and **releases
the outgoing thread's slots**, exactly as closing a column does. A slot is what
`onScreen` keys on, so one left standing kept every delta of a thread nobody was
looking at running through `set` — and every selector in the app with it. The
thread's own transcript is refetched when it is opened anyway, and its columns
are fetched back beside it.

**They are written through to storage** (`localStorage.threadColumns`, from a
store subscription at the foot of `store.ts`). In memory only, every thread
relaunched as one column with its other chats sitting in the closed list, which
reads as the app having lost the layout. At `init` the stored map is pruned to
side chats that still exist and still belong to that thread; `openChat` then
drops any column whose chat has gone and fetches the rest into fresh slots
(`hydrateSideChats`), since a column restored from storage has no transcript
behind it.

- **The chat is created up front, not on the first send.** The project-draft
  rule — a prompt never sent leaves nothing behind — does not transfer: its
  reasons are that `chats:create` freezes a provider/model pair and, for a
  worktree target, runs a real `git worktree add`. A side chat takes no
  worktree, its pickers stay live, and deferring would have bought an empty
  column carrying its own pre-creation copy of the pickers.
- **`addThreadChat` captures the thread before its `createChat` round trip**, so
  a switch made inside that trip files the column under the thread it was added
  to rather than dropping it onto the one now on screen — `openChat`'s
  `if (get().activeId === id)` guard in the other shape.
- **Closing a column does not delete the chat, and it asks first**
  (`CloseChatDialog`). A close takes a live chat off the screen — possibly
  mid-turn or with a prompt waiting — from a ✕ beside the expand button in a
  32px header, so it is not left to a stray click; the dialog says what happens
  to *that* chat (kept, discarded if untouched, or still running in the
  background). The one you close is very often the one you want two minutes
  later. The `+` in the thread header turns into a
  popover listing **Closed chats** once there is one, sorted on `updatedAt`
  (metas restored at boot arrive newest-first and `hoistChat` moves rows on every
  turn start, so array position says nothing), each with the activity dot a
  closed chat mid-turn would otherwise have nowhere to show. **One thing deletes
  one: the ✕ on a row there, and it asks first** (`SideChatDeleteDialog`,
  rendered by `App` because the popover closes on the click).
  - **The slot is dropped on close and refetched on reopen.** Main keeps the
    session alive and keeps persisting, so a retained slot would be a second copy
    of the truth that drifts. Dropping it also makes `onScreen` false, which is
    what turns a closed column into an ordinary background chat.
  - **A column that was never used is discarded on close**, or `+` → ✕ would
    leave a blank row in the list. "Never used" includes *no turn in flight*: a
    message sent a second ago has an empty transcript and an answer on its way.
- **They survive quitting.** The tab version first deleted side chats at quit,
  and that was wrong twice: quitting is a weaker statement of intent than
  closing (a laptop lid, an update, a crash), and the purge never deleted the
  conversation anyway — the CLI writes its own transcript regardless, and the
  Usage page bills it. What is left is one rule: a side chat is removed when the
  user says so, or when its thread is.
- **Deleting a thread deletes its side chats**, enforced in main
  (`sideChatIdsOf`, in the `chats:delete` handler) as well as in the renderer
  (`pruneSideChats`), because a *closed* one has no column anywhere and the
  database is shared between builds. **They also leave a worktree with their
  thread**: the three exits relocate `sideChatIdsOf(chatId)` alongside it.
- **`hasOtherChatIn` ignores them.** It gates every worktree exit, and a column
  runs in its thread's cwd by construction — counted, it would refuse to remove,
  merge or hand off the worktree the whole thread is about.

### Reordering columns, and dragging a thread into another

**Columns reorder by drag**: a column's header, or its pill in the thread
header, dropped on the left or right half of another column or pill. The order
is kept as a hint per thread (`threadOrder`, persisted) and read through
`orderByHint` rather than stored as the columns themselves, because columns are
added, closed, reopened and restored at launch by paths that know nothing about
order — as a hint, a new column lands at the end, a closed one drops out and a
reopened one comes back where it was, with none of those paths keeping a second
list in step. The thread's own chat can be dragged anywhere too: position is
presentation, while which chat *is* the thread (its title, its ⋯ menu, the one
column with no ✕, the store's singular transcript slice) stays data.

**A sidebar chat dragged onto the thread on screen joins it as a column**
(`joinThread`, `chats:move-to-thread`). Joining is a meta change and nothing
else — the chat gains `sideOf` and `ephemeral`, so do the side chats it already
had, and their sessions are untouched — which is why it can be done at all
without a migration. The columns it had open come with it, after it; the ones
it had closed join the closed list. It is refused, and says so while hovering
(`threadJoinCheck`), for a terminal chat, for a chat in another folder (a column
runs in its thread's cwd), and when the chat and its open columns would not all
fit — refused rather than trimmed, so a drop never silently closes something.
**And back out**: a column's header or pill dropped on the sidebar — or "Move to
its own chat" on the header's right-click menu — takes the chat out of its thread
(`leaveThread`, `chats:leave-thread`): `sideOf` and `ephemeral` are cleared, its
`updatedAt` is bumped so its row lands at the top of the list rather than
wherever its last turn was, and its column closes the way a closed column does.
Only a side chat can leave; the thread's own chat *is* the thread, so the
sidebar does not offer itself for one.

The dragged id rides `lib/threadDrag.ts` as well as the drag payload, because
`dataTransfer.getData` is empty until the drop and the verdict is needed before
it. Main checks the same rules again, since it is the layer that writes the rows.

### Focus (`focusedChatId`, `focusChat`)

With one transcript on screen "the active chat" answered every question about
which chat an action meant. With four it answers none of them, and each place
that read `activeId` was a bug in waiting: act on a column, and the thread's
first chat is what moves. So a thread has a **focused** chat — set on pointer
down or focus inside a column (capture handlers on `ThreadColumn`'s section,
which wraps the header and the transcript; imperative, so a focus change
re-renders no transcript), reset to the thread's own chat on every switch, and
moved by ⌘1–⌘4, a pill or a notification (`focusChat(id, { caret: true })`, which
also puts the caret in that composer and, if another column is expanded, moves
the expansion — focusing a chat you cannot see would leave keys answering a
hidden column). `focusedChatId` is never null while a chat is open, so nothing
reads it with an `activeId` fallback.

- **Focus is shown without an outline.** The focused column's number badge is
  filled, its title is at full brightness, and its pill in the thread header is
  raised. A ring around the column was tried and removed: it said the same thing
  a fourth time, as the one border in an app that draws none around a chat.
- **Permission keys.** Enter/Esc ride a window listener per mounted prompt, so
  four columns each nominating their oldest prompt would all fire on one key.
  `focusedChat(e.target)` answers from `data-chat-surface` when focus is inside a
  column, and `focusedChatId` when it is nowhere in particular.
- **Everything that used to resolve `activeId` now takes a chat.**
  `respondPermission`, `sendMessage`, `interrupt`, `setChatOptions`,
  `startCodexReview` and `loadOlderMessages` already did from the tab version;
  `rewindFiles` and `editMessage` now do too (`TurnChangesCard` and
  `UserBubble` get the id through `RenderCtx`, which is part of
  `sameHistory`'s key), as do `stopBackgroundJob`, `BackgroundJobs` (the header
  passes the focused chat) and `SessionPanel` (each composer passes its own).
- **What follows focus rather than a chat id**: the attachment inbox (the
  editor's "Add to chat", the element picker) goes to the focused composer; the
  review's **Last turn** scope is the focused column's last turn — one
  `useScopedChanges` hook for the changes tree, the stacked diffs and the review
  bar, subscribed to that transcript only while the scope is picked, and the
  same chat's turn is what the commit prompt names; the Agents tab
  shows the focused column's roster unless it was opened for another
  (`rosterChat`).
- **`unreadChats`** marks a column whose turn ended while another had focus —
  its header says **Done** and its pill carries a dot — because with four
  columns the one that finished is not the one being read. Only with more than
  one chat on screen; focusing it clears the mark.

### Layout

Two chats always sit side by side. Three or four follow the header's
Columns/Grid toggle (`threadLayout`, persisted), defaulting to columns for three
and a 2×2 grid for four (`threadLayoutFor`) — four columns fall under a readable
width on any laptop. Columns never draw under `THREAD_COLUMN_MIN_PX` (340); past
that the strip scrolls sideways rather than crushing a transcript.

- **Esc steps back one layer**: a floating panel first, then an expanded column
  (beside which the panel is docked, so it stays).
  It listens on `document` in the bubble phase — below `window`, where the prompt
  dock listens, and above React's root, where the composer's menus mark the key
  handled — so with a prompt pending the first Esc closes the panel and only the
  second denies. Keys inside the panel or an open popup are left to them.
- **Expanding a column (⤢, double-click its header, ⌘⇧↵) gives it the full
  width and hides the others**, with nothing drawn in their place. They were
  folded to 44px vertical rails at first, each with its number, provider and
  status — which is exactly what the header's pills already show, one row up,
  and a pill click already switches the expansion. So the rails were a second
  tab strip. The others are **hidden** rather than unmounted: a column is a live
  transcript, and a remount restarts its stream reveal, drops its scroll position
  and replays its rows' entrances.
- **With several chats on screen, a composer nobody is writing in folds to one
  line** (`Composer`'s `collapsible`, from `severalChatsShown`): the input, and
  on the same line the model and permission pickers, attach, the context ring
  and send or Stop. Four full composers took a third of every column. Two
  shapes were tried first and dropped: hiding the toolbar left an empty
  capsule that read as a broken search box, and moving the pickers to a tray
  under the input read as a second box. The toolbar is **one element in both
  shapes** — the frame is a wrapping flex row, and folding only changes each
  child's basis and order — so nothing remounts and a picker opened folded
  stays anchored. **Only the input engages it** (focus or a click in the text),
  and focus or a click outside the composer folds it again; a popup it opened
  portals out of it and still counts as inside, and the pickers work folded
  without moving under the pointer. It never folds while it holds text,
  attachments or a slash/mention menu, and prompts and the task dock sit above
  the input either way. **The fold animates**: no CSS transition can
  interpolate a line becoming a textarea over a toolbar, so the frame's height
  is animated from the previous render's measurement to the new one (Web
  Animations, clipped while it moves) and the toolbar fades into place; reduced
  motion skips it.
  Relatedly, only the thread's own chat's composer takes the caret on
  mount: every column mounts at once when a thread opens, and each grabbing it
  left focus, and the thread's focused chat, on the last column.
- **The composer's chips drop their labels under a 400px bar**
  (`@container` on the toolbar row). Each chip's label is several spans, and in a
  narrow column they overflowed into each other rather than truncating — the
  model trigger drew its effort over the permission chip. The model name stays;
  the effort and the permission's words are one click away.
- **The sidebar row is the thread's.** `ThreadMark` counts its open chats, and
  the row's activity is `projectActivity` over all of them, so "needs your input"
  on a row means some column in that thread does.

### The shared panel floats (`panelFloating`)

**With several chats on screen, floating is the default, and pinning docks
it.** One conversation on screen — a single chat, or one column expanded —
always gets the docked panel, and no pin: it has the width to spare, and covering
the only conversation showing bought nothing — floating there read as the panel
having broken. Expanding a column docks an open panel beside it; restoring the
thread floats it again. Docked, the panel takes the
width two columns need; floating, it is the *same* panel — full height, flush to
the window's right edge, its strip on the title bar — laid over the chats, and
the columns beneath never reflow on open or close (the e2e measures the column
strip at the same width with the panel open, and the panel at the content pane's
full height). The first cut was an inset card under the thread header, and it
read as a smaller, lesser panel rather than the one you had docked, so the only
thing that differs between the two placements is whether the chats make room.
Pinning puts it back beside the thread, where a preview you are watching while
you type has to be.

- **Docked, the panel leaves room for the thread**, not for one chat:
  it reserves two columns while several chats show (`severalChatsShown` — past
  two, columns scroll and a grid has two per row), and one chat's worth
  otherwise. `panelFloats` is the one reading of "is it floating" that the panel
  and Esc share. The first cut reserved the single-chat 480px, and
  pinning beside four chats squeezed the grid to half its floor.
- **Floating, it may cover all but `FLOAT_EXPOSED_PX`** of the thread, so a
  column's edge stays visible to click back into. Maximizing still turns the
  panel into the content pane, where it has nothing to float over.
- **Its contents follow the thread, not a column.** Open files and the active
  tab are stashed under the thread's chat, previews are keyed by cwd, and every
  column runs in that cwd — so whichever column opens a file or a page, it lands
  in the one panel all of them are reading. The plan tab shows for any column's
  plan, and an `ExitPlanMode` request from any column opens it.
- **Open in either placement, the panel's own header holds the collapse** at the
  inset the thread header's toggle uses, so open and close stay one unmoving
  target. The thread header's right end is covered while it floats; closing the
  panel (or Esc) uncovers it.

### The two stores that were singletons

`agentsStore` and `taskListStore` held one chat's roster and checklist. That is
why the side variant used to publish into neither: with two transcripts mounted,
whichever folded last won, and closing a side chat cleared the main chat's
roster. Equal columns cannot live with that, so both are keyed by chat id
(`byChat`), each `ChatView` publishes its own entry and removes it on unmount,
and every column now carries its own task dock, goal bar and agent activity bar.
The Agents tab shows while any column has runs.

### Notifications

A column notifies like any chat — main's `notifyOnStatus` and the renderer's
`notifyTurnDone` both skip only an ephemeral chat *without* a thread. Clicking
sends `openChat` a side chat's id, which opens its thread and brings the column
to the front, reopening it if it had been closed. The tab version could not:
opening a side chat as the active chat was a state nothing else allowed, and a
notification whose click does nothing is worse than none.

`demo/e2e/threads.js` pins all of the above against the real reducer, drives
the reorder and the join with real drag events, — the
reference identity across columns, the cap, focus and unread, the layouts,
an expansion that hides the other columns without unmounting them, close/reopen/discard, persistence and
restore, opening a side chat by id, the floating panel's zero reflow, the docked
reserve, and composer chips that never overlap — and shoots the five states.

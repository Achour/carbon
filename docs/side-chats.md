# Side chats

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Side chats (`ChatMeta.ephemeral`, `SideChatSlot`, `openSideChat`)

A second, scratch conversation in a right-panel tab, running in the same
project as the main one and kept out of the sidebar. It exists because every
question *about* the work in flight — what an error means, what a function is
for, whether there is a shorter way — either interrupted the turn you were
watching or cost a chat switch that took the transcript, the tabs and the file
tree with it.

**The renderer was built around there being exactly one conversation on screen,
and that is the only thing this really changes.** `store.ts` holds the active
chat's transcript in *bare* fields — `messages`, `hiddenBefore`, `loadingOlder`,
`contextUsage` — and `applyEvent` gated every transcript write on
`ev.chatId === s.activeId`. Those four fields are now also a `Record` keyed by
chat id (`sideChats`), and `onScreen` / `patchTranscript` are the one pair of
helpers every streamed case routes through, so the two surfaces cannot disagree
about how a `tool-update` lands. Everything else about a chat was already
`Record<chatId, …>` — `statuses`, `permissions`, `queued`, `backgroundJobs`,
`rateLimits`, `fastMode` — and `ChatManager` keys sessions by chat id with no
notion of an active one, so main needed no new concept at all.

- **A side chat is a real chat wearing a flag, not a lighter kind of session.**
  It goes through `chats:create`, `ChatManager` and the same persistence; a
  parallel session type would have meant a second implementation of resume,
  permissions, tools and streaming. `ephemeral` rides the JSON `meta` blob, so
  there is no migration and no `user_version` bump — which matters because
  `userData` is shared between builds and an older one has to open this
  database — which reads the row as an ordinary chat, and is also why the field
  keeps the name `ephemeral` now that nothing about it is: 0.1.95 rows already
  carry it, and renaming would cost compatibility code to say the same thing.
- **`listChats` is where it is hidden, and that is deliberate.** That one read
  seeds the renderer's `chats`, which is the sidebar's order, the chat search,
  ⌘N's project list, the Recents section and `pruneChatDrafts` — filtering at
  each of them means the next one added forgets. The metas still live in `chats`
  in the renderer (`visibleChats` filters the sidebar's own read, in a memo
  rather than a selector, since a fresh array per call fails zustand's snapshot
  comparison and loops React into a crash). They have to: `meta`, `message` and
  `status` all patch that array by id, and holding them elsewhere would mean a
  second branch in each.
- **The tab is created eagerly, not on the first send.** The project-draft rule
  says a prompt you never sent must leave nothing behind, and it does not
  transfer here: its actual reasons are that `chats:create` freezes a
  provider/model pair and, for a worktree target, runs a real `git worktree add`.
  A side chat takes no worktree, its pickers stay live, and the row it writes is
  invisible and deleted at quit. Deferring would have bought an empty tab
  carrying its own pre-creation copy of the model, effort and permission mode —
  `NewChat`'s state, per tab, for a chat that lasts an hour.
- **It leaves no trace in the app's defaults.** `chats:create` skips
  `rememberOptions`/`rememberDir` for an ephemeral chat and `setChatOptions`
  skips the renderer's mirror of them. Both halves are needed or the defaults
  flip back on relaunch — and without either, asking one throwaway question on a
  cheaper model silently makes it the model the next New-chat screen offers.
- **A side chat belongs to ONE chat, and its tab is stashed with that chat's.**
  This was scoped by *project* first, mirroring `canvasScopePatch`, and that is
  the wrong unit: moving between two chats in one folder left a scratch
  conversation about the first one standing in the strip beside the second, with
  a transcript answering a question the chat on screen never asked. A canvas is
  a document that belongs to a project; a side chat is a conversation *about a
  conversation*. So it rides `chatSwitchPatch` — the same stash-and-restore
  `openFiles` and `activeTab` already get, at the same seams — which makes
  project correctness follow for free, since a side chat runs in its parent's
  cwd and is only ever visible while that parent is open. It is a **stash**, not
  a close: a turn mid-flight keeps running and the tab comes back where you left
  it. `sideChats` is deliberately untouched by the switch, so a stashed tab
  keeps accumulating its turn and paints instantly on return. Two consequences:
  `openSideChat` refuses on the home screen (nothing to sit beside, and a tab
  keyed to no chat could never be stashed — the + menu and the launcher drop the
  row there rather than offering one that does nothing), and it captures
  `activeId` *before* its `createChat` round trip so a switch made inside that
  trip files the tab under the chat it was opened beside — `openChat`'s
  `if (get().activeId === id)` guard in the other shape.
- **Deleting a chat deletes the side chats opened beside it** (`pruneSideChats`,
  shared by `deleteChat` and `removeProject`). Without it the tab restores over
  whatever chat comes next, the slot sits in `sideChats` for the rest of the
  session, and the row outlives the conversation it belonged to.
- **Closing its tab does not delete it**, and the first version got this exactly
  backwards. "Temporary" was read as "✕ discards it", which makes the side chat
  you close the one you can never get back — and the one you close is very often
  the one you want two minutes later, because that is what a scratch
  conversation *is*. So ✕ means what it means on a file tab: the tab goes, the
  conversation stays, and the panel's `+` menu grows a **Closed side chats**
  section to bring it back. **One thing deletes one: the ✕ on a row in that
  list, and it asks first** (`confirmSideChatDelete` → `SideChatDeleteDialog`,
  rendered by `App` because the menu the ✕ lives in closes on the click).
  - **The slot is dropped on close and refetched on reopen** (`getChat`,
    layering anything that streamed in during the round trip, exactly as
    `openChat` does). Holding the transcript across the close was the obvious
    shortcut and is wrong twice: main keeps the session alive and keeps
    persisting, so a retained slot is a second copy of the truth that drifts
    from disk, and it would grow for every side chat closed in a session.
    Dropping it also makes `onScreen` false, which is what correctly turns a
    closed side chat into an ordinary background chat.
  - **A side chat that was never used is discarded on close**, or `+` → Side
    chat → close would leave a blank row in the list for the rest of the
    session. "Never used" has to include *no turn in flight*: a message sent a
    second ago has an empty transcript and an answer already on its way, and
    deleting that would throw away the thing the user just asked for.
  - **The reopen row carries the activity dot** the tab would have. A closed
    side chat mid-turn has no tab, so without it a finished answer lands with
    nothing on screen to say so — and a companion conversation that can lose an
    answer is not one.
- **Deleting a chat deletes the side chats opened beside it.** `ChatMeta.sideOf`
  is what makes that answerable: a *closed* side chat has no tab anywhere, so
  keying the cascade on the tab maps — which is how it was written first — would
  have orphaned exactly the ones this lifecycle now produces most. It is
  enforced in **main** as well as the renderer (`sideChatIdsOf`, in the
  `chats:delete` handler), because the renderer's maps describe one window and
  this database is shared between builds.

**Four things break silently without a guard, and each is a case where the
"obvious" code is wrong only once there are two transcripts:**

- **The singleton stores.** `agentsStore` is a pure singleton (it holds one
  chat's runs, with no id to check) and `taskListStore` is one with a stamp. The
  side variant publishes into neither: whichever folded last would win, so the
  Agents tab would flip between the two chats' rosters and the dock would blank
  each time the other published. Worse, `ChatView`'s unmount-clear would let
  *closing a side chat* empty the main chat's roster and pull the Agents tab out
  of the strip while its agents were still running. The cost is that a side
  chat's own checklist is invisible while it runs; the main column owns both
  surfaces, which is also where they belong.
- **The permission keys.** Enter/Esc ride a window-level listener per mounted
  card, and `keyboard` alone stops meaning "this card owns them" once two
  transcripts each nominate their own oldest prompt — both fire on one keypress.
  `keyMayAnswer` cannot break the tie either: it unlocks on *either* composer
  being empty. `focusedChat` resolves it off `data-chat-surface`, the neutral
  marker on both roots (`data-chatview` is the frosted main column, which a side
  chat is not); with focus nowhere, the main column answers.
- **`respondPermission` resolved its chat as `activeId`**, so a prompt answered
  in a side chat would have released the *main* chat's request. It, `sendMessage`,
  `interrupt`, `setChatOptions`, `startCodexReview` and `loadOlderMessages` now
  all take the chat explicitly — a side chat is never the active one, so every
  one of them would have acted on the wrong conversation behind right-looking UI.
  `PlanPanel` had the same bug twice over: it resolved its chat from `activeId`,
  and `showPlan` gated the tab on it, so a side chat entering plan mode set
  `activeTab: 'plan'` for a tab the strip refused to draw — the side tab
  deselected and the plan appeared nowhere.
- **`hasOtherChatIn` gates every worktree exit.** A side chat opened to ask about
  the work runs in that same cwd, so counted it would refuse to remove, merge or
  hand off the worktree its own conversation was about — a menu item that quietly
  does nothing. An *unreadable* row still counts, though: that answer decides
  whether a directory is destroyed, and the safe reading of "I cannot tell" is
  that someone is in there.

**They were deleted at quit, and that was wrong twice.** The first design
borrowed the tool this feature was modelled on — "side chats are temporary and
disappear when you close the app" — and it survived one round of use before both
halves came apart.

The first is a lifecycle inverted. ✕ on a tab already *keeps* the conversation,
for the reason recorded above: the one you close is very often the one you want
two minutes later. Quitting is a **weaker** statement of intent than that click —
it is closing a laptop, an auto-update, a crash — so an app where the smaller
gesture is conservative and the larger one destroys is one that loses work at
exactly the moment the user was not thinking about this feature at all. Carbon
had already written the rule down: drafts exist because unsent text vanished on
a chat switch, and a side chat holds an *answer*.

The second is that the promise was never true. A side chat drives the real CLI,
which writes its own transcript to `~/.claude/projects/<slug>/<session>.jsonl`
regardless — the Usage page reads those files and already bills the side chat's
tokens. `ephemeral` gates exactly one thing in the adapters (`maybeGenerateTitle`).
So the purge deleted *Carbon's ability to show the conversation*, not the
conversation, which is the half that costs the user and none of the half that
reassures them.

Removing it took more out than it put in: `purgeEphemeral`, `ephemeralIds`, the
`before-quit` ordering against `flushAll`'s `closed` flag, the startup pass ahead
of `registerIpc`, and with them the whole crash story — a killed instance leaves
its `locks` row behind, and for `LOCK_STALE_MS` (30 s) that row is
indistinguishable from a live instance's, so the purge correctly declined and a
force-quit orphan waited for the launch after next. What is left is one rule: a
side chat is removed when the user says so, or when the chat it belongs to is.

**`listSideChats` is the price of persisting them.** `listChats` filters side
chats out, and that read is what seeds the renderer's `chats` — so left alone, a
side chat survived the quit on disk and was invisible on the next launch, which
is worse than deleting it. It is a **second read** rather than a flag on the
first, because that one call is also the sidebar's order, the chat search, ⌘N's
project list and Recents, and widening it puts the predicate back at every one
of them. Both land in the renderer's own `chats`, which is where side chat metas
already lived for the session that opened them; `visibleChats` filters at the
single place that draws history (`Sidebar`), and `homeCwd` takes the visible
half so the newest chat's project is never a side chat's. `pruneChatDrafts` gets
the **union**, or the launch that restores a side chat drops its draft.

`ClosedSideChats` sorts on `updatedAt` rather than reversing `chats`. Reversing
read array position, which meant "newest last" only for the ones `openSideChat`
appended this session: restored metas arrive newest-first, and `hoistChat`
reorders on every turn start anyway — so after a relaunch the row you closed a
minute ago sat at the bottom.

A delete still writes **no tombstone** — a tomb only guards against the legacy
`chats/<id>.json` archive resurrecting a chat, which a side chat postdates by
construction, so it is a row that could never do anything but accumulate.

**Side chats leave a worktree with their parent.** The three exits
(`worktree:handoff` / `:merge` / `:finish`) relocate `sideChatIdsOf(chatId)`
alongside the chat itself. They run in the parent's cwd — which is exactly why
`hasOtherChatIn` ignores them and the exit is offered at all — so one left
behind would now be reopened months later against a checkout git deleted, still
carrying the `worktree` metadata and a session id that resumes into it.

No AI title either (a second model call for a tab), though `send`'s derived
placeholder still lands and is what tells two open side chats apart. No OS
notification, on both sides: its only action is `openChat`, and a side chat as
the active chat is a state nothing else in the design allows. The completion
*cue* still plays — it is on screen, and "your answer is ready" is what it says.
Drafts persist like any other chat's: they were held in memory only while the id
died at quit, which would have made the stored draft unreopenable.

`demo/e2e/side-chat.js` pins the part that has no other symptom: it pumps a
synthetic turn through the real reducer into each transcript and asserts the
other one's `messages` array comes back at the **same reference** — not merely
the same length, since a fresh array with identical contents still re-renders the
whole of the other conversation on every delta.

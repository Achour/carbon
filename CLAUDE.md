# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop GUI for coding agents. Claude sessions run through `@anthropic-ai/claude-agent-sdk`; Codex sessions run through `@openai/codex-sdk`; Grok sessions speak ACP to the `grok` CLI, which ships no SDK. All three live in the Electron main process, drive **the CLIs the user installed** (see Provider CLIs below), reuse their existing provider login, and operate in whatever project folder the user picks.

## Commands

```sh
npm run dev        # run the app in dev mode (electron-vite, hot reload)
npm run build      # production build to out/
npm run typecheck  # tsc over both projects: tsconfig.node.json (main+preload) and tsconfig.web.json (renderer)
npm test           # node --test over test/*.test.ts (Node strips the TS types natively)
```

`npm run typecheck` is the primary verification gate. There is no linter. Tests are
minimal and cover only pure, tricky logic worth pinning (e.g. `test/imageScan.test.ts`
for Codex generated-image discovery) — most code is verified by typecheck + running the app.
When you extract such logic, keep it dependency-free (import only `node:*`) so `node --test`
can run the `.ts` directly without a bundler.

Dev utilities (env vars for `npm run dev`, used for UI iteration without a human clicking):
- `AIGUI_CAPTURE=/tmp/shot.png` — saves a window screenshot after load. `AIGUI_CAPTURE_DELAY=2000,8000` takes a comma list of delays and saves `shot-1.png`, `shot-2.png`, …
- `AIGUI_E2E='<js>'` — runs a script in the renderer after load and logs the result to the terminal.
- `CARBON_CLAUDE_PATH` / `CARBON_CODEX_PATH` / `CARBON_GROK_PATH` — pin a provider's
  CLI to a specific binary, above the Settings → Providers value. Useful for testing
  a prerelease CLI, or the "not installed" path (point one at a path that isn't there).
- `CARBON_UPDATE_REPO=owner/repo` — points the update check at another repo, so a real
  "newer release" can be faked (any repo whose latest tag outranks `package.json`).
- `CARBON_FAKE_HOMEBREW=1` — forces `installedViaHomebrew`, the only way to reach the
  cask variant of the update UI outside an actual `brew install`. Dev-only; a packaged
  build ignores it.
- Renderer console output is mirrored to the terminal in dev.

## Distribution and updates

Auto-update is impossible while the app is unsigned, and not for the reason people
assume: `build/adhoc-sign.cjs` gives every build a designated requirement of
`cdhash H"…"` — a hash of *that one build* — so Squirrel.Mac's check that an update
matches the installed app can never pass. It's the signature, not the feed. Fixing it
costs an Apple Developer ID ($99/yr); the release layout here is already what
`electron-updater` wants, so that day changes the client and nothing else.

The Homebrew cask is therefore the one route that updates in place, and
`installedViaHomebrew` (`main/updates.ts`) is what lets the update banner say so —
`brew upgrade --cask carbon` instead of a download. It keys on
`<brew prefix>/Caskroom/carbon/<running version>`: matching the *version*, not just the
token, keeps the answer honest when someone brew-installs and then builds a newer copy
over the top. Every failure mode is a false negative, which is why each check is a hard
requirement rather than one signal among several — the cost is a brew user seeing the
generic banner, where the reverse would tell a non-brew user to run a command that
errors, or a brew user to install a `.dmg` that desynchronizes Homebrew's records.

The cask lives in a second repo, `Achour/homebrew-carbon` (Homebrew requires the
`homebrew-` prefix). `.github/workflows/release.yml` rewrites it on every tag via `sed`
over three anchored lines — `version` and both `sha256`s — followed by `grep`
assertions, because `sed` exits 0 when it matches nothing and would otherwise push a
cask still pointing at the previous release. The step needs a `TAP_DEPLOY_KEY` secret —
the private half of a write-enabled deploy key on the tap, since `github.token` can't
reach another repo — and skips itself without one, so a missing secret never fails a
release. A deploy key rather than a PAT: it is scoped to that single repo, carries no
other permission, and is revoked from the tap's settings instead of an account-wide list.

## Architecture

Three Electron layers with one shared contract:

- `src/shared/types.ts` — **the contract between all three layers.** The `Api` interface (preload bridge), the `ChatEvent` union (main → renderer streaming), message/part types, `MODEL_OPTIONS`, `PERMISSION_MODES`. Most features start here.
- `src/main/` — Electron main process. `index.ts` registers all `ipcMain.handle` channels and emits `ChatEvent`s to the renderer over the single `chat:event` channel. `claude.ts` owns agent sessions. `store.ts` persists chats/settings. `git.ts` / `files.ts` are thin helpers behind the `git:*` / `fs:*` IPC channels.
- `src/preload/` — typed `window.api` bridge (contextIsolation on); a mechanical 1:1 mapping of `Api` methods to `ipcRenderer.invoke` calls.
- `src/renderer/src/` — React app. One zustand store (`store.ts`) holds all UI state; `applyEvent` is the reducer for incoming `ChatEvent`s. Components in `components/`, shadcn-style primitives built on Base UI in `components/ui/`, message renderers in `components/messages/`.

**Adding an IPC method touches four files:** the `Api` interface in `shared/types.ts`, a handler in `main/index.ts`, the bridge entry in `preload/index.ts`, and the caller in the renderer store.

Path aliases: `@` → `src/renderer/src`, `@shared` → `src/shared` (renderer and main both get `@shared`).

### Session flow (`src/main/claude.ts`)

`ChatManager` holds one provider-specific session per active chat. Claude uses one long-lived Agent SDK `query()` input stream. Codex uses SDK `Thread.runStreamed()` turns and resumes the same thread id across turns and app restarts. Grok spawns `grok agent stdio` and speaks ACP to it. All three normalize provider events into the shared `ChatEvent` contract.

- Conversations resume across app restarts via `chat.sessionId` (`resume` option); the session id arrives on the SDK `init` message.
- SDK stream events are normalized into `AssistantPart[]` (`text` / `thinking` / `tool`); when the final `assistant` message arrives, `reconcileAssistant` replaces the streamed parts wholesale. Tool results come back on `user` messages and are matched by `toolUseId` via the `toolLoc` map.
- Streaming text deltas are coalesced ~40ms before IPC emission (per-token renders make the UI feel hung).
- Permissions: the SDK's `canUseTool` callback returns a Promise held in a `pending` map until the renderer answers via `chat:respond-permission`. "Always allow" uses the SDK's permission `suggestions`.
- Changing **effort** has no live SDK setter — `setOptions` disposes the session and the next send resumes it in a fresh process. Model and permission mode change live.
- Sub-agent traffic is skipped in the UI: messages with `parent_tool_use_id` are ignored.
- **Claude in Chrome needs `CLAUDE_CODE_ENABLE_CFC`, and it is the CLI that decides.** `shouldEnableClaudeInChrome` bails on `!isInteractive()` *before* it reads `claudeInChromeDefaultEnabled`, so the browser tools a user paired in the terminal reach no session the SDK spawns — the setting they flipped is never consulted. That env var is the one check sitting above the bail (the `--chrome` flag, which the SDK cannot pass, is the other), so Carbon sets it unless the user already has: `=0` is then their opt-out, since the CLI reads it as a boolean. `env` **replaces** the subprocess environment rather than merging it, hence the `process.env` spread — and that spread is what carries the PATH `shellEnv` hydrated. The tools arrive as an MCP server named `claude-in-chrome` and go through the ordinary permission prompt; only `mcp__preview__*` is auto-allowed. Wiring it also makes the CLI rewrite `~/.claude/chrome/chrome-native-host` to point at whichever binary wired it last — Carbon's bundled one here, the user's `~/.local/share/claude/versions/…` after their next interactive run. It is one global file the two rewrite back and forth, and each repair is a session start, so the failure mode is self-healing rather than sticky.

### Grok Build (`src/main/grokAcp.ts`, `grok.ts`)

The third provider is the one with **no SDK**, so the protocol itself is the
integration surface: `grokAcp.ts` spawns `grok agent stdio` and speaks
[ACP](https://agentclientprotocol.com) JSON-RPC over its pipes, and `grok.ts`
turns that into `ChatEvent`s. The split is exactly the one `codex.ts` keeps
against `codexAppServer.ts`, and it is what lets the manager, the IPC layer and
the whole renderer stay unaware there is a third backend — `AgentSession`
remains the only seam.

**`GROK_OAUTH2_REFERRER=carbon` is why this needs no API key.** It identifies the
client to xAI's OAuth flow, so a SuperGrok/X subscription authorizes the session;
without it the CLI cannot tell who is asking. Auth is then resolved, not
configured: `XAI_API_KEY` if set, otherwise the CLI's own cached login.

Shapes were read off grok 1.0.3 rather than the published schema, which collapses
several `sessionUpdate` variants into one and omits every `x.ai/*` extension.
Four findings drove the design, each measured against the running CLI:

- **Grok has two independent permission axes, not one.** A *baseline* fixed at
  `session/new` (`_meta.yoloMode` / `_meta.autoMode`) and a plan flag that moves
  live via `session/set_mode` — which recognizes only `plan` and `default`, and
  accepts every other id with an empty result and no `current_mode_update`. So a
  permission-mode change respawns the agent, the way an effort change does, while
  plan mode does not. `_meta.autoMode` is sent **explicitly false** rather than
  omitted: with no flag the CLI falls back to `permission_mode` in the user's own
  `~/.grok/config.toml`, which is frequently `auto`, and a chat Carbon labels
  "Ask" would then run tools without prompting.
- **`session/set_model` works live**, so the model changes without a respawn.
  Reasoning effort does not — no method exists — so it is a spawn flag
  (`--reasoning-effort`) and moving it respawns.
- **Grok never gates `exit_plan_mode`.** The tool simply succeeds and the turn
  ends, in every permission mode including plain ask. The plan review is therefore
  *synthesized* from the tool call rather than bridged from a pending request, the
  plan text is read from `plan.md` in the session directory (the call's input is
  empty), and approving it starts a **new turn** because there is no suspended one
  to release — Codex's shape, not Claude's. The plan flag is re-asserted at the
  head of every turn: on approval the chat's mode returns to `default` while the
  *session* is still refusing every edit outside `plan.md`, which silently failed
  every write the implementation turn attempted.
- **Only the first payload of a tool call identifies it.** The closing
  `tool_call_update` carries `title: undefined` and `_meta: null`, so a naming
  function that always answers renames a finished "Read" card to a generic
  fallback at the moment it completes (`toolNameIfNamed` vs `toolName`), and
  `isExitPlanTool` cannot recognize it — hence `planToolIds`, without which each
  plan leaves a stray unnamed error card.

`fetchGrokModels` probes the catalog for **zero tokens**: the model list rides the
ACP handshake, so the agent is spawned, `initialize` is answered, and the process
is killed before a session exists. It returns `[]` when the CLI is absent, and
that is deliberately how Grok stays out of the picker for anyone who has not
installed it. Grok is now the *general* case rather than the exception — no CLI
ships with the app — so the rule lives in `availableProviders`, and what stays
Grok-specific is only that it has no static fallback at all: Claude's and Codex's
`MODEL_OPTIONS` rows still stand in for a catalog that hasn't arrived yet *when
their CLI is present*, because then the fetch is pending rather than impossible.
Grok's `MODEL_OPTIONS` rows exist solely so `knownProviderForModel` can place a
stored `grok-4.6`.

### Persistence (`src/main/store.ts`)

SQLite (`node:sqlite`, no native dep) in `userData/chats.db`: a `chats` table of metadata, a `messages` table keyed `(chat_id, seq)` where `seq` is the message's index in `chat.messages`, and a `kv` table (migration marker, deletion tombstones). `settings.json` stays a plain file. `userData` is pinned to `ai-gui` so dev and packaged builds share history (`~/Library/Application Support/ai-gui/`); `AIGUI_USERDATA` overrides it for an isolated instance.

**Chats load lazily, and only a window of each one.** Startup opens the database and reads nothing else — `listChats` is one indexed query over `chats`. Opening a chat hydrates only its most recent messages (`HYDRATE_TAIL` / `HYDRATE_BYTES`, floored by `HYDRATE_MIN`); older slots hold an `unloadedMessage` placeholder so **`seq` keeps meaning "index in `chat.messages`"** for every write pass. `loadOlder` promotes one more window on demand. This is what makes the 36.6 MB chat open in ~5 ms instead of ~37 ms plus a 36.9 MB structured clone.

**No write pass may ever serialize a placeholder** — it is not the message, and writing it would flatten real history. `candidateRows` and `reconcile` both skip `Resident.unloaded` and `Resident.corrupt`, and the sets survive eviction (via `holes`) because a re-admitted chat rebuilds its baseline from scratch and forces a full reconcile. Placeholders are also *in sync with disk by construction* — nothing ever parsed them, so nothing can have mutated them — which is why they count toward neither `unchecked` (durability) nor the `unverified` set. Conflating that with `inexact` (byte accounting) would pin every windowed chat in memory forever, since `evictOverBudget` refuses to evict an unverified chat.

`getChat` returns the full-length array with placeholders — what sessions hold and mutate. `viewChat` returns the loaded suffix plus `hiddenBefore` and is what the renderer gets; a placeholder never crosses IPC. Anything reading a chat from the *front* (only title generation) must check `Store.hiddenBefore` first.

Resident chats are held under a byte budget (`RESIDENT_BUDGET`) with an LRU — measured on the window, not the chat's size on disk. Evicted ones are tracked by `WeakRef` so **there is at most one `ChatData` per id alive in the process** and `getChat` always returns it. That invariant is load-bearing: provider sessions hold `this.chat` for their whole lifetime and mutate it in place.

The last explicitly chosen model/effort/permission-mode become the defaults for new chats (`rememberOptions`).

**Writes are incremental.** `saveChatSoon` (1.5s trailing debounce, 5s cap) re-serializes only the rows that can have changed — appended-since-last-write, the tail, anything holding a live tool, and anything flagged via `markMessageDirty`. `saveChat` (turn boundaries) and a 30s floor run a reconcile against what the database actually holds; that pass never DELETEs rows it lacks in memory. The reconcile is **bounded** — it verifies the tail plus a rotating window (`RECONCILE_VERIFY_BYTES`) rather than re-serializing the whole chat, so a big chat cannot stall the main thread at every turn; the cursor covers everything over successive passes, and quit runs one thorough pass over `dirty` ∪ `unverified` — a chat leaves `dirty` after a bounded pass that may have skipped the very mutation the thorough pass exists to catch, so tracking it separately is what stops that mutation reverting on the next launch. Eviction writes a **thorough** pass for the same reason: it is the last moment the object is guaranteed reachable, and a chat that is only WeakRef-held can be collected before quit ever sees it. `flushAll` on quit writes only chats that were actually mutated.

Two safeguards for the shared-userData design: a per-chat advisory `locks` row (heartbeat, 30s staleness) so two instances never write one chat at once, and a `chats.rev` counter asserted inside the write transaction so an instance holding a view from before another's changes cannot overwrite them. A rolling `chats.db.bak` (`node:sqlite` `backup()`, refreshed when dirty and on quit) is the real backup; recovery goes damaged DB → backup → archive.

The legacy `chats/<id>.json` files are imported once and then **never written, moved, or deleted** — so `rm chats.db` rolls back to the pre-migration corpus. They are an *archive, not a live backup*: they stop tracking reality the moment the migration lands. See `store.ts` for the corruption path (salvage the readable rows first, fall back to the archive only if nothing survives).

### Renderer state (`src/renderer/src/store.ts`)

Only the active chat's messages are held in memory, and only the window main sent — `messages` is the loaded suffix and `hiddenBefore` counts what is still in the database. Switching chats refetches via `getChat`; the "Load earlier messages" control at the top of `ChatView` prepends the next window and restores the reading position by anchoring on distance from the *bottom* of the scroller, which is the part a prepend does not move. Events for non-active chats still update sidebar metadata and statuses. The right panel hosts file tabs, git diff tabs (tab ids prefixed `diff:`), and the plan panel; an `ExitPlanMode` permission request auto-opens the plan panel. When a chat's status returns to `idle`, open files, the file tree, and git status are refreshed so the agent's edits show up.

### Drafts (`lib/drafts.ts`, `DraftItem`)

Text typed and not sent. `App` renders `<ChatView key={chat.id}>`, so the
composer unmounted on **every** chat switch and took whatever was in the box
with it — silently, with no undo. That is the bug; the home screen was only its
most visible case.

Two shapes, two lifetimes. A **chat draft** is text alone: the chat already
remembers its model, effort and permission mode. A **project draft** is a chat
that was never created, so it carries everything `NewChat` had picked as well —
reopening one that quietly relaunched on a different model than the chip said
when you walked away would be worse than losing it. `NewChat` is keyed by
`selectedCwd` for the same reason `ChatView` is keyed by chat id.

A project draft is deliberately **not** a `ChatMeta`. `chats:create` freezes the
provider/model pair and, for a `new` worktree target, runs `git worktree add` —
a real checkout and branch on disk. A prompt you never sent must leave neither
behind, so a draft stays pre-creation state and becomes a chat at send, where
that work already happens. It also keeps `chats` out of it: that array *is* the
sidebar order and moves only on create/delete/turn-start (`hoistChat`), and a row
that never starts a turn has no defined position in it.

- **The text lives in the composer, not the store.** Typing has to be instant, and
  routing keystrokes through zustand re-renders every subscriber. The store sees a
  400ms-debounced copy plus a flush on unmount — the flush is the write that
  matters, since the unmount *is* the chat switch. Both readers take their draft
  imperatively (`useApp.getState()` in a `useMemo`) rather than subscribing: a
  subscription in `ChatView` would re-render the whole transcript twice a second
  while you type. Keying the component is what makes an imperative read correct.
- **Discarding needs `draftDiscards`.** The sidebar can discard the draft of the
  project you are looking at, and deleting the stored copy alone is undone by the
  very next debounce, because the text is still in the box. The counter is how a
  discard reaches the composer holding it.
- **Only reference-shaped attachments persist.** Images and picked elements carry
  raw base64; `localStorage` throws at its ~5 MB quota and that throw would take
  the *text* of every other draft with it. A path survives a restart, a payload
  doesn't — text is what you can't cheaply retype. Both stay live in memory for
  the session.
- **`updatedAt` tracks the text**, which is what the Drafts section orders on;
  `patchProjectDraft` (a picker moved) deliberately leaves it alone.

The **Drafts** section sits above even Pinned — it is the one section whose
contents exist nowhere else, and there is at most one row per project, so it
costs the pins a row and never a screenful. It is scoped by the project filter
exactly as the pins are, for the same reason: a draft from another project
showing through a filtered sidebar makes the whole list a half-truth.

### Code selections (`lib/codeSelection.ts`, `CodeEditor`)

Select lines in the editor and an "Add to chat" pill (⌘L) puts them in the
composer as a `selection` attachment. It rides the same `attachmentInbox` seam
the browser's element picker uses, so nothing new crosses IPC.

- **The snippet and the reference both ship.** `describeSelection`
  (`main/attachmentText.ts`, shared by all three providers) writes a fenced block
  under a `path (lines a-b)` heading. The reference alone goes stale the moment
  the agent edits the file; the snippet alone gives it no address to edit. The
  fence is sized to outrun the longest backtick run *inside* the selection —
  source files are full of fenced examples, and a three-backtick fence around one
  ends at its fence, spilling the rest into the prompt as prose.
- **Offsets, not line elements.** `lineSelection` widens a character range to the
  whole lines it touches — a range reported as "12-14" has to *be* 12-14 — and
  backs off the newline a downward drag sweeps up on its way to column 0 of the
  next line, which would otherwise claim one line too many. That arithmetic is
  pinned by `test/codeSelection.test.ts`. It was written against a highlight.js
  blob, where a character offset was the only anchor that survived the `<span>`
  structure, and it **outlived that DOM**: CodeMirror reports its selection in
  exactly the same units, so the module carried over untouched when the editor
  landed. Only `offsetsInNode`, the half that measured the blob, is gone.
- **A selection deliberately does not set `Attachment.path`.** The composer
  dedupes its inbox on that field, so sharing it would collapse two selections
  from one file into a single chip. The file lives on `selection.path` instead,
  the way an element's lives on `element`.
- **`SELECTION_MAX_CHARS` exists because selections persist.** They carry no
  `data`, so `persistableAttachments` keeps them in a draft — an uncapped snippet
  would put a whole file in `localStorage`, which is the quota throw the drafts
  rule already guards against. Past the cap the line range still names every
  line, so the agent reads the rest itself.
- **The pill's label is computed from line numbers, its text is not.** Placing
  the pill runs on every selection transaction — every mousemove of a drag, every
  shift+arrow — so it reads `doc.lineAt`, which is O(log n) on CodeMirror's rope.
  `lineSelection` needs the document *as a string*, and calling it there would
  allocate a full copy of the file per frame; it runs once, in
  `addSelectionToChat`, when the click actually happens. The newline back-off is
  `trimTrailingNewlines`, shared by both: it takes a character accessor rather
  than a string so the module stays dependency-free *and* the editor can read off
  the rope. Written twice it had already drifted — the copy backed off one
  newline where the tested original backs off every one, so a pill could name a
  line the attachment did not. The pre-editor version had the same rule for
  the same reason, enforced differently: it measured on `mouseup` rather than
  `selectionchange`, because resolving a DOM offset walked the text before it.

The pill is positioned in the editor's *content* coordinates and recomputed on
scroll, so it travels with the code; a fixed-position element detaches from the
lines it names on the first wheel tick. The **diff view is not covered** — its
rows carry their own line numbers, so mapping a selection there is a different
problem, not this one.

### The file editor (`CodeEditor.tsx`, `lib/editorBuffers.ts`)

Files are **editable**, not just readable. `FileViewer`'s `text` branch is a
CodeMirror 6 view; every other branch (Markdown preview, image, binary,
too-large) is untouched, and `DiffView` is deliberately not covered — its rows
carry their own line numbers and are a different problem.

CodeMirror over Monaco because Monaco brings VS Code's chrome and ~5 MB with it,
and because CM6 themes off CSS variables — which is what lets the editor repaint
on a theme change with **no** JS involvement. `editorTheme.ts` is installed once
and never rebuilt; the alternative is reconfiguring every open view each time the
appearance flips.

- **Dirtiness is cached, and compared as a rope.** `dispatchTransactions` fires
  for *every* transaction, and selection-only ones vastly outnumber edits —
  `MouseSelection` dispatches one per mousemove of a drag. So the early return
  sits above any comparison, and the answer is a field on the buffer. The
  comparison itself is `Text.eq` against a `baseDoc`, not a string compare
  against a `base`: `eq` skips shared subtrees by reference, so an untouched
  buffer settles on an identity check and an undone one on a few pointer
  comparisons, where flattening rebuilt the whole file each time.
- **The buffer lives outside React and outside zustand.** Outside React because
  `EditorState` has to survive a tab switch: the inactive editor is unmounted,
  and rebuilding its state on return loses undo history, cursor and scroll.
  Outside zustand because the document changes on every keystroke, and routing
  that through the store re-renders every subscriber twice a second — the same
  reasoning that keeps draft text in the composer. The store learns only about
  **transitions** (clean ⇄ dirty), which happen once per edit session.
- **Dirtiness is `doc !== base`, not a sticky flag**, so typing a character and
  deleting it leaves the tab clean, and so does undoing back to the saved text.
  The `length` check in front settles insertions and deletions without reading a
  character.
- **Everything keyed by a path is released by one call.** `dropBuffer` drops the
  state *and* the scroll offset; the offset used to live in the component, which
  made disposal a two-call ritual the sites disagreed about, and put a
  `store → component` import in the one direction this app never has.
- **A truncated read is never saveable.** `readFileContent` caps at
  `MAX_TEXT_BYTES`, and writing that buffer back would put the head of a file
  over the whole of it. Such a buffer opens read-only with a bar saying so. The
  cap itself moved 512 KB → 2 MB because its reason was highlight.js
  highlighting the whole blob eagerly; CodeMirror parses and renders by viewport,
  so the cost is now the read.
- **The post-turn refresh reconciles, it does not re-read.** `refreshFiles` runs
  at the end of every turn and used to pull every open tab's body back over IPC
  and overwrite it — correct for a viewer, *data loss* for an editor. It now
  stats first (`fs:stat-many`, mtime only), skips what hasn't moved, and for a
  file that has, dispatches the new text into the mounted view rather than
  replacing it, which would lose scroll and flash the pane.
- **`fs:write` takes the mtime the buffer was read at** and refuses on a
  mismatch. This collision is Carbon's own: the agent writes the files the user
  is editing, and neither side can be assumed to win — the buffer may be a
  half-finished thought, or a stale copy of what the agent just rewrote. So
  `ConflictBar` states the fact and offers both. The comparison is `!==` rather
  than `>`: a checkout or a revert moves mtime backwards and is still someone
  else's write.
- **A dirty preview tab stops being disposable.** Single-clicking another file
  reuses the preview slot, Cursor-style; doing that to a tab the user has typed
  into would destroy the only copy of those edits, so it gets pinned instead and
  the new file opens beside it. Closing a dirty tab asks (Save / Discard /
  Cancel), and a Save that hits a conflict leaves the tab open — closing it then
  would discard the edits under cover of the word "Save".
- **⌘F routes to CodeMirror's search panel on editor tabs.** `FindBar` collects
  ranges by walking the DOM under `#editor-find-scope`, and CodeMirror only
  materializes the *viewport* — a DOM search would silently report matches from
  the visible screenful alone, which looks exactly like a complete answer.
  FindBar still serves the diff view and the Markdown preview.
- **Unsaved edits survive both exits.** Closing a tab asks; closing the *window*
  and **quitting** ask the same question through one guard, because on macOS ⌘Q
  is the ordinary way to leave an app and a guard that only covered ⌘W would miss
  the common case. `dirtyFileCount` is pushed to main on every transition rather
  than requested at close time: `close` is synchronous about whether it is
  vetoed, and an IPC round trip inside it would have to guess. Two buttons, not
  three — a "Save All" would need the renderer to write every buffer and report
  back before the exit may proceed, and Cancel already puts the user where ⌘S
  works.
- **New files are named in the tree, not in a dialog.** The name is only half
  the decision — the other half is *where* — and a modal takes the tree off
  screen at the moment that matters. The inline row shows its own answer: the
  indentation is the parent folder. It sits at the top of that folder's children
  rather than in sorted position, because a row with no name yet has no place in
  the sort and one that jumped as you typed would be worse. `createPath`
  (`main/files.ts`) accepts slashes, so `lib/util.ts` makes the folders on the
  way — which is why the name is *checked* rather than trusted: a leading `/`
  escapes to the filesystem root and `..` climbs out of the project, and the
  resolved path is compared against the parent to prove neither happened
  (`test/createPath.test.ts`). Files are created with `wx` so a name that
  appeared between the existence check and the write is never silently emptied.
- **Renaming re-keys the buffer instead of reopening the file.** The document,
  its undo history, its cursor and its *unsaved* state are properties of the
  file, not of its name — so dropping the buffer and re-reading would silently
  discard edits at the moment the user was only relabelling something. The view
  is deliberately not moved with it: `CodeEditor`'s mount effect is keyed on
  `path`, so it rebuilds against the re-keyed buffer, which is also what rebinds
  the language server to the new uri. A renamed folder rewrites every descendant
  path — tabs, contents, dirty flags, expanded state — by prefix, carrying the
  separator so renaming `src` cannot rewrite a sibling `src-old`. The inline row
  is the same component as the create row with a starting value, and it selects
  the base name rather than the whole thing: renaming is almost always renaming
  the *name*, and arrowing past `.tsx` every time is the kind of small tax that
  makes a feature feel unfinished. `renamePath` shares `createPath`'s validation
  (`resolveChildPath`) because both take a free-text name from the tree and must
  refuse the same escapes — and it excludes the target-exists check for a
  case-only change, since on a case-insensitive filesystem `Foo.ts` → `foo.ts`
  collides with itself and is the first rename every macOS user tries.
- **Deleting goes to the Trash, and always asks.** `shell.trashItem`, not an
  unlink: a delete from the tree should be recoverable from the Finder the way
  it is in every other editor, and that is also what lets the confirm dialog say
  something true — the question is "are you sure", not "is this gone forever".
  A folder takes its contents, so every tab *under* it closes and its buffer is
  released; the prefix match carries a separator so deleting `src` cannot close
  a tab in a sibling called `src-old`. The dialog is rendered by `App`, beside
  `PublishDialog` and `FileSearchDialog`, because its state is store state and
  the tree it was opened from unmounts whenever the dock switches to the changes
  view — which would take the question off screen with the answer still pending.
  Failures are reported *on* the dialog rather than through `gitError`: the
  question is still up, and a locked file is something the user may be able to
  fix and retry.
- **Grammars are lazy.** `@codemirror/language-data` descriptors are `import()`s,
  so a user who only opens TypeScript never pays for Haskell; the mode lands a
  frame or two after first paint and is swapped into the live view through a
  `Compartment` rather than rebuilding it.

`--syn-*` (`index.css`) is the syntax palette, and it is now **one** definition
consumed by both highlighters — highlight.js for chat code blocks and the diff
view, CodeMirror for the editor. They were separate, which meant a token could be
one color in a message and another in the file it came from.

### Language servers (`src/main/lsp.ts`, `lib/lspClient.ts`)

⌘-click a symbol and the definition opens, cross-file. This is LSP, and the split
is the reverse of every other integration in the app: **main does no protocol
work at all.** `@codemirror/lsp-client` runs the whole of JSON-RPC in the
renderer, so `main/lsp.ts` is a spawn plus `Content-Length` framing, and the
`Transport` seam the package asks for is satisfied by IPC that already existed.
That keeps the protocol next to the editor that needs it, and keeps main off the
critical path of every keystroke's `didChange`.

**Carbon ships no servers**, for the reason `providerCli.ts` ships no CLIs: a
vendored server is stale by the next release, and the user's own is the one their
project is written against. Resolution is project `node_modules/.bin` → PATH →
install prefixes — the *reverse* of `providerCli.ts`'s order, and for the same
underlying reason. There the user's shim wins because the CLI is a tool they run;
here the server must agree with the TypeScript version in the repo's lockfile.

- **It is `typescript-language-server`, not `tsserver`.** Raw tsserver speaks
  TypeScript's own protocol and fails `initialize` outright. `vtsls` is tried
  first, so a project that pins it gets it.
- **An installed server can still refuse to start**, and the common case is
  `typescript-language-server` in a project with no TypeScript for it to load.
  `initialize` is therefore awaited before the extension is handed to the editor,
  which turns that into "no language features" — the same answer as a missing
  binary — instead of an unhandled rejection and an editor posting requests into
  a dead process. The failure is cached: a server that cannot initialize will not
  initialize for the next file either, and retrying per tab spawns a doomed
  process every time one is opened.
- **A missing server is not an error.** It logs and the file simply has no jumps,
  exactly as a machine without a provider CLI has no model rows.
- **One server per (project root, language)**, shut down five minutes after the
  client releases it — a cold tsserver on a large repo is seconds of nothing, and
  closing a project then reopening it is common. There is deliberately **no
  refcount in main**: the renderer caches one client per key, so it asks once and
  releases once, and a count here would have described a lifecycle main never
  sees. One owner — the renderer decides when a server is done, `LspManager`
  decides how long to wait before believing it, and `releaseAllServers` rides
  `beforeunload`.
- **`CarbonWorkspace` exists for `displayFile`.** The package's default workspace
  can only return an editor that is *already* open, which makes a jump into an
  unopened file silently do nothing — and that is the majority of jumps. The
  override goes through the store's own `openFile`, so the target lands in a
  normal Carbon tab, then waits for CodeMirror to mount.
- **Diagnostics are a client concern, and there are two of them.** Two traps
  stacked here. First, `languageServerSupport()` and `languageServerExtensions()`
  look interchangeable and are not — only the latter carries
  `serverDiagnostics()`, because `publishDiagnostics` is a server-*initiated*
  notification whose handler belongs to the `LSPClient` rather than to any one
  editor; wiring the editor bundle gives completion, hover, signature help and
  jumps with no squiggle anywhere. Second, `serverDiagnostics()` cannot be used
  *at all* here: it dispatches `setDiagnostics`, which **replaces** the entire
  diagnostic set, so it and any `linter()` erase each other and the file shows
  its syntax errors or its type errors depending on which fired last. Lint
  *sources*, by contrast, are collected and batched — so `lspDiagnostics.ts`
  re-implements the handler to park the raw payload and re-emit it from a
  source, and `editorDiagnostics.ts` joins it with the grammar's. The client
  therefore takes the bundle spelled out minus `serverDiagnostics()`, and each
  editor takes `client.plugin(uri, languageId)`.
- **Syntax errors need no server.** Lezer already parses every open file to
  highlight it, and it recovers from bad input by marking error nodes rather
  than stopping — so "where are the syntax errors" is a walk of a tree that
  exists anyway. That is what makes an unclosed brace visible on a machine with
  nothing installed, which is the normal case: Carbon ships no servers. Type
  errors, imports and symbols still need one. Two shapes have to be handled: a
  *missing* token is a zero-length node, and a zero-width range draws no squiggle
  at all, so `widenPoint` (dependency-free, `test/diagnosticRange.test.ts`) moves
  it onto a real character **on its own line** — taking the newline would mark
  the line below. An error on a blank line, which is where an unclosed bracket at
  end-of-file lands every time a file ends in a newline, falls back to the last
  line with content; dropping it instead meant the single most common syntax
  mistake rendered nothing at all.
- **The raw LSP payload is stored, not the converted diagnostics.** Positions are
  line/character pairs against the document the server last saw, so converting
  them at lint time — through the plugin's `fromPosition` and its record of
  unsynced local edits — is *more* accurate than converting on arrival and
  letting the result drift behind subsequent typing.
- **Errors below the fold need a number.** A squiggle only says something about
  the lines on screen, so a count chip sits bottom-right and opens
  CodeMirror's lint panel. It recomputes only when a `setDiagnosticsEffect`
  actually lands — once per server push, not per keystroke. Squiggles are a real
  `text-decoration: underline wavy` rather than CodeMirror's repeating
  background image, so they stay crisp at any zoom and take a theme color:
  `--destructive` / `--warning`, which mean *state*, and deliberately not a
  `--syn-*` hue, which means *identity*.
- **A finished turn invalidates the server's view of the project.** Open tabs
  re-sync themselves, but a file the agent rewrote and the user never opened is
  still cached, and a server answering from it sends you to a line that has
  moved. `workspace/didChangeWatchedFiles` on the idle transition is what stops
  that, keyed off the same `lastTurnEditedPaths` the git scope uses.

`LspManager` takes its emitter in the constructor, like `TerminalManager` and
`PreviewManager` — the other two modules in main that own live child processes.
Its one concession is an explicit field instead of a parameter property, because
`test/lspFrames.test.ts` imports this file directly and `node --test`'s
type-stripping rejects the shorthand. Binary discovery is `providerCli.ts`'s
`isExecutable`/`onPath`, exported rather than copied; only the *ordering* differs
(project-local first here, PATH first there), which is the real distinction.

`splitFrames` is pure and pinned by `test/lspFrames.test.ts`: `Content-Length`
counts **bytes**, a message can arrive split across several `data` events and
several can arrive in one, and slicing the decoded string instead of the Buffer
is off by one per non-ASCII character — which is every file with an emoji or a
curly quote in it.

### The task checklist (`lib/taskList.ts`, `TodoCard`)

One card, two completely different provider shapes. Codex sends `TodoWrite`,
where a single call carries the whole list and the card is just a render of
`input.todos`. Claude Code replaced that tool with an incremental API —
`TaskCreate` one task at a time, `TaskUpdate` to flip a status — so **no single
call holds the list** and it has to be folded out of the transcript. `TodoCard`
therefore takes the list, not the tool part.

Three things about the fold, each measured against the real corpus rather than
assumed:

- **The id exists only in the output.** `TaskCreate`'s *input* has no id; it
  comes back in the result (`Task #3 created successfully: …`), and that string
  is the only thing a later `TaskUpdate` can be matched against.
- **It is never message-local.** Each API response carries at most one of these
  calls, so a `TaskUpdate` is never in the same assistant message as its
  `TaskCreate` — across 366 real updates, not once. Folding per message would
  render an empty list every time; the fold spans the whole loaded window.
- **A run collapses to one card.** A five-task plan arrives as five back-to-back
  `TaskCreate`s, which would stutter "0/1, 0/2, 0/3…" — 566 real calls for 255
  runs, i.e. over half the cards saying nothing. Only the last call of a run
  draws, showing the list once it settled; any other rendered content between
  two calls ends the run. Superseded calls are dropped in `AssistantBlock`
  rather than rendered as null, because Claude Code puts one call in a message
  and an empty block is still a flex item in the message list — the gap
  `isBlankMsg` exists to prevent.

A call with no folded list falls back to an ordinary tool card: it either failed
(the list didn't change, so claiming otherwise would be a lie) or it only moved
a task created before the loaded window, which nothing on screen can name.
`Task{Stop,Output,Get}` are a *different* feature — background agents, keyed by
a snake_case `task_id` hash rather than the checklist's numeric `taskId` — and
are deliberately not folded in.

The fold and the live-card id live in `taskListStore`, outside the message
history render path, for the reason that store already existed: both churn
several times a second mid-turn, and threading them through props would
re-render every transcript row on each flip. That only works because
`reconcileSnapshots` carries unchanged lists forward *by identity* — a fresh
array per fold would defeat the whole arrangement.

### File icons (`lib/fileIcon.tsx`)

One filename → icon map behind every place the app names a file: the tree,
editor tabs, ⌘P, @-mentions, composer attachments. **Shape says what kind of
thing a file is, color says which language** — an image, an archive, a lockfile,
a key and a stylesheet each get their own silhouette, while the twenty-odd
source languages share `FileCode` and are told apart by hue. That split is the
whole design: at 14px a column of distinct silhouettes reads as static, where
one silhouette in seven colors reads as a sorted list. The exceptions are marks
more recognisable than any color (React's orbit, Rust's gear, Java's cup) and
`CLAUDE.md` / `AGENTS.md`, which get their provider's own `ProviderMark`.

Colors come from `--icon-*` (`index.css`), a seven-hue palette stepped per mode
— *not* real brand hues, which are picked for marketing pages and half of which
are illegible or shouty against one of the two chat surfaces. Distinct again
from `--brand-*` (a fact about a logo) and `--chart-*` (series identity): here
color is only a grouping, and no icon may out-shout the filename beside it.

The tree also carries git: a changed file's *name* takes its status color
(`lib/gitStatusColor.ts`, shared with the review panel's status column, since a
file that is amber in one list and green in the other is worse than no color at
all), and a **collapsed** folder holding changes gets an amber dot — the one
place a change would otherwise be invisible. Repo-relative paths are joined onto
the tree root exactly as `openDiff` does it.

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
indent was that row's hanging indent. `projectMenuItems` is the single
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

### Usage (`src/main/usageScan.ts`, `usageStats.ts`, `components/UsageStats.tsx`)

Two different questions wear the word "usage", and they share nothing. `usage.ts`
+ `UsagePanel` ask the providers **how much plan headroom is left right now** —
answered live, off a throwaway process, shown as a chip in the sidebar footer.
`usageStats.ts` + the Usage **page** ask **what was spent, on what, over the last
7/30/90 days** — a history question no live API answers, since no provider bills a
subscription per token. Only Claude and Codex answer the *live* question at all;
Grok exposes no plan-headroom endpoint, so it appears on the page and never in the
sidebar chip.

The only durable record is the CLIs' own session logs, so that is the source:
`~/.claude/projects/<slug>/<session>.jsonl`,
`~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, and
`~/.grok/sessions/<percent-encoded cwd>/<id>/updates.jsonl`. Reading them covers
Carbon's own turns *for free* — every adapter drives the real CLI, so an in-app
chat lands in the same files as a terminal one. That is also why the page does **not** also sum the
`TurnStats` on our own event messages: it would double every in-app turn.

- **Subagents are separate files.** A Task/subagent turn is written to
  `<session>/subagents/agent-*.jsonl` (and one level deeper under
  `subagents/workflows/<id>/`), sharing no message ids with the parent and leaving
  no `isSidechain` copy in it. Stopping the directory walk at the session file
  silently omitted ~16% of spend, which is why `collectJsonl` descends 6 levels.
- **Dedupe is per file, on `message.id` + `requestId`.** One API response is
  written once per content block, so a turn with text *and* a tool call appears
  twice carrying identical usage.
- **Codex reports a running total and a per-call delta** on `token_count` events,
  and no model — hence `CodexFileReader`, a per-file cursor that carries the model
  forward from `turn_context` / `thread_settings_applied` and sums only the delta.
  Its `input_tokens` is *inclusive* of `cached_input_tokens`; Claude's is not.
- **Grok reports the cost itself**, on one line kind: an `_x.ai/session/update`
  whose `sessionUpdate` is `turn_completed`, carrying per-model totals and
  `costUsdTicks` at 1e-10 USD per tick. Its totals are *per turn* (verified
  against a session whose three turns rise then fall), so they sum rather than
  needing Codex's delta treatment, and `inputTokens` is inclusive like Codex's.
  This is the one case where a cell stores money: the rule against it exists
  because a *computed* estimate would freeze one day's rate table into a file
  that is never re-read, and a provider-reported figure has no such defect — it
  is not an estimate of what a turn cost, it is what the turn cost. `priceCell`
  prefers it. The derived `grok` rate entry therefore never prices a turn; it
  exists only for the cache-savings counterfactual, which has no reported
  equivalent and read as a flat $0 without it.
- **Rates are fetched, not hard-coded** (`usageRates.ts`). A static table cannot
  price the Codex-only slugs: `gpt-5.6-sol` bills at $5/$30 per MTok, 4× the
  GPT-5 family it is named after, and guessing the family understated Codex spend
  by ~4×. They come from LiteLLM's public `model_prices_and_context_window.json`
  — the feed `ccusage` prices against — cached 24h in `userData/usage-rates.json`,
  fetched only when the page is opened. The built-in table in `usageScan.ts` is
  the fallback, not the source: it answers before the first fetch and forever if
  the fetch never lands, and an id the feed doesn't know falls through to it and
  then to being reported unpriced rather than silently free.
- **The 1-hour cache-write rate is applied** (2× input vs 1.25× for 5-minute).
  Claude Code writes 1-hour caches almost exclusively and they run to ~170M
  tokens a month, so collapsing the two TTLs understates Claude by ~8%. Fast mode
  is likewise a different SKU rather than a faster tier — `usage.speed` says which
  served the turn, and it is part of the cell key for exactly that reason.
- **Nothing is read twice, and cells hold tokens rather than money.** Each file
  reduces to a few `(model, speed, day)` cells cached under `(path, mtime, size)`
  in `userData/usage-cache.json`; session logs are append-only, so an unchanged
  stamp means unchanged content. Cost is applied at *read* time (`priceCell`) —
  a cell that stored dollars would freeze one day's rates into a file that never
  changes again and therefore never gets re-read, which is precisely the bug a
  refreshing rate feed would otherwise introduce. A cold scan is ~2 GB and ~5 s,
  a warm one ~20 ms, and switching range never re-reads. `CACHE_VERSION` now
  tracks only the *parsing* — rate changes reprice for free.

`--chart-claude` / `--chart-codex` / `--chart-grok` (`index.css`) are the one place
the app carries hue a theme does not set: on a page whose job is comparing
providers the colors *are* the labels, so they must not move when the theme does.
Validated for CVD separation and contrast in both modes — they are not
interchangeable with `--warning` / `--success`, which mean state rather than
identity.

The third series is a materially harder problem than the first two, and the
numbers say so. Warm/cool alone carries a *pair* through every CVD type with room
to spare (ΔE00 ≥ 44); a third hue has to clear both at once, and the obvious pick
— a green — collapses against orange under protan/deutan (ΔE00 12) and against
blue under tritan (ΔE00 5). Plum at low lightness is the best any single hue
family manages, because it separates on *lightness*, which CVD preserves, rather
than on hue alone: light clears 20 on every pair, dark's tightest is 18.1. That
shortfall is stated rather than designed away — the alternative was a near-gray at
chroma 0.04, which buys ΔE00 21.6 by giving up being a color at all. Re-run the
check before touching any of the three, since they are now solved as a set.

`--brand-grok` is a different decision: xAI's mark is monochrome like OpenAI's, so
it takes the *same* value as `--brand-codex` rather than a hue invented to
separate them. The shapes carry the difference — OpenAI's knot against xAI's two
slashes is a wider gap at 14px than any two hues would be — and a tinted xAI badge
would be a brand fact we made up, which is exactly the error the blue-Codex note
above rules out.

### Git worktrees (`src/main/worktree.ts`)

A chat can run in an isolated worktree. **The app creates the worktree itself** (`git worktree add`) rather than delegating to Claude Code's `.claude/worktrees/` or Codex's equivalent — a worktree is just a directory, so owning creation is what makes the feature provider-neutral. `chat.cwd` points at the worktree and `chat.worktree` carries the metadata (`repoRoot`, `branch`); **the provider adapters are untouched**, since both already take `chat.cwd`. Preserve that property: cwd is the only seam.

The entry point is a Cursor-style "Run on" chip **above** the composer (`WorktreePicker.tsx`) — This Mac / an existing worktree / New worktree — paired with a branch chip that tracks the selection. It sits above the composer deliberately: the composer's own controls row (model, effort, permission mode) is already tight.

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

`branchVsDefault` (git.ts) is the *single* implementation of "where does this branch stand vs main" — one `for-each-ref` + one `rev-list --left-right`. `gitStatus` puts its answer on `GitStatus.defaultBranch` / `behindDefault` / `aheadDefault` (started before the numstat reads so it overlaps them instead of adding a round trip); `worktreeStatus` derives `unmergedCommits` from the same call; the merge guards read it directly. Everything user-facing — the `↓n` staleness chip in `ContextStrip` (click runs "Update from main"), the ⋯ menu labels, the merge dialog's counts — reads the `GitStatus` copy, so the chip, the menu and the dialog can never disagree. Staleness has no other symptom until it surfaces as a conflicted merge, which is why the chip says it out loud while it's still cheap to fix. Note `behindDefault` is *not* `GitStatus.behind`, which is measured against the branch's own upstream. `listWorktrees` tags each ref `merged` from a single `branch --merged`, which is what lets the picker mark a finished worktree and offer to remove it instead of accumulating dead ones. It also **drops the refs git calls `prunable`**: a worktree deleted outside the app keeps being reported until something prunes it, and offering one starts a chat in a directory that isn't there. The stale metadata behind it is cleared only when *every* prunable entry is app-managed — `prune` takes no path filter, and while `~/.karbun/worktrees` sits under `$HOME` and is always mounted (so missing there means gone), someone else's worktree on an unplugged disk is merely *absent*, and pruning it would destroy the record they need to plug the disk back in. The filtering is what fixes the picker; the prune is only housekeeping, and `prunable` stays a main-local field (`ParsedWorktree`) rather than joining the shared `WorktreeRef`, since those refs are dropped before anything crosses IPC. The renderer-side half of the same blind spot is **`GitStatus.missing`**: git fails identically for a folder that isn't a repo and one that isn't *there*, so a vanished worktree read as "not a git repo" and sent you looking in the wrong place. The stat that separates them sits in `gitStatus`'s existing `catch` — the only path that can be missing, so the normal case pays nothing — rather than beside it in the renderer, which would have been a second field to keep in sync and a second round trip on all 21 `refreshGit` call sites. It rides `GitStatus` for the reason everything else user-facing does: one answer, so no two views can disagree. A fresh worktree with no setup script also says so in the chat (`setupMissingFor`); the silence used to read as "installed", and the agent would just start failing on missing dependencies.

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

## Provider integration

### Provider CLIs (`src/main/providerCli.ts`)

**Carbon spawns the CLIs the user installed. It ships none of its own.**

That was not always true, and it was never decided — it was a default. Both SDKs
carry the provider's entire CLI as an *optional dependency* (`@anthropic-ai/
claude-agent-sdk-darwin-arm64`, `@openai/codex-darwin-arm64`; ~300 MB apiece),
`npm install` pulls them in, and electron-builder ships the whole production
tree. So the app shipped a second copy of a tool its users already had, and
shipped it **stale**: a Carbon release pinned the agent's version, which means a
CLI fix waited on an app release to reach anyone. Grok was the only provider
resolved from the system, and only because xAI publishes no SDK to have vendored
one.

Two lines opt out — `pathToClaudeCodeExecutable` on the Agent SDK's query
options, and this module's answer where `codexAppServer.ts` used to resolve the
vendored package — after which `electron-builder.yml` drops the vendored
packages from the build. The app went from ~860 MB to 299 MB, essentially all of
which is now Electron.

The cost of the choice is this file, and it is the whole cost: resolution, a
version floor, and an honest "not installed" answer.

- **Resolution order is env override → PATH → known install locations.** PATH
  before the installers' own directories, because a version manager's shim
  (mise, asdf, volta) is what the user's terminal would run and Carbon should
  agree with it; the known locations answer for the Dock-launched app whose
  `hydrateShellPath` found nothing. `CARBON_CLAUDE_PATH` / `CARBON_CODEX_PATH` /
  `CARBON_GROK_PATH` outrank both (the Grok one predates the other two and keeps
  its spelling).
- **The binary is discovered, never configured.** There is no path setting, on
  purpose: it would be a second source of truth for a question resolution
  already answers, and one that goes stale the moment the CLI moves — the
  failure mode being a setting that silently stops applying. The env vars cover
  pointing at a specific build, which is a dev need rather than a user one.
- **`path` and `installed` are separate fields.** An override that resolves to
  nothing is reported *as itself* with `installed: false`, so the row can name
  the path instead of saying "Not installed" and sending someone hunting for an
  install they already have.
- **A disabled provider is indistinguishable from a missing one downstream.**
  Both are absent from `availableProviders`, so neither contributes a model row
  anywhere. The switch exists because someone with all three installed may want
  the picker down to the ones they use.
- **`MIN_CLI_VERSION` is a floor, not the version we built against.** Being
  *above* it is the normal case and the entire point of using the user's
  install — it moves faster than Carbon does. Below it, the row warns and
  nothing is blocked: refusing to run would be the app overruling a version the
  user chose to keep.
- **Session construction requires a binary; probes don't.** `requireCliPath`
  throws a message naming the install command, and `deliver` already wraps
  session construction, so it lands in the chat as an error card with the prompt
  preserved. The throwaway probes (`warmModels`, `warmCommands`, the usage read)
  call `cliPath` and return empty instead — a missing provider is a fact about
  the machine, not a failure to report each time it's checked.
- **`hasCompleteModelCatalog` is relative to what's available.** It used to name
  Claude and Codex as required and exclude Grok. Requiring a provider that isn't
  installed retries a probe that is correctly returning nothing, forever.

Settings → Providers renders `ProviderCli[]` and re-probes on open, since the
usual reason to be there is having just installed something in the terminal
next to the app. Settings live in `settings.json` under `providers`, coerced
through `knownProvider` on read like every other provider-keyed record.

### Normalizing the three backends

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and synthesizes the same plan-review event so the renderer remains provider-neutral; Grok bridges ACP `session/request_permission` to the same event and synthesizes the plan review from a tool call (see Grok Build above).

Adding the third provider changed **six lines of renderer logic and no architecture**, which is the seam working — but it did expose the idiom that breaks when a pair becomes a trio: `provider === 'codex' ? … : 'Claude'`, and its inverse `!isCodex` standing in for "is Claude". Both silently mislabel or over-serve a third provider rather than failing to compile. `PROVIDER_SHORT_LABELS` and an explicit `isClaude` replace them; prefer a `Record<Provider, …>` over a ternary anywhere provider identity is being decided, so the compiler names the next gap.

A chat can switch provider mid-conversation (the composer's model picker offers all three providers). A cross-provider pick is **deferred**: it only arms `chat.pendingModel` — the composer previews the target (chip, efforts, placeholder) but nothing else happens, so a misclick is undone by picking again and the original session is never touched. The switch applies on the next send (`applyPendingSwitch` → `switchProvider`): the session is disposed and the conversation carries over by **handoff** (`src/main/handoff.ts` + `ChatManager.handoffContext`) — the outgoing model writes a brief from the app's own transcript on a *throwaway* one-shot, falling back to the raw capped transcript on failure or timeout. The brief rides that same turn via `AgentSession.send`'s `hiddenContext` parameter — prepended to the prompt the model sees, never to the displayed/persisted user message — and may be a *promise*: the echo lands instantly and each session's internal `sendChain` holds turns in order until the context resolves. The plan review's "Build with" picker crosses providers too (this one applies at Approve, which is already deliberate): `ChatManager.approvePlanCrossProvider` tears down the review (disposing the plan session resolves it), restores the pre-plan permission mode, runs `switchProvider`, and kicks off implementation with the plan text verbatim — the plan itself is the handoff artifact; the brief only covers the conversation around it.

A plan approval may carry a `model` (`PermissionDecision`) — the plan review's "Build with" picker — so one model can plan and another implement, Cursor-style. Within a provider, each session applies it at approval time: Claude fires the live `setModel` *before* resolving the approval (both ride the CLI's stdin, so ordering guarantees the implementation turn starts on the new model); Codex sets `chat.model` before building the implementation turn, which snapshots it. A model from the *other* provider never reaches the session — the manager intercepts it (see the handoff paragraph above).

**The model decides the backend, and it is stored twice.** Every place that
remembers a model remembers a provider beside it (`chat.provider`,
`AppDefaults.modelProvider`, `NewChat`'s two `useState`s) — a second field is
unavoidable, because a runtime-discovered id is in no static catalog and only
the picker knows which list it came from. Two fields drift, and this pair drifts
in a way that has no symptom until a send: a chat launched as Codex carrying
`claude-fable-5[1m]` fails every turn with *"The 'claude-fable-5[1m]' model is
not supported when using Codex with a ChatGPT account"*, permanently, because
nothing revisits the pair. So `providerForRememberedModel` is the single
reconciler and the precedence is fixed — a model whose provider is *certain*
outranks the recorded one, which answers only for ids nothing can place.
Certainty comes from the live catalog, then the static one, then the id's shape
(`knownProviderForModel`), that last rule existing because the SDK's wire ids
(`claude-opus-5[1m]`) appear in no catalog at all. Mirroring one field without
the other is the bug this prevents: the renderer copied `defaults.model` after
each new chat and left `modelProvider` behind, so the *next* New-chat screen
paired a fresh Claude pick with the previous chat's Codex provider. Reconcile
where the pair is frozen (`chats:create`), and drop a model the chat's provider
cannot run at send (`dropForeignModel`) so a chat already written that way heals
instead of failing forever.

**A stored provider can name a backend this build does not have.** `userData` is
pinned to `ai-gui` so every build shares one database and one `settings.json` —
which is what lets dev and packaged share history, and also what lets a branch
that adds a fourth provider write rows the merged app must still open. Nothing
revisits the pair, so the row outlives the branch. The symptom is not a
mislabelled chat: `Record<Provider, …>` is total over the union and plain
`undefined` outside it, so `PATHS[provider].map` in `ProviderMark` *throws* — and
since the sidebar renders outside the content pane's error boundary, React
unmounts the root and the window becomes a flat sheet of the theme's background,
on every launch, because the row is still there on the next one. So `Provider` is
enumerable (`PROVIDERS`) and `knownProvider` coerces at the two places a provider
is read off disk: `parseMeta` / `reconcileProvider` in `store.ts` and
`providerForRememberedModel` for `settings.json`. The whole provider-side
identity goes with the name — `model` is that backend's own id, which
`dropForeignModel` deliberately *leaves alone* when no catalog can place it, so
left behind it would be sent to Claude for good; `sessionId` is a thread only
that backend can resume. Coerce at the read rather than teaching each lookup a
fallback: drawing one backend's mark on another's chat is worse than declining
to place it. The root `ErrorBoundary` in `main.tsx` is the backstop — it cannot
make the app work, but a render throw anywhere must never leave a black window
with nothing to click.

Codex's `workspace-write` sandbox carves `.git` out as read-only, and it resolves a worktree's `.git` *pointer file* to the shared gitdir and carves that out too — so a worktree creates no Claude/Codex asymmetry that a plain checkout doesn't already have. If that ever changes, the escape hatch is `additionalDirectories` on the SDK's `ThreadOptions` (forwarded as `--add-dir`).

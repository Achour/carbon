# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop GUI for coding agents. Claude sessions run through `@anthropic-ai/claude-agent-sdk`; Codex sessions run through `@openai/codex-sdk`. Both live in the Electron main process, reuse the user's existing provider login, and operate in whatever project folder the user picks.

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
- Renderer console output is mirrored to the terminal in dev.

## Architecture

Three Electron layers with one shared contract:

- `src/shared/types.ts` — **the contract between all three layers.** The `Api` interface (preload bridge), the `ChatEvent` union (main → renderer streaming), message/part types, `MODEL_OPTIONS`, `PERMISSION_MODES`. Most features start here.
- `src/main/` — Electron main process. `index.ts` registers all `ipcMain.handle` channels and emits `ChatEvent`s to the renderer over the single `chat:event` channel. `claude.ts` owns agent sessions. `store.ts` persists chats/settings. `git.ts` / `files.ts` are thin helpers behind the `git:*` / `fs:*` IPC channels.
- `src/preload/` — typed `window.api` bridge (contextIsolation on); a mechanical 1:1 mapping of `Api` methods to `ipcRenderer.invoke` calls.
- `src/renderer/src/` — React app. One zustand store (`store.ts`) holds all UI state; `applyEvent` is the reducer for incoming `ChatEvent`s. Components in `components/`, shadcn-style primitives built on Base UI in `components/ui/`, message renderers in `components/messages/`.

**Adding an IPC method touches four files:** the `Api` interface in `shared/types.ts`, a handler in `main/index.ts`, the bridge entry in `preload/index.ts`, and the caller in the renderer store.

Path aliases: `@` → `src/renderer/src`, `@shared` → `src/shared` (renderer and main both get `@shared`).

### Session flow (`src/main/claude.ts`)

`ChatManager` holds one provider-specific session per active chat. Claude uses one long-lived Agent SDK `query()` input stream. Codex uses SDK `Thread.runStreamed()` turns and resumes the same thread id across turns and app restarts. Both normalize provider events into the shared `ChatEvent` contract.

- Conversations resume across app restarts via `chat.sessionId` (`resume` option); the session id arrives on the SDK `init` message.
- SDK stream events are normalized into `AssistantPart[]` (`text` / `thinking` / `tool`); when the final `assistant` message arrives, `reconcileAssistant` replaces the streamed parts wholesale. Tool results come back on `user` messages and are matched by `toolUseId` via the `toolLoc` map.
- Streaming text deltas are coalesced ~40ms before IPC emission (per-token renders make the UI feel hung).
- Permissions: the SDK's `canUseTool` callback returns a Promise held in a `pending` map until the renderer answers via `chat:respond-permission`. "Always allow" uses the SDK's permission `suggestions`.
- Changing **effort** has no live SDK setter — `setOptions` disposes the session and the next send resumes it in a fresh process. Model and permission mode change live.
- Sub-agent traffic is skipped in the UI: messages with `parent_tool_use_id` are ignored.

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

`branchVsDefault` (git.ts) is the *single* implementation of "where does this branch stand vs main" — one `for-each-ref` + one `rev-list --left-right`. `gitStatus` puts its answer on `GitStatus.defaultBranch` / `behindDefault` / `aheadDefault` (started before the numstat reads so it overlaps them instead of adding a round trip); `worktreeStatus` derives `unmergedCommits` from the same call; the merge guards read it directly. Everything user-facing — the `↓n` staleness chip in `ContextStrip` (click runs "Update from main"), the ⋯ menu labels, the merge dialog's counts — reads the `GitStatus` copy, so the chip, the menu and the dialog can never disagree. Staleness has no other symptom until it surfaces as a conflicted merge, which is why the chip says it out loud while it's still cheap to fix. Note `behindDefault` is *not* `GitStatus.behind`, which is measured against the branch's own upstream. `listWorktrees` tags each ref `merged` from a single `branch --merged`, which is what lets the picker mark a finished worktree and offer to remove it instead of accumulating dead ones. A fresh worktree with no setup script also says so in the chat (`setupMissingFor`); the silence used to read as "installed", and the agent would just start failing on missing dependencies.

## Provider integration

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and synthesizes the same plan-review event so the renderer remains provider-neutral.

A chat can switch provider mid-conversation (the composer's model picker offers both providers; picking across the line flips `chat.provider`). Sessions aren't portable across backends, so the conversation carries over by **handoff** (`src/main/handoff.ts` + `ChatManager`): at switch time the outgoing model writes a brief from the app's own transcript on a *throwaway* one-shot — never by resuming the original session, which is what lets switching back before the first send restore that session untouched (`chat.handoff` stashes its resume id). The brief rides the new provider's first turn via `AgentSession.send`'s `hiddenContext` parameter — prepended to the prompt the model sees, never to the displayed/persisted user message. If the brief fails or times out, the raw serialized transcript (much smaller cap) is injected instead. Sends that arrive while the brief is still generating chain per-chat (`handoffSends`) so the context rides exactly the first turn. The plan review's "Build with" picker crosses providers too: `ChatManager.approvePlanCrossProvider` tears down the review (disposing the plan session resolves it), restores the pre-plan permission mode, runs `switchProvider`, and kicks off implementation with the plan text verbatim — the plan itself is the handoff artifact; the brief only covers the conversation around it.

A plan approval may carry a `model` (`PermissionDecision`) — the plan review's "Build with" picker — so one model can plan and another implement, Cursor-style. Within a provider, each session applies it at approval time: Claude fires the live `setModel` *before* resolving the approval (both ride the CLI's stdin, so ordering guarantees the implementation turn starts on the new model); Codex sets `chat.model` before building the implementation turn, which snapshots it. A model from the *other* provider never reaches the session — the manager intercepts it (see the handoff paragraph above).

Codex's `workspace-write` sandbox carves `.git` out as read-only, and it resolves a worktree's `.git` *pointer file* to the shared gitdir and carves that out too — so a worktree creates no Claude/Codex asymmetry that a plain checkout doesn't already have. If that ever changes, the escape hatch is `additionalDirectories` on the SDK's `ThreadOptions` (forwarded as `--add-dir`).

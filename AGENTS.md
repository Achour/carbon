# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

An Electron desktop GUI for coding agents. Claude sessions run through `@anthropic-ai/claude-agent-sdk`; Codex sessions run through `@openai/codex-sdk`. Both live in the Electron main process, reuse the user's existing provider login, and operate in whatever project folder the user picks.

## Commands

```sh
npm run dev        # run the app in dev mode (electron-vite, hot reload)
npm run build      # production build to out/
npm run typecheck  # tsc over both projects: tsconfig.node.json (main+preload) and tsconfig.web.json (renderer)
npm test           # node --test over test/*.test.ts
```

There is no linter. `npm run typecheck` is the primary verification gate; focused tests cover provider-independent tricky logic such as generated-image discovery, image caching, Codex plan parsing, and stale-session recovery.

Dev utilities (env vars for `npm run dev`, used for UI iteration without a human clicking):
- `AIGUI_CAPTURE=/tmp/shot.png` — saves a window screenshot after load. `AIGUI_CAPTURE_DELAY=2000,8000` takes a comma list of delays and saves `shot-1.png`, `shot-2.png`, …
- `AIGUI_E2E='<js>'` — runs a script in the renderer after load and logs the result to the terminal.
- `CARBON_UPDATE_REPO=owner/repo` — points the update check at another repo, faking a newer release.
- `CARBON_FAKE_HOMEBREW=1` — forces `installedViaHomebrew`, the only way to reach the cask variant of the update UI outside a real `brew install`. Dev-only.
- Renderer console output is mirrored to the terminal in dev.

Carbon ships unsigned, so it can't auto-update: the ad-hoc signature makes every build's
designated requirement a `cdhash` of that one build, which Squirrel.Mac can never match
against an update. The Homebrew cask in `Achour/homebrew-carbon` is the only in-place
route — `installedViaHomebrew` (`main/updates.ts`) detects it and swaps the update
banner's download for `brew upgrade --cask carbon`. The release workflow bumps that cask.

## Architecture

Three Electron layers with one shared contract:

- `src/shared/types.ts` — **the contract between all three layers.** The `Api` interface (preload bridge), the `ChatEvent` union (main → renderer streaming), message/part types, `MODEL_OPTIONS`, `PERMISSION_MODES`. Most features start here.
- `src/main/` — Electron main process. `index.ts` registers IPC channels. `claude.ts` contains the provider-neutral `ChatManager` plus `ClaudeSession`; `codex.ts` contains `CodexSession`; `session.ts` is their shared interface. `store.ts` persists chats/settings.
- `src/preload/` — typed `window.api` bridge (contextIsolation on); a mechanical 1:1 mapping of `Api` methods to `ipcRenderer.invoke` calls.
- `src/renderer/src/` — React app. One zustand store (`store.ts`) holds all UI state; `applyEvent` is the reducer for incoming `ChatEvent`s. Components in `components/`, shadcn-style primitives built on Base UI in `components/ui/`, message renderers in `components/messages/`.

**Adding an IPC method touches four files:** the `Api` interface in `shared/types.ts`, a handler in `main/index.ts`, the bridge entry in `preload/index.ts`, and the caller in the renderer store.

Path aliases: `@` → `src/renderer/src`, `@shared` → `src/shared` (renderer and main both get `@shared`).

### Session flow (`src/main/claude.ts`, `src/main/codex.ts`)

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

## Provider integration

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and synthesizes the same plan-review event so the renderer remains provider-neutral.

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

`npm run typecheck` is the primary verification gate. There is no linter. Tests cover
only pure, tricky logic worth pinning (e.g. `test/imageScan.test.ts` for Codex
generated-image discovery) — there are ~50 of them and none touches Electron or the DOM,
which is what lets `node --test` run the `.ts` directly with no bundler and no harness;
everything else is verified by typecheck + running the app. When you extract such logic,
keep it dependency-free (import only `node:*`) so `node --test` can run the `.ts`
directly without a bundler.

Dev utilities (env vars for `npm run dev`, used for UI iteration without a human clicking):
- `AIGUI_CAPTURE=/tmp/shot.png` — saves a window screenshot after load. `AIGUI_CAPTURE_DELAY=2000,8000` takes a comma list of delays and saves `shot-1.png`, `shot-2.png`, …
- `AIGUI_E2E='<js>'` — runs a script in the renderer after load and logs the result to the terminal.
- `AIGUI_WINDOW=940x800` — opens the window at that size instead of the saved bounds, for
  capturing a layout at a small window without dragging the corner.
- `AIGUI_PROFILE=/tmp/run.cpuprofile` — with `AIGUI_E2E`, samples the renderer's
  main thread for the whole of the script and writes a `.cpuprofile` (open it in
  DevTools → Performance, or reduce it with a script). The Performance API says
  *when* a long task happened; this is how to learn what it was doing.
- `CARBON_CLAUDE_PATH` / `CARBON_CODEX_PATH` / `CARBON_GROK_PATH` — pin a provider's
  CLI to a specific binary, above the Settings → Providers value. Useful for testing
  a prerelease CLI, or the "not installed" path (point one at a path that isn't there).
- `CARBON_UPDATE_REPO=owner/repo` — points the update check at another repo, so a real
  "newer release" can be faked (any repo whose latest tag outranks `package.json`).
- `CARBON_FAKE_HOMEBREW=1` — forces `installedViaHomebrew`, the only way to reach the
  cask variant of the update UI outside an actual `brew install`. Dev-only; a packaged
  build ignores it.
- Renderer console output is mirrored to the terminal in dev.

**A screenshot requested “here” or “in chat” must be visible inline.** Carbon
surfaces image blocks returned by tools outside the collapsed activity card, so
that already satisfies the request — do not save or link a duplicate. If the
capture exists only as a local file, put its readable absolute path in Markdown
image syntax (`![description](/absolute/path.png)`) so Carbon's `LocalImage`
renderer loads it over IPC and draws it inline. When both builds are running,
the development window is the `com.github.Electron` app; `com.achour.carbon` is
the installed Carbon window hosting the conversation.

`demo/` is the screenshot profile the README's and the landing page's images are
shot against: `setup.sh` rebuilds three small repositories (and one worktree)
from `demo/repos`, `seed.mjs` writes the chats straight into a throwaway
`AIGUI_USERDATA`, and `shoot.sh` drives the app through one of `demo/e2e/*.js`
and kills the whole process group afterwards — killing `npm run dev` alone
leaves Electron running, reparented to launchd. See `demo/README.md`.

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
- Streaming text deltas are coalesced ~80ms before IPC emission (`deltaCoalescer.ts`) — per-token IPC, and a persist per token, are genuinely too expensive. That window is about *cost*, not about pacing: the renderer spreads the text back out (see "Smooth streaming" in `docs/performance.md`), so widening or narrowing it here does not change what the reading looks like.
- **A tool call's input streams, and the row streams with it.** The input
  arrives as `input_json_delta` fragments and used to land on the part only at
  `content_block_stop` — so a row read "Terminal" beside a spinner for as long
  as the model took to type the command, then filled in all at once. Now the
  accumulated prefix is run through `parsePartialJson` (`main/partialJson.ts`,
  dependency-free, `test/partialJson.test.ts`) and emitted on the part with
  `partial: true` at most every `PARTIAL_INPUT_MS` — coarser than the text
  coalescer, since each emit is a full-part IPC plus a parse of the whole
  prefix. The parser closes whatever is open (a string, a key with no value, the
  brackets), backs off a half-written escape, and cuts back to the last `,` or
  opening bracket when the tail is an unfinishable literal. The flag is cleared
  at block close and by `terminalizeRunning`, so an interrupted stream never
  leaves a part claiming more is coming. Before the first parseable prefix
  lands, `ToolCard` pulses a placeholder in the summary's slot rather than
  drawing the label alone: a row that is forming should look like one.
  **The window widens with the prefix** (`partialInputDelay`): every emit
  re-parses the whole accumulated prefix *and* structured-clones the whole
  part, so a fixed window makes streaming one call quadratic in the size of its
  input — an 80 KB canvas write streaming for ~280 s is ~2,300 emits carrying
  ~190 MB between them, which is the app going sluggish for the whole of a long
  write. Scaling it keeps the total linear, where a hard cap would have cost the
  progressive `Edit` diff: that is drawn from exactly these partial inputs.
  `PARTIAL_INPUT_MAX_MS` sits **above** `saveChatSoon`'s 5 s cap and not below
  it: that debounce is trailing, so while emits land inside its 1.5 s window
  they keep resetting it and only the cap ever fires — a ceiling between the two
  would make every emit miss the window and persist, i.e. more writes than the
  flat window it replaced, on exactly the inputs this exists for.
- **Two more emitters are throttled at the same grain, for the same reason.** A
  redacted thought's `estimated_tokens` pings went out as a full-part IPC each,
  several a second for the whole of a long thought, re-rendering the transcript
  for a number nothing draws; the count still accumulates on the part per ping
  and is *shipped* at most every `THINKING_PING_MS`, and once more at block
  close. Codex's `item/commandExecution/outputDelta` arrived as the whole item
  and went out as the whole part per write to the pipe — O(k²) bytes for a
  chatty command, plus a persist each; `OUTPUT_MS` (`codex.ts`) holds one
  trailing timer per item and the terminal update flushes it.
- **Force-sending a queued message races the turn it interrupts.** The SDK
  writes the interrupt receipt *before* the aborted turn's result, so
  `interrupt()` resolves, the renderer's idle drain sends the queued prompt, a
  new turn starts — and only then does the dead turn's result land. Run the
  turn-end path for it and a **live** turn is declared idle: the transcript
  stops, and because the real end then dedups against that idle, the turn's
  genuine completion emits nothing at all — no queue drain, no refresh — so the
  chat looks stopped until the next send happens to move the status again. With
  nothing to unwind the receipt-to-result gap measured 6 ms against a 8 ms
  renderer round trip; anything that makes the CLI slower to write the result
  than the renderer is to answer the idle puts it the other way, which is why it
  reads as intermittent rather than broken. `isStaleResult` tells the two turns
  apart by **name** rather than by timing: `send` stamps a uuid on the prompt and
  the result echoes it back (`user_message_uuid`, or `user_message_uuids` when
  several sends merged into one turn), and a result naming another send settles
  only its own flags. Silence on both fields — an older CLI, a synthetic turn —
  is read as "this turn", so nothing regresses where the CLI says nothing.
  **Claude is the only provider with this shape**, and it is the cost of the
  long-lived input stream: the CLI drains it, so main never gets to serialize the
  two turns. Codex holds idle back for `drain()` while a run is live, and Grok's
  `sendChain` cannot start the next `runTurn` until the cancelled one's
  `finishTurn` has returned.
- **An interrupted message is delivered once more, after the interrupt.** The
  CLI ships the cut-off assistant message again with `aborted: true`, ending
  mid-word — measured ~21 ms behind the receipt, and (as the SDK's own ordering
  promises) just ahead of that turn's result. So it arrives after `interrupt()`
  has closed the turn, and on a force-send after the *next* turn has opened:
  `ensureCurrent` gives it a fresh bubble and the aborted text is printed a
  second time, below the new user message. `interrupt()` therefore parks the
  message in `abortedCurrent` instead of dropping it, `reconcileAssistant`
  routes an `aborted` copy there, and the trailing `current = null` is skipped
  for it — the turn now running owns `current`. The park is released at the
  turn's result, which the ordering guarantee puts strictly after the copy.
- Permissions: the SDK's `canUseTool` callback returns a Promise held in a `pending` map until the renderer answers via `chat:respond-permission`. "Always allow" uses the SDK's permission `suggestions`.
- Changing **effort** has no live SDK setter — `setOptions` disposes the session and the next send resumes it in a fresh process. Model and permission mode change live.
- **The system prompt is the one option that changes on neither axis.** Carbon
  passes an `append` (`GUI_SYSTEM_APPEND`, which carries the Mermaid nudge and
  `CANVAS_SESSION_RULES`), and the SDK stops *recording* the rendered prompt the
  moment one is passed — so the preset re-rendered its dynamic sections on every
  request and every relaunch, moving the prompt-cache prefix underneath a
  conversation and, with extended thinking, discarding the reasoning already in
  it. `systemPrompt.snapshot: true` restores recording. The cost is that the
  record then lives in the session transcript and survives `resume`: an edit to
  either constant reaches a chat only once it starts or compacts, not merely on
  the next launch. Codex re-sends its equivalent (`developerInstructions`) on
  every `turn/start`, and Grok's rides `_meta.rules` on `session/new` /
  `session/load`, so both pick a constant up at their next turn or spawn — the
  asymmetry is deliberate and lives at the definition sites.
- Sub-agent traffic never becomes a top-level message, but it is no longer *dropped*: only a
  `stream_event` carrying a `parent_tool_use_id` breaks: its `assistant` and `user` messages
  are routed onto the spawning tool card (`handleSubAgentAssistant` /
  `handleSubAgentToolResults`), which is what fills `ToolPart.children` and the agent roster.
  A **backgrounded** agent's `tool_result` is a placeholder that lands at spawn; its call is
  held `running` and its routing entry kept until the CLI's `task_notification`
  (`backgroundCalls`), or every child after the placeholder is dropped and the turn folds
  and unfolds at each continuation — see "Background agents" in `docs/transcript.md`.
- **Three things the model does are invisible unless they are decoded, and all three used to be.** Each is a shape the SDK grew that a text-only reader drops on the floor, and the symptom is identical every time: a step the user can see happen with nothing to show for it.
  - **A `tool_result` block is not always text.** `ToolSearch` — which Claude Code now calls ahead of every deferred tool — answers in `tool_reference` blocks carrying a tool *name* and no `text` at all, so a mapper reading `text` alone rendered the whole card empty. `toolResultText` is the one decoder, shared by the main-agent and sub-agent result paths so they cannot drift.
  - **`advisor` is a *server-side* tool.** The call arrives as a `server_tool_use` block and its answer as an `advisor_tool_result` block — never as a `tool_result` on a following user message, the only completion path `handleToolResults` knows. Unhandled, the card spun for the rest of the chat. Two paths have to settle it, and both are load-bearing: `handleStreamEvent` (mid-turn, so the card settles while the user is watching) and `reconcileAssistant` (a replay, or `includePartialMessages` off, reaches reconcile with the card still `running` and nothing else would ever settle it). The result is its own assistant message, *after* the one holding the call, which is why the reconcile branch falls back to `settleServerTool`'s `toolLoc` lookup rather than searching the parts it is building — and why the block is handled **above** `ensureCurrent`, which would otherwise open a message for a block that belongs to an earlier one. The content is normally `advisor_redacted_result`: encrypted for the model, with no text to show, so the honest line is the CLI's own — that it was consulted and the feedback is being applied. It goes on the *collapsed* row rather than one expand away, because the outcome is the only thing this call has to say. **An advisor call can also simply never be answered** — the turn ends with the consult still open and the CLI strips the pair out of the history it resends — so `terminalizeRunning` says that instead of leaving a green tick over an empty body.
  - **Thinking now ships with its text withheld.** The block arrives as `thinking: ""` plus a signature, and the only thing that streams is an `estimated_tokens` on each delta — itself a *delta*, which the CLI's own handler calls `estimatedTokensDelta`, so it accumulates. The last one is `null`, and that is where the corrected total arrives instead, on the `thinking_tokens` system message; `setThinkingTokens` applies it upward-only, because the count restarts at ~50 per thought and a reading landing before its block opened would otherwise overwrite the finished thought above it. **The count is kept and deliberately not drawn.** It was a row for a while — the reasoning it replaced is invisible, and a silent twenty-second pause reads as a hang — but the row was the wrong answer twice over: "Thought · 450 tokens" is a number the reader can act on in no way, and one lands between *every* pair of tool calls, so a ten-call sequence rendered as ten cards with a token tally wedged between each pair, the run-grouping broken by the very thing that had nothing to say. The turn's own **"Thinking…" / "Working…"** indicator at the foot of the transcript already covers the live case, for exactly as long as the turn runs, so a withheld thought now draws nothing at all and leaves no trace in history. That makes it blank *everywhere* — `isBlankMsg`, `isGroupableMsg` (transparent to it, so a `[thinking, tool]` message still joins the run) and `AssistantBlock`; a filter that kept it in one of the three would put the row back. `ThinkingPart.tokens` stays on the contract because main already accumulates it correctly and it is the only handle a redacted thought has, should one be wanted.
- **Claude in Chrome needs `CLAUDE_CODE_ENABLE_CFC`, and it is the CLI that decides.** `shouldEnableClaudeInChrome` bails on `!isInteractive()` *before* it reads `claudeInChromeDefaultEnabled`, so the browser tools a user paired in the terminal reach no session the SDK spawns — the setting they flipped is never consulted. That env var is the one check sitting above the bail (the `--chrome` flag, which the SDK cannot pass, is the other), so Carbon sets it — from **Settings → Providers** now rather than unconditionally (see "Per-provider capabilities"), defaulting to on. `=0` in the environment is still the opt-out, since the CLI reads it as a boolean. `env` **replaces** the subprocess environment rather than merging it, hence the `process.env` spread — and that spread is what carries the PATH `shellEnv` hydrated. The tools arrive as an MCP server named `claude-in-chrome` and go through the ordinary permission prompt; only `mcp__preview__*` is auto-allowed. Wiring it also makes the CLI rewrite `~/.claude/chrome/chrome-native-host` to point at whichever binary wired it last — Carbon's bundled one here, the user's `~/.local/share/claude/versions/…` after their next interactive run. It is one global file the two rewrite back and forth, and each repair is a session start, so the failure mode is self-healing rather than sticky.

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

## Surfaces (`docs/`)

This file carries the contract, the session flow and the provider seams — what
every session needs. Each surface's own long-form reasoning lives beside it in
`docs/`: why it is built the way it is, and which obvious alternatives were
tried first and were wrong. **Read the file named here before changing the code
it guards**, and put new reasoning in that file rather than back in this one.

- **`docs/performance.md`** — first paint and the cost of every message
  (`main/shellEnv.ts`'s remembered PATH, `providerCli`'s versions off the
  critical path, `lib/preloadHeavy.ts`, `lib/lspBridge.ts`, `Sidebar`'s
  memoization, the open-fence fast path) and smooth streaming
  (`lib/streamReveal.ts`, `useStreamText`, the reading column's
  `ResizeObserver`, `useHistoryNodes`, the foot's Thinking…/Working… label).
  Read it before touching anything on the path to first paint or to a streamed
  token.
- **`docs/transcript.md`** — what a turn draws: the activity rows
  (`ToolCard`, `ToolGroup`, `lib/toolSummary.ts`), the task checklist
  (`lib/taskList.ts`, `TaskDock`, `TasksCard`), the agent roster
  (`shared/agentRuns.ts`, `AgentsPanel`, `AgentActivityBar`), what the agent
  asks you (`PromptDock`, `CodexReviewDialog`) and the turn's changed files
  (`TurnChangesCard`, `lib/turnChanges.ts`).
- **`docs/chat-layout.md`** — the one reading column (`lib/chatColumn.ts`),
  tables in a message (`.markdown table`, `Markdown.tsx`), type in the chrome
  (`--ui-row`, `--code-font-size`, and why there is no text-size setting), file
  icons (`lib/fileIcon.tsx`, `--icon-*`) and the clickable file references each
  provider writes in its own syntax (`lib/fileLink.ts`).
- **`docs/editor.md`** — the file editor (`CodeEditor.tsx`,
  `lib/editorBuffers.ts`, `lib/frontmatter.ts`), code selections
  (`lib/codeSelection.ts`), the panel's tabs (`RightPanel.tsx`,
  `lib/tabOrder.ts`) and language servers (`main/lsp.ts`, `lib/lspClient.ts`,
  `lib/lspDiagnostics.ts`).
- **`docs/review.md`** — the stacked diff review (`DiffView.tsx`,
  `MultiDiffView.tsx`, `lib/diffRows.ts`, `LazyDiffBody`).
- **`docs/canvas.md`** — the canvas MCP server and its panel (`canvasTools.ts`,
  `canvasStore.ts`, `CanvasPanel`, `previewBridge.ts`, `previewMcp.ts`,
  `shared/canvasText.ts`, `lib/canvasRef.ts`).
- **`docs/side-chats.md`** — a second conversation in a panel tab
  (`ChatMeta.ephemeral`, `ChatMeta.sideOf`, `SideChatSlot`, `openSideChat`,
  `sideChats` in the renderer store).
- **`docs/drafts.md`** — text typed and not sent (`lib/drafts.ts`, `DraftItem`,
  `NewChat`).
- **`docs/image-viewer.md`** — the lightbox (`ImageView.tsx`,
  `LightboxTarget`).
- **`docs/sidebar.md`** — the two sidebar densities, the project filter, the
  order of `chats`, and `NewChatDialog` (`Sidebar.tsx`, `SidebarDensity`).
- **`docs/usage.md`** — the spend history page and its scan
  (`main/usageScan.ts`, `usageStats.ts`, `usageRates.ts`,
  `components/UsageStats.tsx`), and `--chart-*`.
- **`docs/worktrees.md`** — running a chat in a worktree (`main/worktree.ts`,
  `WorktreePicker.tsx`, `BranchPicker.tsx`, `branchVsDefault`) and publishing a
  project (`main/github.ts`, `PublishDialog.tsx`, `ensureRootCommit`).
- **`docs/sounds.md`** — the three generated alert cues (`lib/sounds.ts`).

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
- **Resolution is synchronous and cheap; a version is not.** A path is a few
  `stat`s, but `--version` is a subprocess with an 8 s timeout, and reading it
  lazily from `cliPath` put that stall in front of the first turn. Only
  `providerClis` (Settings → Providers) reads versions, asynchronously and in
  parallel — see "First paint" in `docs/performance.md`. A *disabled* provider is still probed: the
  row has to show what it found, or turning it back on is a leap of faith.
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

### Per-provider capabilities (`src/main/providerFeatures.ts`)

Each provider row in Settings → Providers carries switches for what a session
of that backend is *allowed to do* — browser use, computer use, the task
checklist, Artifacts. The two providers that have any arrive at the shape from
opposite directions, and normalizing them into one `ProviderFeatureState` is
what lets one row render either.

- **Claude's three are static, because nothing lists them.** They are the
  env-gated features above (`CLAUDE_CODE_ENABLE_CFC`,
  `CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_ARTIFACT`), and the catalog
  lives in `CLAUDE_FEATURES` — so Carbon is wrong about it the day the CLI
  renames one. `claudeFeatureEnv` writes **every** entry including the `0`s: an
  absent variable means "fall back to the CLI's own gate", which is not the same
  as off.
- **Codex's are discovered, so they cannot go stale.**
  `experimentalFeature/list` answers with a name, a stage, and both `enabled`
  and `defaultEnabled`. Of the ~138 flags it reports, the ones at stage `beta`
  carry a `displayName` and a `description` the CLI wrote for its own
  experimental-features UI and come through on its say-so; the handful that
  matter and are stage `stable` carry no copy at all, so they appear only if
  `CODEX_FEATURE_LABELS` names them. The rest is internal plumbing
  (`content_item_kinds`, `unbounded_connection_retries`) that a settings page
  offering would be a footgun. A name the CLI stops reporting simply vanishes
  from its answer, so the curated half fails by *omitting a row* rather than by
  wiring a switch to nothing.
- **The transport is the command line, not the runtime request.**
  `experimentalFeature/enablement/set` exists and works, but it is explicitly
  *process-wide runtime* state that dies with the app server — and Carbon
  disposes those freely, since every throwaway probe spawns one. `-c
  features.<name>=<bool>` at spawn is the durable spelling, the same one the
  CLI's own `--enable`/`--disable` compile to. Only keys the user touched are
  emitted, so a flag Carbon never surfaces reaches the CLI untouched.
- **Only a `0` in the environment overrides a switch.** These variables are
  documented above as opt-*outs*, and Carbon's own answer is on, so a `1` asks
  for nothing the switch would not already do. Reading a `1` as an override was
  actively wrong: Claude Code exports all three to every subprocess it spawns,
  so a Carbon launched from a terminal *inside a session* — which is how Carbon
  is developed — inherited three `1`s nobody chose and greyed out all three
  switches permanently. A `0` still wins and still names itself on the row,
  because that one is a deliberate instruction and is the escape hatch for a UI
  that is wrong.
- **Both are read at spawn**, so a toggle lands on the next session:
  `refreshProviderFeatures` disposes *idle* sessions of that provider the way an
  effort change does, and deliberately leaves a running turn alone — a settings
  toggle is not a reason to kill work the user is watching, and the row says so.

Grok has no equivalent API and contributes no switches, which is the same
answer a provider whose CLI is missing gives.

Settings → Providers renders `ProviderCli[]` and re-probes on open, since the
usual reason to be there is having just installed something in the terminal
next to the app. Settings live in `settings.json` under `providers`, coerced
through `knownProvider` on read like every other provider-keyed record.

### Normalizing the three backends

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and synthesizes the same plan-review event so the renderer remains provider-neutral; Grok bridges ACP `session/request_permission` to the same event and synthesizes the plan review from a tool call (see Grok Build above).

**Codex's sandbox is spelled twice, and a turn takes the newer spelling.** Thread
start and resume still accept the SDK's kebab-case `sandbox`, while an App
Server `turn/start` takes a structured `sandboxPolicy` (`readOnly` /
`workspaceWrite` / `dangerFullAccess`) — so sending only the first left a
*resumed* thread running under the sandbox it was created with, and a
permission-mode change the user made mid-chat never reached the turn.
`appServerSandboxPolicy` is the one mapping, and both boundaries are sent at
their own spelling rather than picking a winner.

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

### Artifacts (`CLAUDE_CODE_ARTIFACT`)

The third tool behind an env gate, and the first whose gate is the **entrypoint
itself**. `Artifact` renders an HTML file to a claude.ai page and answers with
its `…/code/artifact/<uuid>` link; the CLI's own `isEnabled` bails when
`CLAUDE_CODE_ENTRYPOINT` is `sdk-ts` / `sdk-py` / `sdk-cli`, `mcp` or the GitHub
action — every way the SDK spawns it — unless `CLAUDE_CODE_ARTIFACT` is truthy.
So the same login that published an artifact from the terminal answered "I
can't" in Carbon and wrote a local `.html` instead. Set from Settings →
Providers like the other two, `=0` in the environment their opt-out, landing at
spawn.

**The env var lifts one half of the gate and cannot lift the other.** Above the
entrypoint bail sits an account check — a rollout flag (`tengu_cobalt_plinth`)
over a Pro/Max-shaped plan and a claude.ai OAuth login, the Console API-key
login explicitly not counting. Nothing in the environment overrides it (the
CLI's own `Me(CLAUDE_CODE_ARTIFACT)&&!1` is dead code), which is the honest
limit to state: Carbon can stop *disqualifying itself*, and can do nothing for
an account the feature was never on for.

`ToolCard` already draws the result — an artboard for the source page, and an
Open button scraped for the `https://claude.ai/…` URL out of the publish output.
That card was written before the tool could ever fire here, which is why the
scrape is written to yield nothing rather than to trust a field.

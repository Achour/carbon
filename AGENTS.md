# AGENTS.md

This file provides guidance to Codex when working with code in this repository.
`CLAUDE.md` is the long-form version of the same notes; where this file is
terse, that one carries the reasoning.

## What this is

An Electron desktop GUI for coding agents. Claude sessions run through
`@anthropic-ai/claude-agent-sdk`; Codex sessions run through `@openai/codex-sdk`;
Grok sessions speak ACP to the `grok` CLI, which ships no SDK. All three live in
the Electron main process, drive **the CLIs the user installed** (see Provider
CLIs below), reuse their existing provider login, and operate in whatever project
folder the user picks.

## Commands

```sh
npm run dev        # run the app in dev mode (electron-vite, hot reload)
npm run build      # production build to out/
npm run typecheck  # tsc over both projects: tsconfig.node.json (main+preload) and tsconfig.web.json (renderer)
npm test           # node --test over test/*.test.ts (Node strips the TS types natively)
```

There is no linter. `npm run typecheck` is the primary verification gate. Tests
cover pure, tricky logic worth pinning and nothing else — diff row folding,
Codex rollout parsing, store invariants, path validation, LSP framing — so when
you extract such logic keep it dependency-free (import only `node:*`) and
`node --test` can run the `.ts` directly with no bundler. Everything else is
verified by typecheck plus running the app.

Dev utilities (env vars for `npm run dev`, used for UI iteration without a human clicking):
- `AIGUI_CAPTURE=/tmp/shot.png` — saves a window screenshot after load. `AIGUI_CAPTURE_DELAY=2000,8000` takes a comma list of delays and saves `shot-1.png`, `shot-2.png`, …
- `AIGUI_E2E='<js>'` — runs a script in the renderer after load and logs the result to the terminal.
- `CARBON_CLAUDE_PATH` / `CARBON_CODEX_PATH` / `CARBON_GROK_PATH` — pin a provider's CLI to a specific binary, above the Settings → Providers value. Useful for a prerelease CLI, or for testing the "not installed" path.
- `CARBON_UPDATE_REPO=owner/repo` — points the update check at another repo, faking a newer release.
- `CARBON_FAKE_HOMEBREW=1` — forces `installedViaHomebrew`, the only way to reach the cask variant of the update UI outside a real `brew install`. Dev-only.
- Renderer console output is mirrored to the terminal in dev.

`demo/` is the screenshot profile the README's and the landing page's images are shot
against — `setup.sh` rebuilds three repositories and a worktree, `seed.mjs` writes chats
into a throwaway `AIGUI_USERDATA`, `shoot.sh` drives one of `demo/e2e/*.js` and kills the
whole process group (killing `npm run dev` alone leaves Electron reparented to launchd and
running). See `demo/README.md`.

Carbon ships unsigned, so it can't auto-update: the ad-hoc signature makes every build's
designated requirement a `cdhash` of that one build, which Squirrel.Mac can never match
against an update. The Homebrew cask in `Achour/homebrew-carbon` is the only in-place
route — `installedViaHomebrew` (`main/updates.ts`) detects it and swaps the update
banner's download for `brew upgrade --cask carbon`. The release workflow bumps that cask.

## Architecture

Three Electron layers with one shared contract:

- `src/shared/types.ts` — **the contract between all three layers.** The `Api` interface (preload bridge), the `ChatEvent` union (main → renderer streaming), message/part types, `MODEL_OPTIONS`, `PERMISSION_MODES`, `PROVIDERS`. Most features start here.
- `src/main/` — Electron main process. `index.ts` registers IPC channels. `claude.ts` contains the provider-neutral `ChatManager` plus `ClaudeSession`; `codex.ts` / `codexAppServer.ts` and `grok.ts` / `grokAcp.ts` contain the other two; `session.ts` is their shared interface. `providerCli.ts` resolves the binaries. `store.ts` persists chats/settings. `git.ts`, `github.ts`, `worktree.ts`, `files.ts`, `lsp.ts`, `terminal.ts`, `preview.ts` sit behind their own channels.
- `src/preload/` — typed `window.api` bridge (contextIsolation on); a mechanical 1:1 mapping of `Api` methods to `ipcRenderer.invoke` calls.
- `src/renderer/src/` — React app. One zustand store (`store.ts`) holds all UI state; `applyEvent` is the reducer for incoming `ChatEvent`s. Components in `components/`, shadcn-style primitives built on Base UI in `components/ui/`, message renderers in `components/messages/`.

**Adding an IPC method touches four files:** the `Api` interface in `shared/types.ts`, a handler in `main/index.ts`, the bridge entry in `preload/index.ts`, and the caller in the renderer store.

Path aliases: `@` → `src/renderer/src`, `@shared` → `src/shared` (renderer and main both get `@shared`).

### Session flow (`src/main/claude.ts`, `codex.ts`, `grok.ts`)

`ChatManager` holds one provider-specific session per active chat. Claude uses one long-lived Agent SDK `query()` input stream. Codex uses SDK `Thread.runStreamed()` turns and resumes the same thread id across turns and app restarts. Grok spawns `grok agent stdio` and speaks ACP to it. All three normalize provider events into the shared `ChatEvent` contract.

- Conversations resume across app restarts via `chat.sessionId` (`resume` option); the session id arrives on the SDK `init` message.
- SDK stream events are normalized into `AssistantPart[]` (`text` / `thinking` / `tool`); when the final `assistant` message arrives, `reconcileAssistant` replaces the streamed parts wholesale. Tool results come back on `user` messages and are matched by `toolUseId` via the `toolLoc` map.
- Streaming text deltas are coalesced ~40ms before IPC emission (per-token renders make the UI feel hung).
- Permissions: the SDK's `canUseTool` callback returns a Promise held in a `pending` map until the renderer answers via `chat:respond-permission`. "Always allow" uses the SDK's permission `suggestions`.
- Changing **effort** has no live SDK setter — `setOptions` disposes the session and the next send resumes it in a fresh process. Model and permission mode change live.
- Sub-agent traffic never becomes a top-level message, and is not dropped either: a `stream_event` with a `parent_tool_use_id` breaks, while its `assistant` / `user` messages route onto the spawning tool card (`handleSubAgentAssistant` / `handleSubAgentToolResults`) and fill `ToolPart.children` for the roster.
- **Three shapes a text-only reader drops on the floor**, each producing the same symptom — a step the user watched happen with nothing to show for it. A `tool_result` block is not always text: `ToolSearch` answers in `tool_reference` blocks carrying a name and no `text`, so `toolResultText` is the one decoder both the main-agent and sub-agent paths share. `advisor` is a *server-side* tool — a `server_tool_use` block answered by `advisor_tool_result` on a *later* assistant message, never by a `tool_result`, so both `handleStreamEvent` and `reconcileAssistant` must settle it (the reconcile branch via `settleServerTool`'s `toolLoc` lookup, handled above `ensureCurrent`), and an unanswered consult is terminalized rather than left green over an empty body. Thinking now ships with its text withheld — `thinking: ""` plus an `estimated_tokens` *delta* that accumulates, corrected by the `thinking_tokens` system message (`setThinkingTokens`, upward-only). A withheld thought is deliberately drawn **nowhere**: `isBlankMsg`, `isGroupableMsg` and `AssistantBlock` all treat it as blank, since a "Thought · 450 tokens" row lands between every pair of tool calls and breaks run grouping to say nothing.
- **Three env vars are set at spawn unless the user already set them**, each because the CLI gates a feature off an entrypoint check the SDK fails: `CLAUDE_CODE_ENABLE_CFC` (Claude in Chrome), `CLAUDE_CODE_ENABLE_TODO_TOOLS` (the `Task*` checklist tools), `CLAUDE_CODE_ARTIFACT` (publishing artifacts). `=0` is the user's opt-out in each case. `env` **replaces** the subprocess environment, hence the `process.env` spread — which is also what carries the PATH `shellEnv` hydrated. The artifact gate additionally has an account half nothing in the environment can lift.

### Grok (`src/main/grokAcp.ts`, `grok.ts`)

No SDK, so the protocol is the integration surface: `grokAcp.ts` spawns `grok agent stdio` and speaks [ACP](https://agentclientprotocol.com) JSON-RPC over its pipes, `grok.ts` turns that into `ChatEvent`s — the same split `codex.ts` keeps against `codexAppServer.ts`, which is what keeps the manager, IPC and renderer unaware of a third backend. `GROK_OAUTH2_REFERRER=carbon` is what lets a SuperGrok/X subscription authorize the session with no API key; auth is otherwise `XAI_API_KEY` or the CLI's own cached login.

Shapes were read off the running CLI, not the published schema. Four findings drive the design: Grok has **two** permission axes — a baseline fixed at `session/new` (`_meta.yoloMode` / `_meta.autoMode`, the latter sent *explicitly false* so the user's `~/.grok/config.toml` can't silently make an "Ask" chat auto-approve) and a plan flag moved live by `session/set_mode`, which recognizes only `plan` and `default` — so a permission-mode change respawns while plan mode does not. `session/set_model` works live; reasoning effort is a spawn flag and respawns. Grok never gates `exit_plan_mode`, so the plan review is *synthesized* from the tool call, its text read from `plan.md`, approval starts a **new** turn, and the plan flag is re-asserted at the head of every turn. Only the first payload of a tool call identifies it (`toolNameIfNamed` vs `toolName`, `planToolIds`).

`fetchGrokModels` probes the catalog for zero tokens — the model list rides the ACP handshake — and returns `[]` when the CLI is absent, which is how Grok stays out of the picker. It has no static fallback at all; Claude's and Codex's `MODEL_OPTIONS` rows stand in only while their CLI is present and the fetch is merely pending.

### Provider CLIs (`src/main/providerCli.ts`)

**Carbon spawns the CLIs the user installed and ships none of its own.** Both SDKs carry the provider's whole CLI as an optional dependency (~300 MB apiece); `electron-builder.yml` excludes them, and the app went ~860 MB → 299 MB. Shipping them meant a Carbon release pinned the agent's version.

- Resolution order is env override → PATH → known install locations. PATH first because a version manager's shim is what the user's terminal would run; the known locations answer for a Dock-launched app whose PATH hydration found nothing.
- **Resolution is a few `stat`s and stays synchronous; reading a `--version` is a *process* and is async.** `providerClis` (Settings → Providers) is the one caller that needs versions and the one that pays; a lazy version read inside `cliPath` used to stall the first turn behind `claude --version`.
- The binary is **discovered, never configured** — a path setting would be a second source of truth that goes stale silently. `path` and `installed` are separate fields so an override that resolves to nothing is reported as itself.
- `MIN_CLI_VERSION` is a floor, not the version we built against: below it the row warns and nothing is blocked.
- `requireCliPath` throws (session construction, landing in the chat as an error card with the prompt preserved); the throwaway probes call `cliPath` and return empty. `hasCompleteModelCatalog` is relative to what's *available* — requiring an uninstalled provider retries a correct empty answer forever.

### Startup and first paint

Work that used to happen at a moment nobody chose — between the click and a window, or between a token and a frame.

- **PATH is remembered, not re-derived.** `hydrateShellPath` is a synchronous `zsh -ilc` — 0.5–2 s on a real config, at every launch. userData holds the previous launch's PATH and it's applied immediately while the shell is re-read in the background to rewrite the cache. Only a first-ever launch spawns a shell, and staleness is bounded by construction. `app.setPath('userData')` must stay above it.
- **The heavy renderer chunks are split out and preloaded on idle.** highlight.js registers only `HLJS_LANGUAGES` (one definition shared with `rehype-highlight`, since the extra languages could only color a streaming fence until the full parse replaced them); mermaid, CodeMirror and xterm are dynamic imports warmed one at a time by `lib/preloadHeavy.ts` — lazily loading without warming only *moves* the cost to the first click. `lib/lspBridge.ts` exists because `store.ts` and `main.tsx` are on the path to first paint and statically imported `lspClient`: the client registers itself when its chunk lands, so both callers are no-ops until an editor is opened, which is also the only shape that works for `releaseAllServers` on `beforeunload`.
- **An open code fence skips the markdown parse.** Nothing inside a fence is a seal boundary, so it is the one block whose live tail grows without bound. `splitMarkdownStream` reports it separately and it renders as one memoized row per line, highlighted whole and *then* cut into lines (hljs carries state across lines, so per-line highlighting miscolors everything under a block comment). A mermaid fence declines the fast path.

### Persistence (`src/main/store.ts`)

SQLite (`node:sqlite`, no native dep) in `userData/chats.db`: a `chats` table of metadata, a `messages` table keyed `(chat_id, seq)` where `seq` is the message's index in `chat.messages`, and a `kv` table (migration marker, deletion tombstones). `settings.json` stays a plain file. `userData` is pinned to `ai-gui` so dev and packaged builds share history (`~/Library/Application Support/ai-gui/`); `AIGUI_USERDATA` overrides it for an isolated instance.

**Chats load lazily, and only a window of each one.** Startup opens the database and reads nothing else — `listChats` is one indexed query over `chats`. Opening a chat hydrates only its most recent messages (`HYDRATE_TAIL` / `HYDRATE_BYTES`, floored by `HYDRATE_MIN`); older slots hold an `unloadedMessage` placeholder so **`seq` keeps meaning "index in `chat.messages`"** for every write pass. `loadOlder` promotes one more window on demand.

**No write pass may ever serialize a placeholder** — it is not the message, and writing it would flatten real history. `candidateRows` and `reconcile` both skip `Resident.unloaded` and `Resident.corrupt`, and the sets survive eviction (via `holes`) because a re-admitted chat rebuilds its baseline from scratch and forces a full reconcile. Placeholders are *in sync with disk by construction* — nothing ever parsed them — which is why they count toward neither `unchecked` (durability) nor the `unverified` set. Conflating that with `inexact` (byte accounting) would pin every windowed chat in memory forever, since `evictOverBudget` refuses to evict an unverified chat.

`getChat` returns the full-length array with placeholders — what sessions hold and mutate. `viewChat` returns the loaded suffix plus `hiddenBefore` and is what the renderer gets; a placeholder never crosses IPC. Anything reading a chat from the *front* (only title generation) must check `Store.hiddenBefore` first.

Resident chats are held under a byte budget (`RESIDENT_BUDGET`) with an LRU — measured on the window, not the chat's size on disk. Evicted ones are tracked by `WeakRef` so **there is at most one `ChatData` per id alive in the process** and `getChat` always returns it. That invariant is load-bearing: provider sessions hold `this.chat` for their whole lifetime and mutate it in place.

**Writes are incremental.** `saveChatSoon` (1.5s trailing debounce, 5s cap) re-serializes only the rows that can have changed. `saveChat` (turn boundaries) and a 30s floor run a **bounded** reconcile — the tail plus a rotating window (`RECONCILE_VERIFY_BYTES`) — so a big chat can't stall the main thread every turn; that pass never DELETEs rows it lacks in memory. Quit runs one thorough pass over `dirty` ∪ `unverified`, tracked separately because a chat leaves `dirty` after a bounded pass that may have skipped the very mutation the thorough pass exists to catch. Eviction also writes thorough: it is the last moment the object is guaranteed reachable.

Two safeguards for the shared-userData design: a per-chat advisory `locks` row (heartbeat, 30s staleness) so two instances never write one chat at once, and a `chats.rev` counter asserted inside the write transaction. A rolling `chats.db.bak` is the real backup; recovery goes damaged DB → backup → archive. The legacy `chats/<id>.json` files are imported once and then **never written, moved, or deleted** — an archive, not a live backup.

The last explicitly chosen model/effort/permission-mode become the defaults for new chats (`rememberOptions`).

### Renderer state (`src/renderer/src/store.ts`)

Only the active chat's messages are held in memory, and only the window main sent — `messages` is the loaded suffix and `hiddenBefore` counts what is still in the database. Switching chats refetches via `getChat`; "Load earlier messages" prepends the next window and restores the reading position by anchoring on distance from the *bottom* of the scroller, the part a prepend does not move. Events for non-active chats still update sidebar metadata and statuses. The right panel hosts file tabs, git diff tabs (ids prefixed `diff:`), the plan panel and the agents roster; an `ExitPlanMode` permission request auto-opens the plan panel. When a chat's status returns to `idle`, open files, the file tree, git status and the language servers' view of the project are refreshed.

State that churns several times a second lives **outside** the message-history render path — `taskListStore` (the checklist fold), `agentsStore` (the roster), the editor's buffers, the composer's draft text — because threading it through props re-renders every transcript row on each flip. Each of those stores carries unchanged values forward *by identity* so subscribers see nothing when nothing moved.

### The editor and language servers (`CodeEditor.tsx`, `lib/editorBuffers.ts`, `main/lsp.ts`, `lib/lspClient.ts`)

Files are **editable**, not just readable: `FileViewer`'s `text` branch is a CodeMirror 6 view (every other branch — Markdown preview, image, binary, too-large — is untouched, and `DiffView` is deliberately not covered).

- **The buffer lives outside React and outside zustand**, keyed by path: `EditorState` has to survive a tab switch, or undo history, cursor and scroll go with it. The store learns only about clean ⇄ dirty transitions. Dirtiness is `Text.eq` against a `baseDoc` behind an early return, because selection-only transactions vastly outnumber edits. `dropBuffer` releases everything keyed by a path.
- **A truncated read is never saveable** (read-only with a bar saying so). `fs:write` takes the mtime the buffer was read at and refuses on a mismatch — `!==`, not `>`, since a checkout moves mtime backwards — and `ConflictBar` offers both ways out. The post-turn refresh stats first and dispatches new text into the mounted view rather than replacing it.
- A dirty preview tab gets pinned instead of reused; closing a dirty tab asks; closing the window and **quitting** ask through one guard, fed by a `dirtyFileCount` pushed to main on every transition (`close` is synchronous about being vetoed).
- New files are named **in the tree**, not a dialog; `createPath` accepts slashes and validates the resolved path against the parent (`test/createPath.test.ts`), and creates with `wx`. Renaming **re-keys the buffer** rather than reopening the file, and rewrites descendants by prefix *with the separator*. Deleting goes to `shell.trashItem` and always asks; the dialog is rendered by `App` because the tree unmounts when the dock switches.
- Frontmatter is split off before the preview parses (`lib/frontmatter.ts`) — CommonMark turns `---` + keys + `---` into a setext H2, which rendered every agent file as one giant heading. Prose soft-wraps, code does not. Grammars are lazy `import()`s swapped in through a `Compartment`.

LSP is the reverse split of everything else here: **main does no protocol work.** `@codemirror/lsp-client` runs JSON-RPC in the renderer, so `main/lsp.ts` is a spawn plus `Content-Length` framing (`splitFrames`, pinned by `test/lspFrames.test.ts` — the header counts *bytes*, so slicing the decoded string is off by one per non-ASCII character).

- **Carbon ships no servers.** Resolution is project `node_modules/.bin` → PATH → install prefixes, the reverse of `providerCli.ts`'s order, because the server must agree with the repo's lockfile. TypeScript 7 **is** a language server and is tried first, resolved by path and gated on the file existing — `vtsls` and `typescript-language-server` wrap a `tsserver.js` that TS 7 doesn't ship, so on such a project they are a broken fallback rather than a fallback.
- `initialize` is awaited before the extension reaches the editor, so a server that can't start degrades to "no language features". **That** failure is cached; a *missing* server is not, because it heals on its own when `setup.sh` finishes.
- A missing server must not be silent: the ⌘-click affordance only arms when the plugin is present, and a jump that goes nowhere posts a transient notice distinguishing *unavailable* (with the install command) from *absent*. F12 is a listener on the editor host, not a keymap entry, because a `Command` returns a boolean and can't reach the notice.
- Take `languageServerExtensions()` **minus** `serverDiagnostics()`: it dispatches `setDiagnostics`, which replaces the whole set and would erase the Lezer-based syntax linter (and be erased by it). `lspDiagnostics.ts` parks the raw payload and re-emits from a lint source; storing raw LSP positions is *more* accurate than converting on arrival.
- One server per (project root, language), shut down 5 min after release, with **no refcount in main** — the renderer caches one client per key, so it asks once and releases once, and a count in main would describe a lifecycle it never sees. `CarbonWorkspace.displayFile` routes through the store's `openFile` so a jump into an unopened file works. A finished turn sends `workspace/didChangeWatchedFiles` for `lastTurnEditedPaths`.

### The review (`DiffView.tsx`, `MultiDiffView.tsx`, `lib/diffRows.ts`)

Every changed file stacked in one scroller under a sticky, collapsible header, meant to read as *code* rather than a table of changed lines. Lines don't wrap by default and the horizontal scroller sits **inside** each section (a shared one carries the sticky headers off the left edge). The gutter counts the new file, so a deleted line has no number. Tints sit behind syntax highlighting, with the signal carried by a solid bar at the row's outer edge.

**Two kinds of hidden line:** git elided some (`-U3`) and they aren't in the text; we folded the rest and have them. `parseDiff` answers the first (`gaps`), `foldRanges` the second, `diffItems` merges them. Opening a git-elided gap **re-runs the diff** with more context (the new side of a staged diff is the index, not the working tree); reveals are line *ranges*, not row indices, because the row array is replaced wholesale when that lands; a refetch that comes back shorter is dropped. `MIN_FOLD` keeps runs under four lines open. `LazyDiffBody` mounts only near-viewport bodies (headers stay mounted, so scroll-to-file still works) and remembers heights off the `IntersectionObserver` entry — 303,960 nodes → 8,418 on a 40-file review. ⌘F forces every file to mount, since `FindBar` collects matches by walking the DOM.

### Agents, tasks and turn changes

- **`shared/agentRuns.ts` / `AgentsPanel`** — a fan-out is state, not an event, so the roster folds `ToolPart.agent` + `children` out of the transcript rather than taking a second channel. The three providers report vitals at three different moments (Claude on every sub-agent message, deduped by an `agentUsageMsg` cursor and carried across `reconcileAssistant`; Codex only in the child's own rollout; Grok not at all, drawn missing rather than guessed). Tokens are input + cache reads + cache writes + output. `endedAt` is the agent's last activity, not when its call returned. The panel is never auto-selected.
- **`lib/taskList.ts` / `TodoCard`** — Codex sends the whole list in one `TodoWrite`; Claude Code replaced it with incremental `TaskCreate`/`TaskUpdate`, where the id exists only in the *output*, an update is never in the same message as its create, and a run of creates collapses to one card (superseded calls are dropped in `AssistantBlock`, not rendered null). `Task{Stop,Output,Get}` are background agents keyed by a snake_case `task_id` and are deliberately not folded in.
- **`TurnChangesCard` / `lib/turnChanges.ts`** — a directory holding two or more changed files gets a collapsible row, everything else a plain one; every file is listed. Rows open that file's diff and fall back to the file once committed. Deltas are exact from Codex, summed from the working tree for Claude, and drawn as nothing rather than `+0 −0` when gone.

### Usage (`src/main/usageScan.ts`, `usageStats.ts`, `components/UsageStats.tsx`)

Two different questions share the word. `usage.ts` + `UsagePanel` (sidebar chip) ask the providers how much **plan headroom** is left right now — Claude and Codex only; Grok exposes no such endpoint. The Usage **page** asks what was **spent** over the last 7/30/90 days by reading the CLIs' own session logs: `~/.claude/projects/<slug>/<session>.jsonl`, `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, `~/.grok/sessions/<percent-encoded cwd>/<id>/updates.jsonl`. Every adapter drives the real CLI, so Carbon's own turns are already there — which is why the page must not also sum our `TurnStats`.

Gotchas the code exists to handle: subagent turns live in separate `<session>/subagents/agent-*.jsonl` files (walk 6 levels or lose ~16% of spend); one Claude response is logged once per content block, so dedupe on `message.id` + `requestId`; Codex's `token_count` carries a running total *and* a per-call delta and no model, so `CodexFileReader` carries the model forward and sums only the delta; Codex's and Grok's `input_tokens` are inclusive of cached input, Claude's is not; Grok reports **per-turn** totals and `costUsdTicks` (1e-10 USD), the one case where a cell stores money, because a provider-reported figure is not an estimate that can go stale. Rates are fetched from LiteLLM's `model_prices_and_context_window.json` (cached 24h, fallback = the built-in table) — a static table can't price the Codex-only slugs, which bill ~4× the family they're named after. Claude's 1-hour cache writes (2× input) and fast mode are separate SKUs. Cells store **tokens, not money**; cost is applied at read time, so a rate refresh reprices without re-reading a byte. Per-file results are cached under `(path, mtime, size)` — bump `CACHE_VERSION` whenever *parsing* changes.

`--chart-claude` / `--chart-codex` / `--chart-grok` are the one place the app carries hue a theme does not set: on a page comparing providers the colors *are* the labels. They were solved as a set for CVD separation in both modes — re-run that check before touching any of the three.

### Sidebar modes (`Sidebar.tsx`, `SidebarDensity`)

Two shapes, chosen in Settings → Chats, persisted in `localStorage`. **Compact** is one line per chat grouped by project. **Detailed** is a provider mark, the title, and a second line naming the project and branch — in one flat newest-first list bucketed by date, because grouping *and* naming the project on every row says the same thing twice ("Today" is likewise unlabelled).

**The order is the array**, and it moves only on create, delete or turn start (`hoistChat`) — never on `updatedAt` as messages arrive, which had two streaming chats trading places forever. The project **filter** heads both modes; a filtered compact list drops its project row and moves its actions onto the chat rows' menu via `ProjectMenuItems`, the one definition all three sites render. **Starting a chat asks which project** (`NewChatDialog`), ordered by recency so ⌘N-Enter is the common case, and is also where projects are pruned.

Branches come from `git:branches` → `branchesAt` (`git.ts`): it reads `.git/HEAD` rather than spawning `rev-parse` per row, follows a worktree's `.git` pointer file, is skipped entirely in compact mode, and refreshes when *any* chat's turn ends.

Drafts (`lib/drafts.ts`) are the other thing the sidebar owns: text typed and not sent, kept because `<ChatView key={chat.id}>` unmounts the composer on every switch. A **chat** draft is text alone; a **project** draft also carries the model/effort/permission/worktree picks, because it is a chat that was never created — and deliberately not a `ChatMeta`, since `chats:create` freezes the provider pair and may run `git worktree add`. The text lives in the composer with a 400ms debounce plus a flush on unmount; both readers take it imperatively. Only reference-shaped attachments persist — a base64 payload would throw at `localStorage`'s quota and take every other draft's text with it.

### Git worktrees (`src/main/worktree.ts`) and publishing (`github.ts`)

A chat can run in an isolated worktree. **The app creates it itself** (`git worktree add`) rather than delegating to either provider's own mechanism, because a worktree is just a directory and owning creation is what makes the feature provider-neutral. `chat.cwd` points at it and `chat.worktree` carries the metadata; **the adapters are untouched — cwd is the only seam.** Preserve that.

The picker is a "Run on" chip above the composer (This Mac / an existing worktree / New worktree) paired with a **branch** chip: one combobox that filters existing branches *and* composes a new name, with create as the last row (typing `grok` where `grok-build` exists is far more often an unfinished search). `sanitizeBranch` lives in `@shared/branchName` so the preview shows the name git will actually make. A branch another worktree holds is not offered; the collision retry renames only a *generated* name, never one the user typed. This Mac deliberately cannot switch branch.

Worktrees live in `~/.karbun/worktrees/<repo>-<hash>/<branch>` (`KARBUN_WORKTREES_DIR` overrides). A fresh one gets the project's committed `.karbun/setup.sh` (falling back to `.codex/setup.sh`) in a visible terminal tab, not awaited. The ⋯ menu carries the lifecycle: **update from main** (a delegated `resolveGitActions` rung, so the agent resolves conflicts here rather than at landing), **merge into main** (app-executed for a worktree since the merge must happen in `repoRoot`; `gitMergeIntoDefault` in-place otherwise, idle-only), **continue in local checkout**, **remove worktree**. All refuse on a dirty tree and undo a conflicting merge, so a refusal leaves the directory as it was found. Both exits relocate the chat, so main disposes the session.

`branchVsDefault` is the *single* implementation of "where does this branch stand vs main"; `gitStatus` puts its answer on `GitStatus.defaultBranch` / `behindDefault` / `aheadDefault` so the staleness chip, the menu labels and the merge dialog cannot disagree (`behindDefault` is **not** `GitStatus.behind`, which is against the upstream). `listWorktrees` drops refs git calls `prunable`, and `GitStatus.missing` separates "not a repo" from "not there" inside `gitStatus`'s existing catch.

`ensureRootCommit` is the shared floor under both worktrees and publishing: a freshly `git init`ed folder has no commit and both `git worktree add … HEAD` and `git push` fail on an unborn HEAD. It uses plumbing (`commit-tree` + `update-ref`) rather than `commit --allow-empty`, which would sweep whatever is staged into a commit nobody asked for. **Publish repository** is a dialog rather than a delegated task — owner, name and visibility are decisions, and delegated, an agent invented a name and quietly chose private. `publishRepo` is ordered by what is recoverable (everything local first; the push last, since it is the only failure that leaves a real repository behind) and injects gh's credential helper for that one command rather than writing the user's global config.

## Provider integration

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and Grok bridges ACP `session/request_permission`, and both synthesize the same plan-review event so the renderer stays provider-neutral.

Adding the third provider changed six lines of renderer logic and no architecture — but it exposed the idiom that breaks when a pair becomes a trio: `provider === 'codex' ? … : 'Claude'` and its inverse `!isCodex`. Both mislabel a third provider rather than failing to compile. **Prefer a `Record<Provider, …>` over a ternary anywhere provider identity is decided**, so the compiler names the next gap.

A chat can switch provider mid-conversation. A cross-provider pick is **deferred**: it arms `chat.pendingModel` only, so a misclick is undone by picking again and the original session is never touched. It applies on the next send (`applyPendingSwitch` → `switchProvider`): the session is disposed and the conversation carries over by **handoff** (`src/main/handoff.ts`) — the outgoing model writes a brief on a throwaway one-shot, falling back to the raw capped transcript. The brief rides that turn via `AgentSession.send`'s `hiddenContext`, never touching the displayed message, and may be a *promise*, held in order by each session's `sendChain`. The plan review's "Build with" picker crosses providers too, applying at Approve: the plan text itself is the handoff artifact.

**The model decides the backend, and it is stored twice** (`chat.provider`, `AppDefaults.modelProvider`, `NewChat`'s two `useState`s) — unavoidable, since a runtime-discovered id is in no static catalog. The pair drifts silently and fails only at send, so `providerForRememberedModel` is the single reconciler: a model whose provider is *certain* (live catalog → static catalog → `knownProviderForModel` on the id's shape) outranks the recorded one. Reconcile where the pair is frozen (`chats:create`), and `dropForeignModel` at send so a chat already written wrong heals.

**A stored provider can name a backend this build doesn't have** — one userData is shared by every build, so a branch's rows outlive it. `Record<Provider, …>` is total over the union and `undefined` outside it, so an unknown provider *throws* in `ProviderMark`, and the sidebar renders outside the content pane's error boundary: a flat sheet of background on every launch. So `Provider` is enumerable (`PROVIDERS`) and `knownProvider` coerces at the two places a provider is read off disk (`parseMeta` / `reconcileProvider`, and `providerForRememberedModel`). The root `ErrorBoundary` in `main.tsx` is the backstop.

Codex's `workspace-write` sandbox carves `.git` out as read-only and resolves a worktree's `.git` pointer file to the shared gitdir, so a worktree creates no asymmetry a plain checkout doesn't already have. The escape hatch, if that changes, is `additionalDirectories` on the SDK's `ThreadOptions`.

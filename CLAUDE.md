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

**Chats load lazily.** Startup opens the database and reads nothing else — `listChats` is one indexed query over `chats`, and message bodies are hydrated only when a chat is opened. Resident chats are held under a byte budget (`RESIDENT_BUDGET`) with an LRU; evicted ones are tracked by `WeakRef` so **there is at most one `ChatData` per id alive in the process** and `getChat` always returns it. That invariant is load-bearing: provider sessions hold `this.chat` for their whole lifetime and mutate it in place.

The last explicitly chosen model/effort/permission-mode become the defaults for new chats (`rememberOptions`).

**Writes are incremental.** `saveChatSoon` (1.5s trailing debounce, 5s cap) re-serializes only the rows that can have changed — appended-since-last-write, the tail, anything holding a live tool, and anything flagged via `markMessageDirty`. `saveChat` (turn boundaries) and a 30s floor run a full reconcile against what the database actually holds; that pass never DELETEs rows it lacks in memory. `flushAll` on quit writes only chats that were actually mutated.

The legacy `chats/<id>.json` files are imported once and then **never written, moved, or deleted** — so `rm chats.db` rolls back to the pre-migration corpus. They are an *archive, not a live backup*: they stop tracking reality the moment the migration lands. See `store.ts` for the corruption path (salvage the readable rows first, fall back to the archive only if nothing survives).

### Renderer state (`src/renderer/src/store.ts`)

Only the active chat's messages are held in memory; switching chats refetches via `getChat`. Events for non-active chats still update sidebar metadata and statuses. The right panel hosts file tabs, git diff tabs (tab ids prefixed `diff:`), and the plan panel; an `ExitPlanMode` permission request auto-opens the plan panel. When a chat's status returns to `idle`, open files, the file tree, and git status are refreshed so the agent's edits show up.

### Git worktrees (`src/main/worktree.ts`)

A chat can run in an isolated worktree. **The app creates the worktree itself** (`git worktree add`) rather than delegating to Claude Code's `.claude/worktrees/` or Codex's equivalent — a worktree is just a directory, so owning creation is what makes the feature provider-neutral. `chat.cwd` points at the worktree and `chat.worktree` carries the metadata (`repoRoot`, `branch`); **the provider adapters are untouched**, since both already take `chat.cwd`. Preserve that property: cwd is the only seam.

The entry point is a Cursor-style "Run on" chip **above** the composer (`WorktreePicker.tsx`) — This Mac / an existing worktree / New worktree — paired with a branch chip that tracks the selection. It sits above the composer deliberately: the composer's own controls row (model, effort, permission mode) is already tight.

Worktrees live in `~/.karbun/worktrees/<repo>-<hash>/<branch>` (outside the repo so they never dirty git status, outside `userData` whose path contains a space that breaks build scripts). `KARBUN_WORKTREES_DIR` overrides the root — tests set it so they don't write to a real `$HOME`.

A fresh worktree has no gitignored files (`node_modules`, `.env`). Like Claude Code and Codex, we don't copy them: the project ships a committed `.karbun/setup.sh` (falling back to Codex's `.codex/setup.sh`, with `CODEX_WORKDIR` exported), run in a visible terminal tab on creation. It is deliberately not awaited — the agent starts while the install races alongside it.

Removal mirrors Claude Code: unforced `git worktree remove` + `branch -d`, so git itself refuses to destroy uncommitted or unmerged work; the confirm dialog reports what's at risk and only then offers a force. A worktree shared by more than one chat is never removed with one of them.

Because everything is cwd-parameterized, the existing GitPanel ladder (commit → push → `gh pr create`) already works from inside a worktree.

The **Environment menu** (`EnvironmentMenu.tsx`, in the context strip of an open chat) collects what you can do to a chat's environment: review changes, the `resolveGitActions` ladder (same resolver the source-control button uses, so labels and availability aren't duplicated), and — for worktree chats — **Continue in local checkout**. That hand-off (`handOffWorktree`) removes the worktree and checks its branch out in `repoRoot`; order is forced, since git won't check out a branch another worktree holds. It refuses while the worktree is dirty, because removal would take uncommitted work with it. Afterwards main disposes the session so the next send respawns in the new cwd — the same reason an effort change disposes.

## Provider integration

Keep provider behavior behind `AgentSession` and normalize it into `ChatEvent`. Claude has native per-tool permissions and `ExitPlanMode`; Codex maps permission choices to sandbox policies and synthesizes the same plan-review event so the renderer remains provider-neutral.

A plan approval may carry a `model` (`PermissionDecision`) — the plan review's "Build with" picker — so one model can plan and another implement, Cursor-style. Each session applies it at approval time: Claude fires the live `setModel` *before* resolving the approval (both ride the CLI's stdin, so ordering guarantees the implementation turn starts on the new model); Codex sets `chat.model` before building the implementation turn, which snapshots it. The picker only offers the chat's own provider — sessions aren't portable across backends.

Codex's `workspace-write` sandbox carves `.git` out as read-only, and it resolves a worktree's `.git` *pointer file* to the shared gitdir and carves that out too — so a worktree creates no Claude/Codex asymmetry that a plain checkout doesn't already have. If that ever changes, the escape hatch is `additionalDirectories` on the SDK's `ThreadOptions` (forwarded as `--add-dir`).

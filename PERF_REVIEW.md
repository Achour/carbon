# Performance Review — 2026-07-17

Four parallel Opus 4.8 review agents (main process, renderer store, React components, end-to-end streaming/persistence). Findings verified against the code; deduplicated and ranked.

## High

- **`src/renderer/src/store.ts:430`** — `updateAssistant` does `messages.findIndex` from the front on every streamed event (`part-delta`, `part`, `tool-update`), but the streaming assistant is always the last message. Per-token cost grows linearly with conversation length.

## Medium

- **`src/renderer/src/components/GitPanel.tsx:537` + `MultiDiffView.tsx:60`** — Both subscribe to the whole `messages` array, so they re-render on every token; GitPanel additionally passes fresh `changes.filter(...)` arrays that bust `ChangeTree`'s memo, rebuilding + recursively sorting the entire file tree per token while the panel is open.
- **`src/main/index.ts:49`** — `part`/`part-delta`/`tool-update` events for **all** chats are shipped over IPC, but the renderer discards them for non-active chats (and refetches on switch anyway). Background agents flood IPC with 100% wasted traffic.
- **`src/main/store.ts:195`** — Every debounced persist `JSON.stringify`s the entire chat (all messages + tool outputs) and rewrites the whole file; cost grows unboundedly with transcript length (~every 1.5–5s during streaming).
- **`src/main/claude.ts:1074`** — `terminalizeRunning` scans the entire transcript (recursing into all tool children) on every turn end → O(N²) over a long session.
- **`src/main/claude.ts:1309` / `src/main/codex.ts:1035`** — Sub-agent updates clone and re-send the parent's entire `children` array over IPC on every child event → O(k²) bytes for long-running Task cards.
- **`src/main/workspaceCheckpoint.ts:63`** — Full working-tree `git read-tree`/`add -A`/`write-tree` awaited **twice per Codex turn**; seconds of turn latency on large repos.
- **`src/renderer/src/components/messages/ToolCard.tsx:376` + `Parts.tsx:255`** — `ToolGroup` re-runs `toolMeta` (incl. `humanizeShellCommand`) for every part on each render; fresh `parts` array defeats its `React.memo`, so this fires per token for the live turn.
- **`src/renderer/src/store.ts:1627,1702`** — `message`/`meta` events rebuild and `.sort()` the whole `chats` array (even for background chats), re-rendering all sidebar subscribers when ordering hasn't changed.
- **`src/renderer/src/lib/useStableChanges.ts:25`** — `JSON.stringify(changes)` runs per render on the streaming hot path; unbounded work proportional to change-set size.

## Low

- **`src/main/store.ts:236`** — `flushAll` on quit rewrites every chat file regardless of dirty state; shutdown scales with total history size.
- **`src/main/codex.ts:159`** — Sync `readdirSync`/`statSync` over the whole OS tmpdir on first CodexSession creation blocks the main-process event loop.
- **`src/main/codex.ts:625`** — The full completed assistant message (incl. capped-100k tool outputs) is re-emitted over IPC a second time per turn just to attach `fileChanges`.
- **`src/renderer/src/components/ChatView.tsx:111`** (`lib/turnChanges.ts:42`) — `turnPresentations` walks all messages on each new-message commit → O(n²) per turn in long chats.
- **`src/main/git.ts:127`** — `gitStatus` spawns ~4 git processes + per-untracked-file reads; re-run on every return-to-idle.
- **`src/renderer/src/store.ts:1744`** — Idle transition triggers one IPC round-trip per open file/diff tab (refreshFiles/refreshGit bursts).
- **`src/main/codex.ts:486,214`** — Sync fs scans of the generated-images dir ~3×/turn; `checkpoints` map grows unpruned for session lifetime (small entries).
- **`src/renderer/src/components/FileViewer.tsx:75`** — Unmemoized `split('\n')` + gutter string rebuild per render for files up to 512KB.
- **`src/renderer/src/components/ChatView.tsx:259`** — Unthrottled `onScroll` forces layout reads per scroll event.

## Verified non-issues

Delta coalescing (~40–80ms, no timer leaks), `saveChatSoon` debounce semantics, `toolLoc` map pruning, idle-session cap, `MessageHistory` ref-memo, `StreamingMarkdown` 120ms cap, `latestTodoStore` isolation, rollout-watcher throttling, `walkProject` TTL cache — all checked and working as intended.

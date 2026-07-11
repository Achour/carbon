# AI GUI

A desktop GUI for coding agents. Claude Code today, Codex next.

Electron + React + Tailwind v4 + shadcn-style components on [Base UI](https://base-ui.com), talking to the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) from the Electron main process. Sessions use your existing Claude Code login and run locally in whatever folder you pick.

## Run

```sh
npm install
npm run dev
```

## Features

- Chats with history in the sidebar (stored in `~/Library/Application Support/ai-gui/chats/`)
- Live streaming responses, thinking blocks, collapsible tool cards
- Permission prompts in the UI (Allow / Always allow / Deny), permission modes per chat
- Model picker grouped by provider (Codex entries are placeholders for now)
- Sessions resume across app restarts via the Claude Code session id
- Light/dark theme

## Architecture

- `src/main` — Electron main process. `claude.ts` owns agent sessions (streaming input queue → Agent SDK `query()`), normalizes SDK messages into UI messages, and streams granular events to the renderer. `store.ts` persists chats/settings as JSON.
- `src/preload` — typed `window.api` bridge (contextIsolation on).
- `src/renderer` — React app. Zustand store applies chat events; components in `components/`, shadcn-style primitives on Base UI in `components/ui/`.
- `src/shared/types.ts` — the contract between all three.

Dev utility: `AIGUI_CAPTURE=/tmp/shot.png npm run dev` saves a window screenshot after load (used for UI iteration).

## Adding Codex (planned)

Implement a `CodexSession` next to `ClaudeSession` speaking `codex exec --json`, map its events into the same `ChatEvent` union, and enable the Codex entries in `MODEL_OPTIONS`.

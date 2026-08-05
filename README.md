# AI GUI

A desktop GUI for coding agents. Claude Code today, Codex next.

Electron + React + Tailwind v4 + shadcn-style components on [Base UI](https://base-ui.com), talking to the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) from the Electron main process. Sessions use your existing Claude Code login and run locally in whatever folder you pick.

## Install

Download the latest `.dmg` from [Releases](https://github.com/Achour/carbon/releases/latest) —
`-arm64` for Apple Silicon, `-x64` for Intel.

Carbon is not notarized (an Apple Developer account costs $99/yr, and this is a
free app), so macOS will refuse the first launch with *"Carbon is damaged and
can't be opened."* It isn't damaged — that message is what Gatekeeper says about
any app it can't trace to a paid developer certificate. Clear the quarantine flag
once, after dragging it to Applications:

```sh
xattr -cr /Applications/Carbon.app
```

The app checks GitHub for new releases on launch and every 6 hours, and shows a
banner in the sidebar when one is out. Updates are downloads, not in-place
installs — for the same reason: macOS won't apply an automatic update to an
unsigned app.

## Run from source

```sh
npm install
npm run dev
```

## Releasing

```sh
npm version 0.2.0 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which typechecks, tests, builds
both macOS architectures, and attaches the `.dmg` files to a GitHub Release.
Running installs pick it up from there — no separate publish step.

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

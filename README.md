# Carbon

A desktop app for Claude Code and Codex.

Both agents already run in your terminal. Carbon gives them a window: streaming
responses with collapsible tool cards, permission prompts you click instead of
type, a diff review beside the conversation, and — the part a terminal can't do
— more than one agent working at once, in isolated git worktrees, without them
stepping on each other.

It uses the login you already have. No API key, no extra subscription; Carbon
talks to the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
and the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) from the
Electron main process, and they reuse your existing Claude Code / Codex session.

## Install

Download the latest `.dmg` from [Releases](https://github.com/Achour/carbon/releases/latest) —
`-arm64` for Apple Silicon, `-x64` for Intel.

macOS will refuse the first launch with *"Carbon is damaged and can't be
opened."* It isn't damaged. That message is what Gatekeeper says about any app it
can't trace to a paid Apple Developer certificate ($99/yr), which this one
doesn't have. Drag it to Applications, then clear the quarantine flag once:

```sh
xattr -cr /Applications/Carbon.app
```

Carbon checks for new releases on launch and every 6 hours, and shows a banner in
the sidebar when one is out. Updates are downloads rather than in-place installs,
for the same reason — macOS won't auto-update an unsigned app.

## What it does

**Two providers, one conversation.** Claude and Codex are both first-class, and a
chat can switch between them mid-conversation — the outgoing model writes a brief
of the discussion so far, and the incoming one picks it up. Plan with one model,
implement with another.

**Parallel work in git worktrees.** Point a chat at a new worktree and it runs in
its own branch and directory, so several agents can work simultaneously without
colliding. Carbon creates the worktree, runs your `.karbun/setup.sh` in a visible
terminal, and offers the whole lifecycle when you're done: update from main, merge
into main, hand off to your local checkout, or clean up after a merged PR.

**Review without leaving.** A diff chip tracks what the turn changed; the review
pane carries a commit → push → `gh pr create` ladder that knows which rung you're
on. There's a file tree, an editor, a real terminal (node-pty), and a browser
preview that starts your dev server and can hand screenshots back to the agent.

**The rest.** Permission prompts with per-tool "always allow", plan mode with an
approve/edit review, checkpoint and rewind to any message, chat history that
survives restarts, MCP server status, usage and rate-limit tracking, light/dark
themes with macOS vibrancy.

## Run from source

```sh
npm install
npm run dev
```

Requires Node 22+ and a working `claude` or `codex` login.

```sh
npm run build      # production build to out/
npm run typecheck  # the primary verification gate — tsc over main+preload and renderer
npm test           # node --test over test/*.test.ts
npm run package    # build a local .dmg into dist/
```

## Architecture

Three Electron layers with one shared contract:

- **`src/shared/types.ts`** — the contract between all three. The `Api` interface
  (preload bridge), the `ChatEvent` union (main → renderer streaming), message and
  part types, the model list. Most features start here.
- **`src/main/`** — Electron main process. `index.ts` registers the IPC channels;
  `claude.ts` and `codex.ts` own agent sessions and normalize both providers into
  the same `ChatEvent`s; `store.ts` persists to SQLite; `worktree.ts`, `git.ts`,
  `files.ts`, `terminal.ts` sit behind their own channels.
- **`src/preload/`** — the typed `window.api` bridge, contextIsolation on.
- **`src/renderer/src/`** — React app. One zustand store holds UI state and
  reduces incoming events; shadcn-style primitives on [Base UI](https://base-ui.com);
  Tailwind v4.

Adding an IPC method touches four files: the `Api` interface, a handler in
`main/index.ts`, the bridge entry in `preload/index.ts`, and the renderer store.

`CLAUDE.md` / `AGENTS.md` carry the deeper notes — persistence invariants,
session flow, worktree design — for both humans and agents working in this repo.

## Releasing

```sh
npm version 0.2.0 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which typechecks, tests, builds
both macOS architectures and attaches the `.dmg` files to a GitHub Release.
Running installs pick it up from there — there's no separate publish step.

## Status

macOS only for now. The build config and the update check already handle Windows
and Linux artifacts; nobody has tested them.

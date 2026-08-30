# Carbon

A desktop app for Claude Code, Codex and Grok.

All three agents already run in your terminal. Carbon gives them a window:
streaming responses with collapsible tool cards, permission prompts you click
instead of type, an editor and a diff review beside the conversation, and — the
part a terminal can't do — several agents working at once, in isolated git
worktrees, without stepping on each other.

**Carbon spawns the CLIs you already have, and ships none of its own.** So the
agent running in the app is the one you keep current in the terminal, on the
login you already use — no API key, no extra subscription. Claude goes through
the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
Codex through the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk),
and Grok — which publishes no SDK — speaks [ACP](https://agentclientprotocol.com)
to the `grok` CLI. All three run in the Electron main process and normalize onto
one contract, which is what lets a chat switch providers mid-conversation.

## Install

```sh
brew install --cask achour/carbon/carbon
```

Then update in place:

```sh
brew update && brew upgrade --cask carbon
```

The `brew update` is load-bearing. Homebrew only re-pulls a tap once its last
auto-update is a day old, so a bare `brew upgrade` can read a stale copy of the
cask and tell you the latest version is already installed. Carbon recognizes a
Homebrew install and shows you that command in the sidebar when a release lands,
instead of a download link.

Homebrew won't load a cask from a third-party tap until you trust it. Installing
one by name counts as trusting it, so the line above is all you need — but a
read-only command like `brew info --cask carbon` will refuse until you've either
installed it or run `brew trust achour/carbon`.

**You also need at least one provider CLI, installed and logged in:**

| | Install | Log in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | run `claude` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Grok | `npm install -g @xai-official/grok` | run `grok` |

Any install route works — a version manager, Homebrew, a shell installer;
Settings → Providers shows what Carbon found and where. A provider you haven't
installed simply doesn't appear in the model picker. (`@xai-official/grok` is
xAI's own package. `@vibe-kit/grok-cli` is an unrelated third-party one whose
name reads like the official.)

<details>
<summary>Prefer a <code>.dmg</code>, or building from source?</summary>

`.dmg` builds are on [Releases](https://github.com/Achour/carbon/releases/latest)
— `-arm64` for Apple Silicon, `-x64` for Intel. They don't update in place, and
because they *are* downloaded, macOS refuses the first launch with *"Carbon is
damaged and can't be opened."* It isn't damaged; that's what Gatekeeper says
about any app without an Apple Developer certificate ($99/yr, and this is a free
app). Open it once via **System Settings → Privacy & Security → Open Anyway**, or
clear the flag:

```sh
xattr -cr /Applications/Carbon.app
```

Building it yourself avoids Gatekeeper entirely — an app you compiled was never
downloaded, so nothing prompts. See [Development](#development).
</details>

## What it does

**Three providers, one conversation.** Claude, Codex and Grok are all
first-class, and a chat can switch between them mid-conversation — the outgoing
model writes a brief of the discussion so far and the incoming one picks it up.
Plan with one model, implement with another.

**Parallel work in git worktrees.** Point a chat at a new worktree and it runs in
its own branch and directory, so several agents can work at once without
colliding. You pick the branch — an existing one, or a name typed into the same
box that searches them. Carbon creates the worktree, runs your `.karbun/setup.sh`
in a visible terminal, and offers the whole lifecycle when you're done: update
from main, merge into main, hand off to your local checkout, or clean up after a
merged PR.

**An editor, not just a viewer.** The file tree opens into CodeMirror with real
editing, syntax errors without a language server, and ⌘-click to a definition
through whichever server your project already has — a TypeScript 7 project needs
nothing installed at all, since its compiler *is* the server. ⌘P by name, ⌘F
inside a file, select lines and send them to the chat as a quotable reference.

**Review without leaving.** A diff chip tracks what each turn changed, and a card
at the end of the turn names the files. The review pane stacks every changed file
in one scroller, folded down to what moved and expandable back out to the whole
file, and carries a commit → push → `gh pr create` ladder that knows which rung
you're on — including publishing a project that has no remote yet.

**The rest.** Permission prompts with per-tool "always allow", plan mode with an
approve/edit review and a "build with" picker, checkpoint and rewind to any
message, a roster of every agent a fan-out spawned with its model and token
count, a usage page reading the CLIs' own logs for what you spent by provider,
model and day, a real terminal, a browser preview that starts your dev server and
can hand screenshots back to the agent, MCP server status, alert sounds, and
light/dark themes with macOS vibrancy.

## Development

**Requires Node 24+** (the app itself doesn't — that's what the cask is for).

```sh
git clone https://github.com/Achour/carbon
cd carbon
npm install
npm run install-app   # builds and puts Carbon.app in /Applications
```

`git pull && npm install && npm run install-app` updates that build. An app you
compiled yourself never meets Gatekeeper, so this route prompts for nothing —
but it doesn't auto-update, and neither does the `.dmg`; only the cask does.

```sh
npm run dev        # hot-reloading dev window
npm run typecheck  # the primary verification gate
npm test           # node --test over test/*.test.ts
npm run package    # build Carbon.app into dist/ without installing it
```

<details>
<summary>If <code>npm install</code> fails on <code>node-pty</code></summary>

Carbon's terminal uses node-pty, which compiles through node-gyp, which still
imports Python's `distutils` — removed from the standard library in Python 3.12.
Give it the compatibility shim:

```sh
python3 -m pip install --break-system-packages setuptools
npm run rebuild
```
</details>

Three Electron layers with one shared contract:

- **`src/shared/types.ts`** — the contract between all three. The `Api` interface
  (preload bridge), the `ChatEvent` union (main → renderer streaming), message and
  part types, the model list. Most features start here.
- **`src/main/`** — Electron main process. `index.ts` registers the IPC channels;
  `claude.ts`, `codex.ts` and `grok.ts` own agent sessions behind the one
  `AgentSession` interface in `session.ts` and normalize all three providers into
  the same `ChatEvent`s; `providerCli.ts` finds the binaries; `store.ts` persists
  to SQLite; `worktree.ts`, `git.ts`, `github.ts`, `files.ts`, `lsp.ts`,
  `terminal.ts` and `preview.ts` sit behind their own channels.
- **`src/preload/`** — the typed `window.api` bridge, contextIsolation on.
- **`src/renderer/src/`** — React app. One zustand store holds UI state and
  reduces incoming events; shadcn-style primitives on [Base UI](https://base-ui.com);
  Tailwind v4.

Adding an IPC method touches four files: the `Api` interface, a handler in
`main/index.ts`, the bridge entry in `preload/index.ts`, and the renderer store.

`CLAUDE.md` / `AGENTS.md` carry the deeper notes — persistence invariants, session
flow, the provider seam, worktree design — for both humans and agents working in
this repo.

## Releasing

```sh
npm version 0.2.0 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which typechecks, tests, builds
both macOS architectures, attaches the `.dmg` files to a GitHub Release, and
bumps the cask in [Achour/homebrew-carbon](https://github.com/Achour/homebrew-carbon).

That last step needs a `TAP_DEPLOY_KEY` repository secret — the private half of a
write-enabled deploy key on the tap, since the workflow's own token only reaches
this repo. Without it the step skips itself: the release still succeeds and the
cask goes un-bumped.

## Status

macOS only. The build config and update check already handle Windows and Linux
artifacts; nobody has tested them.

## License

[MIT](LICENSE)

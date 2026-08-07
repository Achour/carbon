# Carbon

A desktop app for Claude Code and Codex.

Both agents already run in your terminal. Carbon gives them a window: streaming
responses with collapsible tool cards, permission prompts you click instead of
type, a diff review beside the conversation, and — the part a terminal can't do
— several agents working at once, in isolated git worktrees, without stepping on
each other.

It uses the login you already have. No API key, no extra subscription; Carbon
talks to the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
and the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) from the
Electron main process, and both reuse your existing Claude Code / Codex session.

## Install

**Requires:** macOS, Node 24+, and a `claude` or `codex` login you can already use.

```sh
git clone https://github.com/Achour/carbon
cd carbon
npm install
npm run install-app
```

That builds Carbon and puts it in `/Applications`. Open it from Spotlight.

Building locally is the recommended path because macOS never questions it.
Carbon isn't signed with an Apple Developer certificate ($99/yr, and this is a
free app), and Gatekeeper blocks *downloaded* apps that aren't — but an app you
built on your own machine was never downloaded, so nothing prompts.

To update:

```sh
git pull
npm install
npm run install-app
```

Carbon tells you when there's a new version — a banner in the sidebar, and
Settings → About → Check for updates.

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

### Homebrew

```sh
brew install --cask achour/carbon/carbon
```

Homebrew won't load a cask from a third-party tap until you trust it. Installing
one by name counts as trusting it, so the line above is all you need — but a
read-only command like `brew info --cask carbon` will refuse until you've either
installed it or run `brew trust achour/carbon`.

The cask clears the quarantine flag after installing, so this route skips the
Gatekeeper prompt the raw `.dmg` gets — and it's the only one that updates in
place:

```sh
brew update && brew upgrade --cask carbon
```

The `brew update` is load-bearing. Homebrew only re-pulls a tap once its last
auto-update is a day old, so a bare `brew upgrade` can read a stale copy of the
cask and tell you the latest version is already installed.

Carbon recognizes a Homebrew install and shows that command in place of a
download link when a new version lands.

### Prebuilt download

There are `.dmg` builds on [Releases](https://github.com/Achour/carbon/releases/latest)
if you'd rather not build — `-arm64` for Apple Silicon, `-x64` for Intel. Because
these *are* downloaded, macOS will refuse the first launch with *"Carbon is
damaged and can't be opened."* It isn't damaged; that's what Gatekeeper says
about any unsigned app. Open it once via **System Settings → Privacy & Security →
Open Anyway**, or clear the flag from a terminal:

```sh
xattr -cr /Applications/Carbon.app
```

## What it does

**Two providers, one conversation.** Claude and Codex are both first-class, and a
chat can switch between them mid-conversation — the outgoing model writes a brief
of the discussion so far and the incoming one picks it up. Plan with one model,
implement with another.

**Parallel work in git worktrees.** Point a chat at a new worktree and it runs in
its own branch and directory, so several agents can work at once without
colliding. Carbon creates the worktree, runs your `.karbun/setup.sh` in a visible
terminal, and offers the whole lifecycle when you're done: update from main, merge
into main, hand off to your local checkout, or clean up after a merged PR.

**Review without leaving.** A diff chip tracks what each turn changed; the review
pane carries a commit → push → `gh pr create` ladder that knows which rung you're
on. There's a file tree, an editor, a real terminal, and a browser preview that
starts your dev server and can hand screenshots back to the agent.

**The rest.** Permission prompts with per-tool "always allow", plan mode with an
approve/edit review, checkpoint and rewind to any message, chat history that
survives restarts, MCP server status, usage and rate-limit tracking, light/dark
themes with macOS vibrancy.

## Development

```sh
npm run dev        # hot-reloading dev window
npm run typecheck  # the primary verification gate
npm test           # node --test over test/*.test.ts
npm run package    # build Carbon.app into dist/ without installing it
```

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

`CLAUDE.md` / `AGENTS.md` carry the deeper notes — persistence invariants, session
flow, worktree design — for both humans and agents working in this repo.

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

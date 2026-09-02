# The screenshot profile

Every screenshot on the README and on [achour.dev/carbon](https://achour.dev/carbon)
is taken from a real build of Carbon driven against a seeded profile — three
small repositories, ten chats, one real transcript. Nothing here is a mock-up:
the rows go through the same components as yours. What it buys is a sidebar with
no client's name in it, and a conversation that says the same thing every time
the shots are refreshed.

```sh
./demo/setup.sh                              # build demo/projects and demo/worktrees
AIGUI_USERDATA=demo/userdata npm run dev     # once, so the app writes the schema, then quit
node demo/seed.mjs                           # write the chats
./demo/shoot.sh /tmp/hero 9000 demo/e2e/hero.js
```

- **`repos/`** — each project at HEAD, plus a `.patch` holding its uncommitted
  working tree. A repo with changes in it is the whole point of the review and
  diff shots, and a patch is the only way to carry "modified but not committed"
  through a commit. `setup.sh` turns these back into git repositories (and the
  one worktree) under `projects/` and `worktrees/`, both gitignored — they are
  generated, and nesting three repositories inside this one is worse than
  regenerating them.
- **`seed.mjs`** — writes the chats straight into `userdata/chats.db`. Run it
  only while the app is **closed**: it would otherwise fight the per-chat `locks`
  row. Only the active chat's messages are ever rendered, so exactly one chat
  carries a transcript and the rest are metadata, which is all a sidebar row
  reads.
- **`shoot.sh`** — launches the app against the profile with `AIGUI_CAPTURE` and
  `AIGUI_E2E`, then kills the whole process group. **Killing `npm run dev` does
  not stop the app**: Electron is its grandchild and is reparented to launchd the
  moment npm dies, so a naive loop silently stacks up one running instance per
  shot, each heartbeating advisory locks against this profile. The script asserts
  nothing survived and fails if anything did.
- **`e2e/`** — one script per shot, in the renderer, clicking its way to the
  state being photographed. `probe-tabs.js` is a plain inspector rather than a
  shot, and so is `stream-probe.js`: it pumps a Claude-shaped and a Codex-shaped
  turn through the real `applyEvent` reducer at a model's pace and reports frame
  timing, reducer cost per delta, and whether a finished reply or a settled tool
  row keeps its DOM across the moments it stops being live — the numbers behind
  the "Smooth streaming" section of `CLAUDE.md`. `foot-probe.js` does the same
  for the "Thinking…" / "Working…" label at the foot, in both shapes.
  `real-turn-probe.js` sends a *real* prompt through the chat named in it (full
  access, so nothing waits on a permission) and reports the same frame numbers
  plus every entrance animation that replayed — pair it with `AIGUI_PROFILE` to
  see what a long task was doing. It spends real tokens.

The appearance mode is persisted in `settings.json`, so a script that wants dark
sets it explicitly; otherwise the previous shoot decides what this one looks
like.

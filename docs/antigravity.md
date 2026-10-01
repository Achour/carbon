# Antigravity (`src/main/antigravity.ts`, `antigravityAcp.ts`, `antigravityInstall.ts`, `acpRpc.ts`)

The fourth provider, and the second that speaks ACP. Read this before changing
any of the four files; the reasons below were each measured or read off the
server's own source, and the obvious alternatives were tried first.

## Why the ACP server and not `agy`

The user's `agy` CLI (1.2.x) is the natural thing to drive, and it is wrong for
Carbon. Its only programmatic surface is `--print` with
`--input-format stream-json --output-format stream-json`. That stream is good
— `init`, `step_update` events with `text_delta`s, tool steps, a `result` —
but **headless mode cannot prompt**. A tool that needs approval is auto-denied,
and the CLI says so on stderr: *"a tool required the "command" permission that
headless mode cannot prompt for, so it was auto-denied."* So Ask mode and Accept
edits would be impossible, leaving only `--dangerously-skip-permissions`. It
also takes no per-session MCP servers, so Carbon's `carbon` tools (canvas,
preview) could not reach it. `agy` has no ACP mode either (its issue #31 asks for
one).

Google ships the ACP agent separately, as `agy_acp_server`, through the
[ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
That is what Zed and T3 Code run, and it has everything the CLI's stream lacks:
`session/request_permission`, `mcpCapabilities.http`, `session/resume`, live
modes and models, and image prompts.

## The install exception

Carbon ships no CLI, and this does not change that. Nothing is bundled. The
server downloads only when the user presses **Install** in Settings → Providers,
from the registry's own entry (the archive Zed fetches), into
`userData/providers/antigravity/<version>/`. A registry bump reaches users
without a Carbon release, which is the point of "use the user's install".

The exception exists because Google publishes no package or installer for this
binary. Resolution still goes env (`CARBON_ANTIGRAVITY_PATH`) → PATH → known
locations, and the known locations are Carbon's managed folder and **Zed's
registry download**. Someone who already runs it from Zed gets no second copy.

Two guards in `antigravityInstall.ts`:

- **Only `https://dl.google.com` archives are accepted**, whatever the registry
  says. The registry is a GitHub repo, and this keeps a bad commit to it from
  pointing Carbon at a binary from anywhere else.
- **Unpacking is atomic.** The archive unpacks to `<version>.partial` and is
  renamed into place, so resolution can never find a half-written binary. The
  extract uses the system `unzip` (bsdtar on Windows) rather than a dependency.

The server has no `--version`. Every place it is installed names its directory
for the version, so `readVersion` reads the directory name.

## Sign-in is the server's own

The server's Google login is **separate from `agy`'s**. It runs its own
loopback OAuth (`authenticate` with `oauth-personal`), records the method in
`~/.gemini/antigravity-acp/settings.json`, and keeps the token in the macOS
keychain. Later processes skip `authenticate` entirely.

- **Carbon opens the link, not the server.** The server uses Python's
  `webbrowser`, which `BROWSER=true` turns into a no-op (except on Windows).
  The link is parsed off stderr (`parseAuthUrl`) and opened through
  `shell.openExternal`. That way the Settings row can say what is happening,
  rather than a tab appearing from nowhere.
- **The server's own deadline is five minutes.** After that `authenticate`
  answers "Onboarding failed: Timed out…".
- **A send works without a trip to Settings.** A session that gets
  "Authentication required" (`-32000`, `isAuthRequired`) signs in on the spot
  (`withSignIn`), and the turn waits on the browser.
- **The Settings status costs a spawn.** `antigravityAuthState` asks the server
  for a session in a temp folder, measured at ~4.5 s. So only the Antigravity
  row asks, and only when it is open.

## Shapes, read off the 1.2.1 server's source

The `.par` is a frozen Python app whose source is embedded as text, so
`strings` on the binary gives the real adapter (`class AgyAdapter`). That is
where these came from, rather than from the ACP schema:

- **Modes move live, so nothing respawns.** The modes are `default`,
  `auto_edit` and `yolo`, set through `session/set_config_option`
  (`configId: 'mode'`). The model moves the same way (`configId: 'model'`): the
  server rebuilds its agent and keeps the history. Unlike Grok, there is no
  options key and no restart.
- **Plan mode is the `/plan` command.** There is no plan mode, only a `/plan`
  slash command. Carbon prefixes it (`withPlanCommand`) and, like Codex, raises
  its own review from the finished turn. The plan is a `plan*.md` artifact the
  turn wrote under `brain/<session>/`, or else its last answer. The review is
  skipped when the turn answered a question or edited a file (`turnActed`),
  because `/plan` "awaits user approval" through the server's own question
  prompt. If the user said yes there, the turn has already built the plan, and
  offering its summary as a plan would ask for a second implementation.
- **Tools have no name on the wire.** A call is a `title` plus a `kind`: the
  title reads "Run edit_file?" while it waits for permission and "Running
  view_file" once it runs, and a shell call's title is the command itself.
  `agyToolName` recovers the wire name and maps it to the renderer's
  (`Read`/`Edit`/`Bash`). An MCP tool the server calls *natively* arrives the
  same way — "Running preview_status", no `_meta`, no server prefix, and a
  `rawOutput` that is the call's purpose ("Call carbon preview_status") rather
  than its result — so Carbon's own are recognized by their `preview_` /
  `canvas_` names. MCP calls carry `_meta.mcp.{server,tool}`, which is
  how `carbon_canvas_write` becomes `mcp__carbon__canvas_write`. The closing
  update carries only `rawOutput` and a status. A shell call's `rawOutput` is
  `{ combinedOutput, exitCode }`.
- **A permission prompt and its execution share one row.** The server opens a
  `pending` `tool_call` before asking, then moves that same id to
  `in_progress`. So the card exists before the prompt does.
- **Questions ride the permission method.** They arrive on a synthetic
  `interaction_<hex>` tool call whose options are the answers, not allow/deny.
  `isAgyQuestion` routes them to the question card. Throwaway sessions answer
  them yes, because a first-run workspace-trust prompt is one of them.
- **The server reports no usage and no titles.** The prompt reply is a bare
  `stopReason`, and there is no usage or `session_info` update. Turn cards
  show duration only. The Usage page excludes Antigravity (`UsageProvider`)
  because its SQLite trajectories carry no token counts to scan.
- **Models are `gemini-*` only.** The catalog filter drops everything else, so
  `knownProviderForModel` places that prefix. Effort is part of the model id
  (`…-high` / `-medium` / `-low`), so `PROVIDER_EFFORTS.antigravity` is empty
  and the composer hides the Reasoning menu.
- **Throwaway sessions leave files.** Model probes and one-shots need a real
  `session/new`, which writes `conversations/<id>.{db,meta}`.
  `removeAgyConversation` deletes them, guarded on the sidecar's `cwd` matching
  the temp folder.

- **A background command closes after its turn.** At `end_turn` the server
  parks shell calls that are still running (`persisted_open_tool_calls`) and
  sends their terminal `tool_call_update` when they finish. So `finishTurn`
  keeps the running entries in `toolLoc`, and `handleUpdate` lets an idle
  `tool_call_update` through for those ids only.

## Google's backend fails, and the server retries

Measured on a free-tier account (`loadCodeAssist` reports `free-tier`): the
model backend intermittently answers `500 INTERNAL` or `503 No capacity
available for model gemini-3.8-flash-high`, **with or without images in the
conversation**. Five runs of one three-step turn with no image hit it in two;
an earlier guess that a full-size preview screenshot caused it did not survive
that baseline. The server's harness retries ("retryable api error, retrying in
4s"), and three shapes reach the client:

- **The open tool fails** with `rawOutput` "Encountered retryable error from
  model provider…" (`isAgyRetryNotice`). The step never ran, so its row says so,
  and the text that attempt streamed is emptied (`dropAbandonedText`).
- **The retry re-streams the answer from its first word**, sometimes with no
  notice at all. A chunk that opens with the words the part already opens with
  replaces the part (`agyRestartsText`), or the abandoned half prints glued to
  the new answer.
- **Spent retries end the turn with an agent message**, "Agent execution error:
  Error 503, …", not an error. `agyExecutionError` turns it into an error card
  that says it is Google's side.

## What has and hasn't run

Against the real server, signed in: turns with the `carbon` MCP tools
(preview status, navigate, screenshot), file reads, model and mode changes
over `session/set_config_option`, and the failures above. The rest — Ask and
Accept edits prompts, questions, interrupt, `/plan` review → approve →
implement, the signed-out row and Settings sign-in — ran in the dev app against
a stand-in server emitting these shapes. Not yet run:

- **The in-chat sign-in** (`withSignIn`): a send while signed out.
- **`turnActed`'s positive path**: a `/plan` turn that edits or asks, which
  should raise no review.
- **A turn whose close arrives after `end_turn`** (above).

Also, a fresh folder's first turn may raise the workspace-trust question. If
that turn is a `/plan`, answering it suppresses the review, once per folder.

## A signed-out account is a row, not an absence

An installed server with nobody signed in returns no models. Answered with
`[]`, the renderer's `hasCompleteModelCatalog` would never be satisfied, and
the picker would offer nothing with no reason given. So the probe returns one
**disabled** row, "Sign in with Google in Settings → Providers". Signing in or
installing drops the provider's cached catalog in main (`forgetCatalog`) and in
the renderer (`refetchProviderModels`).

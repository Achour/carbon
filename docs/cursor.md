# Cursor (`src/main/cursor.ts`, `cursorSdk.ts`)

The fifth provider, and the first that is **not a CLI Carbon spawns**. It runs
on Cursor's official TypeScript SDK, `@cursor/sdk`. Read
this before changing either file. Every shape below was measured against a real
Plus account on SDK 1.0.37; the obvious alternatives were tried first.

## Why it ships, when nothing else does

Carbon ships no CLI (CLAUDE.md, "Provider CLIs"), and this is the one exception,
for a reason that does not apply to the others: **the SDK is the agent
runtime itself**. It runs inside Carbon's main process. Tools execute there, and
it spawns its own sandbox helper (`cursorsandbox`), `rg` and tree-sitter from a
per-platform sibling package, `@cursor/sdk-darwin-<arch>`. There is no
installed Cursor binary for Carbon to drive instead. The `cursor-agent` CLI
speaks ACP, but the request here was the SDK.

- **`providerCli` resolves the package, not a binary.** The source is `bundled`,
  the path is the package folder, and the version comes from its manifest
  (`cursorSdkPackage`). It is never looked up on PATH.
- **The SDK loads on first use** (`loadCursorSdk`), not at import time: it is
  ~10 MB of bundled JavaScript. In practice the first use is the model-catalog
  warmup shortly after launch, and the import itself measured ~65 ms.
- **The helpers live in `Carbon.app/Contents/node_modules`, not beside the
  SDK.** The SDK finds `@cursor/sdk-<platform>-<arch>` only by walking up from
  `argv[1]` and from `process.execPath` (`platform-package-locator.ts` in its
  bundle). A packaged app's `argv[1]` is not its entry script, and the execPath
  walk passes `Contents/MacOS`, `Contents`, `Carbon.app`, never `Resources/app`.
  Dev works only because Electron's binary sits inside the repo's
  node_modules. electron-builder's collector also skips optional dependencies,
  so the first package build simply had no helpers. `extraFiles` copies each
  dmg's own arch there now. Verified by running a sandboxed shell call through
  the packaged binary (`ELECTRON_RUN_AS_NODE=1 …/MacOS/Carbon`), and
  `codesign --verify --deep --strict` passes.
- **Both arches' helpers must be on disk to package.** npm installs only the
  host's platform package, and one Apple Silicon runner builds both dmgs.
  `scripts/cursor-sdk-platforms.mjs` fetches the other one with `npm pack`
  (`npm run package` and the release workflow both run it). The afterPack hook
  warns when an app is missing its own. The helpers carry Cursor's own
  Developer ID signatures.

## Sign-in is the SDK's own

The editor's login does not carry over. `Cursor.auth.login` sends the browser to
cursor.com, which mints a named, **90-day API key** ("Carbon" in the
dashboard). The SDK stores the key in `~/.cursor/sdk/auth.json`, which is
shared with every other SDK client on the machine. `CURSOR_API_KEY` in the
environment overrides it, and the SDK reads that first. Sign-out only forgets
the key locally; it stays valid until it expires or is revoked in the dashboard,
and the Settings row says so.

- **A send works without a trip to Settings.** An auth error at open or send
  signs in on the spot (`withSignIn`), and the turn waits on the browser,
  following Antigravity's rule.
- **A signed-out account gets a disabled row, not `[]`.** That keeps the
  picker's catalog complete, again following Antigravity's rule.

## The model catalog is the plan's

`Cursor.models.list()` returns only what the plan allows. For this Plus account
that was Composer 2.5 and Grok 4.5 / 4.6 / 4.7.

- **Every fixed parameter must be sent.** `{ id: 'composer-2.5' }` alone was
  refused: *"Model unavailable on Plus … with fixed settings"*. With the default
  variant's `fast: false` it ran. `cursorModelSelection` sends the whole default
  variant, then replaces effort and Fast only with values the catalog lists.
- **`default` is refused too.** The SDK's own default selection answered
  *"Cannot use this model: default"*, so `cursor/default` is Carbon's sentinel.
  It resolves to Composer when the plan has it, otherwise to the first row.
- **Ids are namespaced: `cursor/<id>`.** The catalog uses other labs' names
  (`grok-4.6` is a row in Grok's own static catalog; Claude and GPT ids appear
  for other plans). Bare, they would be placed on another backend by every
  shape rule in `knownProviderForModel`, and `dropForeignModel` would strip them
  from a Cursor chat. `cursorWireModel` strips the prefix at the SDK boundary,
  and a delegate's bare id gets the prefix in `ChatManager.delegate`.
- **Effort and Fast are per model.** The effort parameter is spelled `effort` on
  some models and `reasoning_effort` on others. A model offering one effort
  value gets `supportedEfforts: []`, so the composer shows no Reasoning menu.

## No approval prompts exist

The SDK has no permission callback, so Ask cannot exist. The permission axis is
the **sandbox** (on/off) plus Cursor's **Auto-review** classifier. Both are agent
options fixed at `Agent.create` / `Agent.resume`, so a mode change reopens the
agent at the next turn (`ensureAgent`), keeping its history.

| Carbon mode | Sandbox | Auto-review | `send` mode |
|---|---|---|---|
| Sandboxed (`acceptEdits`) | on | off | agent |
| Auto-review (`auto`) | on | on | agent |
| Plan | on | off | plan |
| Full access | off | off | agent |

A chat carrying `default` (from another provider, or a delegate inheriting
Ask) runs sandboxed, the most restrictive mode that can run.

**The user's own MCP servers do not work under the sandbox.** `settingSources`
loads `~/.cursor/mcp.json`, but the SDK refuses every MCP-server call while the
sandbox is on (see the next section). Carbon's tools avoid this as callbacks;
the user's servers cannot. They work in Full access only.

**Auto-review is measured to run, not to classify.** A sandboxed turn with
`autoReview: true` completed a shell call normally. Whether the classifier
engaged is up to the account ("when the connected backend has the Auto-review
classifier feature enabled", per the SDK's own doc comment), and no turn has
shown it blocking anything. The mode's description says "where your plan has
it" for that reason.

**The SDK decides once per process whether sandboxing works.** An unsandboxed
agent opened first records "unsupported", and every sandboxed run after it is
refused. `primeSandbox` warms and releases a sandboxed
workspace before the first agent of either kind.

## Carbon's tools are callbacks, not an MCP server

Every other HTTP provider connects to `carbonBridge` as an MCP server. Cursor
cannot: **with the sandbox on, it rejects every MCP-server call**, measured:
*"Local SDK runs cannot request interactive approval for this MCP tool call."*
In-process callbacks (`local.customTools`) are the one kind it exempts. So
`CarbonMcpSession` grew `tools()` and `call()`, which run through the bridge's
own `answer`. Plan-mode refusals and the delegation check therefore cannot
differ from the HTTP path. The SDK serves those callbacks as a server called
`custom-user-tools`, which `cursorToolName` renders as `mcp__carbon__…`.

Measured: a sandboxed turn's `chart_render` was refused twice over HTTP MCP.
After the switch, the same call succeeded and the chart drew inline.

## Stream shapes

Only `onDelta` is consumed. It carries everything; `run.stream()` repeats it as
whole messages.

- `text-delta` / `thinking-delta` stream text. `thinking-completed` also arrives
  *between text chunks* (with ~1 ms), so it ends only a thinking slot.
  `step-completed` ends any slot.
- **Tool calls** come as `partial-tool-call` (args growing), then
  `tool-call-started`, then `tool-call-completed` with
  `result: { status: 'success', value } | { status: 'error', error }`. The kind
  is `toolCall.type`: `read`, `shell`, `edit`, `updateTodos`, `createPlan`,
  `task`, `grep`, `glob`, `mcp` and others, mapped in `cursorToolName` /
  `cursorToolInput` / `cursorToolOutput`.
- **`edit` carries only a path in its args.** The change arrives on the result as
  `diffString`, a unified diff that the Edit card draws through the same
  `changes[].diff` path as Codex's patches. A new file's diff starts at
  `--- /dev/null`.
- **`updateTodos` args are a merge.** A second call names only what changed,
  while the successful result carries the whole list, so the result wins
  (`cursorTodos`). Statuses are camelCase (`inProgress`).
- **A subagent (`task`) streams its own deltas** as `tool-call-delta` with a
  nested `taskUpdate` on the parent call id. `CursorChildStream` turns them into
  the `Agent` card's children, emitted on a trailing 250 ms window.
- **`turn-ended` carries the turn's usage** (input, output, cache read/write).
  This is cumulative over the turn's model calls, so it is shown on the turn
  card and not used as context occupancy.
- **A cancel mid-tool leaves the call open.** The shell's `tool-call-started`
  never gets a completion, so `finishTurn` settles every open call.

## Plan mode

`mode: 'plan'` on the send. The turn ends in a `createPlan` tool call whose
`args.plan` is the plan as markdown, streamed through `partial-tool-call`.
Carbon raises its own review from it when the turn finishes, persisted like
Codex's, Grok's and Antigravity's. Approval restores the pre-plan mode and
starts a new turn in agent mode with the plan text, because there is no
suspended turn to release. A plan-mode turn without a `createPlan` (a
clarifying question) raises no review.

## Things to know

- **Concurrent processes share one local store; concurrent agents do not
  clash.** The SDK keeps agents in a SQLite store, and two *processes* touching
  it at once got *"database is locked"*, so running dev and packaged Carbon on
  Cursor chats at the same moment can hit this. Two agents running at once in
  *one* process (threads, delegates) both finished, measured.
- **A handoff brief leaves an agent record.** `generateCursorText` runs
  `Agent.prompt` in a temp folder, and the SDK keeps that agent in its store.
  Antigravity cleans its throwaways up; this one has no delete for local
  agents.
- **The SDK logs at INFO to main's stdout** (rules, skills loading). That is
  noise in the dev terminal, not an error.
- **`settingSources` must be passed.** Omitted, the SDK loads none of the
  user's rules, skills or MCP config. Carbon passes all five.
- **`agent.getUsage()` is refused on this account** (`feature_unavailable`), so
  nothing reads it.
- **No fork or rollback** in the SDK, so edit-and-resend replays the kept turns
  into a fresh agent (`CONVERSATION_FORKS.cursor`).
- **Resume** is `Agent.resume(agentId, options)` with the full options rebuilt.
  An agent the store no longer has falls back to a fresh one, as Antigravity's
  does.
- **A run left "active" by a crashed process** blocks the next send ("already
  has active run"). `sendOnce` cancels the stale run and retries once.

## What has and hasn't run

Against the real SDK and a signed-in Plus account, in the dev app (`AIGUI_E2E`):
- the provider row, sign-in state and catalog;
- a sandboxed turn with Read, shell, todos, an Edit diff and `chart_render`;
- a resumed follow-up that remembered the earlier change;
- plan → review → approve → implementation in Sandboxed;
- an interrupt mid-command (the shell row reads "Interrupted.");
- a Full-access turn on the Default row (resolved to Composer) calling
  `chart_render`;
- Settings → Providers → Cursor.

Plus the packaged arm64 binary running a sandboxed shell call, Auto-review and
two concurrent agents through the SDK directly, and the probes behind every
shape above.

Not yet run:
- the in-chat sign-in (`withSignIn`), i.e. a send while signed out;
- Settings sign-in and sign-out from the button (the login itself ran through
  the same `Cursor.auth.login`);
- delegation to Cursor, and the handoff brief (`generateCursorText`);
- image attachments;
- resume after an app restart (resume across two processes did run);
- live `shell-output-delta` (no run has sent one);
- an Intel Mac.

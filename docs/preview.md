# The browser preview

The right panel's preview tab: a `<webview>` showing the project's dev server,
and the `preview_*` tools on the `carbon` MCP server that let the agent use it.
`BrowserPane.tsx` is the tab, `lib/previewCommands.ts` + `lib/previewRegistry.ts`
answer main's requests about panes, `main/preview.ts` owns the dev servers,
`main/previewDriver.ts` drives the page over CDP, `main/previewPage.ts` is the
script that runs inside the page, and `main/previewTools.ts` is the tool table.

## Who does what

**Main does everything inside the page; the renderer answers for what it owns.**
The `<webview>`'s own methods are enough for a toolbar, but they cannot send a
*trusted* input event, read the network, or emulate a device —
`webContents.debugger` can, and it lives in main. So each pane hands its guest to
main on `dom-ready` (`previewGuestAttach`, idempotent per guest), main attaches
CDP and starts recording console and network, and every agent tool runs there.
The renderer is asked (`PreviewCommand`) only for: which pane is this project's
(`ensure`), loading a URL in it, its pixels (`screenshot`, `reveal`/`conceal`)
and its viewport.

**Console and network are recorded from attach, whoever started the server.**
They used to be forwarded by the renderer only when *Carbon* had started the dev
server, and only for lines that looked like errors — so a server from the user's
terminal produced an empty `preview_console`, and a `console.log` the agent
added to debug something never came back. `PreviewLog` keeps a cursor *per
caller* (the chat id): a read answers "what is new since you last looked", and
two chats on one project do not consume each other's lines.

## The agent's tools

`snapshot` is the centre of it: the page as text — headings, text runs, and
every interactive element with a ref (`[ref=e12]`), its value and state — plus
any console errors and failed requests since the last snapshot. `click`,
`type`, `press`, `scroll` and `wait_for` take those refs (or a selector, or
visible text). A ref is a `WeakMap` entry in the page, so an element keeps its
ref across snapshots, and a ref whose element left the DOM says so instead of
acting on whatever now sits at the old point.

**A ref can never come to mean something else.** Each document numbers from
`e1`, so the page keys refs by a per-document token (`<doc>:eN`) and refuses a
key from another document; the model sees short aliases the driver issues from
one counter across every pane and guest, and an alias names its pane. An old
`e1` from before a reload, a replaced guest or another tab says so.

**Each chat drives its own pane** (`shared/previewPane.ts`). Several agents on
one project — a parent and the delegates it started, or two threads — used to
share one page, so one navigated away from the route another was testing, a ref
read by one was stale for the next, and every one of them queued behind the
others' waits. Now a pane has an `owner` (`PreviewTab.owner`), the chat id
`runPreviewTool` passes as `caller`, carried on `ensure`/`navigate` as
`PreviewCommand.owner`. `pickPreviewPane` takes the chat's own pane, else an
unowned one — the user's own preview, or one whose owner chat is gone — which it
claims in the same tick (two agents asking at once must not both take it), and
otherwise none: the chat gets a new tab, opened **behind** whatever the panel
shows, since five agents' tabs each coming to the front would flip the panel
under the user five times. The one-chat case is unchanged: its first command
claims the preview the user has open. A delegate's tab is labelled with its
name. The dev server stays one per project, shared by every pane — which is why
`preview_stop` from a chat is refused while another chat has used the preview
in the last few minutes (`othersActive`), unless it passes `force`; the user's
own Stop is never refused. A chat's sub-agents share its id, so they share its
pane and its lane: the old per-project rule, scoped to one chat.

**One operation per chat at a time.** Parallel tool calls used to
interleave inside the page — two `type`s focused A, focused B, then typed both
values into B. `PreviewManager.serial` runs a chat's operations in order (keyed
by project *and* chat, so different chats' panes run side by side), and holds
the lane until every CDP command on that chat's pane has actually finished
(`quiesce`), not merely until its caller timed out; a command still running past the cap —
a script awaiting forever — gets the page reloaded, which ends its context, so
nothing from before can act under the next operation. An action that *acts*
(click, type, press, evaluate) and had to wait records the pane and page it was
asked about and refuses if either changed; it checks the page again at the
moment of input, and re-measures a click point if a device change landed in
between. A focus that did not take is an error, not a key sent to whatever had
focus before, and a click whose point hits anything but the target (or inside
it) is refused.

**What the window has one of is still serialized** (`withWindow`). Keyboard
focus is one element per window, and `type`/`press` need the guest to hold it,
so two chats typing into their own panes at once would still send one's keys
into the other's — and a `click`, being real input, *gives* its guest focus, so
it would pull focus out from under another chat's typing; a screenshot uncovers
its pane under a cover or, for a full page, puts it on top. Those sections take
a process-wide lock *inside* their own lane — a few hundred milliseconds of
queueing — and everything else (navigation, snapshots, scrolls, waits) runs
concurrently. A pane reclaimed from a deleted chat waits for that chat's lane
to drain first (`drainPrevious`): its last `evaluate` may still be running, and
would otherwise act on the new owner's page. Measured with two
chats navigating and typing at the same moment: each read back its own page
and its own typed value.

**Typing needs the guest's keyboard focus, not a click.** `el.focus()` moves
the DOM's focus but `insertText` still drops the text (measured); a real click
gives the guest input focus but also activates what it lands on — Enter on a
submit button fired it twice. Focusing the `<webview>` element from the
renderer gives the focus with no click (the `focus` command), and `unfocus`
hands it back afterwards, so the user's next keystroke goes to the composer
rather than a hidden preview.

- **A click is real input** (`Input.dispatchMouseEvent`), so it goes through
  hit-testing, focus and the whole pointer/mouse/click sequence with `isTrusted`
  set. The cost is that it lands on whatever is *at* the point: the target is
  scrolled into view first, and a click on an element something else covers
  (a modal backdrop, a cookie banner) is refused, naming the cover.
- **Every action reports what followed it**: a navigation, new console
  errors/warnings, failed requests — after waiting for the page to go quiet (no
  load, no in-flight fetch/XHR for 200 ms, at most 3 s).
- **`type` replaces the field's value** (fill semantics) unless `append`, and
  answers with what the field holds afterwards. A `<select>` is chosen by option
  text instead.
- **`press` names the editing command** for `Meta+A`-style shortcuts
  (`previewInput.ts`): a synthetic shortcut never reaches the native menu that
  resolves it on macOS, so the CDP event carries `commands: ['selectAll']`.
- **A JavaScript dialog opened during an agent action is accepted** and logged;
  one opened by the user is left to Electron. Unanswered, it blocks every later
  command.
- **`evaluate` runs only on loopback pages.** The preview's partition persists
  cookies for every site the user ever opened in it, so a script on a signed-in
  site is a read of their account — a prompt injection away from exfiltration.
  A dev server's page is the agent's own work. `snapshot` still reads any page.
  The check is the *execution context's* origin as CDP reports it (a remote
  page that navigates itself to `about:blank` keeps its origin), and the script
  runs pinned to that context (`uniqueContextId`). `navigate` takes only
  http(s)/file URLs — a `javascript:` URL is a script by another door — and a
  password field's value is masked in `type`'s confirmation as in the snapshot.
- **Plan mode refuses `click`, `type`, `press` and `evaluate`** beside
  `start`/`stop` (`SIDE_EFFECT` in `previewTools.ts`): a click on a dev app can
  write to a real dev database.

One parameter table (`PREVIEW_TOOL_INFO.params`) produces Claude's zod shape,
the JSON Schema the other providers read, and the coercion of raw arguments
(`carbonToolInput`) — see `docs/canvas.md` for why that has to be one table.

## Panes and tabs

**Every preview tab stays mounted while the panel is open**, hidden with
`visibility` like the terminals (not `display: none`, which reloads a
`<webview>` when it comes back). It used to mount only the selected one, so a
tab switch threw away history, scroll and form state, and — worse — an agent
command arriving while a file was in front found no pane and opened a duplicate
preview every time. The worry that motivated unmounting was CPU; measured, a
hidden guest is throttled like a background tab — timers to ~1/s,
`requestAnimationFrame` stopped — so it costs no frames.
`Page.setWebLifecycleState('frozen')` was tried and not used: a frozen page
also stops answering `Runtime.evaluate`, which every agent command needs.

`ensure` finds the chat's pane (its own or a free one, see above) in order: one
on screen, then the one most recently selected, then a tab that exists but is
unmounted because the panel is closed (the panel opened, the tab not
duplicated), and only then a new tab — and only when main gave a URL to open it
at.

## Screenshots

**A hidden pane is shot where it is, under a cover.** A `visibility: hidden`
guest produces no frames, so its capture never resolves; the old answer was to
switch the user's panel to the preview and leave it there. Measured: the
guest's own `capturePage()` succeeds while an opaque cover sits *over* it. So
`capture()` makes the pane visible beneath its cover and beneath the tab the
user is looking at (`z-index: -1`), shoots, and hides it again.

**Full page is stitched.** CDP's own full-page paths — `captureBeyondViewport`,
or a device-metrics override the height of the page — return the first
~1,300 px and then the top of the page again, tiled, on a `<webview>` guest.
A viewport capture is reliable, so `captureFullPage` scrolls a viewport at a
time and joins the bitmaps, hiding fixed/sticky elements after the first tile
and scrollbars throughout. It needs a painted guest, so the pane is put on top
(`reveal`) for the length of it — a brief flash if another tab is in front.

## Viewports

`PreviewTab.viewport` is the one source of truth for the toolbar's device menu
and `preview_resize`. A preset's size is the `<webview>` element's own size
(scaled down with a CSS transform when it is larger than the pane — CDP input
still lands right, being injected below the embedder's transform); CDP adds
what a sized box cannot: the pixel ratio, touch, the mobile user agent, and
`prefers-color-scheme`. A new guest starts with none of it, so emulation is
re-sent on every attach.

## Dev servers

`detectDevPlan` (`devServerPlan.ts`): the root `package.json`'s script; then one
web app among a monorepo's `apps/*` / `packages/*` (chosen by its dependencies,
so a `tsc -w` package is not mistaken for it); then Rails, Django, Phoenix,
Jekyll and Hugo.

**A server already running for the project is used, not duplicated.**
`localServers.ts` reads `lsof`'s listening sockets, knocks on each port, and
keeps the ones that answer with a page, with the owning process's working
directory. `start` adopts one running inside the project (`external: true`) —
the agent used to spawn a second server into a port conflict when the user had
one up in their terminal — and `stop` will not kill a server Carbon did not
start, and polls an adopted server so one stopped in its terminal reads as
stopped rather than "running" for good. The same scan rescues a spawned server that never prints a localhost URL
(Express, Rails, `ready on port 3000`), which used to stay "starting" for good:
after 4 s a listener in the spawned process tree, or in the project folder,
wins. The toolbar's ⋯ menu and the load-error screen list every local server.

A worktree's dev servers are stopped when the worktree is removed.

## The element picker on React 19

React 19 removed `fiber._debugSource`, so the picker's file:line was empty on
any current React app. A dev fiber keeps `_debugStack` instead — an `Error`
captured where the element was created — and its first frame outside React and
the bundler is the user's JSX, as a position in the *served* module. Main
resolves it through the dev server's source map (`previewSource.ts`, loopback
only), honouring index maps (Turbopack) and `sources` relative to the map or
script URL (Vite writes `App.jsx` beside `/src/App.jsx`). The pick also carries
the component's name.

## Permissions

`previewSession.ts`. Electron's default grants every permission request, so
any page in the preview got the camera, microphone and location without a
prompt. Harmless ones are granted, ones that reach the user's machine ask once
per site for the app's lifetime, device choosers are refused. The check handler
can only say granted or denied, so `navigator.permissions.query` reports
`denied` rather than `prompt` until a request has been allowed.

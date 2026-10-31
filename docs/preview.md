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

**An action reports what it changed on the page** (`previewDelta.ts`,
`PreviewDriver.seed` / `changes`). It used to report only navigation, console
errors and failed requests, so the agent looked again after nearly every
action. In the recorded chats, 51% of 813 clicks were followed directly by a
screenshot, a snapshot or a `preview_evaluate`, and those evaluates were mostly
hand-written `setTimeout` reads of a toast or a dialog. Claude took 1,155
screenshots against 153 snapshots. Now click, type and press end with the
snapshot lines that moved (`+`, `-`, and `~` for the same ref with a new line,
naming a state that went away), capped at 40 lines / 2 KB. Past the cap, or when
the middle is too big for a cheap LCS, the action says to take a snapshot
rather than give a partial list. Some rules keep it cheap and honest:
- **The baseline is per caller and per document.** An explicit snapshot seeds
  it, every action leaves the next one, and an action with none reads one first
  (only the first action on a page pays for that). A reload or navigation bumps
  `docGen`, which voids it, and the action then says its refs are stale. A
  "changed substantially" answer deletes the baseline, because the agent was
  not shown what changed.
- **Some lines are compared without their noise.** Indentation, `(offscreen)`
  and `focused` are stripped before comparing, because a click scrolls its
  target into view and moves focus. Focus is reported once, on its own line,
  and not when it landed on the element acted on.
- **The read runs after the window's focus lock and outside the action's
  pinned context, and is caught whole.** A click that navigated has done its
  work; a failed read must not turn it into "Not done" and invite a second
  submit.
- **A truncated capture is the top of the page, not all of it.** A toast
  inserted above, or a reorder, can carry a row past the limit, where it would
  read as removed. Aligning the two captures cannot tell that apart from a
  real removal: equal text proves nothing, and an element both captures share
  does not keep the rest on its side of the cut. So the page is asked instead
  (`presentRefs`): a ref'd line gone from a truncated capture whose element is
  still connected and visible (`checkVisibility`, so a closed dialog's buttons
  count as gone) is dropped. A text line gone from one, or any line new after
  one, may only have crossed the limit. When something above grows or
  shrinks by k lines, those are the last k lines of a capture, so the unsure
  lines there are folded into one ("… 3 lines at the capture limit moved in
  or out of it"). An unsure line higher up stays inline, under a header saying
  it may only have moved. A ref changed in place (`~`) is exact either way.
- **Floating content is read first** (`floating()` in `previewPage.ts`).
  Portals put dialogs, toasts and menus at the end of `<body>`, which on a
  long page is past where the capture stops, so a modal opening there was
  invisible to both the snapshot and an action's changes. The top layer
  (`aria-modal`, `dialog[open]`, `:popover-open`) is lifted to the head of the
  tree, under a `floating:` line. So is a dialog, alert, status, menu, listbox,
  tooltip or live region inside a fixed or absolute layer. In the flow they
  read in place, so a page's own nav menu does not jump to the top. They must
  be visible, counting ancestors, and only the outermost is lifted. Its lines
  are the capture's `head`, read whole whenever the capture goes on past them,
  so a change there is exact even on a truncated page.
- **`type` skips only a change to the typed field's value**, which its own
  confirmation states. A change to the field's state (`[invalid]`), its name
  or its presence is still reported.
- **The snapshot walk stops at its output cap** (and at 30,000 elements),
  instead of computing styles and rects for every element past it in order to
  count them. Measured live: capture plus diff costs 1–5 ms per action, a
  3,000-row table included.

Timers still show up as changes (an "Uptime 3 → 4" line), which is the truth
and costs a line. `settle` waits for loads and fetches, not for a `setTimeout`,
so a delayed toast reads "No changes yet" and `wait_for` is the tool for it.

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
rather than a hidden preview. **Handed back the moment the input is in**, not
when the tool returns: `release` runs between the dispatch and the settle, which
can take 3 s, and the user's keystrokes went to the page for all of it. A click
goes through the same pair — being real input it takes the focus anyway, and
used to keep it until the user clicked back. Focus emulation
(`Emulation.setFocusEmulationEnabled`) does not make the dance optional:
without real focus `insertText` still drops the text (re-measured). Measured
over a type, a click, an Enter and a scroll: 28 ms of focus held in total.

**In the background, the guest is never given focus — it takes it.** With
another app in front, two things the focus dance did activated Carbon over it
(measured per call, Electron 43): `<webview>.focus()`, and handing the focus
*back* to the composer from a focused guest. CDP input, `capturePage`,
navigation and `expose` do not. So `focus` gives the guest the keyboard only
while Carbon is the active app; otherwise it answers whether the guest already
holds it (`PreviewCommandResult.focused`), and the hand-back waits for the
window's next `focus` event. Without the keyboard:

- **Typing goes through the page** (`insertText`): `execCommand('insertText')`
  on the field `prepareType` focused and selected — the same trusted
  `beforeinput`/`input` a keystroke fires, replacing the selection.
- **Keys are given the keyboard by a click into their field**
  (`grantKeyboard`): a CDP click focuses the guest *without* activating the app,
  and the guest keeps that focus for later calls, so Enter then lands as a real
  key (measured: trusted, and it submitted the form). The field's selection is
  put back after the click.
- **A key with no text field to click into** (Enter on a button, a key with
  nothing focused) goes as page events (`syntheticKey`) — the page's handlers
  see it, and Enter/Space activating a button or submitting a form are done by
  hand — and the result says so.

A main-process `webContents.focus()` on the guest activates the app too —
Electron makes it focus the owner window. There is deliberately no guard in
`index.ts` to undo a steal: the one that existed `blur()`ed the window when it
gained focus shortly after a preview command, and on macOS `blur()` is
`orderBack:` — it fired mostly when the *user* switched back to Carbon while an
agent drove the preview, and threw the window behind every other app's.

One activation is still unexplained: in a real agent turn, the first
`preview_navigate` brought Carbon forward for about a second, and the same
navigate driven with no provider turn did not.

**The agent never opens the panel.** It used to, three ways: `ensure`
reopened it to mount a tab, `openPreview` opened it even when asked to open
behind, and the auto-open on a dev server coming up (which, the user's own
Start being pressed inside a preview, is in practice the agent's
`preview_start`) opened it too. The root was that a pane existed only while the
panel was open, so a user who closed it destroyed the agent's page and the next
call had to bring it back — over the chat they had just closed it to read. Now
a closed panel keeps its previews mounted, **parked**: taken out of the shut
aside (docked: absolutely positioned leftward from its zero-width edge;
floating: its slide undone), laid at the width the panel would open to,
transparent and inert to the pointer. Both halves of that are measured
requirements. A guest clipped to nothing or pushed off-screen is throttled as
hidden — its capture never resolves and input goes nowhere — and at the
panel's minimum width the agent tested a page reflowed narrower than the one
the user would see.

**A hidden pane is a hidden page, and drops input.** `visibility: hidden` — a
tab behind another, and every pane while the panel is closed — paints nothing
and silently discards mouse and key events: a click or an Enter reported
success and did nothing, and only `insertText` landed (measured on a parked
pane). A background tab is the same `visibility: hidden`, so the same
mechanism applies there; with `expose`, a click, an Enter and a scroll were
measured landing on a pane behind a file tab, the file tab staying in front. `expose` / `unexpose`
(`BrowserPane`) make the pane visible beneath its opaque cover and beneath
whatever the user is looking at, counted so a scroll can overlap a capture;
`focus` exposes, and `scroll` is wrapped in the pair since a wheel is input
too.

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

**The strip lists one project.** Preview tabs are one list across every chat
— a pane must stay mounted for an agent to drive it from a chat the user is
not looking at — so the panel used to show every chat's previews, and a chat
in one project wore the tabs an agent opened in another. `previewShown`
(`shared/previewPane.ts`) decides the strip: the project on screen, or a pane a
chat of the thread drives. Mounting ignores it, and so does nothing else. A
pane opened *behind* becomes the panel's tab only for the thread it belongs to
(`openPreview`), or a background agent's tab became this chat's active one.

## What the agent is doing

**Drawn by the app, over the page — never in it.** Main tells the pane what an
action is about to do (`PreviewDriver.onMark` → a `mark` command, sent without
waiting) a beat before the input goes out, and `PreviewMarks` draws it: a
cursor that glides to each click and ripples, an outline on the field being
typed into, the key pressed, the direction scrolled. Injected into the page,
the marks would be in the agent's own snapshot and in the app's DOM under
test. Positions arrive in the page's CSS px with the viewport they were
measured in, and the layer covers the guest exactly as drawn, so one ratio per
axis places them at any size — filled, a device preset scaled to fit, or the
pop-up. Their hue is `--agent-mark`, one vivid blue rather than `--primary`,
because they sit on whatever page is being tested and several themes make
`--primary` a near-neutral.

`previewActivity` records which chat used each pane this turn, set on every
`ensure`/`navigate` (so a snapshot-only turn counts) and cleared when that chat
goes idle: the tab's activity dot, the chip naming the chat in the pane, and
the pop-up below all read it.

**The pop-up is the parked layer itself.** While the panel is closed and a
chat of the thread is using a pane, that pane is shown small in the top-right
corner until the turn ends or the user hides it (hidden holds for the rest of
the turn). A `<webview>` moved to another parent reloads, and nothing inside
the parked layer can escape its `opacity: 0`, so the pop-up is that same layer
made visible, scaled and cropped to the pane's page with `clip-path` (taken
in layout px, before the transform). The page is the pane's frame
(`data-preview-frame`): the whole stage when it fills — scaled to the card's
width, cropped below — and the device alone when a preset is set, fitted whole,
so a laptop makes a wide card and a phone a narrow one. Cropping to the stage
put a small device in a field of dotted backdrop. The stage's own size, which
fits a device to the pane, is read as `offsetWidth`/`offsetHeight` for the same
reason the crop is: a bounding rect taken under the pop-up's transform refit the
device to a fraction of its real size. The page therefore
keeps the exact size the agent has been testing at — measured 642×778 with the
pop-up shown and after it is hidden — and input still lands, being injected
below the transform. Two plain siblings around it make the card: a surface and
shadow beneath, and the controls above. The page is inert there: a click opens
the panel, because one into a page the agent is driving would race its input.
`BrowserPane`'s `popup` counts as on screen, or `expose` would draw its cover
over the pop-up for every input.

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

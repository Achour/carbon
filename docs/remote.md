# Remote access

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Carbon from a phone (`main/remoteAccess.ts`, `src/renderer/src/remote/`)

Settings → Remote access turns on a small HTTP server in the main process. It
serves a phone-sized client and relays the conversation to it, so a phone can
read chats as they stream, send messages and photos, answer permission prompts,
plans and questions, stop a turn and start a new chat. The agents never move:
they run on the Mac, on the user's installed CLIs, exactly as they would with
the window open. The phone is one more window onto them.

- **The phone calls the desktop's own handlers, captured, not copied.**
  `RemoteAccess.captureIpc` wraps `ipcMain.handle` before `registerIpc` runs and
  records every listener, and `POST /api/invoke` names a channel and its
  arguments exactly as the preload bridge would. A second implementation for
  the phone would drift the first time a handler changed. Only channels in
  `REMOTE_CHANNELS` are reachable, and that list is the conversation and nothing
  else: no `fs:*`, no terminal, no git writes, no settings, no deleting.
  `chat:set-options` is the composer's own pickers. Like on the desktop, a pick
  there also becomes the Mac's New-chat default (`rememberOptions`), unless it
  is an effort or speed that a model pick only replays (`remember: false`).
  `chat:edit-message` (edit and resend) is a send; `chat:rewind-files` is a
  turn's Undo, which restores only what that turn's own checkpoint recorded;
  `canvas:list` / `canvas:get` read documents Carbon keeps in its own database,
  not the disk; `usage:overview` is the plan's 5-hour and weekly headroom,
  read-only and cached in main (`usage.ts`'s TTL and in-flight dedup), so a
  phone reopening its Usage sheet spawns nothing a warm cache can answer;
  `usage:report` is the Usage page's history, aggregates per day, model and
  project rather than any transcript (`docs/usage.md`, "On the phone"). None
  gives the phone more than the agent it steers. A lost
  phone can still steer the agents, which is the feature, but it is not a more
  direct remote shell than that.
- **Events are the same `ChatEvent`s, as server-sent events.** `emit` feeds
  `remote.observe`, which writes each event to every open `/api/events` stream.
  Transcript events (`message`, `part`, `part-delta`, `tool-update`, `truncate`,
  `context-usage`) only go to a phone that has said it is reading that chat
  (`/api/watch`), because a background turn's tool outputs are most of the
  traffic and a phone on a cellular link should not pay for chats it isn't
  looking at. SSE rather than a WebSocket: one direction is all the events need,
  `EventSource` reconnects on its own, and it needs no dependency on either side.
- **Main keeps the state a phone needs on connect, because nothing else does.**
  Which chats are working and which prompts are open were only ever *told* to
  the window as events; the window keeps them in its store. `observe` keeps the
  same two maps from launch onwards, whether or not the server is on, and
  `/api/snapshot` hands them over. A plan review that opened before the phone
  connected therefore shows up on it.
- **The snapshot carries side chats, which the desktop's list leaves out.**
  `listChats` drops ephemeral chats for the sidebar's sake, and the desktop
  keeps its side chats in a list of their own. A delegate's live state is read
  off its own chat (`AgentGroupCard`, `DelegateCard`), so a phone holding only
  `listChats` found no row, read every delegate as deleted, and showed three
  running agents as finished. `/api/snapshot` sends both lists, and the phone's
  lists filter side chats back out (`listedChats`).
- **Who may connect: Tailscale and loopback always, the LAN only on opt-in, the
  internet never.** The server binds every interface so a Tailscale that comes
  up after Carbon needs no restart. `remoteAddressAllowed` then drops any peer
  outside `100.64.0.0/10` / `fd7a:115c:a1e0::/48`, loopback, and (with "Allow
  the local network") RFC 1918 and link-local. Tailscale is the recommended
  path because its WireGuard tunnel is what makes plain HTTP acceptable. On the
  LAN, the pairing code and the cookie cross the air in the clear, which is why
  that is off by default and the switch says so. TLS on the LAN would mean a
  self-signed certificate that iOS makes the user trust by hand in Settings, and
  that is worse than telling them to use Tailscale.
- **The Wi-Fi address to keep is the Mac's name, not its IP.** On the local
  network the router hands out the IP, and it can hand the Mac another one, at
  which point a Home Screen app saved at `192.168.1.2` stops opening. The
  server therefore lists the Bonjour name (`scutil --get LocalHostName` +
  `.local`) ahead of the raw IPs, so the pairing link and the QR code carry it.
  Sign-in is per address (the cookie belongs to the origin), which is why the
  link has to be right the first time. It resolves to the Mac's LAN IPv4 or an
  `fe80::`/`fd…` IPv6 address, all of which "Allow the local network" already
  admits. Tailscale still comes first: its address is just as stable, and it
  also works away from home.
- **Pairing is a one-time six-digit code; a paired phone holds a device token.**
  "Pair a phone" makes a code that lives ten minutes and survives five wrong
  guesses, behind a global limit of twenty misses per ten minutes. The QR code
  is the same code in a link (`/#pair=…`, a fragment so it never reaches a log).
  Pairing mints `<deviceId>.<token>` as an `HttpOnly`, `SameSite=Strict` cookie
  and stores only the token's SHA-256 in `settings.json`, so reading the
  settings file is not enough to impersonate a phone. Unpairing deletes the
  record and closes every open stream, since a stream outlives the cookie check
  that admitted it.
- **CSRF is the custom header plus `SameSite`.** Every `POST` must carry
  `x-carbon-remote: 1`, which no form and no cross-site `fetch` can send without
  a preflight the server never answers. DNS rebinding gets a page onto the
  server's address but not the cookie, which is scoped to the real origin. That
  leaves it guessing pairing codes against the limits above.
- **A Home Screen app may start with a cookie jar of its own.** iOS has not
  always carried Safari's cookies into an app added to the Home Screen. So the
  manifest is generated per request, and for an authenticated one its
  `start_url` carries the credential (`/?device=…`). The server trades that for
  the cookie and redirects to `/`, which drops it from the page's history. The
  manifest is only ever served to the phone the credential belongs to.
- **The client is a second page of the renderer build, not a second build.**
  `electron.vite.config.ts` adds `remote.html` as an input beside `index.html`,
  so the client shares the aliases, `@shared/types` and React, and ships inside
  `out/renderer` with no packaging step. The two pages share one chunk (React and
  the markdown stack), which the desktop page now `modulepreload`s; it is the
  same bytes it loaded before, in two files. The server gzips text files once
  and keeps them, since the build cannot change under a running app. In
  `npm run dev` it proxies to Vite instead, websocket upgrades included. The
  upgrade is not optional: Vite's client opens its hot-reload socket on the
  page's own origin, and unanswered it falls back to polling for the dev server
  and reloads the whole page whenever it thinks the server came back. In dev the
  styles arrive by script, so that reload was a white flash in the middle of
  use.
- **The first frame is the app's background, in every build.** `remote.html`
  paints `html` and `body` in the desktop's `--background` for the phone's
  appearance and sets `.dark` in an inline script, all before any stylesheet or
  module loads. The `theme-color` metas follow the same two colours, so the
  status bar matches.
- **A Home Screen app is one status bar short of `100dvh`.** It draws under
  its translucent status bar (`black-translucent`, `viewport-fit=cover`), yet
  iOS reports the viewport as the screen minus that bar. A shell sized
  `100dvh` therefore left a strip the bar's height empty below the composer.
  Running standalone at full width, `main.tsx` sets `--app-height` to the
  screen's own height, and the shell uses `var(--app-height, 100dvh)`. It
  only ever grows the shell, so a WebKit that stops doing this leaves the
  variable unset.
- **Navigation is the desktop's: a sidebar, not a list screen.** `Sidebar.tsx`
  is the desktop sidebar at thumb size, compact by default. New chat and Search sit on top,
  followed by pinned chats, then each project with its real mark (`/api/icons`,
  `projects:icons` over roots the *server* chooses, never the phone) and its
  chats hanging under the name. The open chat sits on the accent pill, and
  activity shows as the desktop's glyphs (`chatActivity`, `DotSpinner`). Chats
  keep the desktop's `sortKey` order. Projects are ordered by most recent
  activity, since the desktop's project order and custom names live in its
  window's `localStorage`, which main cannot read. The drawer follows the
  finger: a swipe from the left edge opens it, a swipe anywhere closes it, and on
  release it settles by distance and speed. Routes are *replaced*, never
  pushed (`navigate`): iOS reads a left-edge swipe as Back whenever the page
  has history behind it, and takes the touch before the drawer sees it, so
  the swipe that should open the sidebar went to the previous chat. With no
  history there is no Back to take, and the edge belongs to the drawer. During a drag the transforms are
  written straight to the elements, because a React render per touch-move would
  re-render the transcript every frame. `#/` is the desktop's home screen (a
  greeting, "What are we building?", the project chip and the composer).
- **The transcript is the desktop's, not a copy of it.** The first phone client
  drew messages with its own small renderers (plain GFM, its own tool rows), on
  the argument that the desktop's components reach for `window.api` and the
  desktop store. It was wrong in the way copies always are: Mermaid, charts and
  diagrams, diffs, sub-agents, the checklist, a turn's changes and the turn
  fold were all missing, and every block the desktop gained would have been
  missing too until someone ported it. So `ChatView`'s transcript moved into
  `components/Transcript.tsx` (`renderMessages`, `useHistoryNodes` and the live
  slot, behind `useTranscript`), and both screens render it. The phone supplies
  what those components read, narrowly (`remote/desktop.ts`): a `window.api`
  that routes the few calls the transcript makes to allowlisted channels and
  refuses the rest, and a mirror of its own state into the desktop store's
  `chats`, `statuses`, `permissions`, active chat and appearance. The desktop
  store is created but never initialized, so none of its loaders run.
  `remote/state.ts` is still the phone's own store (chat list, one open
  transcript, open prompts), because the shell around the transcript is the
  phone's: its sidebar, header, composer and prompt cards.
- **What opens a panel on the desktop opens a layer on the phone.**
  `TranscriptSurfaceContext` (`components/messages/surface.ts`) tells the
  components where they are drawn. With `panels: false` they leave out controls
  whose only job is to open the editor, the diff view or the preview (Open
  diff, a file row, a path link), and route the rest through the surface: a
  delegate opens as the chat on screen, a sub-agent's transcript and a canvas
  open full screen (`remote/Viewers.tsx`), and so does a turn's changed file
  (`openDiff` → `DiffScreen`). Its diff comes from `/api/diff`, which takes a
  chat and a path, never a folder, and runs only inside that chat's own
  folder. A path resolving outside it is refused. It is the file's
  uncommitted change against HEAD, so a file committed since says so. The
  phone lists every changed file, since it has no review view for "Show more
  in diff" to open. A canvas is framed as `CanvasDoc`
  frames it, `allow-scripts` without `allow-same-origin`, which here also keeps
  it away from the pairing cookie. Mermaid and images open in the desktop's own
  lightbox.
- **The pickers are the desktop composer's, computed the same way.**
  `/api/snapshot` carries the catalog's inputs: the live model list, the Codex
  config model and the installed providers. `remote/options.ts` runs them
  through `assembleModelOptions`, `visibleModelOptions` (Settings → Models
  hiding), `effortOptionsFor`, `serviceTierOptionsFor` and
  `PROVIDER_PERMISSION_MODES`, so the phone never offers a row the Mac would
  not. A model pick replays the effort and speed last used with that model, as
  `Composer.handleModelChange` does. A cross-provider pick only arms
  `pendingModel`, and the phone says so with an Undo. Probing the CLIs is never
  a phone tap: the catalog is the one the window already fetched, and a cold
  start gets a bounded probe with the static rows standing in.
- **JSON cannot say `undefined`, in either direction, and both directions
  bit.** An omitted positional argument (`chat:send` with no photos) arrives as
  `null`, and `null` slips past a default parameter to throw on its first
  `.length`. That broke every send the phone made. `handleInvoke` reads a
  positional `null` back as `undefined`, and no allowlisted channel gives one a
  meaning of its own; the client also stops sending trailing `undefined`s. The
  other way, a `meta` patch clears a field by carrying it as `undefined` (an
  undone model switch is `pendingModel: undefined`). The key vanishes in
  `JSON.stringify`, so the phone kept drawing the switch. `wire()` sends those
  as `null`, and the phone's reducer reads them as cleared.
- **The composer is the phone's own, and carries what the desktop's does.**
  While its box is focused on a touch screen it drops the home-indicator
  padding (`safe-area-inset-bottom`, ~34pt) for a small margin: the keyboard
  covers the indicator, so that padding was only a gap above the keys.
  **With the keyboard up, the app is the visible area above it**
  (`followKeyboard`, `--kb-height` from `visualViewport`). Left full height,
  the page was taller than what showed, and iOS scrolled all of it up to
  reveal the composer, taking the header off the top. Sized to what is
  visible there is nothing to scroll, and the transcript's own resize
  observer keeps its bottom edge where it was (`ChatScreen`), so the last
  lines stay above the composer. Verified as a Home Screen app in the
  Simulator, opening, typing and closing the keyboard.
  The context ring reads the same `contextTokens` / `contextWindow` off the
  chat and opens the desktop's `ContextDetail` in a sheet, fed by the
  `context-usage` event the phone now keeps for its open chat. The permission
  chip says one word ("Full", "Edits"), because at a phone's width the model
  chip, the ring and send leave no room for "Full access". A photo is decoded
  through an `<img>`, not `createImageBitmap`: the bitmap is a full-resolution
  decode, and iOS Safari refuses one the size of a 48 MP photo, which failed
  every pick. A photo that still cannot be decoded is sent untouched when the
  model can read its type and it fits the API's size cap.
- **Any file can be attached, by the button, a paste or a drop.** A photo is
  shrunk and sent inline as above. Anything else goes to `POST /api/upload`,
  which writes it to `userData/remote-uploads/<uuid>/<name>` and answers with
  the path. The phone attaches it as a `file` attachment, the same shape a file
  dropped on the desktop composer takes, so the agent reads it on the Mac by
  path. The name is cut to its last segment and loses any leading dots, so a
  hostile name lands inside its own folder and nowhere else. Uploads are
  pruned after 7 days, when the server starts. The cap is the server's 25 MB
  per request, checked on the phone first so the refusal says so. A paste is
  taken over only when it carries files, so text still pastes as text.
- **The phone has display settings of its own, and the desktop does not.**
  A gear in the sidebar's footer opens a sheet with text size, code size,
  color mode and palette (`remote/prefs.ts`, `remote/Settings.tsx`). They are
  kept in the page's own `localStorage`: per device, never on the Mac, and no
  new relay channel, because `REMOTE_CHANNELS` leaves settings out and a
  phone wanting larger type than the desktop is normal, not something to sync.
  Text size is a `zoom` on the reading surfaces (the transcript column, a
  sub-agent's transcript, the plan sheet) through `--reading-zoom`, not a
  font-size variable. The transcript is the desktop's components, sized in px
  throughout, and the desktop already chose zoom over a text scale
  (`docs/chat-layout.md`). The phone just has no ⌘+ and no pinch
  (`maximum-scale=1`), so this setting fills the gap. The shell is left
  unzoomed: the drawer's geometry is in screen px, and the composer's 16px
  is the size below which iOS zooms into a focused field. The palettes are the
  six built-ins from `lib/themes.ts`. Imported themes live in the desktop
  window's storage and cannot travel. Color mode defaults to System, not the
  desktop's Dark. `remote.html`'s pre-paint script reads the chosen mode and
  the palette's remembered background (`carbon.remote.paint`, one per
  appearance), so the first frame and the status bar are already the right
  colour. Safari's non-standard `zoom` has historically mispositioned
  anything placed with `getBoundingClientRect` inside a zoomed element. The
  preview's Chromium follows the standardized behaviour, so a real iPhone is
  the only test for menus inside the transcript at a size other than 100%.
- **The sidebar has the desktop's two shapes, chosen per phone.** Compact
  groups chats under their projects and folds each after "Chats per
  project" (default 5, the phone's fold before it was a setting). Detailed is
  the desktop's flat list in `sortKey` order, three lines a row: project and
  time, the title, then branch or folder with the backend's mark. It folds by
  batches of 40, as the desktop's does. A row's branch comes from
  `/api/branches`, which runs the desktop's `git:branches` over the listed
  chats' folders. Like `/api/icons`, it reads the folders the *server* picks,
  never a list the phone sends, because a branch name is a read of the Mac's
  disk. It is fetched only while the sidebar is detailed, then again on each
  resync and at each turn's end, as the desktop does. A worktree chat carries
  its branch on its meta, so that row is labelled before the read lands.
  Outside a repo the row shows the folder, written with `~` against the
  snapshot's `home`.
- **Hold a row to move it (`remote/touchSort.ts`).** After ~350 ms still, the
  row lifts and follows the finger. The others slide apart to open the gap a
  drop will fill (`lib/sortShift.ts`, the desktop's own, see
  `docs/sidebar.md`), the list scrolls near an edge, and on release the row
  glides into the gap before the order commits. The order written is the
  desktop's, `chats:place` and `chats:set-pinned-order`, so the Mac's sidebar
  moves with the phone's. It works within one list: the pins, the flat list,
  or one project's chats. Pinning by drag stays a desktop gesture. The
  dragged row's transform is written straight to the element: a React render
  per touch-move would re-render the sidebar every frame. React renders only
  when the gap moves to another slot. The scroller's `touchmove` is a native
  non-passive listener, because React's are passive and only a non-passive
  one can stop the list scrolling under the row. A hold that turns into a
  drag swallows the click its release would send, and a finger that moves
  before the hold fires is a scroll, not a hold.
- **The project filter is the desktop's, per phone.** A third row under New
  chat and Search opens a sheet of projects, most recently active first, and
  the pick is kept in `prefs.ts` (`carbon.remote.project`), apart from the
  Mac's `sidebarProject`. It scopes what the desktop's does: the pins, the
  list, and where both New chat buttons start a chat. Filtered, compact drops
  its project rows and lists the chats flush, since the filter already names
  the project. **"Needs you" ignores it**, a deliberate difference from the
  desktop, which has no such section: a question waiting in another project is
  usually why the phone was picked up, and a filter must not hide it. A saved
  filter naming a project with no chats left reads as no filter
  (`useProjectFilter`).
- **The plan's headroom rides the footer.** The desktop's ring and
  "Claude 39%" chip sit beside the bell, and a tap opens the 5-hour and weekly
  bars in a sheet (`Usage.tsx`). It reads `usage:overview` on each resync and
  at each turn's end; main's cache makes both nearly free.
- **It moves like a native app, and the physics live in `remote/`.** Sheets
  follow the finger down from their handle, or from their body once it is
  scrolled to the top. The scrim fades with the drag, and a release settles by
  distance and speed, the drawer's rule. A long picker opens on the row
  already chosen, centred below any pinned header (the model sheet pins
  effort, speed and search). Full-screen viewers (a canvas, a sub-agent) are
  pushed screens: in from the right, back by the chevron or a swipe from the
  left edge. The edge strip sits above the content because a canvas iframe
  keeps every touch that lands on it. The chat's header floats over the
  transcript, opaque and `position: fixed` (every screen's header is, with a
  spacer holding its place in flow). **That is for iOS, not for layout.** iOS
  lays its own progressive blur over the top of a Home Screen web app, above
  the page, and the title sat in it, soft. It never shows in a Safari tab.
  Three releases guessed at it (no `backdrop-filter`, a fixed shell, a pinned
  header) and none held. It was settled in the Simulator, as a Home Screen app
  driven with `idb`. Two things are needed together. First, the default
  status bar (`remote.html`), so the page starts below the bar, out of the
  band. `black-translucent` put the header under it, and nothing on the page
  turned the blur off there. Second, an opaque bar `fixed` to the top: an
  absolutely placed header was blurred even with the default bar, and so was
  a `sticky` one where nothing scrolls around it. A translucent fixed bar is
  sharp too, but shows a seam against the status bar. iOS reads the status bar
  style when the icon is added, so an icon added before keeps the old bar and
  the blur until it is removed and added again. `fitStandalone` keeps such an
  icon's height right meanwhile (`underStatusBar`). It is measured so the scroller's top padding follows it when
  the connection strip appears. Its hairline shows once something is
  under it, and tapping the title scrolls to the top, the status-bar tap iOS
  only gives a page's own scroll. A round button jumps back to the latest
  message once the reader is most of a screen up, with a dot while the agent
  is still working. Both of these flip state only when their answer changes,
  never per scroll event. The last lines fade into the composer through an
  overlay rather than a mask, because a masked scroller is composited whole
  every frame. Three rules hold throughout:
  - **Drag transforms are written to the elements.** React registers
    `touchmove` passively, so a drag that must stop the body scrolling
    listens natively, with `passive: false`.
  - **A flung sheet or a swiped viewer finishes on an inline transition.**
    The class-based exit is skipped there, because tw-animate's keyframes
    outrank the inline transform and would restart the exit from the edge.
  - **Sheets and viewers stop touch propagation at their root.** Portals
    bubble through the React tree, and the shell's drawer gesture listens
    for left-edge touches.

  Long-pressing chrome shows no callout, and nothing tappable waits for a
  double tap. A chat opens on a skeleton instead of a spinner. One known
  gap is the iOS keyboard. A Home Screen app keeps its layout height when the
  keyboard opens and scrolls the page instead. Fixing that means tracking
  `visualViewport`, which this preview cannot exercise, and a wrong guess
  hides the composer, so it waits for a real device.
- **Only the HTTPS address is a secure context, and the others miss two
  APIs.** At `http://<name>.local:7391` or a raw Tailscale IP the page is
  neither HTTPS nor localhost, so Safari leaves out `crypto.randomUUID` and
  `navigator.clipboard`. The first made every photo pick throw before it was
  sent; the second breaks every copy button the transcript borrows from the
  desktop. `lib/insecureContext.ts` (`randomId`, `copyText`) is the fallback
  for both. The HTTPS address (below) is secure, but the plain ones stay
  supported, so anything new the phone runs still has to avoid secure-only
  APIs or go through that file. Testing in a browser at `127.0.0.1` cannot
  catch this: localhost counts as secure.
- **A message typed during a turn is queued on the phone**, and sent as that
  chat goes idle, the way the desktop composer queues. "Goes idle" is not only
  the live event: a phone that was locked when the turn ended never heard it,
  and the message sat there for good. So every resync also sends what is
  waiting behind a chat the snapshot reports idle. Sending straight into a
  live turn means something different on each provider.
- **A new chat is announced to the other screen, in both directions.** One
  made on the phone reaches the window as the `chat-added` event a delegate
  uses; one made on the desktop reaches phones the same way, from
  `chats:create` itself (the window adds its own from the return value and does
  not dedup, so it is not sent there). Both insert the row by `sortKey`: the
  window used to append it, which put a phone's new chat under its project's
  "Show N more", where it looked as if it had never synced. The New-chat screen seeds its pickers from the Mac's
  defaults, exactly as the desktop's does, and passes all of them to
  `chats:create`. Omitting the model would make `rememberOptions` record an
  empty one, quietly resetting the Mac's New-chat model.

### Notifications (`main/webPush.ts`, `main/tailscaleCert.ts`, `remote/push.ts`)

A phone in a pocket hears about a turn that finished, failed, or is waiting on
an approval, the way the desktop does when its window is in the background.

- **The constraint is iOS, not where Carbon runs.** A backgrounded app is
  frozen within seconds and its stream to the Mac goes with it, so nothing on
  the phone is listening. Only Apple's push service can wake it. For a native
  app that means APNs, and APNs needs the paid Developer Program; the free
  account cannot even enable the capability. Web Push to a Home Screen web
  app (iOS 16.4+) also goes through Apple, but needs no developer account:
  the subscription accepts any sender that signs with the VAPID key it was
  made for. So the phone client stays a web app.
- **Web Push needs a secure context, and that is what Tailscale is for.**
  Service workers exist only on HTTPS. `tailscale cert` issues a real Let's
  Encrypt certificate for the Mac's `<name>.<tailnet>.ts.net`, with nothing for
  the phone to trust by hand, which is what made a self-signed LAN certificate
  the wrong answer earlier. Carbon asks the user's own Tailscale for it
  (`fetchTailscaleCert`). Both halves go to stdout (`--cert-file -`), never to
  a path: the App Store build's CLI is sandboxed, and a path Carbon named would
  be written into Tailscale's container. The answer is cached by Tailscale, so
  it is re-asked every 12 h and swapped in live (`setSecureContext`). With no
  certificate it is retried every 5 minutes, and whenever Settings opens,
  because the fix is a switch flipped in Tailscale while Carbon runs. Each way
  it can be missing is a sentence (`certDomainFromStatus`): not installed,
  signed out, not connected, or "HTTPS Certificates" off for the tailnet.
  That last one only the user can fix, in the admin console's DNS page. The
  `.local` address has no way in, so a Wi-Fi-only phone gets no notifications.
- **One port, both protocols.** The listener reads each connection's first
  byte: `0x16` opens a TLS handshake and no HTTP method does, so the byte
  decides which of two servers gets the socket. The address keeps its port
  when it gains the `s`, there is one "port in use" message, and a TLS hello
  before there is a certificate is simply dropped. The address check runs on
  the raw socket too, before either server sees it. Over HTTPS the device
  cookie is `Secure`. The HTTPS address leads `urls` and is the one the
  pairing link carries. Sign-in is per origin, so a phone paired at an `http`
  address pairs once more there and is re-added to the Home Screen.
- **The encryption is written here, against the RFC's own numbers.** RFC 8291
  (`aes128gcm`) and RFC 8292 (VAPID) are a page of `node:crypto`.
  `test/webPush.test.ts` reproduces RFC 8291's example message byte for byte
  and checks the JWT the way Apple's service does. Apple's service is the
  strict one: `aud` is the endpoint's bare origin, `exp` within a day, `sub`
  present, and the signature raw `r‖s` rather than DER, each mistake answered
  with a 403 `BadJwtToken`. The VAPID pair is made once and kept in
  `settings.json` (`RemoteSettings.vapid`). Every subscription is bound to
  its public half, so regenerating it would silently break them all.
- **The Mac decides whether to notify; the service worker always draws.** iOS
  revokes a subscription whose pushes show nothing, so `public/remote-sw.js`
  shows every push it gets, and `maybePush` in main sends only what is worth
  showing. That is the desktop's rule set (`notifyOnStatus`): a turn's `turn`
  event (body: the opening of its last reply, `lastReplyText`), its `error`
  event, and a *new* `permission-request` (one re-announced on reload was
  already pushed). A delegate's turn ending or failing is not pushed, on the
  phone or the desktop. Its outcome goes back to the agent that started it,
  and that agent finishing is the notice the user wants. Its approvals still
  push, because only the user can answer those. It is skipped for a device
  that has the chat open on screen. "On screen" is reported by the page (`/api/watch` carries
  `visible`), with the hidden report sent `keepalive` as the page goes away,
  because iOS freezes the page before the server notices its stream died. A
  push's `tag` is the chat id, so a second notice about a chat replaces the
  first. 404/410 from the push service means the subscription is gone, and it
  is dropped from the device record.
- **The bell says why it can't, rather than being absent.** The sidebar's
  footer carries it. Each state is a sentence (`PUSH_HINT`): on plain HTTP it
  points at the HTTPS address, and in a Safari tab it says to add the app to
  the Home Screen. WebKit exposes `PushManager` only to the installed app, so
  `subscribe` would otherwise throw. Denied points at iOS's Settings. The
  permission prompt is requested first thing inside the tap, since iOS
  refuses one that isn't, and `applicationServerKey` is passed as bytes.
  Tapping a notification focuses the open app and posts it the chat's hash,
  or opens the app on it.
- **The page cannot ask on its own, so a card asks once.** iOS shows the
  permission prompt only in answer to a tap. The home screen therefore offers
  "Get notified on this phone" while notifications could be turned on and are
  not. "Turn on" is the tap that brings up the prompt, and "Not now" puts the
  card away for good (`localStorage`); the bell stays. The card and the bell
  read one shared state (`usePush`), so turning it on in either updates both.

### The home screen's board (`remote/board.ts`, `HomeBoard.tsx`)

The phone is usually picked up to learn one thing: what happened while it was
in a pocket. So while anything needs you, is working, or finished unseen,
`#/` swaps the centred "What are we building?" for three sections — **Needs
you**, **Working**, **Done** — with the greeting above and the composer still
below. With nothing to show it is the plain screen again, and `#/new/<project>`
(a new chat asked for by name) always is.

- **A native app was considered and rejected.** On a free Apple account it
  cannot receive push at all, it stops opening after 7 days, and a widget
  without push cannot refresh when a turn ends. This web app already has push,
  so the board went here.
- **Done is kept by the Mac, per device, not by the page.** A backgrounded
  phone hears nothing; only main saw the turn end. `maybePush`'s own moments
  (a `turn` or `error` event) write a mark (`RemoteUnseen`: when, failed, and
  the line the notification said) onto every paired device that was not
  looking at the chat. That means every device, notifications on or not.
  `RemoteDeviceRecord.unseen` persists it, so a Mac restart while you are out
  keeps the list. It is written with `store.setRemote` rather than `save`,
  which would redraw Settings at every turn's end. Delivery is the snapshot
  (now per device) plus a named `unseen` SSE event carrying the whole map to
  that device's streams.
- **Reading it is what clears it.** `/api/watch` with the chat on screen
  clears its mark, and that covers opening a chat, tapping a notification and
  returning to the app on a chat. Returning to the app now re-sends `visible:
  true`. Before, a live stream only resynced, so the server went on thinking a
  phone back on a chat was hidden, and pushed about the chat being read. "Clear"
  is `/api/seen`. Deleting a chat drops its marks (`forgetChat`).
- **Each chat sits in one row, the most urgent.** Needs you > Working > Done.
  A finished chat sent again is Working until it ends again, and keeps its
  mark meanwhile. Rows are `listedChats`, so side chats, terminal chats and the
  archive are not on it, and main skips marking what the phone will not list.
  A Needs you row says what it is asking with the notification's own words
  (`shared/promptLine.ts`). A Done row carries the reply's opening line. The
  sidebar marks the same chats with a dot where the time would be.
- **The icon badge is Needs you plus Done.** The page sets it whenever that
  count moves (`useAppBadge`). The service worker sets it from each push, and
  the Mac counts it there (`badgeFor`), because the worker knows no other
  chat. A chat whose turn has just ended counts as done even if its idle
  status has not landed yet. iOS only honours the badge for the Home Screen
  app with notifications allowed.
- **Known limit: a turn watched on the Mac still lands in Done.** Main knows
  whether the window is focused, not which chat it shows. This matches push,
  which also notifies regardless of the desktop. "Clear" is the answer after a
  day at the desk.

Verified against an isolated dev instance with a pre-paired device and real
Haiku turns. A turn ending with the phone home was marked, carrying its reply.
Opening the chat cleared the mark. A turn ending with the chat on screen left
none. The same chat with the app hidden was marked again, and Clear emptied the
list. The marks survived in `settings.json`. Headless Chrome drew the board at
iPhone size, in both schemes, with all three sections. Not tested: the badge
on a real iPhone.

**Known limits.** The Mac has to be awake: "Keep computer awake" only holds
while an agent works, and a closed lid still sleeps it. The first launch after
turning this on may raise macOS's "accept incoming connections?" prompt, and an
ad-hoc-signed build can raise it again after an update, because the signature
it is keyed on changes. Two Carbons sharing `userData` (dev and packaged) share
the setting, and the second to start reports the port as in use. Terminal chats,
the file editor and the preview are not on the phone, and diffs only as a
turn's changed files. Images the agent
references by local path do not load, and path links read as plain text, since
the phone cannot read the Mac's disk.

**Verification.** `test/remoteNet.test.ts` pins the address and credential
logic, the Tailscale status and certificate parsing, and the notification
body. `test/webPush.test.ts` pins the encryption to RFC 8291's example
message and the VAPID header. The notification path was driven end to end
against an isolated dev instance. A stub `tailscale` (`CARBON_TAILSCALE_PATH`)
handed out a localhost certificate. Headless Chromium paired over HTTPS, got a
`Secure` cookie and registered the worker. It turned the bell on through the
sidebar, with only the browser's `pushManager.subscribe` stood in for, since
headless Chromium has no push service. A fake push service decrypted every
message and verified its signature. Real Haiku turns checked: a finished turn
pushed its reply; the same chat open on screen pushed nothing; the page
hidden pushed again; a Bash approval pushed its command; and a 410 dropped
the subscription. Not yet tested: a real `tailscale cert` and an iPhone
receiving through Apple. The display settings were driven in the same preview against an isolated dev
instance with a pre-paired device. That run covered: Ember in Light mode at
117% text and 13px code, which survived a reload with the right first frame;
System tracking the emulated scheme live, `theme-color` metas included; and
the drawer stepping aside under the sheet. It did not cover the 140% / 18px
extremes, or Safari. The gestures were driven in the same preview with
synthesized touch events: a sheet dragged 80px with the scrim at 0.89, flung
shut, and dragged 40px slowly and snapping back; the model sheet opening
centred on the model in use under its pinned effort and speed; and a canvas
viewer swiped 155px from the edge and released shut, the drawer behind it
unmoved. The floating header, its hairline, the jump-to-latest button and
its jump were checked in both appearances. Real fingers on a real iPhone are
still the test for all of it. The rebuilt client was driven in Carbon's own preview at iPhone 15
size, in both appearances, against the real app and real Claude turns. That
run covered: the project-grouped list; a long transcript with grouped tool
runs; the model sheet and a cross-provider pick with its Undo; the permissions
sheet; a send with no photos; and approving a Write and denying an Edit from
their cards. The server and client were driven end to end in headless Chromium at
iPhone size, against the real `RemoteAccess` and a simulated agent. That run
covered pairing by link, the device record, the allowlist refusing `fs:read`, a
streamed turn with a tool approval, a plan review that predates the connection,
creating a chat, a denial and unpairing. The shared transcript was then driven
the same way, against a copy of a real database on a second port: an existing
chat's Mermaid block (and its lightbox) and inline diagram, a canvas, a
sub-agent's transcript, a live Haiku turn with a Bash approval and a Mermaid
reply, and its Undo reverting the file on disk. The desktop window rendered
the same chat, and showed a phone-created chat at the top of its project.

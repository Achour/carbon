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
  else: no `fs:*`, no terminal, no git writes, no settings, no deleting. A lost
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
  `npm run dev` it proxies to Vite instead, so client edits hot-reload on the
  phone too.
- **The client is deliberately not the desktop store.** `remote/state.ts` is the
  slice of `applyEvent` a phone needs (chat list, one open transcript, open
  prompts) and `remote/Markdown.tsx` is plain GFM. The desktop's `Markdown` and
  store reach for `window.api` everywhere (file links, images off disk, the
  editor), which a browser does not have, and importing them would pull those
  five thousand lines into the bundle to do things a phone cannot. The prompt
  decisions it sends are the desktop's own (`PromptDock`, `PlanPanel`), so no
  provider can tell which screen answered.
- **A message typed during a turn is queued on the phone**, and sent as that
  chat goes idle, the way the desktop composer queues. Sending straight into a
  live turn means something different on each provider.
- **A chat created from the phone is announced to the window** with the
  `chat-added` event a delegate uses, so the desktop sidebar gets its row
  without a relaunch. The phone passes the app's defaults to `chats:create`
  explicitly. Omitting the model would make `rememberOptions` record an empty
  one, quietly resetting the Mac's New-chat model.

**Known limits.** The Mac has to be awake: "Keep computer awake" only holds
while an agent works, and a closed lid still sleeps it. The first launch after
turning this on may raise macOS's "accept incoming connections?" prompt, and an
ad-hoc-signed build can raise it again after an update, because the signature
it is keyed on changes. Two Carbons sharing `userData` (dev and packaged) share
the setting, and the second to start reports the port as in use. Terminal chats,
the file editor, diffs, the preview and canvases are not on the phone. Images
the agent references by local path render as a placeholder, since the phone
cannot read the Mac's disk.

**Verification.** `test/remoteNet.test.ts` pins the address and credential
logic. The server and client were driven end to end in headless Chromium at
iPhone size, against the real `RemoteAccess` and a simulated agent. That run
covered pairing by link, the device record, the allowlist refusing `fs:read`, a
streamed turn with a tool approval, a plan review that predates the connection,
creating a chat, a denial and unpairing.

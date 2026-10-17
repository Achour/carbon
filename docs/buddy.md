# Desktop buddy

Settings → Chats → "Desktop buddy" (`AppDefaults.buddy`, off by default) puts a
small bear in its own transparent window, floating over every app and Space. It
types at a laptop while an agent works, waves with a `!` when a chat needs you,
jumps when one finishes, greets you when the screen unlocks, and naps after five
idle minutes. Clicking it opens the chat it is talking about; dragging it moves
it, and the spot is remembered.

- **The mood is computed in main, never in the buddy's page.** `main/buddy.ts`
  is fed from `emit` in `index.ts` — the chokepoint `keepAwake.ts` already
  reads — and sends the window one small `BuddyState` only when it changes. A
  second renderer subscribed to `chat:event` would parse every streamed delta
  to decide whether a bear looks busy.
- **Precedence is needs → back → done → working → idle/sleep.** "Done" is the
  same edge `notifyOnStatus` uses (non-idle to idle) with the same exclusions
  (an ephemeral chat with no thread, a scheduled run's ending), so the bear and
  the notification never disagree about one event. A click opens whoever needs
  you, else what just finished, else the one chat at work; with nothing to open
  it is a pat (hearts) and Carbon comes forward.
- **A disposed session emits no last status**, so `ChatManager`'s `onDispose`
  and chat deletion call `buddy.forget` beside `keepAwake`'s `forgetChat` —
  otherwise the bear types forever after a hand-off refused mid-turn.
- **The window never takes focus.** `type: 'panel'` + `focusable: false` +
  `acceptFirstMouse`: clicking it must not pull you out of the app you are in,
  and it stays out of ⌘-Tab and Mission Control. `openChatFromOutside` (shared
  with notifications) calls `app.focus({ steal: true })`, because the click
  comes from inside some other app.
- **Click-through is toggled by the page.** The window starts with
  `setIgnoreMouseEvents(true, { forward: true })`; pointer moves still arrive,
  and the page turns it off only over the bear's painted shapes or the bubble.
- **Drag is pointer events over IPC, not `-webkit-app-region: drag`**, which
  swallows clicks. A press that travels 4 px is a drag; anything less is a
  click. The saved position is kept only while most of the window still lands
  on a display — an unplugged monitor would otherwise strand it offscreen.
- **`app.on('activate')` checks `!win`, not "no windows"**: the buddy is a
  window, so with it showing, the Dock icon after closing the main window
  would have opened nothing.
- **The bear is one inline SVG** (`buddy/bear.ts`) whose parts `buddy.css`
  shows and animates off `data-mood`. It is drawn in a 760-unit box, so the
  CSS's stroke widths, origins and keyframe distances are in those units.

Dev: `AIGUI_BUDDY=idle,working:Some title,needs,…` shows the buddy and steps
through those moods, one every 2.5 s (`mood:bubble text`), and
`AIGUI_BUDDY_CAPTURE=/tmp/buddy.png` shoots each as `buddy-1.png`, `buddy-2.png`, ….
The window is a separate page of the renderer build (`buddy.html`) with its own
four-call preload (`preload/buddy.ts`).

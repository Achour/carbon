# Depth

Carbon's surfaces stack in levels. Each level is a visible step lighter than
the one it sits on and is drawn by its edge as well as its fill. The levels are
defined once, in `index.css` under "Depth.", as utilities:

| Utility | What it is | Examples |
| --- | --- | --- |
| `surface-card` | a block on a page or panel | a Settings group, a PR's summary, a scheduled task's facts, the panel's launch list |
| `surface-group` | rows grouped *inside* a card, or a well of controls | the launch list's actions, the session popover's lists, the track of a `Segmented` |
| `surface-raised` | a control you press | `Button variant="secondary"`, the active segment, the active panel tab, context chips |
| `surface-overlay` | what floats over everything | popover, menus, select, dialog, tooltip |
| `surface-well` | an input, a step *below* | `Input`, the panel's file search, edit fields |
| `surface-fill` | a filled button, lifted by an outer shadow only | `Button` default and destructive, the send button, the commit split button |

## Why it is built this way

- **A lightness step alone does not read.** Carbon's ladder is 0.02–0.03 apart
  and a screenshot of it looked like one flat sheet. Dark mode therefore adds a
  1px top highlight, the raised edge catching light. Light mode adds a soft
  drop shadow instead, because a highlight on near-white is invisible.
- **Every level is derived, never given a value.** `applyTheme` writes the
  surface ladder inline on `<html>`, so a fixed number in `:root` would be dead
  for every built-in theme and every imported one. `--surface-group` and
  `--surface-raised` are relative colors off `--card` and `--background`, and
  that is why there is no new per-theme token.
- **The window is not split into sheets.** The first attempt made the chat and
  the right panel separate raised sheets on a base. That was the wrong reading:
  the depth belongs *inside* the panels and pages, as cards holding groups.
- **The transcript stays flat.** Messages and activity rows get none of this.
  The box around a tool row was removed on purpose (see `docs/transcript.md`),
  and a shadow on a streaming row costs a repaint per token. The one exception
  is `CHAT_FRAME`, which the composer and a sent prompt share. It takes the top
  highlight only.
- **The composer's controls are the one place inside it that is raised.**
  With depth on, the composer was the only flat thing on a raised page: the
  same outlined box either way, its unarmed send a half-transparent white disc.
  `surface-control` is the level for a control sitting on a card: the attach
  button and the model chip take it, the unarmed send takes `--surface-raised`
  with the same edge, and hover moves toward the foreground. Depth off maps it
  to transparent with an accent hover, which is the ghost control it was. The
  frame itself stays `CHAT_FRAME`, so it still matches the sent prompt.

## Primitives that carry it

- `ui/segmented.tsx` is the one "pick one of a few" control: a `surface-group`
  track with the chosen option `surface-raised`. Usage, Settings, the Pull
  requests tabs, the theme import's tabs and a markdown tab's Preview/Source
  each used to hand-roll it a pixel apart. Pass `tabs` where it switches the
  view below rather than setting a value.
- `ui/group.tsx` is a titled card of divided rows: a muted title above, then
  rows inside that keep their own `px-2 py-2.5`. Settings and its sub-pages use
  it.
- `SwitchPill` and Settings' `Toggle` draw the same switch: a `surface-well`
  track when off, and a knob with the highlight.

**Selection has one look: raised.** An active tab, segment, nav item or
selected list row is `surface-raised`. That covers the sidebar's active chat,
Settings' nav, the Providers, Models, Projects, Pull requests and Scheduled
lists, the panel's tabs and the thread's pills. The one addition is the selected
theme card, which also takes an outline, since every theme card is already
raised against its group. A ring would fight `surface-raised` for
`box-shadow`, and the base `outline-none` needs `outline-solid` to bring the
outline back. Keyboard highlights inside menus and pickers stay `bg-accent`:
that is a cursor, not a selection.

**Settings → Appearance → Depth turns it off** (`data-depth="off"` on
`<html>`, stored in `localStorage` like translucent chrome, on by default).
Off is handled entirely by the variables the utilities read, so a new surface
gets the flat case for free and nothing at a call site checks the setting.
Flat keeps the layout and the hairlines. Cards lose their fill, groups and
wells go transparent, a selection falls back to the accent fill, and overlays
keep a plain drop shadow. The one call-site exception is a switch's track
(`switch-track`). Unlike an input, it has no border to fall back on, so with
the well gone it vanished entirely.

When adding a surface, pick the level by what the surface *is*. Small chips,
badges, `kbd`, code blocks and diff bodies are not surfaces and keep their own
borders.

# The chat column, tables, type, file icons and file references

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The chat column (`lib/chatColumn.ts`)

A chat has **one** reading column, and two kinds of thing sit in it: **prose**
starts on the column edge, and a **framed** object — the user's prompt, the
composer, the pill rows above it — hangs `CHAT_BLEED` (14px) outside it and
carries the same amount as padding, so its border steps out while its own text
lands back on the column. That is Cursor's model, and it only reads as
deliberate while *every* frame bleeds by the same amount.

It was written out twice and the two copies disagreed, which put **three** left
edges on one screen — measured at a 1512px window: composer border 504, prompt
border 508, prose 522.

- **`max-w-3xl` meant two different things.** The transcript spells it
  `max-w-3xl px-6` (so the cap is the *box* and the column is 720px); the
  composer spelled it `px-6` on the outer element and `max-w-3xl` on the inner
  (so the cap is the *column* and the box is 768px). Wide enough for the cap to
  bind, the composer ran 48px wider than the reply it answers; narrower, the two
  agreed — which is why this survived so long, since a pane with the right panel
  open never shows it.
- **The scrollbar is layout.** `::-webkit-scrollbar` is styled with a width, so
  it takes real space: the transcript's scroller is 12px narrower than the
  composer's container and `mx-auto` therefore centers the two columns 6px
  apart. `--scrollbar-width` is one value used by both — the scroller reserves
  it with `scrollbar-gutter: stable` (without which the column also steps
  sideways the moment a chat grows long enough to scroll) and the composer's
  wrapper reserves the same amount as `pr`.
- **The bleed wraps the whole composer stack**, not just the composer: the
  activity bar, the context strip and the queued rows are framed objects too,
  and they read as one column only while their borders share an edge. The
  checklist needs nothing — `TaskDock` already rides inside the composer's box.
- **The composer's own padding had to come down to 14px** (`px-4` → `px-3.5` on
  the textarea, and the attachment and error rows with it). The bleed puts the
  border 14px out; anything else inside and the placeholder misses the prose
  column by the difference.

### Tables in a message (`.markdown table`)

A table is a **framed block**, like a code fence is, and both halves of that —
the frame and the fitting — were arrived at by getting them wrong first.

**Where the frame lives.** The original rule was `width: 100%` with
`display: block; overflow-x: auto` **on the table itself**. A block box takes its
container's width, so the table layout had no room to size a column and pushed
the overflow down into the cells instead: `src/server/backend.ts` came out as
`src/server/backend.t` + `s` on the next line, each half wearing the inline-code
chip's own background. The scroll therefore moved to a wrapper
(`markdown-table-scroll`, a `table` component in `Markdown.tsx`) and the table
went back to being a table. That wrapper is now the **border** as well, and it
has to be: a wide table scrolls *inside* its frame, and a border drawn on the
scrolling element slides away with the content it is supposed to contain. It
takes `pre`'s chrome exactly — same `--color-border`, same `--radius-lg`, same
margins — because a table and a code block are the same kind of object in a
reply, and two boxes that nearly agree read worse than one that does. Rounding
clips for free, since a scroll container establishes its own clipping.

**How wide it is.** `width: max-content; min-width: 100%` was the second wrong
answer, on the reasoning that a table's width is set by its content rather than
by the column chosen for prose. That is true of a table of paths and false of the
table people actually write: a three-column comparison of *prose* is far wider
than any chat pane, so every one of them opened clipped at the edge with the last
column unreadable until you scrolled sideways. The rows of a comparison exist to
be **scanned**, and a reader cannot scan what is off screen. So `width: 100%`,
and prose wraps inside the pane.

**`table-layout` stays auto, and that is the load-bearing half.** Auto layout can
never shrink a column below its min-content width, so a cell holding a
`white-space: pre` chip pushes the table past 100% and the frame scrolls
instead — the fitted table and the unbroken chip are the same mechanism, not two
rules in tension. `fixed` would fit every table at the cost of breaking those
chips apart again, which is the bug the wrapper was introduced to fix.

**A chip inside a cell is `white-space: pre`** — it is an identifier, a path or a
flag, and breaking one is worse than scrolling to it; prose in the same cell
still wraps. In running text the opposite holds, which is why `overflow-wrap:
anywhere` stays on the base `code` rule: there the column really is the
constraint and there is no scroller to fall back on.

Cells carry both inner rules, and the frame draws the outer two — hence the
`:last-child` and last-row exceptions, without which the right edge and the
bottom are drawn twice. The header is a **band** (`--color-code`, `pre`'s
recessed surface) rather than bold alone: in a grid this dense a header cell is
one wrapped phrase among others, and weight on its own is easy to read past.

This is `.markdown`, so it is every table in every message *and* the Markdown
preview. `FileViewer`'s frontmatter table is deliberately not one of them — it is
a sibling of `<Markdown>`, with its own classes, for exactly this reason.

### Type in the chrome (`--ui-row`, `--code-font-size`)

There is **no interface-text-size setting**, and that is a decision rather than
an omission. There was one — `--ui-scale`, a multiplier every hand-written size
in the renderer was rewritten through, 245 of them across 36 files — and it was
removed because the View menu (`role: 'viewMenu'`, `main/index.ts`) already
binds ⌘+ / ⌘− / ⌘0 to the renderer's own zoom. Two controls for one question is
worse than either alone, and the one that costs nothing to maintain wins.

The known cost is the macOS traffic lights: `trafficLightPosition` puts them at
a fixed point in *unscaled* coordinates, so zooming slides the space the chrome
reserves for them out from under the buttons. That was the original argument
for a text-only scale; it did not survive the maintenance cost of 245 `calc()`
expressions that a single `text-[11px]` written the ordinary way silently opted
out of.

What remains is the part that was never about scaling:

- **Code is not chrome.** `--code-font-size` is a real setting in px, because
  the file viewer, diffs and code blocks are a document being read rather than
  the app being read — and zoom, which moves both together, is exactly why
  someone who wants small code in a large window still needs this one.
- **`--ui-row` is one size, and file lists have no second one.** The
  source-control tree, the file tree and the review's stacked headers put every
  label at it — a file name, a folder name, the directory beside a name, the
  `+n −n` deltas, a folder's count, the section heading, the scope control —
  and carry hierarchy in *color* alone, which is what Cursor's changes panel
  does. It was a two-size ladder first, and that is precisely what kept
  breaking: the same file is named twice on one screen, once in the review
  header and once in the tree, and every rung added another pair that could
  disagree. Weight is not a substitute either — `font-medium` at one size reads
  as a larger size, which is how the review header came to look bigger than the
  identical 13px row beside it.
- **The review's file header inherits it too**, for the whole row: the name,
  the dimmed directory, the status letter, the `+n −n`. Nothing in there carries
  its own size, which is what keeps the row internally level — and it is the
  same 13px as a row in either tree, so the same file is the same size wherever
  it is named.

### File icons (`lib/fileIcon.tsx`)

One filename → icon map behind every place the app names a file: the tree,
editor tabs, ⌘P, @-mentions, composer attachments. **Shape says what kind of
thing a file is, color says which language** — an image, an archive, a lockfile,
a key and a stylesheet each get their own silhouette, while the twenty-odd
source languages share `FileCode` and are told apart by hue. That split is the
whole design: at 14px a column of distinct silhouettes reads as static, where
one silhouette in seven colors reads as a sorted list. The exceptions are marks
more recognisable than any color (React's orbit, Rust's gear, Java's cup) and
`CLAUDE.md` / `AGENTS.md`, which get their provider's own `ProviderMark`.

Colors come from `--icon-*` (`index.css`), a seven-hue palette stepped per mode
— *not* real brand hues, which are picked for marketing pages and half of which
are illegible or shouty against one of the two chat surfaces. Distinct again
from `--brand-*` (a fact about a logo) and `--chart-*` (series identity): here
color is only a grouping, and no icon may out-shout the filename beside it.

The tree also carries git: a changed file's *name* takes its status color
(`lib/gitStatusColor.ts`, shared with the review panel's status column, since a
file that is amber in one list and green in the other is worse than no color at
all), and a **collapsed** folder holding changes gets an amber dot — the one
place a change would otherwise be invisible. Repo-relative paths are joined onto
the tree root exactly as `openDiff` does it.

### Clickable file references (`lib/fileLink.ts`, `Markdown.tsx`)

A file the agent names in its answer opens in the panel, and the two providers
name one in **different syntax** — so both have to be recognised or the same
reference is live under one and dead under the other.

- **Claude names a file in inline code** (`` `counter.ts` ``, `` `src/a.ts:12` ``).
  `InlineCode` gates on `PATHISH`: no spaces, an extension, an optional
  `:line(:col)`.
- **Codex names it as a link** — `[counter.ts](/Users/me/orbit/counter.ts:1)`.
  That reached the `a` renderer, which sent it out as `<a target="_blank">`, and
  Electron's `setWindowOpenHandler` drops anything that isn't `http(s)`: the
  click did nothing at all. `fileLinkPath` is the decoder — strip `file://`,
  cut the `:line` suffix **before** testing for a scheme (a bare `counter.ts:1`
  otherwise reads as the scheme `counter.ts`), undo the percent-encoding
  `mdast-util-to-hast` applies to every href, and require the last segment to
  carry an extension.

React Markdown's own sanitizer gets one narrow amendment (`URL_TRANSFORM`,
`isBareFileLineRef`): `defaultUrlTransform` reads everything before the first
colon as a scheme unless a `/`, `?` or `#` comes first, so `src/a.ts:12`
survives it and a root-level `counter.ts:12` is blanked to `''` before any
renderer sees the destination. That one shape — a filename with an extension
and a line number, no slash — is added back, and nothing else is; an unknown
scheme still goes.

Both then go through **one** `useResolvedFile`: stat the path against the chat's
cwd, and for a bare basename that isn't at the root fall back to the file index,
linking only when exactly one file carries that name — opening the wrong
`index.ts` is worse than leaving it unlinked. `statOnce` / `lookupOnce` are
module caches, so a transcript naming one file both ways costs one round trip.

The resolved link renders **without an `href`**: it is a tab in this window, not
a destination, and a path left in `href` navigates the whole renderer away on a
middle click — a gesture `preventDefault` on `onClick` never sees. Local *image*
links keep their existing branch above this one, so `[shot](x.png)` still draws
inline. The `:line` suffix is parsed and discarded by both paths; neither jumps
to the line.

### Marks in prose (`Markdown.tsx`)

Two small marks ride the text of a message: a language icon on a file name, and
a site's favicon on an external link. Both answer the same question — *what is
this thing you just named* — before the reader has to click it.

**The file icon draws only on a file that resolved.** `InlineCode` already
recognises a path-ish span and resolves it through `useResolvedFile`; the icon
goes inside the same `<code>`, and only in the branch where a target came back.
The mark is what promises a click, so putting one on a name that resolves to
nothing promises a click that does nothing. It is derived from the *resolved*
path rather than the span's text, so a bare basename found through the file
index is marked by the file that will actually open.

Both marks are `inline-block` and sized in `em` of the chip they sit in.
Neither is decorative: Tailwind's preflight sets `img, svg { display: block }`,
so an untouched mark takes a line of its own mid-paragraph, and `em` is what
makes them track the chip rather than drift when type scales. Each is glued to
its text by a word joiner (U+2060) inside a `select-none` span — an atomic
inline is a UAX #14 contingent break, so a chip landing near the column edge
could otherwise leave its icon stranded at the end of the line above. Not
`white-space: nowrap`: the base `overflow-wrap: anywhere` on `code` is
deliberate, and a long path must still be able to wrap. The joiner is inside
`select-none` so a copied filename is still just the filename.

**Favicons are fetched in main and cached per origin** (`main/favicons.ts`,
`main/faviconCache.ts`), never by the page: the fetch is capped and timed out
in one place, and the site learns nothing about the reader's window. They ride
only the plain external branch of the `a:` renderer — never a local-file link,
which opens a tab rather than a destination. The renderer keeps its own
per-origin promise map beside `statOnce`/`lookupOnce`, nulls included, so a
transcript citing one site eight times is one round trip. A pending, absent or
undecodable mark renders the bare link with no gap and no reserved space. They
draw as `<img src="data:…">`, which works because the app ships no CSP
anywhere — the same thing `LocalImage` has always relied on.

**A favicon is drawn for the site's background, not for ours**, so it is
measured before it is trusted. GitHub's `/favicon.ico` is a black Octocat on a
transparent field: correct on their page, and on Carbon's dark one an invisible
mark leaving a hole in the sentence. A single-colour glyph on transparency is
the house style for developer sites, which is most of what an agent cites. So
each icon is sampled once on a 16×16 canvas (a `data:` URI is same-origin and
never taints it) and inverted in dark mode only when it is unsaturated, dark,
*and* genuinely transparent — that last condition is what stops a filled black
tile, a logo whose square is the design, from being turned into a white one.
**The saturation test is a mean, not a max**: antialiasing along a curve leaves
a handful of faintly coloured pixels, and the Octocat peaks at 0.21 that way,
so a max-based test called the blackest icon on the web "coloured" and left it
invisible. Averaged over what is drawn it is 0.083, against 0.378 for php.net's
mark. The alternative — preferring the `<link rel="icon">` a page declares,
which for GitHub is an SVG that answers `prefers-color-scheme` — costs an HTML
fetch per origin, when the resolver asks for `/favicon.ico` first precisely so
most sites cost one request, and it only helps sites that published a dark
variant at all.

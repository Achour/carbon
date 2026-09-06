# The review (diffs)

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The review (`DiffView.tsx`, `MultiDiffView.tsx`, `lib/diffRows.ts`)

Every changed file stacked in one scroller under a sticky, collapsible header.
The header is the part that names a file the way the rest of the app does —
name, then dimmed directory — and the body is meant to read as *code*, not as a
table of changed lines, which is the whole difference between skimming a
thirteen-thousand-line review and grinding through one.

- **Lines do not wrap by default, and the horizontal scroll is per file.** A
  wrapped line breaks mid-token, and a review of TypeScript is a column of
  broken identifiers. One shared horizontal scroller would have been simpler and
  is wrong: it carries the sticky headers off the left edge along with the code,
  so the scroll wrapper sits *inside* each section, below its header. Wrapping
  is still one toggle away (`diffWrap`, persisted) because the review lives in a
  side panel narrow enough that some files are unreadable without it.
- **The gutter counts the new file, so a deleted line has no number.** Printing
  its old number instead is what a one-column unified diff usually does, and it
  reads as a fault: a deletion at old line 70 sitting between new lines 96 and
  97 makes the ruler count 96, 70, 71, 97. The bar and the tint already say the
  line was removed; what the column is *for* is being monotonic.
- **The tint sits behind syntax-highlighted code**, so `--diff-add-bg` /
  `--diff-del-bg` are held far enough back that `--syn-*` still reads as itself,
  and the "this line changed" signal is carried by a solid bar at the row's
  outer edge (the gutter cell's own left border, which is what stretches it to
  the row's full height). They take the `--success` / `--destructive` hues
  because add and delete are *states* — the same reason `--chart-*` may not be
  reused for them.

**Folds are the centrepiece, and there are two kinds of hidden line.** Git
elided some (`-U3`) and they are simply not in the text; we folded the rest, out
of a diff fetched with enough context to cover the file, and those rows are in
hand. `lib/diffRows.ts` is the whole model — `parseDiff` answers the first
(`gaps`), `foldRanges` the second, `diffItems` merges them so the view never
knows which it is looking at.

- **Opening a git-elided gap re-runs the diff; it does not read the file.** The
  new side of a *staged* diff is the index, not the working tree, and branch
  scope's is a base sha — `GitDiffTarget.context` (`-U`) is the only expansion
  that is correct for all four target shapes. It is fetched lazily, per file, on
  the first expand: 69 files' full text up front is megabytes for nothing.
- **Reveals are line ranges, not row indices**, because the row array is
  replaced wholesale the moment the full-context diff lands — the index a user
  clicked names a different line in the array that answers them. Line numbers
  mean the same thing in both, which is what lets a click land *before* the
  refetch resolves and still open the right stretch.
- **A refetch that comes back shorter than what is on screen is dropped.**
  `gitDiff` reports failure as its return value, so an error arrives as a string
  that parses to no rows and would blank the file — an expand that hides lines
  is the one outcome this must never produce.
- **The row cap counts what is drawn, not what is parsed**, and highlighting runs
  over the render list for the same reason: a full-context diff of a large file
  is mostly folded away, and both the cap and hljs would otherwise be spent on
  rows nothing was going to show.
- **Once we own the context, small gaps stop being folds.** `MIN_FOLD` keeps a
  run of fewer than four hidden lines open, so expanding one gap can also open a
  couple of seven-to-nine-line ones git had elided. That band is the only place
  our folding and git's disagree, and showing seven lines beats a one-row
  control that hides them.

Next/previous change (the toolbar arrows) walks `[data-diff-hunk]` — set on the
first changed row of each run, computed in `diffItems` off what was *emitted*
rather than off the previous row, so a fold between two changed runs correctly
starts a second hunk. It spans every expanded file, which is the point: in a
review this size the alternative is scrolling.

**Only the files near the viewport are in the DOM** (`LazyDiffBody`). A review is
the one place where the amount of markup is set by someone else's work rather
than by the design: 40 files at 26,880 changed lines is ~30,000 rows and
~304,000 nodes, and all of it used to mount at once — five seconds of frozen
window on "expand all", and a sixth of a second to *collapse*. Collapse is the
diagnostic: it parses nothing and highlights nothing, so the only thing it can
have been paying for is the DOM. Measured on that corpus, expand-all's worst
frame went 5,004 ms → 78 ms and the node count 303,960 → 8,418.

- **The header stays mounted and only the body is lazy.** That is what keeps the
  source-control tree's scroll-to-file working: it scrolls to a section that is
  always there, and the body arrives on the way.
- **A file that has been on screen remembers its height.** Left to collapse, an
  unmounted body would pull everything below it upward and scrolling back would
  jump. The height is read off the `IntersectionObserver` entry's own
  `boundingClientRect` — computed at exactly the moment the body is leaving,
  while it is still laid out, and free, because the observer has already
  measured it. One that has *never* been mounted estimates from its line count
  at the row height the CSS already defines, so the placeholder is a `calc()` on
  `--code-font-size` rather than a number JS went and measured.
- **⌘F forces every file to mount.** `FindBar` collects its matches by walking
  the DOM, so viewport-only rendering would quietly narrow every search to the
  files on screen — the same objection that keeps this view off CodeMirror. The
  difference is that here it is *handled* rather than silent: `findOpen` is
  already store state, so the one gesture that needs the whole document in the
  DOM is the one that asks for it.
- Row-level virtualization inside a file is deliberately **not** here. `MAX_ROWS`
  already caps the pathological single file, and per-visible-file cost is a
  frame; a second windowing mechanism inside the first would buy nothing and
  would put the fold math and the render list on different indices again.

`DiffTable` is shared with the single-file `diff:` tab, so both surfaces get the
same folds, the same wrap setting and the same expansion — the tab passes its
own `DiffTabMeta` as the re-fetch target. Deliberately **not** rewritten on
CodeMirror: 69 stacked files means 69 editor instances or a hand-rolled
multibuffer, and CM renders viewport-only *per file*, which would break ⌘F
inside a file — a granularity `LazyDiffBody` never reaches, and one `findOpen`
could not force back.

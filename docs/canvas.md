# Canvas

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Canvas (`canvasTools.ts`, `canvasStore.ts`, `CanvasPanel`)

A **canvas** is a document the agent wrote to be *read* — a comparison, a
report, an architecture note — rendered beside the chat and listed per project.
It is Carbon's second MCP server, and the first one whose interesting decision
is where the document *isn't*.

**A canvas is a tool call, not a file, and that is the whole design.** The
obvious implementation is to have the agent write `docs/foo.html` and render it;
it is also wrong twice over. A canvas in the repo is a canvas in `git status`
and in the next release's diff — and, worse, it is one more file for the
agent's own `grep` and `glob` to wade through on every later turn, so the
feature would make the assistant measurably worse at its actual job the more it
was used. Going through a tool means Carbon owns the storage, which is also
what makes the Recents list one indexed query rather than a directory scan.

- **One bridge, one child script, two namespaces.** `previewBridge.ts` routes on
  a `server` field in the POST body (defaulted to `preview`, so the older shape
  still lands where it did) and `previewMcp.ts` picks its tool table off
  `CARBON_MCP_SERVER`. A second script would have meant a second entry in
  `electron.vite.config` and a second built artifact to resolve beside the
  compiled main, for a file differing only in its table.
- **The body caps are per-server, and that asymmetry is the point.** A preview
  call carries a URL, so 64 KB bounds a request with no business being large; a
  canvas call carries the whole document. Capping both at 64 KB would have
  worked on Claude — whose in-process server never touches the bridge — and
  failed on Codex and Grok, which is exactly the silent provider asymmetry this
  codebase keeps ruling out. The read is bounded by the larger and the smaller
  is enforced once the server is known.
- **`project` and `chatId` are injected at spawn, never taken from the model.**
  `project` is `projectRoot(chat)` — the repo root, so a worktree chat's canvas
  outlives the branch `finishWorktree` deletes — and fixing it at session
  construction also keeps git off the path of every write. A model that could
  name its own project could write into another one's list.
- **`write` answers with the id, twice.** It is the only handle a revision has:
  without it in the result text, "add a column" produces a second canvas with
  the same title instead of a new version of the first. `save` keyed by that id
  preserves `createdAt` and refuses to move a canvas between projects, since the
  id is the identity and a caller passing a different cwd is a worktree.
- **A revision is an `edit`, and for a long time there was no such thing.**
  `write` takes the whole document, so it is O(document) in *output tokens* —
  and output tokens are generated at ~80/s, which nothing about the transport,
  the bridge or SQLite can change. Measured on this repo's own chats
  (`ToolPart.startedAt` between successive calls): a canvas that grew 80,449 →
  80,506 bytes — **57 bytes changed** — took **281 seconds**, which is exactly
  the generation time for the ~22k tokens the unchanged 80 KB costs. Every
  revision in that chat lands between 271 s and 388 s regardless of how much
  actually moved. Files never had this problem because they have `Edit`; the
  canvas had only its `Write`. `edit` is that tool, `Edit`'s contract down to
  the wording of "not found" and "appears N times" so the model already knows
  how to recover, and the same change is now ~50 output tokens. `write` is left
  for creating a canvas or rewriting one wholesale.
  - **`CANVAS_SESSION_RULES` is half the fix**, and was previously half the
    bug: it *instructed* the slow path — "call `read` … then `write` with the
    SAME id". A tool the rules do not name is a tool the model does not reach
    for.
  - **A rename is an edit with no strings.** Re-sending 80 KB to change five
    characters of a title is the same defect at its most absurd, so `title`
    alone is a valid edit.
  - **The replacement is spliced by index, never through `String.replace`**,
    where `$&` and `$1` are substitution patterns — and a canvas is a document
    full of CSS and script that can contain either.
  - **Naming the row took two answers, because an edit carries an id and
    nothing else** — not re-sending the document *or its metadata* is the
    point of it. `CanvasLink` resolves the name out of the project's own
    canvas list while the call runs (so the row says which document is being
    edited from its first frame, where a write cannot know its id until the
    result lands), and the result prose repeats the title so a chat reopened
    after the list has moved on still reads correctly. `resolveCanvasTitle`
    sits beside `resolveCanvasId` rather than in the component, because
    resolving is that module's job and it is the half `node --test` can reach.
    `meta.summary` is *not* where a canvas row is drawn — `CanvasLink` owns
    that slot in `ToolCard`, so a label put there looks right and renders
    nowhere, which is what the first attempt did; it is still read by
    `ToolGroup` for the trailing text on a folded running run, which is why it
    stays. `demo/e2e/canvas-edit.js` pins the rendering, since no unit test in
    this repo renders.
  - **One argument is described once** (`CANVAS_TOOL_INFO.params`). It is
    spelled three ways downstream — zod for Claude's in-process server, JSON
    Schema for the stdio child Codex and Grok read, a field pick in the
    bridge — and hand-copying them drifted within the commit that added
    `edit`: `id` was described two different ways and `old_string`'s "omit only
    when renaming" reached Claude alone. All three are now derived, so the next
    argument cannot arrive on one provider and not the others.
- **Nothing is gated.** A canvas tool writes only Carbon's own database — no
  file, no process, nothing outside the app — so `mcp__canvas__` is auto-allowed
  beside `mcp__preview__`, in plan mode included: a plan that produces a
  document is still a plan.
- **The session rules have to disambiguate against `Artifact`.** Carbon sets
  `CLAUDE_CODE_ARTIFACT`, so a Claude session has *two* "make a document" tools
  and the other one publishes to claude.ai. Left unsaid, "make me a page
  comparing these" is a coin flip between a panel beside the chat and a URL.
- **The schema is additive and carries no `user_version` bump.** `userData` is
  shared between the dev and packaged builds and between branches, so an older
  build has to open a database this one wrote — which `CREATE TABLE IF NOT
  EXISTS` gives for free and a version bump is the one way to break.

**One tab per open canvas, plus the library.** This was built the other way
first — a single Canvas tab with a back button — and it is worth recording why
that is wrong: two canvases get read *side by side*, which is most of the point
of a document panel, and one slot makes comparing them a round trip through a
list. They are still deliberately not `openFiles` entries: a canvas has no path,
no dirty state, no preview slot and nothing to save, so riding that plumbing
would mean teaching every one of those rules a case that never applies. The
library tab exists exactly while `activeTab` is on it — the Files tab's rule —
and closes with a ✕ or ⌘W. It was pinned for as long as the project had a
canvas, which made it the one tab in the strip that could not be closed: a
project keeps its documents for good, so the library sat beside a dozen file
tabs with no way to give its space back. The ways in (the panel's + menu, the
launcher, the List button in an open document's header) all go through
`openCanvas(null)`, so none of them needs the tab to be standing already.

**The renderer is `<iframe sandbox="allow-scripts" srcdoc>`, and the two flags
are only safe apart.** With `allow-same-origin` the document could reach out of
its frame into the app that framed it; alone, `allow-scripts` gives it a unique
opaque origin — the script runs, and it can touch no cookie, no storage and
nothing of Carbon's. Preferred over the `<webview>` `BrowserPane` uses because
it is both simpler and the stronger boundary. **That the script runs at all is a
fact about this app specifically:** Carbon ships no CSP, and `about:srcdoc`
inherits the embedder's policy container — so adding one later would render
every interactive canvas silently inert, with no error anywhere to say why.

**The tool rows had to be taught the tool, in two places.** An `mcp__canvas__*`
call is not in `GROUPABLE_TOOLS` by default, and the run that produces a canvas
is almost always `ToolSearch` + `write` — so the two arrived as two separate
`AssistantBlock`s with a message-sized gap between them, which is the gap
grouping exists to close. `toolMeta` gives them `Preview`'s shape (one label for
the server, the call's subject as the summary) and `summarizeActivity` gets a
`Canvas` clause at Write's rank, because a canvas is a *result* of the turn
rather than part of its method: the row reads "Wrote 1 canvas, found 1 tool".
`PenLine` rather than `Shapes`, which is `Artifact`'s — two destinations sharing
a glyph would say they are one.

**A canvas needs a way in from the transcript, and grouping is what took it
away.** The turn's own prose names the document ("Canvas is up: TanStack Start
vs Next.js") and that text is inert, so the only link lived on the
`mcp__canvas__write` row — which, once the run collapsed, was one expand away
from a reader who had just been told a document existed. The link therefore
lands twice: `ToolMeta.open` gains a `canvas` kind, so the title on the tool row
opens it (the descriptor already existed for files and previews); and
`ToolGroup` carries an **Open** action on the *collapsed* row when the run wrote
one, beside the status, the way a published artifact's link rides a `ToolCard`.
**Recognizing the call is where the third provider broke it.** Claude and Codex
call the server tool by name; **Grok defers MCP tools behind its own
`use_tool`**, so the card arrives named `use_tool` with the real tool name and
arguments in the input — and an empty result text, so there is no id to scrape
either. Matched on `mcp__canvas__write` alone, a Grok canvas drew as an unnamed
`use_tool` row with no way into the document it had just written. `canvasRef.ts`
is the one recognizer (`test/canvasRef.test.ts`): it reads both spellings, takes
the id from the result prose the way `Artifact` does — written to yield nothing
rather than to trust a shape — and falls back to resolving the **title** against
the project's own list, which is the only handle a Grok call leaves behind.

**One component, one slot, one appearance — and it was two by accident.** A
Codex write joins a run, so its link sat in `ToolGroup`'s trailing slot on the
far right with an icon; a Grok write is not groupable, so its link was
`ToolCard`'s summary, inline and bare. Same feature, two looks, decided by which
provider spelled the call. `CanvasLink` is now rendered by both, immediately
after the row's own text, so every canvas row reads the same way: what happened,
then the document. What still differs between them is only the leading text — a
run's summary against a single call's label — which is the distinction the
transcript already draws everywhere.

The link is drawn as a link *at rest*, not on hover, and it says the document's
name: "Open" in the row's muted colour was there and unfindable, because it
named nothing and read as more narration. It also drops the mono face the
summary slot otherwise uses — a path is code, a canvas title is prose.

**A canvas can be attached to a prompt, and what it carries is *text*, not
HTML.** The document the agent just wrote is the thing the next question is
usually about, and until now the only way to ask about it was to describe it
back. `Attachment.kind` grew a `canvas` member carrying a `CanvasRef` — id,
title, extracted text — and `describeCanvas` (`attachmentText.ts`, beside
`describeSelection`) turns it into prompt text.

- **The text and the id both ship**, which is `describeSelection`'s bargain at
  one remove: the text answers "what does this say" with no tool call, and the
  id is what a revision is written against. Neither half is sufficient — an id
  alone costs a `read` round trip before the model can say anything, and text
  alone means the next "add a column" writes a *second* canvas with the same
  title, the exact failure `write`'s own result text already guards against.
- **`canvasText` (`shared/canvasText.ts`) is why it is text.** A canvas is a
  styled document: measured over the ten real ones in this database, 4–24 KB of
  HTML reduces to 0.9–7 KB of reading, ~70% of it CSS and script the model
  cannot act on. Regex rather than a parser, because the renderer builds the
  attachment and `node --test` runs the test directly, so neither may pull in a
  DOM (`test/canvasText.test.ts`).
- **Cell closes become ` | ` and block closes become `\n`, via sentinels.** The
  sentinel is the part that took two tries: injecting the newline directly makes
  a break we *chose* indistinguishable from the source's own indentation, and
  every table then arrives double-spaced. HTML collapses whitespace in text
  nodes to one space, so the collapse has to run *between* marking the breaks
  and emitting them. Without the cell rule at all, a comparison table — the
  single most common thing a canvas holds — comes out `Vite2.1swebpack14.8s`,
  every number silently reassigned to the wrong row. `<title>` is dropped with
  `<script>` and `<style>`: a canvas repeats it as its `<h1>` and the attachment
  carries the title separately, so keeping it says the name twice.
- **It is resolved at attach time in the renderer, never at send time in main.**
  The three adapters build their prompts in three different places, and one of
  them (`buildGrokPrompt`) is a free function with no session handle. A snapshot
  makes all three the same single line beside the selection line they already
  have — which is what "works on every provider" means here, and is pinned for
  Grok specifically (`test/grokAcp.test.ts`), the one with no SDK.
- **The cap is a drafts constraint, not a context one.** A canvas attachment
  carries no `data`, so `persistableAttachments` keeps it in a draft, and
  `localStorage`'s ~5 MB quota is the ceiling every draft shares.
  `CANVAS_ATTACH_MAX_CHARS` is 8000; past it the id still names the whole thing.
- **The way in is a row action, not an @-mention.** `@` matches `[\w./-]*` and
  canvas titles have spaces in them, so the mention path would have covered a
  fraction of the library while looking like it covered all of it. The button
  rides the list row and the open document's header — the code-selection pill's
  seam (`attachmentInbox`), so nothing new crosses IPC. The composer dedupes on
  `canvas.id` for the reason it dedupes files on `path`: a canvas sets no
  `path`, and the attachment id is minted per click, so without it the button
  stacks a chip per press.
- **The chip in the transcript is a *button*.** It is the one attachment whose
  subject is still there and one click away — a file chip's file is already in
  the tree, and a selection's lines have since moved.

**The canvas panel follows the project, and the leak was in the tabs rather
than the store.** Storage was project-scoped from the start (`canvases_project`,
`list(project)`), but the *UI* state was not: `openChat` cleared it on every
chat switch — closing the documents you had open when you moved between two
chats in one folder — while `openChat(null)` cleared nothing and refreshed
nothing, so leaving a chat for the home screen and picking another project left
the previous one's canvas tabs standing over the new one, their titles resolving
to a bare "Canvas" because the id was no longer in the list. `canvasScopePatch`
is the one rule at all three seams (`openChat` both ways, `setSelectedCwd`),
and what it does when `canvasProject` changes is **stash and restore**, not
clear. Clearing was the first version, and it meant a canvas open in project X
was gone the moment you looked at a chat in project Y and back: the chat's
`activeTab` came back as `canvas:<id>` — tabs are stashed per chat — but the id
was no longer in `canvasTabs`, so the panel fell through and the document had to
be reopened from the list every time. The outgoing project's tabs go under its
root in `canvasTabsByProject` (`tabsByChat`'s shape one level up); the incoming
one's come back out. `canvasHtml` is left alone across the switch — a cache
keyed by id, and keeping it is what lets a restored document paint at once. A
stale `activeTab` of `canvas:<id>` needs no handling — `RightPanel` already
falls through to the next real tab when `canvasTabs` does not hold it.

**The document has to be written for both themes, and only the rules can ask for
that.** `color-scheme` on the iframe rescues a document that styles *nothing*;
one that sets its own light background is a white sheet in a dark window, which
is what Codex produced unprompted. So `CANVAS_SESSION_RULES` asks for a
`prefers-color-scheme` counterpart to every colour — there is no way to enforce
it from this side without overriding authored CSS.

**The list sits beside the open document, not only in the library tab.** Once a
project has more than one canvas, moving between them is the common gesture, and
routing it through the Canvas tab makes every hop a three-click round trip.
`CanvasList` is one definition rendered in both places, so the two cannot drift.

**It starts closed, behind a real button in the canvas's own header** — and it
was built the other way first, which is worth recording because "collapsible"
was technically true of that version too. The toggle was a chevron *inside* the
list, so the only control that could close it existed only while it was open;
opened by default, in a pane this narrow, it took a fifth of the reading surface
every time and read as permanent furniture. A control that appears only in the
state it is meant to leave is not a toggle. So the header carries a `List`
button (Cursor's ☰), the document gets the whole pane until asked otherwise, and
the choice persists.

**Deleting always asks, and the dialog says something different from the file
one.** `DeleteFileDialog` can be reassuring — a file goes to the Trash and the
question is genuinely "are you sure", not "is this gone forever". A canvas is a
row in Carbon's own database with nowhere to go, so `CanvasDeleteDialog` says
that plainly instead of borrowing reassurance it cannot give. It is rendered by
`App` for that dialog's reason: the state is store state, and both surfaces a
delete can start from unmount the moment the panel switches tabs, which would
take the question off screen with the answer still pending.

**"Create new canvas" makes a *named target*, which is the only thing a user can
usefully make without an HTML editor.** The name is typed inline in the list —
the file tree's idiom, for the file tree's reason — and the empty canvas carries
a placeholder saying to ask the agent to fill it, since a blank pane reads as a
canvas that failed to load. The agent finds it by title through `canvas list`.

The panel is **never auto-opened**, the agents panel's rule at one remove (`docs/transcript.md`): a
canvas landing mid-read must not take the document you are looking at off
screen. The `canvas` `ChatEvent` carries the summary and never the HTML, so the
Recents list goes live during a turn without pushing a megabyte through the
event channel for a panel that may never open.

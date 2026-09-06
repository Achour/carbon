# The file editor, code selections, panel tabs and language servers

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The file editor (`CodeEditor.tsx`, `lib/editorBuffers.ts`)

Files are **editable**, not just readable. `FileViewer`'s `text` branch is a
CodeMirror 6 view; every other branch (Markdown preview, image, binary,
too-large) is untouched, and `DiffView` is deliberately not covered — its rows
carry their own line numbers and are a different problem.

CodeMirror over Monaco because Monaco brings VS Code's chrome and ~5 MB with it,
and because CM6 themes off CSS variables — which is what lets the editor repaint
on a theme change with **no** JS involvement. `editorTheme.ts` is installed once
and never rebuilt; the alternative is reconfiguring every open view each time the
appearance flips.

**Frontmatter is split off before the preview parses anything**
(`lib/frontmatter.ts`), and the reason is that CommonMark has an opinion about
`---` that is right in general and catastrophic here: the opening fence is a
thematic break, the keys under it are a paragraph, and the closing fence turns
that paragraph into a **setext H2** — so every `.claude/agents/*.md` opened as a
giant bold heading of run-together YAML. It is drawn as the key/value table Zed
and GitHub draw. The split is a *display* split rather than a YAML parse: values
keep their quotes and their colons (`description:` is full of both), indented
lines continue the key above them (`metadata:` / `  type: user`), and anything
that isn't a complete, non-empty mapping returns `null` so the `---` renders as
the horizontal rule it then genuinely is. It lives in `FileViewer`, **not** in
`Markdown` — a chat message may legitimately open with an hr, and frontmatter is
a fact about files. Dependency-free (`test/frontmatter.test.ts`), where
`remark-frontmatter` would have been a dependency whose default behaviour is to
drop the block entirely. The table carries its own classes for the same reason
the split does: `.markdown table` and the heading rules are shared with every
message in the transcript.

- **Dirtiness is cached, and compared as a rope.** `dispatchTransactions` fires
  for *every* transaction, and selection-only ones vastly outnumber edits —
  `MouseSelection` dispatches one per mousemove of a drag. So the early return
  sits above any comparison, and the answer is a field on the buffer. The
  comparison itself is `Text.eq` against a `baseDoc`, not a string compare
  against a `base`: `eq` skips shared subtrees by reference, so an untouched
  buffer settles on an identity check and an undone one on a few pointer
  comparisons, where flattening rebuilt the whole file each time.
- **The buffer lives outside React and outside zustand.** Outside React because
  `EditorState` has to survive a tab switch: the inactive editor is unmounted,
  and rebuilding its state on return loses undo history, cursor and scroll.
  Outside zustand because the document changes on every keystroke, and routing
  that through the store re-renders every subscriber twice a second — the same
  reasoning that keeps draft text in the composer. The store learns only about
  **transitions** (clean ⇄ dirty), which happen once per edit session.
- **Dirtiness is `doc !== base`, not a sticky flag**, so typing a character and
  deleting it leaves the tab clean, and so does undoing back to the saved text.
  The `length` check in front settles insertions and deletions without reading a
  character.
- **Everything keyed by a path is released by one call.** `dropBuffer` drops the
  state *and* the scroll offset; the offset used to live in the component, which
  made disposal a two-call ritual the sites disagreed about, and put a
  `store → component` import in the one direction this app never has.
- **A truncated read is never saveable.** `readFileContent` caps at
  `MAX_TEXT_BYTES`, and writing that buffer back would put the head of a file
  over the whole of it. Such a buffer opens read-only with a bar saying so. The
  cap itself moved 512 KB → 2 MB because its reason was highlight.js
  highlighting the whole blob eagerly; CodeMirror parses and renders by viewport,
  so the cost is now the read.
- **The post-turn refresh reconciles, it does not re-read.** `refreshFiles` runs
  at the end of every turn and used to pull every open tab's body back over IPC
  and overwrite it — correct for a viewer, *data loss* for an editor. It now
  stats first (`fs:stat-many`, mtime only), skips what hasn't moved, and for a
  file that has, dispatches the new text into the mounted view rather than
  replacing it, which would lose scroll and flash the pane.
- **`fs:write` takes the mtime the buffer was read at** and refuses on a
  mismatch. This collision is Carbon's own: the agent writes the files the user
  is editing, and neither side can be assumed to win — the buffer may be a
  half-finished thought, or a stale copy of what the agent just rewrote. So
  `ConflictBar` states the fact and offers both. The comparison is `!==` rather
  than `>`: a checkout or a revert moves mtime backwards and is still someone
  else's write.
- **A dirty preview tab stops being disposable.** Single-clicking another file
  reuses the preview slot, Cursor-style; doing that to a tab the user has typed
  into would destroy the only copy of those edits, so it gets pinned instead and
  the new file opens beside it. Closing a dirty tab asks (Save / Discard /
  Cancel), and a Save that hits a conflict leaves the tab open — closing it then
  would discard the edits under cover of the word "Save".
- **⌘F routes to CodeMirror's search panel on editor tabs.** `FindBar` collects
  ranges by walking the DOM under `#editor-find-scope`, and CodeMirror only
  materializes the *viewport* — a DOM search would silently report matches from
  the visible screenful alone, which looks exactly like a complete answer.
  FindBar still serves the diff view and the Markdown preview.
- **Unsaved edits survive both exits.** Closing a tab asks; closing the *window*
  and **quitting** ask the same question through one guard, because on macOS ⌘Q
  is the ordinary way to leave an app and a guard that only covered ⌘W would miss
  the common case. `dirtyFileCount` is pushed to main on every transition rather
  than requested at close time: `close` is synchronous about whether it is
  vetoed, and an IPC round trip inside it would have to guess. Two buttons, not
  three — a "Save All" would need the renderer to write every buffer and report
  back before the exit may proceed, and Cancel already puts the user where ⌘S
  works.
- **New files are named in the tree, not in a dialog.** The name is only half
  the decision — the other half is *where* — and a modal takes the tree off
  screen at the moment that matters. The inline row shows its own answer: the
  indentation is the parent folder. It sits at the top of that folder's children
  rather than in sorted position, because a row with no name yet has no place in
  the sort and one that jumped as you typed would be worse. `createPath`
  (`main/files.ts`) accepts slashes, so `lib/util.ts` makes the folders on the
  way — which is why the name is *checked* rather than trusted: a leading `/`
  escapes to the filesystem root and `..` climbs out of the project, and the
  resolved path is compared against the parent to prove neither happened
  (`test/createPath.test.ts`). Files are created with `wx` so a name that
  appeared between the existence check and the write is never silently emptied.
- **Renaming re-keys the buffer instead of reopening the file.** The document,
  its undo history, its cursor and its *unsaved* state are properties of the
  file, not of its name — so dropping the buffer and re-reading would silently
  discard edits at the moment the user was only relabelling something. The view
  is deliberately not moved with it: `CodeEditor`'s mount effect is keyed on
  `path`, so it rebuilds against the re-keyed buffer, which is also what rebinds
  the language server to the new uri. A renamed folder rewrites every descendant
  path — tabs, contents, dirty flags, expanded state — by prefix, carrying the
  separator so renaming `src` cannot rewrite a sibling `src-old`. The inline row
  is the same component as the create row with a starting value, and it selects
  the base name rather than the whole thing: renaming is almost always renaming
  the *name*, and arrowing past `.tsx` every time is the kind of small tax that
  makes a feature feel unfinished. `renamePath` shares `createPath`'s validation
  (`resolveChildPath`) because both take a free-text name from the tree and must
  refuse the same escapes — and it excludes the target-exists check for a
  case-only change, since on a case-insensitive filesystem `Foo.ts` → `foo.ts`
  collides with itself and is the first rename every macOS user tries.
- **Deleting goes to the Trash, and always asks.** `shell.trashItem`, not an
  unlink: a delete from the tree should be recoverable from the Finder the way
  it is in every other editor, and that is also what lets the confirm dialog say
  something true — the question is "are you sure", not "is this gone forever".
  A folder takes its contents, so every tab *under* it closes and its buffer is
  released; the prefix match carries a separator so deleting `src` cannot close
  a tab in a sibling called `src-old`. The dialog is rendered by `App`, beside
  `PublishDialog` and `FileSearchDialog`, because its state is store state and
  the tree it was opened from unmounts whenever the dock switches to the changes
  view — which would take the question off screen with the answer still pending.
  Failures are reported *on* the dialog rather than through `gitError`: the
  question is still up, and a locked file is something the user may be able to
  fix and retry.
- **Prose soft-wraps, code does not** (`wrapsLines`, `editorLanguage.ts`) — Zed's
  split, and the reason is that the two file kinds disagree about what a line
  *is*. A Markdown paragraph is one line to the file, so a horizontal scrollbar
  is the wrong way to read one; a wrapped line of code breaks mid-token, which
  is the same objection that keeps `diffWrap` off by default in the review. The
  list of prose extensions is explicit rather than "anything with no grammar",
  which would also catch CSV and TSV, where a row *is* a line. It rides
  `baseExtensions`, so it is fixed when the buffer is created, like read-only
  ness and unlike the two things that need a compartment.
- **Grammars are lazy.** `@codemirror/language-data` descriptors are `import()`s,
  so a user who only opens TypeScript never pays for Haskell; the mode lands a
  frame or two after first paint and is swapped into the live view through a
  `Compartment` rather than rebuilding it.

`--syn-*` (`index.css`) is the syntax palette, and it is now **one** definition
consumed by both highlighters — highlight.js for chat code blocks and the diff
view, CodeMirror for the editor. They were separate, which meant a token could be
one color in a message and another in the file it came from.

### Code selections (`lib/codeSelection.ts`, `CodeEditor`)

Select lines in the editor and an "Add to chat" pill (⌘L) puts them in the
composer as a `selection` attachment. It rides the same `attachmentInbox` seam
the browser's element picker uses, so nothing new crosses IPC.

- **The snippet and the reference both ship.** `describeSelection`
  (`main/attachmentText.ts`, shared by all three providers) writes a fenced block
  under a `path (lines a-b)` heading. The reference alone goes stale the moment
  the agent edits the file; the snippet alone gives it no address to edit. The
  fence is sized to outrun the longest backtick run *inside* the selection —
  source files are full of fenced examples, and a three-backtick fence around one
  ends at its fence, spilling the rest into the prompt as prose.
- **Offsets, not line elements.** `lineSelection` widens a character range to the
  whole lines it touches — a range reported as "12-14" has to *be* 12-14 — and
  backs off the newline a downward drag sweeps up on its way to column 0 of the
  next line, which would otherwise claim one line too many. That arithmetic is
  pinned by `test/codeSelection.test.ts`. It was written against a highlight.js
  blob, where a character offset was the only anchor that survived the `<span>`
  structure, and it **outlived that DOM**: CodeMirror reports its selection in
  exactly the same units, so the module carried over untouched when the editor
  landed. Only `offsetsInNode`, the half that measured the blob, is gone.
- **A selection deliberately does not set `Attachment.path`.** The composer
  dedupes its inbox on that field, so sharing it would collapse two selections
  from one file into a single chip. The file lives on `selection.path` instead,
  the way an element's lives on `element`.
- **`SELECTION_MAX_CHARS` exists because selections persist.** They carry no
  `data`, so `persistableAttachments` keeps them in a draft — an uncapped snippet
  would put a whole file in `localStorage`, which is the quota throw the drafts
  rule already guards against. Past the cap the line range still names every
  line, so the agent reads the rest itself.
- **The pill's label is computed from line numbers, its text is not.** Placing
  the pill runs on every selection transaction — every mousemove of a drag, every
  shift+arrow — so it reads `doc.lineAt`, which is O(log n) on CodeMirror's rope.
  `lineSelection` needs the document *as a string*, and calling it there would
  allocate a full copy of the file per frame; it runs once, in
  `addSelectionToChat`, when the click actually happens. The newline back-off is
  `trimTrailingNewlines`, shared by both: it takes a character accessor rather
  than a string so the module stays dependency-free *and* the editor can read off
  the rope. Written twice it had already drifted — the copy backed off one
  newline where the tested original backs off every one, so a pill could name a
  line the attachment did not. The pre-editor version had the same rule for
  the same reason, enforced differently: it measured on `mouseup` rather than
  `selectionchange`, because resolving a DOM offset walked the text before it.

The pill is positioned in the editor's *content* coordinates and recomputed on
scroll, so it travels with the code; a fixed-position element detaches from the
lines it names on the first wheel tick. The **diff view is not covered** — its
rows carry their own line numbers, so mapping a selection there is a different
problem, not this one.

### The panel's tabs (`RightPanel.tsx`, `lib/tabOrder.ts`)

- **⌘W is decided in the renderer, and the menu had to give it up first.** The
  File menu bound ⌘W to Electron's `close` role, and a menu accelerator is
  consumed in *main* before any `keydown` reaches the window — so the key every
  editor uses to close a file closed Carbon's window, and no renderer handler
  could ever have caught it. File → Close Tab now sends `ui:close-tab`; the
  panel resolves what "close" means for the tab it is on (a dirty file still
  asks, through the same `requestCloseFile` as the ✕), the derived tabs
  (Agents, the Canvas library) ignore it, and with nothing open it asks main
  for `window:close` — through `win.close()` so the unsaved-edits veto runs.
  Close Window keeps the role on ⌘⇧W. It is a store *tick* rather than an
  action that closes something, because `current` and the confirm dialog both
  live in the panel; the effect keys on the tick alone and reads everything
  else through a ref, since `current` in its deps would close on every switch.
- **Browse mode has a tab, and it is *opened* state.** Picking Files from the
  launcher docked the tree under an empty pane with nothing in the strip and no
  way to leave it. The tab that fixed that was derived — it existed exactly
  while `activeTab === 'files'`, the way the Canvas library's still is — which
  makes a tab that closes itself the moment the panel moves anywhere else: open
  a file, glance at the Working Tree, click a preview, and browsing was over
  with no way back but the launcher. So `filesTab` is a boolean the ✕ and ⌘W
  clear, riding `tabsByChat` beside `openFiles`/`activeTab` (a restored
  `activeTab: 'files'` under a global flag would select a tab the strip is not
  drawing). It is also the *last* fallback in `RightPanel`'s `current` chain:
  standing alone in the strip it must draw the tree, not the launcher's
  "nothing is open".
- **A tab moves only within its own kind.** Files, canvases, terminals and
  previews each keep their own array and the strip draws them in that fixed
  sequence, so a drop on another kind is a no-op rather than a jump to the
  kind's edge. `moveItem` is pure and pinned by `test/tabOrder.test.ts` —
  removing the dragged item first shifts every index past it, which is the
  off-by-one that reads right. The drag carries `application/x-carbon-tab` so
  the composer's file-drop highlight, keyed on `Files`, stays dark under it.
- **Gitignored entries are dimmed by asking git, per listing.** `listDir` runs
  `check-ignore --stdin -z` from inside the folder it just read — one probe per
  expand, no repo root needed, tracked files never reported. Exit 1 (nothing
  matched) and 128 (not a repo) are answers, and a timeout degrades to undimmed:
  a listing waits at most `IGNORE_PROBE_MS` on git and never fails for it. The
  cost is one git process per listed folder — on expand and on the tree refresh
  at every turn's end — typically tens of milliseconds.

### Language servers (`src/main/lsp.ts`, `lib/lspClient.ts`)

⌘-click a symbol (or F12) and the definition opens, cross-file. This is LSP, and the split
is the reverse of every other integration in the app: **main does no protocol
work at all.** `@codemirror/lsp-client` runs the whole of JSON-RPC in the
renderer, so `main/lsp.ts` is a spawn plus `Content-Length` framing, and the
`Transport` seam the package asks for is satisfied by IPC that already existed.
That keeps the protocol next to the editor that needs it, and keeps main off the
critical path of every keystroke's `didChange`.

**Carbon ships no servers**, for the reason `providerCli.ts` ships no CLIs: a
vendored server is stale by the next release, and the user's own is the one their
project is written against. Resolution is project `node_modules/.bin` → PATH →
install prefixes — the *reverse* of `providerCli.ts`'s order, and for the same
underlying reason. There the user's shim wins because the CLI is a tool they run;
here the server must agree with the TypeScript version in the repo's lockfile.
Which, for TypeScript 7, it now literally is: see the first bullet.

- **TypeScript 7 *is* a language server, and it is already in the project.** The
  native compiler answers `initialize` under `--lsp --stdio` with
  `definitionProvider: true`, so a modern TS project needs nothing installed at
  all — the best possible reading of "Carbon ships no servers", since the server
  is the one in the repo's own lockfile by construction. It is tried **first**,
  resolved by *path* rather than by name
  (`node_modules/@typescript/typescript-<platform>-<arch>/lib/tsc`) and gated on
  that file existing. First place is not a preference, it is a correctness
  requirement: `vtsls` and `typescript-language-server` both wrap `tsserver.js`,
  which TypeScript 7 **does not ship**, so on such a project they are not a
  fallback but a broken one — and the install hint would send the user to fetch a
  server that cannot read their code. A TS 5 project never has that package, so
  first place costs it nothing. `ServerSpec.resolve` is what makes this safe:
  a spec that knows where its server lives skips the generic search entirely,
  because `bin` is `tsc` and the `tsc` on PATH is usually a *compiler* that would
  be spawned as though it spoke LSP.
- **It is `typescript-language-server`, not `tsserver`.** Raw tsserver speaks
  TypeScript's own protocol and fails `initialize` outright. For a pre-7 project
  `vtsls` is tried first, so a repo that pins it gets it; a global `tsgo` comes
  last, because it says nothing about the project it is pointed at where a
  project-local `vtsls` was chosen for that project specifically.
- **An installed server can still refuse to start**, and the common case is
  `typescript-language-server` in a project with no TypeScript for it to load.
  `initialize` is therefore awaited before the extension is handed to the editor,
  which turns that into "no language features" — the same answer as a missing
  binary — instead of an unhandled rejection and an editor posting requests into
  a dead process. **That** failure is cached: a server that cannot initialize will
  not initialize for the next file either, and retrying per tab spawns a doomed
  process every time one is opened.
- **A missing server, by contrast, is not cached** — and the distinction is the
  whole point. Re-probing costs a few `stat`s in main and spawns nothing, and this
  is the one failure that heals on its own: a fresh worktree is opened before
  `setup.sh` finishes, so `node_modules` — and with it the project's own server —
  appears a minute after the first file does. A cached null left that project
  with no jumps until it was reopened.
- **A missing server is not an error, but it must not be silent either.** It used
  to be exactly that: a `console.info`, a ⌘-click that did nothing, and no way to
  tell an absent server from an absent definition. That is a working feature that
  looks broken. Two things fix it, and neither is a banner — the state is normal,
  so it may not become permanent chrome:
  - **The pointer only arms when something can answer.** `cm-jumpArmed` is gated
    on the LSP plugin actually being present. A hand cursor over every identifier
    in a project with no server is an affordance that lies.
  - **A jump that goes nowhere says why**, in a transient notice placed at the
    symbol — on F12 as well as on a click, which is why F12 is a listener on the
    editor host rather than a keymap entry: a `Command` returns a boolean and has
    no way to reach the notice, and a gesture that explains itself with the mouse
    but not with the keyboard is the same silence half-removed. The wording separates *unavailable* (no server for this language, one
    not installed, one that failed to start — with the install command, since
    there is something the user can do) from *absent* (this symbol has no
    definition, a normal answer about one click).
- **`jumpToDefinition` is reimplemented rather than imported**, and only to get
  that distinction. The packaged command is a `Command`, so it returns a
  synchronous boolean meaning "a request was sent"; the interesting outcome — the
  server answered with nothing — resolves inside a promise it swallows. Every
  piece it uses is public API, so the honest version costs ~20 lines and one
  request. It also normalizes `LocationLink`, which a server may return even
  though we never ask for it, and which the packaged version would read as a
  jump to `undefined`.
- **One server per (project root, language)**, shut down five minutes after the
  client releases it — a cold tsserver on a large repo is seconds of nothing, and
  closing a project then reopening it is common. There is deliberately **no
  refcount in main**: the renderer caches one client per key, so it asks once and
  releases once, and a count here would have described a lifecycle main never
  sees. One owner — the renderer decides when a server is done, `LspManager`
  decides how long to wait before believing it, and `releaseAllServers` rides
  `beforeunload`.
- **`CarbonWorkspace` exists for `displayFile`.** The package's default workspace
  can only return an editor that is *already* open, which makes a jump into an
  unopened file silently do nothing — and that is the majority of jumps. The
  override goes through the store's own `openFile`, so the target lands in a
  normal Carbon tab, then waits for CodeMirror to mount.
- **Diagnostics are a client concern, and there are two of them.** Two traps
  stacked here. First, `languageServerSupport()` and `languageServerExtensions()`
  look interchangeable and are not — only the latter carries
  `serverDiagnostics()`, because `publishDiagnostics` is a server-*initiated*
  notification whose handler belongs to the `LSPClient` rather than to any one
  editor; wiring the editor bundle gives completion, hover, signature help and
  jumps with no squiggle anywhere. Second, `serverDiagnostics()` cannot be used
  *at all* here: it dispatches `setDiagnostics`, which **replaces** the entire
  diagnostic set, so it and any `linter()` erase each other and the file shows
  its syntax errors or its type errors depending on which fired last. Lint
  *sources*, by contrast, are collected and batched — so `lspDiagnostics.ts`
  re-implements the handler to park the raw payload and re-emit it from a
  source, and `editorDiagnostics.ts` joins it with the grammar's. The client
  therefore takes the bundle spelled out minus `serverDiagnostics()`, and each
  editor takes `client.plugin(uri, languageId)`.
- **Syntax errors need no server.** Lezer already parses every open file to
  highlight it, and it recovers from bad input by marking error nodes rather
  than stopping — so "where are the syntax errors" is a walk of a tree that
  exists anyway. That is what makes an unclosed brace visible on a machine with
  nothing installed, which is the normal case: Carbon ships no servers. Type
  errors, imports and symbols still need one. Two shapes have to be handled: a
  *missing* token is a zero-length node, and a zero-width range draws no squiggle
  at all, so `widenPoint` (dependency-free, `test/diagnosticRange.test.ts`) moves
  it onto a real character **on its own line** — taking the newline would mark
  the line below. An error on a blank line, which is where an unclosed bracket at
  end-of-file lands every time a file ends in a newline, falls back to the last
  line with content; dropping it instead meant the single most common syntax
  mistake rendered nothing at all.
- **The raw LSP payload is stored, not the converted diagnostics.** Positions are
  line/character pairs against the document the server last saw, so converting
  them at lint time — through the plugin's `fromPosition` and its record of
  unsynced local edits — is *more* accurate than converting on arrival and
  letting the result drift behind subsequent typing.
- **Errors below the fold need a number.** A squiggle only says something about
  the lines on screen, so a count chip sits bottom-right and opens
  CodeMirror's lint panel. It recomputes only when a `setDiagnosticsEffect`
  actually lands — once per server push, not per keystroke. Squiggles are a real
  `text-decoration: underline wavy` rather than CodeMirror's repeating
  background image, so they stay crisp at any zoom and take a theme color:
  `--destructive` / `--warning`, which mean *state*, and deliberately not a
  `--syn-*` hue, which means *identity*.
- **A finished turn invalidates the server's view of the project.** Open tabs
  re-sync themselves, but a file the agent rewrote and the user never opened is
  still cached, and a server answering from it sends you to a line that has
  moved. `workspace/didChangeWatchedFiles` on the idle transition is what stops
  that, keyed off the same `lastTurnEditedPaths` the git scope uses.

`LspManager` takes its emitter in the constructor, like `TerminalManager` and
`PreviewManager` — the other two modules in main that own live child processes.
Its one concession is an explicit field instead of a parameter property, because
`test/lspFrames.test.ts` imports this file directly and `node --test`'s
type-stripping rejects the shorthand. Binary discovery is `providerCli.ts`'s
`isExecutable`/`onPath`, exported rather than copied; only the *ordering* differs
(project-local first here, PATH first there), which is the real distinction.

`splitFrames` is pure and pinned by `test/lspFrames.test.ts`: `Content-Length`
counts **bytes**, a message can arrive split across several `data` events and
several can arrive in one, and slicing the decoded string instead of the Buffer
is off by one per non-ASCII character — which is every file with an emoji or a
curly quote in it.

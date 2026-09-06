# Performance: first paint and streaming

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### First paint, and the cost of every message (`lib/preloadHeavy.ts`, `lib/lspBridge.ts`, `main/shellEnv.ts`)

None of these was a slow algorithm. Each was work happening at a moment nobody
had chosen — between the click on the icon and a window, in front of the first
turn, or on every message of every turn.

- **The PATH is remembered, not re-derived.** `hydrateShellPath` is a synchronous
  `zsh -ilc` inside `app.whenReady()`, ahead of `createWindow()` — so every
  millisecond the user's shell spends sourcing nvm, oh-my-zsh and conda is a
  millisecond with no window on screen: 0.12 s on a bare config, routinely
  0.5–2 s on a real one, at every launch. **Reordering it behind
  `createWindow()` is not the fix** — the managers built in between resolve
  provider binaries through this PATH, and `registerIpc()` has to be in place
  before the renderer can call anything. So userData holds the previous launch's
  PATH and it is applied immediately while the shell is re-read in the
  background, both to rewrite the cache and to pick up anything installed since.
  Only a first-ever launch spawns a shell. Staleness is bounded by construction:
  every launch refreshes, so the cache is never more than one launch behind, and
  this launch heals itself a moment after opening rather than at the next one.
  `app.setPath('userData')` moves above it, which only records a location.
- **Resolving a binary is a few `stat`s; reading its version is a *process*.**
  `readVersion` is `execFileSync` with an 8 s timeout, and it used to be reached
  lazily through the first `cliPath` — which wants a path and nothing else — so
  the stall landed not at launch but at whatever moment the first turn started,
  with the `chat:event` channel feeding the transcript blocked behind
  `claude --version`. The two are now separate: `providerCli` stays synchronous
  and cheap, and versions are read asynchronously and in parallel by
  `providerClis`, which is Settings → Providers — the one caller that needs them
  and therefore the one that pays.
- **The heavy renderer chunks are split out *and* warmed on idle**, which is the
  half that keeps the split honest. The entry chunk was 6,720 kB, all parsed and
  evaluated before anything appeared; it is 2,733 kB. `import hljs from
  'highlight.js'` registered ~190 languages and bought nothing even in
  principle: the *finished* markdown in a message is highlighted by
  `rehype-highlight` over lowlight's 36-language `common` set, so the extra 150
  could only ever appear on the two surfaces calling `highlightCode` directly —
  a streaming fence and the diff view — and would lose their colour the moment
  the turn ended and the full parse replaced them. `HLJS_LANGUAGES` is now one
  definition fed to both, the way `--syn-*` is one palette rather than two that
  agree by coincidence. mermaid, CodeMirror and xterm are dynamic imports
  preloaded by `preloadHeavy.ts`: lazily loading a surface without warming it
  does not remove its cost, it moves it to the first click on a file, the first
  terminal tab and the first diagram, where it lands as a hitch in the middle of
  a gesture — and at launch nobody is mid-action. They warm **one at a time**,
  because fetching is off-thread but *evaluating* is not, and ~2 MB of it back
  to back is exactly the long task that drops a frame if someone starts typing
  halfway through.
- **`lspBridge` inverts a dependency rather than deferring one.** `lspClient.ts`
  pulls ~470 KB of `@codemirror/*` and was imported statically by `store.ts` and
  `main.tsx` — the two modules on the path to first paint — so lazy-loading
  `CodeEditor` alone would have moved none of it. Both callers want the same
  thing: tell the servers something *if any are running*. If none are, no editor
  was opened and there is nothing to say, which is precisely the case a dynamic
  `import()` at the call site gets wrong, by fetching half a megabyte to
  discover it had nothing to do. So the client registers itself when its chunk
  lands and every call is a no-op until then — which is also the only shape that
  works for `releaseAllServers`, running on `beforeunload`, where an
  `await import()` could never finish.
- **The sidebar redrew on every assistant message** — on Claude, every tool call
  — because `applyEvent` remapped `chats` to bump `updatedAt`, minting a new
  array that every subscriber compares by identity, and `Sidebar` had no memo
  anywhere in its 1,816 lines. `updatedAt` is *display* state here (main owns
  the persisted value and re-states it in a `meta` patch at the turn's end) and
  both surfaces drawing it are coarse — a minute, then a day — so the bump is
  skipped when it would redraw nothing, and a row still ticks over on the
  message that genuinely crosses a boundary. **The skip must not return `{}`**:
  zustand assigns a fresh state object for an empty patch and runs every
  subscriber's selector against it. `ChatItem` is then memoized behind one
  stable `RowActions` built per mount — each handler takes the chat it acts on
  instead of closing over it, and anything volatile is read at click time
  through a ref refreshed every render, so a stable identity never means a stale
  menu. Its comparison is written out rather than left to the default, because
  `chatActivity` and `chatDetail` return a fresh object per call that a shallow
  compare reads as a change every time.
- **An open code fence skips the markdown parse.** Nothing inside a fenced block
  is a seal boundary — that is what keeps the chunk split correct — so an open
  fence is the one block whose live tail grows without bound, and an agent
  writing a file into chat is exactly that case: a 400-line block was ~16 KB of
  markdown re-parsed, re-highlighted and rebuilt into thousands of token spans
  ~8 times a second. `splitMarkdownStream` now reports the open fence separately
  and its body skips the parse entirely (a fence's content is opaque text by
  definition), drawn as one memoized row per line — 37 long tasks and 2,168 ms
  of blocked main thread over a 14 s reply, both to zero. The body is
  highlighted **whole and only then cut into lines**: per-line highlighting is
  cheaper and wrong, since hljs carries state across lines (a block comment
  colours everything below it) and v11 dropped the `continuation` parameter that
  used to expose it. A mermaid fence declines the fast path — its block renders
  a diagram, so it stays the markdown parse's problem — and only a column-0
  fence is lifted, since an indented one is a list item's content.
  `languageFromFenceInfo`, `isMermaidFence` and `highlightCode` are one
  definition each, shared by the streaming and settled renderers, because the
  two disagreeing about the same string is what made an info string like
  `ts title=foo.ts` stream plain and snap to colour at the fence's close (mdast
  hands remark only the first word, hence `languageFromFenceInfo`'s fallback).

### Smooth streaming (`lib/streamReveal.ts`, `useStreamText`)

A reply used to arrive in lumps — five or six words at once, eight times a
second — and the cause was that **both buffers in the path were throttles and
neither was a pacer.** Main coalesces deltas for ~80ms because per-token IPC and
a persist per token are too expensive; the renderer committed at most every
120ms because a markdown re-parse per token makes the window feel hung. Both are
right about cost. But each commit *jumped* to the latest string, so the
smoothness the model was already producing was quantized away on the last hop.

The renderer's throttle is now a drain. The full text is held and the visible
prefix walks toward it on animation frames, closing a share of the gap each
time.

- **A share of the backlog, not a fixed rate.** A constant characters-per-second
  either crawls behind a fast model or races ahead of a slow one; closing a
  fraction is self-tuning, and the resulting deceleration reads as natural rather
  than mechanical. `DRAIN_MS` is a time constant, so the backlog decays
  exponentially — most of it inside one constant, all of it within two or three.
- **The step is word-atomic, and the still-arriving word is held back.** This is
  the difference between a smooth reveal and a typewriter: character-by-character
  puts `**bold**` on screen as `*`, then `**`, then `**b`, a flash of literal
  asterisks that snaps into bold a frame later, on every emphasis in the reply. A
  word is the smallest unit that keeps inline markdown intact, since none of its
  delimiters contain a space. The cost is one word of latency — less than the
  120ms commit already cost. Two escapes: a trailing run past `MAX_HELD_WORD` is
  revealed rather than held (a data URI is one "word" thousands of characters
  long), and the hold lifts once the text has been still for `IDLE_MS`, so a
  reply ending in "." — which is most of them — is not left a word short waiting
  for a delimiter that is never coming.
- **The frame loop stops when it is caught up**, re-armed by the next `text`
  change rather than spinning at 60fps over an empty backlog. Because a step that
  advances runs on to a word boundary, re-renders land at roughly the rate words
  arrive (~10–20/s), not at the frame rate.
- **It starts fully revealed.** A block that mounts mid-turn — a reopened chat, a
  remount — shows what is already there instead of replaying the whole reply as a
  typewriter. Only growth from that point is paced.
- The elapsed time per frame is clamped: a backgrounded window fires its first
  frame minutes later, and an unclamped delta would reveal everything in one
  jump, which is exactly the behaviour this replaced.
- **The scroller follows the column's *height*, not the store.** The pinned
  follow was an effect keyed on `[messages, permissions, status]`, and the
  drain above is precisely what that misses: words are revealed on animation
  frames *between* deltas, the held last word is released 400ms after the
  final one with no store change at all, images decode late and a collapsible
  animates its height over 200ms. Each grew the column under a scroller still
  parked at the previous height, so the reply's last line sat just below the
  fold and the stream read as stuttering. A `ResizeObserver` on the reading
  column (and on the scroller, for a window resize) fires after layout for all
  of them, and `pinnedRef` is the only guard it needs — `loadEarlier` unpins
  before it prepends, so a prepend never snaps the reader back down.
- **A message keeps its DOM when it stops being live.** With the pacing right,
  the last visible seam was the *transitions*, and there were two, measured
  with `demo/e2e/stream-probe.js` (which pumps a Claude-shaped and a
  Codex-shaped turn through the real reducer and checks whether nodes survive).
  First, history was a memoized `MessageHistory` component and the live message
  its sibling — a different React parent, across which keys never match — so
  when the turn moved on the whole message was unmounted and mounted again: on
  Claude every settled Edit or Bash row replayed its enter animation the moment
  the *next* (usually blank) message opened, every finished reply was re-parsed,
  a diagram blanked to its source; at the turn's end the same happened to the
  last message on every provider. `useHistoryNodes` keeps the memo (the same
  element objects come back while the prefix is untouched, which React skips by
  identity) but returns an *array*, spread into **one** keyed array with the live
  node — spelled `{[...history, live]}` and deliberately not `{history}{live}`,
  which is two children and an implicit fragment, i.e. two parents again. The
  live node takes exactly the key and element shape `renderMessages` will give
  it (`groupKey` for a run, the message's own `Fragment` otherwise), so crossing
  over is a prop change. Second, streamed text was `StreamingMarkdown` and
  settled text `<Markdown>`, and a type change is a rebuild regardless of key;
  on Codex, whose turn is one accumulating message, that fired every time a tool
  call landed after a paragraph. `AssistantMarkdown` draws the chunked tree in
  both states — the chunk strings are the same strings, so every memoized body
  is skipped at settle — and falls back to the single whole parse only when the
  text carries something a chunk cannot resolve alone (`needsWholeParse`: a
  link or footnote definition, an HTML block that may span a blank line), which
  is the one thing the old settle-time parse was for. What still remounts, by
  design: a lone call becoming the first row of a group, and a run whose
  summary card hides its edits down to a single card.
- **The foot's "Thinking…" / "Working…" is a slot and a label, and they follow
  different rules.** The *slot* is reserved for as long as the turn runs
  (`showActivity`): keyed on whether a call was in flight it unmounted and
  remounted once per call, and the ~28px it takes moved the foot of the column
  each time. The *label* draws only while nothing else on screen is moving
  (`showActivityLabel`): drawn unconditionally it sat under a tool row that
  already carried a spinner and under a paragraph still growing — the same
  statement twice, and the reader noticed. So it appears before the turn has
  produced anything, and again once the tail has been still for `QUIET_MS`
  with nothing moving in the live block — no running call (`groupRunning`, the
  group row's own test) and no shimmering thought header: Codex streams its
  reasoning visibly, and `ThinkingBlock` says "Thinking…" for as long as the
  thought is the message's last part, the pause after its final delta
  included, so on Codex that header is the motion and the foot stays empty
  under it (`demo/e2e/foot-probe.js` pins both shapes).
  The clock is the **drawn shape** of the last message that draws anything
  (`drawn`: each call's status and how much of its input has arrived, each
  text's length), and deliberately not the last message's identity. Every
  streamed event replaces the message object, and several of them draw
  nothing — a withheld thought's once-a-second token ping, a blank thinking
  message opening between two of Claude's calls, a reasoning item Codex
  re-states on completion with no text — so keyed on identity the label hid
  and came back `QUIET_MS` later two or three times per step, which a timeline
  probe of a real Codex turn showed and the reader called flashing. `QUIET_MS`
  sits above the held word's ~400ms release, so the label never shows under
  text still being revealed, and below the pause of a slow step, which is the
  silence it is there to explain. It fades in *and out* rather than entering
  or cutting: the slot was already there, so a slide would claim something
  arrived, and a hard cut beside a row that has just started moving is a blink.
- **A running group's row trails its last call only while folded.** The
  trailing mono summary ("what the last call is on") was drawn whenever the
  group was running, and a live group is open — so the command sat at the end
  of the summary sentence *and* one row below it with its own label. It now
  shows only when someone has folded a running group shut, which is the one
  state where the motion would otherwise be invisible. And the shell verbs
  `humanizeShellCommand` names (`Create folder`, `Copy`, `Move`, `Remove`)
  have clauses in `summarizeActivity`; they fell to the unknown-label fallback
  and printed `create folder ×1` in a sentence where everything else has a verb.

# The transcript: activity rows, checklist, prompts, agents

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The transcript's activity rows (`ToolCard`, `ToolGroup`, `lib/toolSummary.ts`)

What a turn *did* is narration between its paragraphs, and it used to be
furniture: every call, and every group of calls, was a rounded bordered card
with an icon, a chevron and a green tick. A turn that read six files drew six
boxes through the middle of a conversation — the eye stops at each one, and what
it stops for is a step nobody needed to check. They are now muted text rows,
Cursor's shape, and the box is not lost so much as moved one click away, to
where the output already lived.

- **The mark came back; the box and the tick did not.** Dropping the card took the
  glyph with it, and that was one thing too many: a column of twenty rows all
  opening with the same weight of grey word is read linearly, where a column of
  marks is *skipped* — terminal, terminal, page, globe — until the one that
  matters. So every activity row leads with `ToolMeta.icon` again, at
  `size-3.5` and `text-muted-foreground/60`: quieter than the label beside it,
  the same size as the spinner and the ✕ at the other end of the row, and
  destructive when the call was. What is not back is the chrome the glyph used
  to arrive in.
- **The glyph follows the *label*, never the tool's name.** `Bash` is the case
  that proves it: `humanizeShellCommand` renames the shell's own verbs, and
  Codex does most of its file work through them, so a row saying "Read" would
  have drawn a terminal on Codex and a page on Claude *for the same act*.
  `SHELL_ICONS` is keyed on the humanized label instead, and every spelling of
  a search shares one mark — the same reading `toolSummary.ts` commits to by
  counting grep, glob, `rg` and `find` as one clause.
- **A group draws its first clause's glyph**, off the same grouping pass that
  ordered the words (`leadActivityLabel`). Not the most frequent kind and not
  the first call: the sentence leads with what the turn *changed* rather than
  how it got there, so a run that read nine files to write one says "Wrote 1
  file, read 9 files" and draws the pen. Two passes sorting independently would
  drift the day a rank moved, and a folder glyph over the words "Edited 1 file"
  is the kind of wrong nobody reports.
- **Grok's `use_tool` is unwrapped before any of this** (`unwrapGrokTool`). The
  CLI defers its whole MCP catalog behind that one name, so a browser click, a
  preview screenshot and a canvas read all arrived as `use_tool` with a wrench —
  the same calls Claude and Codex draw as a browser and a preview. Renaming the
  wrapper's `tool_name` into the `mcp__server__tool` shape the switch already
  reads is what makes the three providers agree, and a server nobody has a case
  for still lands on the generic MCP row under *its own* name. Grouping still
  sees `use_tool`, so those calls stay separate rows on Grok.
- **The label leads and the chevron trails it.** That ordering is the whole
  reason the rows read as prose: a disclosure in front indents every row by its
  own affordance, and a line that narrates has to start on the same column the
  narration starts on. A glyph in front does not, because it is the same width
  on every row and the words still start on one column. The chevron's space is
  *reserved* and only its opacity moves — rendering it on hover reflows the text
  under the pointer, which reads as the row flinching away from the cursor.
- **Success draws nothing.** A green tick on every finished step is a column of
  ticks confirming the unremarkable; the row is written in the past tense, which
  already says it finished. Failure cannot be carried by wording, so an error or
  a denial keeps an explicit glyph *and* turns the row's own text destructive —
  a lone icon at the end of a muted line is easy to read past.
- **A group's summary does not go red for a call inside it.** The row is a
  description of several calls, not a call that failed, and "Ran 7 commands" in
  destructive red says all seven did when six succeeded. The ✕ is kept, because
  once the group is collapsed it is the only thing left saying so; the red text
  is not, because one row below is already saying it exactly.
- **A run is open while it works and folds itself when it lands.** A fixed
  default cannot express this and both fixed defaults are wrong: collapsed hides
  the only thing on screen still moving, open leaves a finished forty-call turn
  unreadable. `useRunDisclosure` holds `boolean | null`, and `null` — "nobody has
  said" — is deliberately not `false`: storing a boolean up front would make the
  first auto-close look like a user decision and pin the row shut for the rest of
  the chat. A click wins from then on. `AgentCard` takes the same rhythm while
  keeping its own chrome, because a spawned agent is a nested conversation with a
  model and a spend rather than a step.
- **What opens it is `live`, not "a call is running"** — and the difference is
  the whole feature working or visibly failing. Between any two calls in a run
  there is a moment when the last has returned and the next has not started, so a
  row keyed on call status collapsed and reopened *once per call*: a
  seven-command run flickered seven times. `ChatView` owns the only correct
  answer — its `liveRun` exists exactly while the chat is busy — and passes it
  down. `running` is still OR-ed in so a group holding a backgrounded agent that
  outlives its turn does not shut on it, and a **lone call never opens itself**:
  it is in flight for a few hundred milliseconds and is not a block.
- **`dense` now suppresses only the enter animation.** A call reads the same
  wherever it sits, so the styling no longer forks; the rows arrive together when
  a group opens, and a dozen of them each playing their own entrance is a stutter
  rather than an arrival.
- **The expanded calls are flush, not railed.** The calls a run made are the same
  kind of line as the row summarizing them. An indent would say they are a
  different kind of thing, and at three levels (group → call → its output) it
  walks the transcript steadily rightwards.
- **A long call carries a clock on its collapsed row, and only a long one.** A
  spinner beside `npm test` for a minute reads as hung; a `Read` returns in a
  few hundred milliseconds and a number on it is a flicker. So
  `ToolPart.startedAt` — stamped at first sighting by all three adapters, and
  carried across Codex's wholesale part rebuilds — draws `12s` beside the
  spinner once a call has run past `ELAPSED_AFTER_MS`, ticking in the component
  the way the agent clock does. It is `startedAt` and not the SDK's
  `tool_progress`: that message is declared, and the CLI binary contains its
  emitter, but a probe of a 7.7-second Bash call on 2.1.258 produced zero
  frames of it, and it carries elapsed time only — no stdout — so it could not
  have shown more than the stamp does. Live Bash output for Claude is not
  available through the SDK.
- **An Edit is a diff, inside the panel.** `old_string` over `new_string` as a
  red block and a green block meant reading forty lines to find the one that
  moved. `lib/lineDiff.ts` (LCS over lines, prefix and suffix trimmed, a cell
  cap past which it degrades to the two-block answer; `test/lineDiff.test.ts`)
  draws the change in its context, and it renders *progressively*: the
  streamed `new_string` prefix diffs against the whole `old_string`. Until that
  prefix has a first character the replacement reads as unchanged rather than
  as every anchor line deleted for a beat. Nothing about the collapsed row
  changes — a row is one line, folded, and stays so.
- **A result is cut to its tail, not its head.** The one output people open is
  a failed build or test run, and the error is at the bottom; keeping the first
  6,000 characters hid exactly that. `OutputBlock` keeps the last, cuts on a
  line boundary, says how many lines are above the cut, and shows all of them
  on one click.
- **Enter allows and Esc denies a permission prompt**, on the oldest plain one
  (a question has several answers and a plan has its own review, so neither
  takes keys), and the prompt that owns the keys says so in its own header band.
  The listener rides the window in the bubble phase, and `keyMayAnswer` is what
  keeps it honest: nothing focused, or the composer with nothing typed — read
  off the DOM, since the composer keeps its text out of zustand on purpose. A
  non-empty composer is a message being written, and any other input is a
  dialog. The prompt itself no longer lives in the transcript at all; see **What
  the agent asks you** below.

**`summarizeActivity` is the part that carries information rather than style.**
A mixed run said `Workspace activity · 7 actions` — a count of the one thing the
reader can already see, and a name for none of it. Every kind in the run now gets
a clause and a count: `Edited 1 file, read 3 files, 2 searches`, in the same
width. The clause order is fixed and is deliberately *not* call order — a turn's
reads and searches are its method, what it changed is its result, so edits lead;
chronological order puts a run's twelve reads ahead of the one write that
mattered. Only the first clause is capitalized (the row is one sentence), a
search is named by its own noun because "searched 2 searches" is phrasing that
only reads as English to whoever wrote the template, and `running` swings the
*whole* row into the present rather than only its last clause, since a row
reading "Editing 1 file, read 3 files" describes two moments the reader then has
to reconcile.

It keys off `toolMeta`'s **label**, not the tool's name, and that is what makes
it provider-neutral for free: Codex and Grok already normalize their calls onto
the same canonical names (`codex.ts`, `grokAcp.ts`'s `toolName`), so all three
arrive as the same handful of labels and one sentence serves them. A
`Record<Provider, …>` here would have been three copies of it. Dependency-free
and pinned by `test/toolSummary.test.ts`, because pluralization and clause
joining regress silently.

**A whole MCP server can be groupable, and the browser one had to be.** Grouping
was a `Set` of tool *names*, which the Claude in Chrome server breaks in both
directions: it has two dozen tools and driving a page spends twenty-odd calls —
a navigate, then clicks, screenshots, key presses, a find — each arriving as its
own assistant message and so as its own row, so a single browsing turn laid
fifteen identical-looking lines through the transcript with nothing grouping
them. Those are steps of a run in exactly the way a sequence of reads is.
`GROUPABLE_SERVERS` matches them by **prefix**, and that is the half a longer
list would not have fixed: the tools are deferred behind `ToolSearch` and the
catalog grows, so an exact set stops grouping the day one is added — silently,
since the only symptom is a longer transcript. `mcp__preview__*` joins it (the
same shape at smaller scale) and the three `mcp__canvas__*` names move onto it,
so there is one rule rather than a list and a rule. `isGroupableTool` is now the
single exported checkable, because `ChatView`'s `isGroupableMsg` and `Parts`'
run-builder disagreeing about what groups is a run split in half.

**The label is what makes the folded row worth reading.** These calls landed in
`toolMeta`'s `default` arm, so each one was named `claude-in-chrome__computer`
and every tool was a *different* label — which `summarizeActivity` counts as a
mixed bag of unknowns, i.e. "14 steps". They take `Preview`'s shape instead —
one label for the server, the call's own subject as the summary — matched by the
same prefix rather than by a case per tool. The clause is verb-less
(`14 browser actions`) because no verb covers the set: "Browsed 14 pages" would
multiply the one page the turn actually worked by the number of clicks it took.
`MousePointerClick` rather than Preview's `Globe`, for the reason `PenLine`
isn't `Shapes`: driving the user's own browser and watching this project's dev
server are two destinations, and a shared glyph would claim they are one.

### The task checklist (`lib/taskList.ts`, `TaskDock`, `TasksCard`)

**A live checklist is state, not an event, so there is one of it and it lives on
top of the composer** — `AgentActivityBar`'s argument, applied to the other
thing a turn keeps that a transcript cannot hold. (Only a *live* one: a finished
list is a record rather than state, and moves into the transcript — below.) It was a card in the message
list first, drawn where each call was made, and that is wrong twice over: the
list has exactly one current value but was drawn once per call, so a turn that
flipped five tasks left five near-identical boxes through its prose; and the one
copy worth reading scrolled away under the work it describes, so the plan was
off screen at exactly the moment you were reading the work it was steering. The
dock is Cursor's shape — collapsed to "Tasks · *what it's doing now* · 2/5", one
click to the list, and always where you left it.

It renders **inside the composer's own bordered box** (`Composer`'s `header`
prop), not as a sibling above it. A separate box needs its own border, and the
composer's border *moves* — ring on focus, primary on a file drag — so two
outlines that agree at rest would visibly disagree at the moments the user is
acting. Inside, there is one outline, and the dock only rounds its own top
corners and draws the divider: the root cannot `overflow: hidden`, since that
would clip the slash and @ popovers that hang above it.

**A finished list is not state any more, so it stops living there.** "All done ·
6/6" on top of the composer is a permanent row about a turn that ended, sitting
in the one place on screen reserved for what happens next — and it had no way
out, because the dock drew whatever the fold returned and the fold has no notion
of *over*. So a completed list is **committed**: `TasksCard` draws it in the
transcript at the end of the turn that finished it, and the dock clears. The box
is not dismissed, it **moves** — down to the work it describes, which is where a
record of a plan belongs once there is nothing left to steer, and where reopening
the chat a week later still finds it.

`foldTaskTimeline` answers both halves in one pass, which is the point rather
than an optimization: `tasks` is empty exactly when `completions` holds the list,
so the checklist can never be in two places at once or in neither. Three rules
decide when one commits, each of which is a case that went wrong without it:

- **On the idle transition, not on the last tick.** An agent routinely finishes
  its list and keeps working; committing on the sixth check would pull the box
  off the composer mid-turn and put it straight back on the next `TaskCreate`.
- **Only a turn that touched the checklist can commit one.** Every later turn in
  a finished chat is *also* idle with the list *still* complete, so without this
  the card lands on whichever turn happens to be last and migrates down the
  transcript as the conversation goes on.
- **A snapshot commits once.** Claude appends rather than replacing, so a second
  plan turns 6/6 into 6/12 and finishing that commits a second card holding all
  twelve — one card per finished plan, not one per idle turn. The first six are
  then named in two cards, and that is the honest answer rather than a leak:
  each says what the list was when that turn ended. Suppressing the repeat means
  tracking which ids a card already holds, which is precisely the superseded-id
  bookkeeping this section records deleting.

The anchor is the turn's **last assistant message** — what `turnPresentations`
already hangs the changes card on, so the two settle in the same two render
paths (a plain block, and a collapsed run whose last message ends the turn) and
cannot drift apart. It is fed the messages the transcript will actually draw:
an anchor that `isBlankMsg` filters out downstream is a card nothing renders.
`TasksCard` is the dock's own header row down to the `6/6`, because the box that
lands should be recognizable as the box that left; what changes is the rows. The
dock strikes completed tasks through to separate them from the ones still to
come — here there are none, so the same rendering would cost the card's
legibility to say nothing.

What is left in the transcript is the *calls*, as ordinary muted rows in the
run-grouping — the checklist tools are in `GROUPABLE_TOOLS` for exactly that.
Hiding them would be the same mistake as the silent checklist below; a run of
them reads "Read 3 files, 8 task updates", verb-less and ranked last in
`summarizeActivity` because bookkeeping is neither the turn's method nor its
result. All four spellings share the one `Tasks` label, both providers', since
the summary keys off the label and a second one would print two clauses for one
activity.

Underneath both surfaces is one question — *what does the list look like now* —
answered by applying every successful checklist call in the loaded window
(`foldTasks`, and `foldTaskTimeline` around it). Three things about it, each
measured against the real corpus rather than assumed:

- **The id exists only in the output.** `TaskCreate`'s *input* has no id; it
  comes back in the result (`Task #3 created successfully: …`), and that string
  is the only thing a later `TaskUpdate` can be matched against.
- **It is never message-local.** Each API response carries at most one of these
  calls, so a `TaskUpdate` is never in the same assistant message as its
  `TaskCreate` — across 366 real updates, not once. Folding per message would
  render an empty list every time; the fold spans the whole loaded window.
- **Both providers land in one shape.** Codex's `TodoWrite` carries the whole
  list in one call and replaces the state wholesale, exactly as `TaskList` does,
  so the dock never learns which backend it is looking at. Its ids are
  *positions*, hence the `todo:` prefix: a chat can switch provider
  mid-conversation, and a bare `1` would merge into whatever Claude called #1.

Runs, snapshots and superseded ids are all **gone**, and it is worth recording
what they were for: a five-task plan arrives as five back-to-back `TaskCreate`s,
which as a card each stuttered "0/1, 0/2, 0/3…" — 566 real calls for 255 runs,
i.e. over half the cards saying nothing. Only the last call of a run drew, and
the superseded ones had to be dropped in `AssistantBlock` rather than rendered
as null, because Claude Code puts one call in a message and an empty block is
still a flex item — the gap `isBlankMsg` exists to prevent. One docked list
answers all of that by construction. A failed call still changes nothing (the
list didn't move, so claiming otherwise would be a lie), and so does a *running*
one, whose input is still partial JSON. `Task{Stop,Output,Get}` are a
*different* feature — background agents, keyed by a snake_case `task_id` hash
rather than the checklist's numeric `taskId` — and are not folded in.

The list lives in `taskListStore`, outside the message-history render path, for
the reason that store already existed: it churns several times a second mid-turn
and threading it through props would re-render every transcript row on each
flip. That only works because `reconcileTasks` carries an unmoved list forward
*by identity* — a fresh array per fold would defeat the whole arrangement. The
`completions` half needs the same treatment for a sharper reason:
it rides the transcript's own render context, which `MessageHistory` compares by
identity, so a fresh `Map` per fold would re-render every message in the chat on
every streamed token — the exact cost the dock was moved out of that path to
avoid. `reconcileTimeline` carries both. The live list also
carries a **`chatId`, and that is load-bearing rather than bookkeeping**: the
publish runs in an effect, so on a chat switch the store holds the previous
chat's tasks for one painted frame. A per-call card failed soft on that, looking
itself up by id; one box shared by every chat would show the wrong chat's plan,
so the dock draws nothing until the id is its own. `completions` needs no such
stamp — it is threaded through props into a transcript that is keyed by chat id
and rebuilt with it.

**The tools themselves are behind a flag, and that is why the checklist once
vanished outright.** Claude Code 2.1 registers `TaskCreate`/`TaskUpdate`/`TaskList`/
`TaskGet` only when `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set *or* an account-level
rollout flag is on — so a chat that had a checklist last week silently stopped
having one, with nothing in the transcript to say why and no fold to fix. Carbon
asks for them in the session `env` (`claude.ts`), the same shape and the same
rule as `CLAUDE_CODE_ENABLE_CFC`: set unless the user already set it, so `=0` is
their opt-out. It lands at spawn, so a session already running keeps the old
answer until it is disposed — the lifecycle an effort change already has.

They are also **deferred**, so a checklist run now opens with a `ToolSearch`
call fetching them. That row is not hidden: hiding a step the model actually
took is the same mistake as the silent checklist. It says which tools came back
(see `tool_reference` under Session flow in `CLAUDE.md`) and groups with the other lookups —
including, now, the checklist calls themselves.

### The agent roster (`shared/agentRuns.ts`, `AgentsPanel`, `AgentActivityBar`)

A fan-out is **state, not an event**, and the transcript can only show events.
Five spawn cards land where they were made and scroll away under the output of
whichever agent answered first — so "what is running right now, on what, at what
cost" had no home. The roster is a right-panel tab that answers exactly that,
and it is fed by the parts the transcript already holds rather than by a second
channel: `ToolPart.agent` (`AgentRun`) carries the vitals, `children` carries
the work, and `foldAgentRuns` reads both. One consequence worth keeping: the
panel describes runs from a chat the app has since restarted through, because
the parts are persisted.

**The three providers report these numbers at three different moments, and one
of them reports nothing.** That asymmetry is the whole reason the vitals live on
the part instead of in a live-only map:

- **Claude** puts `model` and `usage` on every sub-agent assistant message, so
  the fold is one read per step in `handleSubAgentAssistant`. Two traps there.
  The CLI ships each content block as its *own* assistant message carrying the
  same `message.id` and the same `usage`, so adding every one triples a
  text+tool step — hence a one-entry-per-spawn cursor (`agentUsageMsg`), which
  is bounded where a set of every id would grow for the life of the chat. And
  `reconcileAssistant` rebuilds every part from a final message that carries no
  vitals at all, so `agent` has to be carried across it exactly the way
  `children` already is; without that, every agent's model and token count
  blanks at the moment its turn ends.
- **Codex** reports nothing about a child in the parent transcript — the model,
  the effort and the totals are in the *child's own* rollout file, which is
  already being tailed for its text and tools, so they are three more record
  types on a read that is happening anyway (`agent-usage`). `total_token_usage`
  is a running total, so it replaces; `last_token_usage` is the call that just
  finished and summing that instead counts every earlier call again.
  **The v2 runtime stopped announcing its children.** A `sub_agent_activity`
  record in the parent rollout used to name each spawn; v2 emits none, and the
  only link is the child's *own* first `session_meta` line
  (`parent_thread_id`, or `source.subagent.thread_spawn`). So the watcher keeps
  scanning the parent's own directory on the `FILE_SCAN_MS` cadence *after* the
  parent tail is found — a child file can appear at any point in the turn,
  where the old event arrived on a stream already being read — and reads only
  each candidate's first line (`SESSION_META_BYTES`) rather than tailing a
  large, still-growing file to decide whether it is one. The `callId` is
  synthesized from the thread id because there is no parent-side call to hang
  it on, and the inherited parent `session_meta` a child file also carries is
  refused by id, or every turn would discover itself.
- **Grok** reports neither: ACP carries no nested traffic for a sub-agent and no
  per-agent usage, so a Grok row is a description, a status and a clock. It is
  drawn *missing* rather than filled in from the parent chat's model — a
  plausible-looking guess about the one thing the panel exists to state is worse
  than a blank.

**Tokens are counted the way the Usage page counts them** — input + cache reads
+ cache writes + output. Summing input and output alone is the obvious reading
and a useless one: measured on real sub-agent transcripts it reports 26 tokens
for a six-step agent that spent 113k, because a sub-agent's context lives in
cached input.

- **`endedAt` is the agent's last activity, not the moment its call returned.** A
  backgrounded agent's `tool_result` lands at spawn, so reading the end off it
  reports every such run as having taken no time. For the same reason "still
  working" is `part.status` **or** a child still moving — one rule, in
  `agentRuns.ts`, so the card and the panel cannot show a tick and a spinner for
  the same agent.
- **Background agents are settled by their `task_notification`, not by their
  result.** Measured against the CLI: `task_started` (carrying the
  `tool_use_id` and `is_backgrounded`) arrives *before* the placeholder
  `tool_result`, the agent's own messages stream with `parent_tool_use_id`
  exactly as a foreground agent's do, and the end is a `task_notification` with
  the agent's report as `summary` and the CLI's own token total. Before this
  was read, `handleToolResults` marked the card done at spawn and deleted its
  `toolLoc` entry — the "result arrives once, after all sub-agent traffic" rule,
  true of a foreground agent and false of a backgrounded one — so every child
  that followed was dropped: four `/simplify` reviewers "finished" in ten seconds
  each with nothing inside. `backgroundCalls` in `claude.ts` holds the part
  `running` through the placeholder and the entry alive until the notification,
  which is what puts the children, the vitals and the turn's liveness back.
  Only the notification's status is authoritative: the CLI sends its empty job
  set in the same tick *ahead* of it, and the empty set already settles running
  parts as a success, so the notification re-applies whatever it says.
- **The fold is published to `agentsStore`, not threaded through props.** Agent
  vitals churn harder than anything else in a turn, and the transcript wants
  none of it — the `taskListStore` arrangement, for the `taskListStore` reason.
  `reconcileAgentRuns` carries an unmoved list forward by identity so the
  panel's subscribers see nothing when nothing moved. Elapsed time ticks in the
  components (1s, only while something runs); a clock in the store would be a
  state write per second for a value two components read.
- **The panel is never auto-selected.** A spawn mid-read would take the file you
  are looking at off screen. The way in is the activity bar above the composer —
  which exists only while something is running — or the tab, which exists only
  while the chat has runs. Clicking a row scrolls to that card *and* opens it
  (`focusId`/`focusTick`; the counter is what makes a second click work after
  you collapse the card again), because a scroll that lands on a collapsed
  header answers half the question.
- **A run of spawns keeps its collapsed group row**, but the row now says what
  the roster says — `3 agents · 2 working · Σ 67.8k tok` — instead of naming
  whatever the last call touched. The collapsed card's own line is deliberately
  *shorter* than the panel's: a model id beside the description wins the width
  fight in a chat column and leaves the card reading "Agent · claude-sonnet-5"
  with the task truncated away, so identity moved to the expanded body and to
  the roster.

### What the agent asks you (`PromptDock`, `CodexReviewDialog`)

A permission request, a question, a plan waiting for review — and the Codex
review picker, which is the one the *user* opens. All four now ride the
composer's own bordered box (`Composer`'s `header`, beside `TaskDock` and
`CodexGoalBar`) instead of standing as their own boxes in the transcript and
floating above it.

**A pending request is state, not an event**, which is the argument `TaskDock`
and `AgentActivityBar` already make and the reason the transcript was the wrong
home for it. It has exactly one current value, it *blocks the turn*, and drawn
as the last thing in the message list it was on screen only for as long as the
reader left the scroller pinned — so glancing up at the very work the agent was
asking about took the question off screen, with nothing anywhere left to say the
turn was waiting. It is now glued to the input the answer would be typed into.

- **The answered prompt leaves no record, deliberately.** The tool row is the
  record: a call that ran shows its result, a denied one keeps its own glyph and
  destructive text (`ToolCard`). A "you allowed npm test" card would be the
  second telling of a thing already told — the bookkeeping the checklist section
  records *deleting*.
- **One frame for the three kinds.** They were three near-identical boxes for one
  moment — `border-warning/40 bg-warning/8`, `border-primary/30 bg-primary/4` and
  `border-primary/30 bg-primary/5` — and two boxes that nearly agree read worse
  than one that does, which is the rule the table frame is built on (`docs/chat-layout.md`).
  `PromptFrame` is the one definition: a tinted band naming who is waiting and
  what for, the body, then the answer row.
- **The tint is a band, not a flood.** This app carries state in a glyph and a
  bar at the row's outer edge (`DiffView`) and narrates in muted rows
  (`ToolCard`), so a fully tinted card was the loudest object on a screen
  designed around not having one. Position does the work the flood was doing.
  Amber for a permission, because caution is what that one means; neutral
  `--primary` for a question and a plan, which are not warnings.
- **Naming the provider in the band fixed a real bug.** `PermissionCard` took no
  `provider` and fell back to `` `Claude wants to use ${…}` ``, which Grok reaches
  whenever the closing ACP payload carries no title (see "Only the first payload
  of a tool call identifies it"). The band says
  `${PROVIDER_SHORT_LABELS[provider]} needs permission` and the body carries the
  subject alone, so there is nowhere left for a backend to be hardcoded.
- **Prompts are last in the header**, which is to say adjacent to the textarea.
  The checklist and the goal bar grow and collapse on their own, and above the
  prompt their movement never pushes the question away from the keys that answer
  it.
- **One prompt is open at a time, and the rest are one-line rows.** Capping the
  stack and scrolling it was the first answer and it was wrong in a way only the
  crowded case shows: four parallel calls drew four identical "Claude needs
  permission" bands and twelve buttons, clipped the fourth mid-row, and gave the
  composer 56% of the window to say one thing four times. They are answered one
  at a time whatever the box does, so the box says so — `ToolGroup`'s grammar.
  It is also what makes the keyboard binding honest: four mounted cards meant
  four window listeners on one keypress with nothing on screen saying which one
  answered, and `ChatView` no longer computes a `keyboardId` at all because the
  open prompt *is* the answer. The open one is held **by id, not index** —
  answering removes a request from the array, and an index would then point at
  whichever prompt shuffled into that slot; a missing id falls back to the
  first, which is what promotes the next one.
- **A queued row shows its own subject, not the band's line.** Repeated, "Claude
  needs permission" distinguishes nothing, and a queue whose rows are identical
  is a queue you cannot choose from. A question's row is the question itself.
- **The cap moved from the dock onto the body**, which is the fix for the other
  crowded shape. `AskUserQuestion` may carry four blocks of options; capped at
  the dock, the whole prompt scrolled and **Submit went below the fold with
  nothing on screen to say it existed** — a question you cannot submit looks
  exactly like one that is broken. Scrolling the body alone keeps the answer row
  where the answer is given, and the band carries `2 of 4 answered`, without
  which a disabled Submit is a question about options that may be off screen.
  Measured on four of each: the dock went 383px → 254px and stopped scrolling,
  and the composer's share of the window 56% → 41%.
- **The `side` guard splits.** `TaskDock` and `CodexGoalBar` stay nulled in a side
  chat because they are structurally dead there — the side variant publishes into
  neither `taskListStore` nor `agentsStore`. Permissions are the opposite:
  `permissions` is keyed by chat id and a side chat raises its own, so nulling
  them would leave its turn blocked on a question with nowhere on screen to ask
  it.
- **The foot had to start speaking.** `showActivity` was
  `busy && permissions.length === 0` — correct while the prompt was *in* the
  transcript, where the label would have been a second voice under it. With the
  prompt gone the foot fell silent at exactly the moment the reader is looking at
  it and nothing anywhere is moving, which reads as a finished turn that is in
  fact waiting. It says "Waiting for your answer…", and says it *immediately*:
  `QUIET_MS` exists to tell a lull from the pause between two steps, and there is
  nothing to disambiguate once the agent has stopped to ask.

**The review picker is the same move for the user's own gesture.** It was
`absolute bottom-full … bg-popover shadow-2xl`, held two pixels clear of the
input — a thing that landed on the window rather than part of it. It is opened by
typing `/review` into the composer and it decides what the next turn will be, so
it *is* the composer for one gesture, and it takes the same arrangement for the
same reason: one outline around one object, and the composer's border is the one
that moves (ring on focus, primary on a file drag), so a second box beside it
would visibly disagree at the moments the user is acting. Two things follow:

- **It carries its own ✕.** Floating, it was dismissed by clicking the backdrop;
  docked, there is no backdrop, and Escape alone is not an affordance.
- **`keyMayAnswer` had to stop matching on `closest('[data-composer]')`.** The
  picker's custom-instructions textarea is inside that box now, and an empty one
  — the state it is in while you are deciding what to type — satisfied the old
  test, so Enter would have allowed the permission sitting under it. The
  composer's own input is marked `data-composer-input` and matched by name. That
  is the general hazard in moving anything into the composer: every rule that
  said "inside the composer" silently widened.

### The turn's changed files (`TurnChangesCard`, `lib/turnChanges.ts`)

One card at the end of a turn saying what it edited: a count, the turn's line
totals, **Undo**, and **Open diff** — which opens the review panel, the same
surface the diff chip does, so the card is a way *in* to the review rather than a
second review of its own.

- **Grouping only where grouping pays.** `groupChanges` gives a collapsible row
  to a directory holding **two or more** of the changed files and a plain row to
  everything else, the file's own directory dimmed beside its name — the idiom
  the review header and both trees already use. A nested tree (`GitPanel`'s
  `buildTree`) is the obvious reuse and is wrong at this size: the common turn
  touches three files in three directories, and a tree spends a row per level
  restating what each path already says. `web/src/lib` is one row here, not
  three, and one file in a directory of its own is not a group at all.
- **Every file is listed.** It was the first three and a "Show 2 more" control —
  a row spent to hide two, on the one card whose whole job is naming what
  changed. Grouping is what makes showing all of them affordable, and the header
  chevron is there for the turn that rewrote forty.
- **A row opens that file's diff, and falls back to the file.** Once the change
  is committed there is no diff left to show, and an inert row would be worse
  than one that opens what it names.
- **The deltas can be absent, and that is honest.** Codex reports exact
  per-file counts (`AssistantMessage.fileChanges`); Claude reports paths, so the
  numbers are summed out of the working tree and are simply gone once the turn's
  work is committed. `LineDeltas` (shared with the review and the source-control
  tree) draws nothing rather than `+0 −0`.
- **Undo stays.** It is the one thing on this card that no other surface offers,
  and it is a popover that *checks first* — the preview round-trip is what lets
  it say how many files it would restore, or why it can't.

**Copying a turn's answer rides the same anchor** (`turnAnswerText`,
`CopyAnswer`). The reason to want it is to hand an answer to another agent, so
what it copies is the turn's *prose* — tool calls and thoughts dropped, since a
transcript of twenty `Read` rows is the noise that makes the paste worse than
retyping it. Three things follow from that:

- **The unit is the turn, not the message.** Claude persists a turn as many
  assistant messages and Codex as one, so a per-message copy hands over a
  fragment on one provider and the answer on the other. `turnPresentations`
  already flattens the turn's parts into `summary`, which is why this needed no
  new grouping — the same anchor `TurnChangesCard` and `TasksCard` hang on.
- **It rides the turn's stats line rather than a row of its own.** A row per turn
  is ~24px of chrome down the whole transcript for a control most turns never
  need, and the alternative — hiding it until hover — wants a wrapper around the
  turn's messages, which is the remount `useHistoryNodes` exists to prevent. The
  stats line is already the turn's footer, so the control costs no height and
  lands where a reader already looks for what a turn *was*. It is the icon alone:
  at 11px beside `1m 36s · $0.28` the word "Copy" is wider than both stats
  together. `EventRow`'s `turn` case therefore no longer returns null on missing
  stats — a turn that reported none still has an answer worth copying — and
  `renderMessages` resolves the answer through the last assistant message seen,
  since an event message is not itself in `presentations`.
- **A turn with no prose draws no control.** `summary` is only set once the turn
  is complete, so a running turn offers nothing (there is no answer yet), and a
  tool-only turn yields an empty string and renders nothing rather than a button
  with nothing behind it.

### The turn header and its fold (`TurnHeader`, `lib/turnFold.ts`)

Every turn opens with a row of its own: `Working for 17s` while it runs, and
`Worked for 31s ›` once it lands, with a hairline rule under it and the turn's
work below. Clicking it folds the turn down to its answer.

**Folding is omission from a flat array, never a wrapper.** `ChatView` renders
history and the live message as one keyed array in one parent, because a
message must keep its key, its element type *and* its parent when it crosses
out of the live slot — that is the whole subject of `useHistoryNodes`, and a
per-turn container would remount every settled row at the moment the turn
ended, replaying each one's enter animation. So `TurnHeader` is a keyed sibling
pushed after the prompt, and a folded turn simply pushes fewer nodes.

**What folds is the work; what survives is the answer** — the trailing run of
`text` parts, walked back across the turn's assistant messages, ended by
anything that is not empty-or-text. A *visible* thought ends it too (Codex
streams its reasoning, so that is a rendered row, i.e. work); a withheld one
decides nothing, since it draws nothing anywhere. The boundary can fall inside
a message — Claude ends a turn with a separate text-only message where Codex
accumulates the whole turn into one — so `AssistantBlock` takes a `fromPart`
index rather than a show/hide flag, and every key inside it stays the part's
absolute index so expanding re-renders the answer instead of rebuilding it.
This is deliberately *not* `turnAnswerText`, which concatenates every text part
in the turn: that is the rule for "copy the answer", and using it here would
keep the preamble the fold exists to hide.

Never folded: the prompt, the event rows, the turn's changes card. Folded with
its anchor: a `TasksCard`, iff the message it hangs off is omitted entirely.
A turn that ends on work rather than prose folds to the header alone.

**A picture a call produced is a result, not work.** A screenshot arrives as
`outputImages` on the call that took it, and `ToolOutputImages` already draws
*outside* the activity row's disclosure precisely so a capture survives that row
collapsing — the turn fold then took the whole node and the picture with it,
which is the one thing a reader who asked for a screenshot cannot lose. So both
fold paths keep the images and drop the rows: a folded message renders at a
boundary past its last part (`AssistantBlock` surfaces a hidden tool part's
images and returns null when nothing else is left), and a folded *run* pushes
its collected images in place of the group. A browser or preview sequence is
exactly such a run, and it is all screenshots.

**A turn whose work outlives it is still live.** A backgrounded agent's call
returns at spawn and its real end arrives minutes later as a `task_notification`
(see "Background agents" under the roster below), and `claude.ts` skips
`terminalizeRunning` while `backgroundJobCount > 0` — so `TurnFold.running`
keeps such a turn open, ticking `Working for`, with no chevron, the rhythm
`useRunDisclosure` already gives a running group. Folding it would take a card
that is still moving off screen, and with it the node `AgentsPanel`'s row click
scrolls to. `turnPresentations` is fed the same reading (`settled` in
`renderMessages`): the changes card and the mutation rows it stands in for must
not appear at a pause the turn is going to resume from.

**The CLI closes a turn more than once, and the fold has to know.** `/simplify`
spawns four review agents in the background, says it will apply their findings
when they report, and the turn *ends* — a `result`, a stats row, status idle.
Each agent's notification then wakes the model under the same prompt, with a
`result` of its own; the saved run has five. Read as five turn ends, the
transcript folded at each one and threw the work open at each continuation —
the collapse-and-expand this was reported as — and the folded turn kept four
cost readings stacked over its answer, since event rows never fold. So a turn
carries `closed` (a `turn` or `error` row has landed) and `workEvents` (every
`turn` row with more of the turn after it — only those: a switch divider, an
error or a compaction mark inside a turn is not a turn end and draws as it
always did), and three things follow. An interim stats row is work and folds. The answer run ends at an interim row — "four agents are
running, I'll wait" is what the turn said *then*, not what it arrived at. And a
turn that is live again after closing is a **continuation**: it stays folded
while the continuation streams under it, with the chevron offered (the label
and the control are independent in `TurnHeader`), because the alternative is
the fold opening under the reader once per wake. A turn whose own work is
still running is not in that state — nothing of it has folded — which is what
`running` outranking `closed` in `renderMessages` says.

Not every wake is an agent. A backgrounded *shell* is deliberately not held
open (`backgroundCalls` in `claude.ts` — a dev server would pin the turn for
the session), so a shell that finishes still closes the turn once before its
notification; the continuation rule is what keeps that from showing. Scheduled
wake-ups and comment notifications arrive the same way and get the same
treatment for free.

**One clock, in both states.** The label is wall clock across the turn's own
messages, not `TurnStats.durationMs` — the provider's number is the more
authoritative one and the wrong one here, since it lands a second or two off
whatever the live row had just ticked to and the label would visibly jump the
moment the turn ended. It is also the only reading a turn that reported no
stats has, and interrupted turns report none: Claude closes no event on
`interruptedTurn`, and Codex stamps its one accumulating message at turn
*start*, so `endTs` also takes the turn's calls' `startedAt` — a floor under
the truth rather than a fiction. The trailing stats row consequently dropped
its duration and keeps the cost and the copy control.

The label carries **no size of its own**. It sits in the same container as the
prose it introduces, so inheriting is an exact match rather than a number kept
level with `body`'s 14px by hand: a chrome *colour* on reading-size type. The
expanded set lives in the renderer store (`expandedTurns`, a new `Set` per
toggle so `sameHistory`'s identity compare fires) and rides `RenderCtx` —
folding is decided while the node array is built, which a `useState` inside the
header could never reach. The live turn is never folded; settled ones start
folded.

**The fold is animated with a view transition**, for the same reason it is
omission: there is no element here whose height could animate. Chromium
snapshots the viewport, so the cost is bounded by what is on screen rather than
by the length of the transcript, and the app's only target is Chromium.
`onToggleTurn` `flushSync`es the toggle inside the transition callback and
corrects `scrollTop` there — before the new state is captured — anchoring on
the header that was clicked rather than on the bottom of the scroller: folding
removes height *above* the answer, so without the correction the transcript
slides out from under the pointer by however much work the turn did. Reduced
motion skips `startViewTransition` outright.

**`demo/e2e/stream-probe.js` needs re-baselining against this.** It pumps
synthetic assistant messages with no user message, so all three shapes land in
one turn that now folds at each `status: idle`; its DOM-identity readings
measure omission rather than a remount until each shape gets a prompt of its
own. `foot-probe.js` is unaffected — it only reads the foot label.

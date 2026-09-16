# Terminal chats

A chat whose middle column is **your shell**, in a pty, instead of Carbon's
transcript and composer. You start `claude`, `codex` or `grok` in it yourself,
with whatever flags you use. Everything around it is unchanged: the same sidebar
row, the same header and ⋯ menu, the same right panel with files, git and diffs.
Reopening the chat puts you back in the CLI session you were on, because Carbon
noticed which one it was and the CLI kept the conversation.

`ChatMeta.surface` is the whole switch. `src/main/chatTerminal.ts` identifies
the session and resumes it; `ChatTerminal` in `TerminalPanel.tsx` draws the
pane; `main/terminal.ts` runs the pty and holds it open between panes.

## Carbon launches nothing

The first version spawned the CLI itself — `claude --session-id <minted uuid>`,
Codex's id read back out of the rollout it wrote — and grew pickers for model,
effort and permission mode to build that command line. Every one of those was a
worse copy of something the CLI already has, and it decided for you which CLI a
chat was *before* you had started it.

So a terminal chat opens a login shell in the chat's folder, and that is all.
On the New chat screen it is one click: the Terminal pill in the context strip
(`OpenTerminalPill`) opens the chat at once, in the folder and worktree already
chosen beside it. It was first a Chat/Terminal picker that swapped the composer
for an "Open terminal" button — a second click and a mode to leave, for a
choice with nothing left to configure. The chat is titled "Terminal" and has no
provider, model or session until you run something. Your flags are
yours and are never replayed — Carbon never saw them. The CLI restores the
conversation on resume, and anything else is a keystroke away inside it.

## It is a surface, not a second kind of chat

`ChatView` draws it: one flag (`chat.surface === 'terminal' && !side`) swaps the
transcript scroller and the composer stack for the pane, and nothing else in the
file changes. A separate component would have needed its own copy of the header
— the title, rename, the worktree lifecycle, merge, delete — all of which act on
a chat, not a transcript, and would have drifted by the next feature.

`messages` is empty for a terminal chat and stays empty, so everything that reads
them is absent by construction: no plan panel, permission dock, task checklist,
agent roster or turn-changes card. The CLI draws its own versions. What is left
underneath is `ContextStrip`, in the composer's slot — with no turns there is no
turn-changes card, so the strip is the only thing on screen that says what has
changed in the folder.

## Which session is running has to be found out

node-pty's foreground process name identifies nothing (measured: Claude Code is
`2.1.270`, its versioned binary; Codex is `node`, like any npm script; Grok is
`grok-1.0.30-maco`, truncated). So `probe` walks every process under the pane's
shell (`ps -axo pid=,ppid=`) and asks each CLI's own evidence, while something
other than the shell is in front:

- **Claude — the pid registry.** Each live process writes
  `~/.claude/sessions/<pid>.json` with the session it is on, and rewrites it when
  that changes: `/clear` (measured: new id within 3 s) and the CLI's own
  `/resume` are followed by reading the same file again. Exact.
- **Codex — the writer lock.** Codex registers nothing, but holds
  `~/.codex/thread-writer-locks/<thread>.lock` open for the life of the thread,
  so `lsof` over the pane's pids names it. Exact. Carbon's own Codex chats run
  under the main process, never under a pane, so they cannot be mistaken for it.
- **Grok — inference, and the weak one.** It holds nothing open and registers
  nothing. The rule is a session directory under
  `~/.grok/sessions/<encodeURIComponent(cwd)>/` **born** after grok came to the
  front of this pane, and only if exactly one was — excluding every id a chat
  already holds. A second grok started in the same folder at the same moment
  from another terminal makes it ambiguous, and Carbon adopts nothing rather
  than guess. A Grok `/clear` or in-CLI session switch is not followed.

**The registry file is read for two fields.** It sits beside a key file and
carries a messaging socket path; Carbon reads `pid` and `sessionId` and nothing
else, and never touches the key or the socket. It is local state on disk, not an
endpoint or a credential.

The probe costs a `ps` and, for Codex, an `lsof`, so its cadence follows what it
can still learn: every 2.5 s until the running command is identified, then every
8 s (only a deliberate session switch is left to catch), and 15 s after four
misses — a dev server left running for an hour is not a CLI and should not pay
for being asked.

Adopting sets `chat.sessionId` and, if it differs, `chat.provider` — a chat that
ran Claude and then Codex is a Codex chat now, because that is what reopening it
will resume. A claim set stops two panes from ever holding one id.

## Resume is typed, and checked against disk

Opening a chat that has a session types `claude --resume <id>` / `codex resume
<id>` / `grok --resume <id>` into the fresh shell, **as a command in its
history** — so leaving the CLI leaves you at your own prompt, and ↑ gets you
back in.

It is typed only after the shell has gone quiet (`whenQuiet(250 ms, 4 s cap)`).
Written ahead of the prompt, the line would be echoed once by the tty and again
by the line editor. Verified against a real login shell with a themed prompt:
the line lands once.

**Resume is decided from the transcript on disk, never from the stored id
alone.** `claude --resume` against an id that is gone exits with *No
conversation found*, which would read as Carbon failing to open the chat. So
`transcriptPath` looks for the file first; on a miss the stored id is dropped
and the chat opens on a bare shell.

Restart (the ⟳ in the pane's header, or any key after the shell exits) does the
same thing: a new shell, the session resumed in it. The chat *is* that session;
a shell with no CLI in it is what you get by leaving the CLI, not by restarting.

## The pty outlives the pane

`ChatView` is keyed by chat id, so switching chats unmounts the pane. The
session must not go with it.

`TerminalCreateOpts.persist` marks a session that survives its pane: unmounting
calls `terminalDetach` instead of `terminalKill`, and the next mount calls
`terminalAttach`, which replays what the pty wrote while nobody was watching.

**A detached session emits nothing.** That is what makes the replay exact: if
bytes kept streaming while the buffer also recorded them, a byte written between
"read the buffer" and "the renderer wired up its listener" would arrive twice or
out of order. With emission gated on `attached`, everything before the attach is
in the replay and everything after is live. The renderer holds the other half:
from the moment a bring starts until its output is written, incoming data is
buffered — the replay crosses an `await`, and a live byte landing in that gap
would print above the history it belongs after.

Two details in `attach` are load-bearing:

- **The buffer drops whole chunks, never bytes.** A replay starting mid escape
  sequence paints garbage.
- **A pane that returns at the same size gets a one-row resize first.** The
  kernel raises `SIGWINCH` only when the grid changes, and `SIGWINCH` is the only
  thing that makes a full-screen TUI repaint. The replay covers the inline case
  (Claude Code's default); Codex and Grok draw on the alternate screen and need
  the nudge.

The buffer is 4 MB on purpose: an alternate-screen session repaints, but an
inline one draws its transcript once, and a short buffer would silently amputate
a conversation the CLI still has.

Quitting the app kills every pty. That is not a loss — the next open resumes.

**Two instances must not both run one session.** `userData` is shared between the
dev and packaged builds, so one chat can be open twice; here that would be two
CLIs resuming one id into one transcript. `start` declines when
`lockedElsewhere` says another instance has the chat, and the pane says why.

**A worktree exit moves the chat out from under its shell.** The shell would go
on sitting in a directory `git worktree remove` just deleted, so
`ChatTerminalManager.relocate` restarts it in the checkout the chat now lives in,
with no resume — `relocateChat` has already cleared the session.

## Working is read off the title

The sidebar's working mark, the hoist at a turn's start and the background
"finished" notification all come from a chat's `status`, which for an SDK chat
is the session's. A terminal chat has no session Carbon runs, so
`ChatTerminalManager` publishes one from what the CLI publishes to any
terminal: **its window title**.

All three animate a spinner at the head of the title for exactly as long as a
turn runs (measured: Claude Code `◐`/`◑`, settling on `✳`; Codex and Grok braille
frames, falling back to a bare title), so `termTitle.ts` reads an OSC 0/2 title
out of the pty's output — across chunk boundaries — and a leading spinner glyph
means `streaming`. It is scanned whether or not a pane is attached, so a chat
left mid-turn still shows it working from the sidebar. The renderer adds the
completion chime on the status settling, since there is no turn message to
chime on.

Things that were not used, and why:

- **Claude's `status: busy|idle` in its pid registry** is exact, but it is
  Claude's alone, and the title already says the same thing a poll later.
- **Transcript writes** go quiet during a long tool call — a build, a test run —
  and would read as finished while the turn is still running.
- **Warp's `OSC 777 warp://cli-agent` events** (`prompt_submit` / `stop`) showed
  up from both Claude and Codex on the development machine, with no
  established source — likely a Warp integration — so nothing relies on them.

Two edges keep it honest: the shell returning to the front forces `idle` (a CLI
that crashed or was killed mid-turn never draws its idle title), and so does
the pane going away. Codex also spins for about a second while it starts, which
shows as a brief working mark — it is loading, so that is left alone. A
permission prompt is not told apart from a turn.

## "Something happened" has to be inferred

The foreground process is `claude` for the whole session, so the busy signal a
terminal *tab* uses never returns to idle here (and `App` keeps chat ptys out of
that list, or every terminal chat would read as a running command). Working
state comes from the title (above); refreshing what the turn changed needs its
own edges.

Two edges stand in for a turn ending, and both emit `activity`:

- **The session's transcript goes quiet** — mtime polled every 1.5 s, quiet for
  1.2 s. A turn writes continuously; the gap is the signal.
- **The shell comes back to the front** — the CLI exited, or a `git commit` or
  an install finished. Any of them may have changed files.

The renderer runs the refresh a turn ending does (`terminalActivity`): git
status, GitHub state, the file tree and open editors. It is also the only thing
that moves `updatedAt`; left alone, the chat you use all day sinks to the bottom
of a Recent-ordered sidebar.

## Titles come from the CLI

Each provider's title source is watched by mtime and read once it has settled:

- **Claude** appends `ai-title` records to its transcript; the last one wins.
- **Grok** writes `summary.json` beside its history — `generated_title`, else
  `session_summary` — and writes it *after* the turn's last history line, which
  is why the title source is its own file and not the transcript's quiet edge.
- **Codex** names nothing, but `~/.codex/history.jsonl` records each submitted
  prompt with its thread id, so the title is the opening prompt — what a normal
  chat starts with too. Read once per session: the file is a shared tail, and a
  later read could find a later prompt after the first scrolls out.

A title you typed is yours: `titleManual` stops the CLI's from replacing it. The
detailed sidebar row draws a terminal glyph until a session is identified, then
that provider's mark with a small terminal badge beside the title.

## Two things route around the missing session

- **Git actions.** The source-control ladder delegates commit/PR/merge prompts to
  the active chat's agent. A terminal chat has no session Carbon can send to, so
  `runGitAction` opens a new chat for the work, as it does from the home screen.
- **A thread's other columns** still work, and are the intended way to ask
  Carbon something beside a terminal chat (see `docs/threads.md`).

## `parentEnv.ts`

Every process Carbon spawns is given the environment it would have had if Carbon
had been opened from the Dock.

This was found here, and it is not cosmetic. Carbon launched from a terminal
*inside* a Claude Code session inherits that session's markers, and `claude`
reads `CLAUDE_CODE_CHILD_SESSION` as "you are a child of another session" and
turns **transcript saving off** for the whole run. For a terminal chat that is
the entire feature: no transcript means no resume, no title and no activity
signal. The messaging socket and token are worse in kind: a session that adopts
them is wired into another session's channel.

Stripping them can only restore the Dock-launch environment, which is why it is
unconditional and applies to every spawn — the ptys, the Agent SDK, the Codex app
server and the Grok agent. Configuration the user chose (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `ANTHROPIC_*`, `XAI_API_KEY`, the feature gates) means the same
thing in a child as in the parent and is left alone.

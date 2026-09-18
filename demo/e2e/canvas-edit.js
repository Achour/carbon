// A canvas-edit probe, not a shot: pumps a synthetic `mcp__carbon__canvas_edit`
// through the real `applyEvent` reducer and reads back what the transcript row
// actually says — while the call is running, and once it lands.
//
// This exists because that row is the one part of the edit tool no unit test
// can reach. `runCanvasTool` is pinned by `test/canvasTools.test.ts`, the wire
// schema by `test/carbonMcp.test.ts` and the recognizer by
// `test/canvasRef.test.ts`; none of them renders anything, and two things went
// wrong here that all three were blind to. A guard in `toolMeta` spelled "not
// the write tool" swallowed `edit` before its own case; and `CanvasLink`, not
// `meta.summary`, is what draws a canvas row in the transcript — so the name
// has to be resolved where the link draws it.
//
// The events are synthetic on purpose: what is under test is the render path,
// and a real turn would make it depend on a CLI being installed and on what the
// model felt like doing.
//
// **The probe owns a turn, and unfolds it after every result.** A settled turn
// folds to its header and `renderMessages` *omits* the hidden nodes rather than
// hiding them (see `lib/turnFold.ts`), so a row that was on screen while the
// call ran is not in the DOM a moment after it lands. That is the transcript
// working as designed, and it silently invalidated half this probe when turn
// folding arrived: the running checks kept passing, every check after a
// `settle` read an empty transcript and failed. So the calls are injected under
// a user message this probe pushes itself, and `toggleTurnExpanded` opens that
// turn back up before anything is asserted about a finished row.
//
//   ./demo/shoot.sh /tmp/canvas 6000 demo/e2e/canvas-edit.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The store parks stream events while the window is hidden, and a probe window
  // behind the user's own is exactly that.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const ID = '2f714d35-fb38-4d87-b12b-8b837fbd2aaa';
  const TURN = 'probe-user';

  // The rows the transcript drew, as text. A tool row is one line, so the
  // deepest element carrying the label is the row itself.
  const rows = () =>
    [...document.querySelectorAll('[data-chatview] *')]
      .filter((e) => !e.children.length && (e.textContent || '').trim())
      .map((e) => (e.textContent || '').trim());
  const saw = (needle) => rows().some((t) => t.includes(needle));
  // Only the rows this probe put there, so a failure prints something legible
  // instead of whatever the composer happens to say.
  const canvasRows = () =>
    rows()
      .filter((t) => /canvas|use_tool/i.test(t))
      .join(' | ') || '(no canvas row drawn)';

  // Only what `resolveCanvasTitle` reads. Re-applied before each step that needs
  // it: opening a chat refreshes the real list, and that refresh lands whenever
  // it lands.
  const SUMMARY = { id: ID, title: 'Vite vs webpack' };
  const listing = (canvases) => app.setState({ canvases });

  // Open the turn this probe's calls belong to, once. `toggleTurnExpanded` is a
  // toggle, so asking twice folds it again.
  const unfold = async () => {
    if (!app.getState().expandedTurns.has(TURN)) app.getState().toggleTurnExpanded(TURN);
    await sleep(400);
  };

  const call = (chatId, msgId, name, input) =>
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: {
        id: msgId,
        role: 'assistant',
        ts: Date.now(),
        parts: [{ type: 'tool', toolUseId: `${msgId}-t`, name, input, status: 'running', partial: true, startedAt: Date.now() }]
      }
    });
  const settle = (chatId, msgId, output) =>
    app.getState().applyEvent({
      type: 'tool-update',
      chatId,
      messageId: msgId,
      toolUseId: `${msgId}-t`,
      patch: { status: 'success', output, partial: undefined }
    });

  return (async () => {
    const meta = app.getState().chats[0];
    if (meta) await app.getState().openChat(meta.id);
    await sleep(1500);
    const chatId = app.getState().activeId;
    check('a chat is open', !!chatId, chatId || 'none');
    if (!chatId) return log.join('\n');

    // Every check below is "is this string on screen", so a chat that already
    // says it would make the whole probe vacuous. Assert the opposite first.
    check(
      'the names being checked for are not already on screen',
      !saw('Vite vs webpack') && !saw('Grok wrapped') && !saw('Fresh canvas'),
      canvasRows()
    );

    // The prompt every call below answers, so the fold has a turn to open and
    // this probe is not reading whatever the chat happened to end on.
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: { id: TURN, role: 'user', ts: Date.now(), text: 'Revise the canvas.' }
    });
    await sleep(400);

    // The project's canvas list is what an edit's row reads its name from: the
    // call carries an id and nothing else.
    listing([SUMMARY]);

    // 1. A running edit, before any result exists. The row must already name
    //    the document rather than offering a bare "Open canvas".
    call(chatId, 'probe-edit', 'mcp__carbon__canvas_edit', { id: ID });
    await sleep(700);
    check('a running edit names the canvas it is editing', saw('Vite vs webpack'), canvasRows());
    check('it is not drawn as an anonymous link', !saw('Open canvas'), canvasRows());

    // 2. Landed. The title is also in the result prose, so it survives a chat
    //    reopened after the list has moved on.
    settle(chatId, 'probe-edit', `Updated canvas "Vite vs webpack" (id: ${ID}). The panel is showing the new version.`);
    await unfold();
    check('a finished edit still names it', saw('Vite vs webpack'), canvasRows());

    // 3. Grok defers MCP tools behind `use_tool`, so the same edit arrives under
    //    a name the switch cannot match — spelled as the running CLI spells it
    //    (grok 1.0.34: `carbon__canvas_edit`, the server's namespace joined to
    //    the tool). The listing is emptied first: a Grok call leaves nothing in
    //    the input to resolve against, so the result prose is the only handle.
    listing([]);
    call(chatId, 'probe-grok', 'use_tool', { tool_name: 'carbon__canvas_edit', tool_input: { id: ID } });
    settle(chatId, 'probe-grok', `Updated canvas "Grok wrapped" (id: ${ID}).`);
    await unfold();
    check("Grok's wrapped edit is not drawn as use_tool", !saw('use_tool'), canvasRows());
    check('and it reads its name off the result', saw('Grok wrapped'), canvasRows());

    // 4. A write still reads as it did — it is told its title outright.
    call(chatId, 'probe-write', 'mcp__carbon__canvas_write', { title: 'Fresh canvas', html: '<p>x</p>' });
    settle(chatId, 'probe-write', `Saved canvas "Fresh canvas" (id: ${ID}).`);
    await unfold();
    check('a write still names its canvas', saw('Fresh canvas'), canvasRows());

    return log.join('\n');
  })();
})()

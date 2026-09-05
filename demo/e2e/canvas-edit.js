// A canvas-edit probe, not a shot: pumps a synthetic `mcp__canvas__edit` call
// through the real `applyEvent` reducer and reads back what the transcript row
// actually says — while the call is running, and once it lands.
//
// This exists because that row is the one part of the edit tool no unit test
// can reach. `runCanvasTool` is pinned by `test/canvasTools.test.ts`, the wire
// schema by `test/previewMcp.test.ts` and the recognizer by
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

  // Only what `resolveCanvasTitle` reads.
  const SUMMARY = { id: ID, title: 'Vite vs webpack' };

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

    // The project's canvas list is what an edit's row reads its name from: the
    // call carries an id and nothing else.
    app.setState({ canvases: [SUMMARY] });

    // 1. A running edit, before any result exists. The row must already name
    //    the document rather than offering a bare "Open canvas".
    call(chatId, 'probe-edit', 'mcp__canvas__edit', { id: ID });
    await sleep(700);
    check('a running edit names the canvas it is editing', saw('Vite vs webpack'), canvasRows());
    check('it is not drawn as an anonymous link', !saw('Open canvas'), canvasRows());

    // 2. Landed. The title is also in the result prose, so it survives a chat
    //    reopened after the list has moved on.
    settle(chatId, 'probe-edit', `Updated canvas "Vite vs webpack" (id: ${ID}). The panel is showing the new version.`);
    await sleep(600);
    check('a finished edit still names it', saw('Vite vs webpack'), canvasRows());

    // 3. Grok defers MCP tools behind `use_tool`, so the same edit arrives under
    //    a name the switch cannot match.
    app.setState({ canvases: [] });
    call(chatId, 'probe-grok', 'use_tool', { tool_name: 'canvas__edit', tool_input: { id: ID } });
    settle(chatId, 'probe-grok', `Updated canvas "Grok wrapped" (id: ${ID}).`);
    await sleep(600);
    check("Grok's wrapped edit is not drawn as use_tool", !saw('use_tool'), canvasRows());
    check('and it reads its name off the result', saw('Grok wrapped'), canvasRows());

    // 4. A write still reads as it did — it is told its title outright.
    call(chatId, 'probe-write', 'mcp__canvas__write', { title: 'Fresh canvas', html: '<p>x</p>' });
    settle(chatId, 'probe-write', `Saved canvas "Fresh canvas" (id: ${ID}).`);
    await sleep(600);
    check('a write still names its canvas', saw('Fresh canvas'), canvasRows());

    return log.join('\n');
  })();
})()

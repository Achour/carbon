// The foot's "Working…" label: absent under a running tool row, present in a
// lull, absent again under streaming text. Three shots, one per state:
//   ./demo/shoot.sh /tmp/foot 4500,7500,10500 demo/e2e/foot-probe.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The store parks stream events while the window is hidden — and a probe
  // window behind the user's own is exactly that — so pin the page visible for
  // the run, or a parked `tool-update` reads as a label that never moved.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  const label = () => {
    const el = [...document.querySelectorAll('[data-chatview] .shimmer-text')].pop();
    return el ? el.textContent : null;
  };
  return (async () => {
    const row = startsWith('Build the Nimbus landing')[0];
    (row.closest('button,[role="button"],li,a') || row).click();
    await sleep(1200);
    const chatId = app.getState().activeId;
    const ev = (e) => app.getState().applyEvent({ chatId, ...e });
    const now = () => Date.now();
    const out = {};
    ev({ type: 'status', status: 'streaming' });
    await sleep(300);
    out.atStart = label();
    const mid = 'foot-tool', tid = 'foot-tu';
    ev({ type: 'message', message: { id: mid, role: 'assistant', parts: [{ type: 'tool', toolUseId: tid, name: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: now() }], ts: now() } });
    await sleep(1500);
    out.underRunningTool = label();            // shot 1 lands here (~4.5s)
    ev({ type: 'tool-update', messageId: mid, toolUseId: tid, patch: { status: 'success', output: 'ok' } });
    await sleep(300);
    out.justAfterResult = label();
    await sleep(1400);
    out.inLull = label();                       // shot 2 lands here (~7.5s)
    const text = 'foot-text';
    ev({ type: 'message', message: { id: text, role: 'assistant', parts: [{ type: 'text', text: '' }], ts: now() } });
    const words = 'The label should be gone while these words are still arriving on the screen, one lump at a time, and back once they stop.'.split(' ');
    for (const w of words) { ev({ type: 'part-delta', messageId: text, partIndex: 0, delta: w + ' ' }); await sleep(90); }
    out.underStreamingText = label();          // shot 3 lands here (~10.5s)
    await sleep(1200);
    out.afterTextSettled = label();
    ev({ type: 'status', status: 'idle' });
    await sleep(200);
    out.afterIdle = label();

    // ---- Codex shape: one message; visible reasoning, then prose, then a command ----
    await sleep(800);
    const cx = 'foot-codex';
    ev({ type: 'status', status: 'streaming' });
    ev({ type: 'message', message: { id: cx, role: 'assistant', parts: [], ts: now() } });
    ev({ type: 'part', messageId: cx, partIndex: 0, part: { type: 'thinking', text: '' } });
    for (const w of 'Looking at the sidebar redraw and what the bump costs each subscriber.'.split(' ')) { ev({ type: 'part-delta', messageId: cx, partIndex: 0, delta: w + ' ' }); await sleep(90); }
    out.cxUnderReasoning = label();
    await sleep(1400);
    // The reasoning has stopped but is still the last part: its header shimmers.
    out.cxReasoningPause = label();
    out.cxReasoningHeader = ([...document.querySelectorAll('[data-chatview] .shimmer-text')].map((e) => e.textContent).join('|')) || null;
    ev({ type: 'part', messageId: cx, partIndex: 1, part: { type: 'text', text: '' } });
    for (const w of 'Here is the plan, in prose, before the command runs.'.split(' ')) { ev({ type: 'part-delta', messageId: cx, partIndex: 1, delta: w + ' ' }); await sleep(90); }
    out.cxUnderText = label();
    await sleep(1400);
    out.cxTextPause = label();
    ev({ type: 'part', messageId: cx, partIndex: 2, part: { type: 'tool', toolUseId: 'foot-cx-tu', name: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: now() } });
    await sleep(300);
    ev({ type: 'part', messageId: cx, partIndex: 2, part: { type: 'tool', toolUseId: 'foot-cx-tu', name: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: now(), output: 'running 3 tests' } });
    await sleep(1200);
    out.cxUnderRunningCommand = label();
    ev({ type: 'tool-update', messageId: cx, toolUseId: 'foot-cx-tu', patch: { status: 'success', output: 'ok' } });
    await sleep(1400);
    out.cxCommandPause = label();
    ev({ type: 'status', status: 'idle' });
    await sleep(200);
    out.cxAfterIdle = label();
    return out;
  })();
})()

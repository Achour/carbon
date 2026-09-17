// Does a turn get more expensive the longer the chat it lands in?
//
// `HYDRATE_TAIL` bounds what main *loads* to 60 messages, so a fresh chat is
// always short — but nothing bounds what a session *appends*. Claude ships one
// assistant message per tool call, so an hour of work is hundreds of them in
// the renderer's array, and every one of them is walked again by
// `displayedMessages`, `foldTurns` and `turnPresentations` on every single
// event of the turn still streaming.
//
// This pumps the SAME synthetic tool-heavy turn through the real reducer at
// three transcript lengths and reports what one event costs at each. Synthetic
// on purpose: a real turn cannot be held identical across three runs, and the
// question here is the slope, not the absolute.
//
//   ./demo/shoot.sh /tmp/scale 120000 demo/e2e/scale-probe.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Stream events park while the window is hidden, and a probe window behind
  // the user's own is exactly that.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));

  return (async () => {
    const row = startsWith('Build the Nimbus landing')[0];
    const target = row && (row.closest('button,[role="button"],li,a') || row);
    if (!target) return { error: 'chat not found' };
    target.click();
    await sleep(1500);
    const chatId = app.getState().activeId;
    if (!chatId) return { error: 'no active chat' };

    let seq = 0;
    const id = (p) => `${p}-${seq++}`;
    const now = () => Date.now();
    const send = (e) => app.getState().applyEvent({ chatId, ...e });

    // One synthetic turn's worth of history: a prompt, a withheld thought, four
    // tool calls and a paragraph — the shape a real Claude turn leaves behind.
    const seedTurn = (n) => {
      send({
        type: 'message',
        message: { id: id('u'), role: 'user', text: 'seeded prompt ' + n, ts: now() }
      });
      send({
        type: 'message',
        message: { id: id('b'), role: 'assistant', parts: [{ type: 'thinking', text: '' }], ts: now() }
      });
      for (let i = 0; i < 4; i++) {
        send({
          type: 'message',
          message: {
            id: id('t'),
            role: 'assistant',
            parts: [
              {
                type: 'tool',
                toolUseId: id('tu'),
                name: i % 2 ? 'Read' : 'Bash',
                input: i % 2 ? { file_path: '/tmp/seed' + i + '.ts' } : { command: 'echo ' + i },
                output: 'ok',
                status: 'success',
                startedAt: now()
              }
            ],
            ts: now()
          }
        });
      }
      send({
        type: 'message',
        message: {
          id: id('a'),
          role: 'assistant',
          parts: [{ type: 'text', text: 'A settled paragraph of answer, turn ' + n + '.' }],
          ts: now()
        }
      });
    };

    // The measured turn: eight tool calls, each its own message, each with its
    // input arriving in partial-JSON emits the way `claude.ts` ships them.
    const measure = async () => {
      const samples = [];
      const timed = (e) => {
        const t0 = performance.now();
        send(e);
        samples.push(performance.now() - t0);
      };
      send({ type: 'status', status: 'streaming' });
      send({
        type: 'message',
        message: { id: id('mu'), role: 'user', text: 'measured prompt', ts: now() }
      });
      for (let i = 0; i < 8; i++) {
        const mid = id('m');
        const tid = id('mtu');
        timed({
          type: 'message',
          message: {
            id: mid,
            role: 'assistant',
            parts: [
              { type: 'tool', toolUseId: tid, name: 'Bash', input: {}, status: 'running', startedAt: now(), partial: true }
            ],
            ts: now()
          }
        });
        // The input filling in, one emit per `PARTIAL_INPUT_MS`.
        const cmd = 'npm run some-fairly-long-command --with-flags --and-more';
        for (let k = 8; k <= cmd.length; k += 8) {
          timed({
            type: 'part',
            messageId: mid,
            partIndex: 0,
            part: {
              type: 'tool',
              toolUseId: tid,
              name: 'Bash',
              input: { command: cmd.slice(0, k) },
              status: 'running',
              startedAt: now(),
              partial: true
            }
          });
          await sleep(16);
        }
        timed({
          type: 'tool-update',
          messageId: mid,
          toolUseId: tid,
          patch: { status: 'success', output: 'ok', partial: false }
        });
        await sleep(40);
      }
      send({ type: 'status', status: 'idle' });
      await sleep(400);
      samples.sort((a, b) => a - b);
      const sum = samples.reduce((a, b) => a + b, 0);
      return {
        events: samples.length,
        totalMs: Math.round(sum),
        meanMs: +(sum / samples.length).toFixed(2),
        p50Ms: +samples[Math.floor(samples.length * 0.5)].toFixed(2),
        p95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
        maxMs: +samples[samples.length - 1].toFixed(2)
      };
    };

    const out = [];
    // Each step seeds up to the next length and re-measures, so the three rows
    // share one window and one mounted tree.
    for (const turns of [4, 40, 140]) {
      const have = app.getState().messages.length;
      while (app.getState().messages.length < turns * 7) seedTurn(app.getState().messages.length);
      await sleep(600);
      const long = [];
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) long.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      const r = await measure();
      po.disconnect();
      out.push({
        messages: app.getState().messages.length,
        seededFrom: have,
        ...r,
        longTasks: long.length,
        longMsTotal: long.reduce((a, b) => a + b, 0)
      });
    }
    return { rows: out };
  })();
})()

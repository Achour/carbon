// A follow probe, not a shot: streams synthetic turns through the real
// `applyEvent` reducer and checks what the transcript's scroller did with them.
//
// - pinned at the bottom, it keeps up — through a tool card and a tall block
//   that land in one frame, which is what used to unpin it with nobody touching
//   anything — and it glides rather than jumping;
// - scrolled up (far, or a nudge of a few lines), it leaves the reader alone;
// - back at the bottom, or via the jump button, it follows again.
//
//   ./demo/shoot.sh /tmp/follow 45000 demo/e2e/follow-probe.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  const scroller = () => document.querySelector('[data-chatview] .overflow-y-auto');
  const gap = () => { const el = scroller(); return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop); };
  const jumpButton = () => document.querySelector('[aria-label="Scroll to bottom"]');
  const wheelUp = (px) => {
    const el = scroller();
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -px, bubbles: true }));
    el.scrollTop -= px;
  };

  const PARA = 'The follow keys on the column height and glides toward the bottom a fraction per frame, so a streamed line eases in and a tall card catches up without the transcript lurching by its height. ';
  const CODE = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const line${i} = compute(${i}) // a row of code`).join('\n') + '\n```\n';

  return (async () => {
    const row = startsWith('Build the Nimbus landing')[0];
    const target = row && (row.closest('button,[role="button"],li,a') || row);
    if (!target) return { error: 'hero chat not found' };
    target.click();
    await sleep(1500);
    const chatId = app.getState().activeId;
    const ev = (e) => app.getState().applyEvent({ chatId, ...e });
    let seq = 0;
    const id = (p) => `${p}-${Date.now()}-${seq++}`;
    const stream = async (mid, text, n = 16) => {
      for (let i = 0; i < text.length; i += n) {
        ev({ type: 'part-delta', messageId: mid, partIndex: 0, delta: text.slice(i, i + n) });
        await sleep(80);
      }
    };
    const textMsg = () => {
      const mid = id('text');
      ev({ type: 'message', message: { id: mid, role: 'assistant', parts: [{ type: 'text', text: '' }], ts: Date.now() } });
      return mid;
    };
    const out = {};

    ev({ type: 'status', status: 'streaming' });
    await sleep(300);
    out.startGap = gap();

    // 1. Pinned through text, then a tool card and a 40-line block in one frame.
    await stream(textMsg(), PARA.repeat(3));
    const tid = id('tu');
    ev({ type: 'message', message: { id: id('tool'), role: 'assistant', parts: [{ type: 'tool', toolUseId: tid, name: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: Date.now() }], ts: Date.now() } });
    const big = textMsg();
    ev({ type: 'part-delta', messageId: big, partIndex: 0, delta: CODE });
    // Sample the glide: a jump would read as one sample at the far end.
    const samples = [];
    for (let i = 0; i < 12; i++) { samples.push(gap()); await sleep(16); }
    out.bigJumpSamples = samples;
    await sleep(1200);
    out.pinnedAfterBigJump = { gap: gap(), jumpButton: !!jumpButton() };

    // 2. Scrolled far up: nothing moves the reader.
    wheelUp(600);
    await sleep(100);
    const parkedFar = scroller().scrollTop;
    await stream(textMsg(), PARA.repeat(2));
    await sleep(600);
    out.farUp = { moved: Math.round(scroller().scrollTop - parkedFar), jumpButton: !!jumpButton() };

    // 3. Back at the bottom: it follows again.
    scroller().scrollTop = scroller().scrollHeight;
    await sleep(100);
    await stream(textMsg(), PARA.repeat(2));
    await sleep(600);
    out.backAtBottom = { gap: gap(), jumpButton: !!jumpButton() };

    // 4. A nudge of 30px — inside the old 90px zone — still counts as leaving.
    wheelUp(30);
    await sleep(100);
    const parkedNudge = scroller().scrollTop;
    await stream(textMsg(), PARA.repeat(2));
    await sleep(600);
    out.nudge = { moved: Math.round(scroller().scrollTop - parkedNudge), jumpButton: !!jumpButton() };

    // 5. The jump button pins, and keeps up with a column still growing.
    const b = jumpButton();
    if (b) b.click();
    const mid = textMsg();
    await stream(mid, PARA.repeat(3));
    await sleep(800);
    out.afterJumpButton = { clicked: !!b, gap: gap(), jumpButton: !!jumpButton() };

    ev({ type: 'status', status: 'idle' });
    return out;
  })();
})()

// A streaming probe, not a shot: pumps two synthetic turns through the real
// `applyEvent` reducer — one in Claude's shape (a message per step, blank
// thinking messages between them) and one in Codex's (a single accumulating
// message) — at a realistic delta rate, and reports what the transcript did.
//
// Three kinds of number come back. Frame timing (long tasks, rAF gaps) says
// whether the stream *costs* smoothness; DOM identity says whether a finished
// reply or a settled tool row survives the moment it stops being live — a node
// that is no longer `isConnected` was rebuilt, which replays its enter
// animation, re-parses its markdown and blanks a diagram; and the reducer time
// per delta says what the store itself spends.
//
//   ./demo/shoot.sh /tmp/probe 60000 demo/e2e/stream-probe.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The store parks stream events while the window is hidden — and a probe
  // window behind the user's own is exactly that — so pin the page visible for
  // the run, or a parked `tool-update` reads as a label that never moved.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));

  const TEXT = [
    'Here is what the turn found, and what changed because of it.',
    '',
    'The **sidebar** redrew on every assistant message because `applyEvent` remapped `chats` to bump `updatedAt`, minting a new array that every subscriber compares by *identity*. The bump is now skipped when it would redraw nothing, and a row still ticks over on the message that genuinely crosses a boundary.',
    '',
    '- `ChatItem` is memoized behind one stable `RowActions` built per mount',
    '- each handler takes the chat it acts on instead of closing over it',
    '- anything volatile is read at click time through a ref refreshed every render',
    '',
    '```ts',
    'export function nextReveal(text: string, shown: number, limit: number, elapsedMs: number): number {',
    '  if (limit <= shown) return shown',
    '  const share = Math.min(1, Math.max(0, elapsedMs) / DRAIN_MS)',
    '  let next = shown + Math.max(1, Math.ceil((limit - shown) * share))',
    '  if (next >= limit) return limit',
    '  while (next < limit && !isBoundary(text[next - 1])) next++',
    '  return next',
    '}',
    '```',
    '',
    'The comparison is written out rather than left to the default, because `chatActivity` and `chatDetail` return a fresh object per call that a shallow compare reads as a change every time.',
    '',
    '| Surface | Before | After |',
    '| --- | --- | --- |',
    '| Sidebar | every message | boundary only |',
    '| Transcript | full re-render | live block only |',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[delta] --> B[coalesce 80ms]',
    '  B --> C[store]',
    '  C --> D[reveal]',
    '```',
    '',
    'That is the whole change. Nothing about the persisted value moved, and the next launch seeds the order exactly as it did before.'
  ].join('\n');

  const column = () => document.querySelector('[data-chatview] .overflow-y-auto > div');
  const lastMarkdown = () => [...column().querySelectorAll('.markdown')].pop();
  const lastToolRow = () => [...column().querySelectorAll('[data-slot="collapsible-trigger"], button')].filter((b) => /Edited|Ran|Read|Terminal|Edit/.test(b.textContent || '')).pop();
  // What is playing its entrance right now, by the text it carries — so a
  // count of one can be told apart: a card that just mounted, or a row that
  // was already on screen being rebuilt.
  const enterAnims = () =>
    document.getAnimations()
      .filter((a) => a.animationName === 'enter' && a.playState === 'running')
      .map((a) => ((a.effect && a.effect.target && a.effect.target.textContent) || '').trim().slice(0, 32));
  const rowWith = (text) => [...column().querySelectorAll('button')].filter((b) => (b.textContent || '').includes(text)).pop();
  const hasSvg = (el) => !!el && !!el.querySelector('svg');

  return (async () => {
    const row = startsWith('Build the Nimbus landing')[0];
    const target = row && (row.closest('button,[role="button"],li,a') || row);
    if (!target) return { error: 'hero chat not found' };
    target.click();
    await sleep(1500);
    const chatId = app.getState().activeId;
    if (!chatId) return { error: 'no active chat' };

    const metrics = { long: 0, longMs: 0, maxGap: 0, over32: 0, over50: 0, frames: 0, busyMs: 0, reducerMs: 0, deltas: 0 };
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { metrics.long++; metrics.longMs += e.duration; }
    });
    po.observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    let running = true;
    const frame = (now) => {
      const gap = now - last; last = now; metrics.frames++;
      if (gap > metrics.maxGap) metrics.maxGap = gap;
      if (gap > 32) metrics.over32++;
      if (gap > 50) metrics.over50++;
      metrics.busyMs += Math.max(0, gap - 17);
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const ev = (e) => {
      const t0 = performance.now();
      app.getState().applyEvent({ chatId, ...e });
      const dt = performance.now() - t0;
      if (e.type === 'part-delta') { metrics.reducerMs += dt; metrics.deltas++; }
    };
    let seq = 0;
    const id = (p) => `${p}-${Date.now()}-${seq++}`;
    const now = () => Date.now();
    const blank = () => ev({ type: 'message', message: { id: id('blank'), role: 'assistant', parts: [{ type: 'thinking', text: '' }], ts: now() } });
    const tool = async (name, input) => {
      const mid = id('tool'); const tid = id('tu');
      ev({ type: 'message', message: { id: mid, role: 'assistant', parts: [{ type: 'tool', toolUseId: tid, name, input, status: 'running', startedAt: now() }], ts: now() } });
      await sleep(400);
      ev({ type: 'tool-update', messageId: mid, toolUseId: tid, patch: { status: 'success', output: 'ok' } });
      return mid;
    };
    // ~190 chars/s, the pace of a fast model, in the 80ms lumps main coalesces into.
    const stream = async (mid, partIndex, text) => {
      let i = 0;
      while (i < text.length) {
        const n = Math.min(text.length - i, 12 + Math.floor(Math.random() * 8));
        ev({ type: 'part-delta', messageId: mid, partIndex, delta: text.slice(i, i + n) });
        i += n;
        await sleep(80);
      }
    };
    const scrollToEnd = () => { const el = document.querySelector('[data-chatview] .overflow-y-auto'); el.scrollTop = el.scrollHeight; };

    const identity = {};

    // ---- Claude shape ----
    ev({ type: 'status', status: 'streaming' });
    blank();
    const editMsg = await tool('Edit', { file_path: 'src/index.css', old_string: 'a', new_string: 'b' });
    await sleep(100);
    const editRow = lastToolRow();
    identity.editRowFound = !!editRow;
    identity.editAnimsAfterMount = enterAnims();
    await sleep(400);
    blank();
    await sleep(100);
    identity.editRowAfterBlank = !!editRow && editRow.isConnected;
    const textMsg = id('text');
    ev({ type: 'message', message: { id: textMsg, role: 'assistant', parts: [{ type: 'text', text: '' }], ts: now() } });
    await sleep(60);
    identity.editRowAfterText = !!editRow && editRow.isConnected;
    identity.editAnimsAfterText = enterAnims();
    await stream(textMsg, 0, TEXT);
    await sleep(700);
    const claudeText = lastMarkdown();
    identity.claudeTextSvgBefore = hasSvg(claudeText);
    blank();
    await sleep(50);
    identity.claudeTextAfterBlank = !!claudeText && claudeText.isConnected;
    identity.claudeTextSvgAfterBlank = hasSvg(lastMarkdown());
    await tool('Bash', { command: 'npm test' });
    await sleep(50);
    identity.claudeTextAfterTool = !!claudeText && claudeText.isConnected;
    identity.claudeTextSvgAfterTool = hasSvg([...column().querySelectorAll('.markdown')].filter((m) => m.querySelector('pre')).pop());
    const lastRow = rowWith('npm test') || lastToolRow();
    identity.claudeLastRowIsBash = !!rowWith('npm test');
    ev({ type: 'status', status: 'idle' });
    await sleep(60);
    identity.claudeLastRowAfterIdle = !!lastRow && lastRow.isConnected;
    identity.claudeAnimsAfterIdle = enterAnims();
    await sleep(800);

    // ---- Codex shape ----
    const claudeMetrics = { ...metrics };
    const cx = id('codex');
    ev({ type: 'status', status: 'streaming' });
    ev({ type: 'message', message: { id: cx, role: 'assistant', parts: [], ts: now() } });
    ev({ type: 'part', messageId: cx, partIndex: 0, part: { type: 'thinking', text: '' } });
    await stream(cx, 0, 'Looking at how the sidebar redraws. The bump mints a new array on every message, so every subscriber sees a change. I should skip it when the displayed time would not move.');
    ev({ type: 'part', messageId: cx, partIndex: 1, part: { type: 'text', text: '' } });
    await stream(cx, 1, TEXT);
    await sleep(700);
    const codexText = lastMarkdown();
    identity.codexTextSvgBefore = hasSvg(codexText);
    ev({ type: 'part', messageId: cx, partIndex: 2, part: { type: 'tool', toolUseId: id('tu'), name: 'Edit', input: { file_path: 'src/index.css', old_string: 'a', new_string: 'b' }, status: 'running', startedAt: now() } });
    await sleep(50);
    identity.codexTextAfterTool = !!codexText && codexText.isConnected;
    identity.codexTextSvgAfterTool = hasSvg([...column().querySelectorAll('.markdown')].filter((m) => m.querySelector('pre')).pop());
    identity.codexAnimsAfterTool = enterAnims();
    await sleep(400);
    ev({ type: 'part', messageId: cx, partIndex: 3, part: { type: 'text', text: '' } });
    await stream(cx, 3, 'And a closing paragraph, streamed after the edit, so the message ends in prose the way most do.');
    await sleep(700);
    const codexTail = lastMarkdown();
    const codexRow = lastToolRow();
    ev({ type: 'status', status: 'idle' });
    await sleep(60);
    identity.codexTailAfterIdle = !!codexTail && codexTail.isConnected;
    identity.codexRowAfterIdle = !!codexRow && codexRow.isConnected;
    identity.codexAnimsAfterIdle = enterAnims();
    await sleep(500);

    // ---- A grouped run (Claude shape): the live ToolGroup handing over to history ----
    const codexMetrics0 = { ...metrics };
    ev({ type: 'status', status: 'streaming' });
    blank();
    await tool('Read', { file_path: 'src/index.css' });
    blank();
    await tool('Grep', { pattern: 'sidebar', path: 'src' });
    await sleep(100);
    // The group's own row — the one that says "Read 2 files, 1 search" — and
    // not a call inside it: the panel's rows unmount when the run folds.
    const groupRow = [...column().querySelectorAll('button')].filter((b) => /\d+ (files?|searches?)/.test(b.textContent || '')).pop();
    identity.groupRowFound = !!groupRow;
    identity.groupOpenWhileLive = !!groupRow && groupRow.hasAttribute('data-panel-open');
    blank();
    await tool('Read', { file_path: 'src/App.tsx' });
    await sleep(100);
    identity.groupRowAfterThirdCall = !!groupRow && groupRow.isConnected;
    identity.groupTextLive = groupRow ? (groupRow.textContent || '').trim().slice(0, 48) : null;
    blank();
    const closing = id('text');
    ev({ type: 'message', message: { id: closing, role: 'assistant', parts: [{ type: 'text', text: '' }], ts: now() } });
    await sleep(60);
    identity.groupRowAfterText = !!groupRow && groupRow.isConnected;
    identity.groupAnimsAfterText = enterAnims();
    await sleep(350);
    // Still open, and rightly: a live message with nothing drawn yet keeps the
    // run live (see `liveRun`), so the group folds on the reply's first word.
    identity.groupOpenBeforeReplyDraws = !!groupRow && groupRow.hasAttribute('data-panel-open');
    await stream(closing, 0, 'Two reads and a search, then this line.');
    await sleep(600);
    identity.groupRowAfterReply = !!groupRow && groupRow.isConnected;
    identity.groupFoldedAfterReply = !!groupRow && !groupRow.hasAttribute('data-panel-open');
    identity.groupTextSettled = groupRow ? (groupRow.textContent || '').trim().slice(0, 48) : null;
    ev({ type: 'status', status: 'idle' });
    await sleep(80);
    identity.groupRowAfterIdle = !!groupRow && groupRow.isConnected;
    identity.groupAnimsAfterIdle = enterAnims();
    await sleep(400);
    scrollToEnd();
    running = false;
    po.disconnect();

    const diff = (a, b) => { const o = {}; for (const k of Object.keys(b)) o[k] = Math.round((b[k] - (a ? a[k] : 0)) * 10) / 10; return o; };
    return { identity, claude: diff(null, claudeMetrics), codex: diff(claudeMetrics, codexMetrics0), group: diff(codexMetrics0, metrics), log };
  })();
})()

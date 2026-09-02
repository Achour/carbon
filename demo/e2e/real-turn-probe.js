// A REAL turn, measured. Opens the chat named below, sets full access, sends
// one prompt through the ordinary send path and waits for the turn to end,
// recording frame timing, long tasks, and every "enter" animation whose target
// text had already been on screen — a replay is a row that was rebuilt. Read
// the key: two rows can share a placeholder label ("Terminal" is every Bash
// row before its command parses), and that pair is two entrances, not a replay.
//   sed 's/__CHAT__/Build the Nimbus landing/' demo/e2e/real-turn-probe.js
(() => {
  const CHAT = '__CHAT__';
  const PROMPT = 'Run `ls`, read package.json, and do one search of the repo for the word "export". Then write a summary of about 120 words of what this project is, with one fenced ts code block quoting five lines from package.json. Then run `ls` once more and end with one sentence.';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app;
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  return (async () => {
    const row = startsWith(CHAT)[0];
    if (!row) return { error: 'chat not found: ' + CHAT };
    (row.closest('button,[role="button"],li,a') || row).click();
    await sleep(1500);
    const chatId = app.getState().activeId;
    await app.getState().setChatOptions({ permissionMode: 'bypassPermissions' });
    await sleep(300);

    const t0 = performance.now();
    const m = { long: [], maxGap: 0, over32: 0, over50: 0, frames: 0, busyMs: 0 };
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.long.push({ at: Math.round(e.startTime - t0), ms: Math.round(e.duration) });
    });
    po.observe({ entryTypes: ['longtask'] });
    let last = performance.now(); let running = true;
    const frame = (now) => {
      const gap = now - last; last = now; m.frames++;
      if (gap > m.maxGap) m.maxGap = Math.round(gap);
      if (gap > 32) m.over32++;
      if (gap > 50) m.over50++;
      m.busyMs += Math.max(0, gap - 17);
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Entrances, and which of them are replays.
    const seenAnims = new WeakSet();
    const firstSeen = new Map();
    const entrances = [];
    const replays = [];
    const poll = setInterval(() => {
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (a.animationName !== 'enter' || seenAnims.has(a)) continue;
        seenAnims.add(a);
        const key = ((a.effect && a.effect.target && a.effect.target.textContent) || '').trim().slice(0, 40);
        const prev = firstSeen.get(key);
        entrances.push(key);
        if (prev !== undefined && now - prev > 1000) replays.push({ key, at: Math.round(now - t0) });
        if (prev === undefined) firstSeen.set(key, now);
      }
    }, 100);

    const status = () => app.getState().statuses[chatId] ?? 'idle';
    void app.getState().sendMessage(PROMPT, []);
    let waited = 0;
    while (status() === 'idle' && waited < 20000) { await sleep(100); waited += 100; }
    const started = performance.now();
    while (status() !== 'idle' && performance.now() - started < 240000) await sleep(200);
    const idleAt = Math.round(performance.now() - t0);
    await sleep(1500);
    running = false; po.disconnect(); clearInterval(poll);
    const msgs = app.getState().messages;
    const turn = msgs.slice(msgs.findIndex((x) => x.role === 'user' && x.text === PROMPT));
    const shape = turn.map((x) => x.role === 'assistant' ? x.parts.filter(Boolean).map((p) => p.type === 'tool' ? p.name : p.type + (p.text ? '' : '(blank)')).join('+') : x.role).join(' | ');
    return {
      chat: CHAT, status: status(), turnMs: idleAt, frames: m.frames, maxGap: m.maxGap, over32: m.over32, over50: m.over50,
      busyMs: Math.round(m.busyMs), long: m.long, entrances: entrances.length, replays, shape
    };
  })();
})()

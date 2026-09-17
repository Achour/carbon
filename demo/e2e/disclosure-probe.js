// What the reader actually complained about, measured: an activity row that
// folds and unfolds under them while a turn is working, and the frames the
// transcript drops while it does.
//
// Three instruments, all on the same clock:
//
//   `toggles`    — every `data-panel-open` flip on a row that STAYED mounted.
//                  That is a disclosure changing its mind: the row was open,
//                  the row is shut, nothing about it was clicked.
//   `played`     — every animation an activity row played, **with the computed
//                  style it had while playing**. Counting animations is not
//                  enough: the first answer here played `enter` (a 6px rise) on
//                  a row inside a clipping panel, so the animation ran in full
//                  while the row was cropped out of sight and the reader
//                  correctly reported no animation at all. An opacity under 1
//                  or a filter carrying a blur is a frame that can be seen —
//                  `invisible` counts the ones that cannot. A `step-in` on an
//                  `inPanel` row is a step arriving; an `enter` on a group
//                  summary would be the promotion rebuild.
//                  (Matching rows by their label text was an earlier answer and
//                  it over-counts: "Terminal" is a real label for an
//                  unrecognized shell verb, so two different calls share it.
//                  An animation is a thing that happened.)
//   `settled`    — the transcript 1.5s and 4.5s after idle: whether the turn
//                  folded at all, and what its runs' disclosures ended up as.
//   frame timing / long tasks — whether the stream also *costs* smoothness.
//
// Pair it with AIGUI_PROFILE to see what a long task was doing.
//   ./demo/shoot.sh /tmp/disc 220000 demo/e2e/disclosure-probe.js
(() => {
  const CHAT = '__CHAT__';
  // Shaped like the complaint, and the shape matters twice over. A *run* only
  // forms from consecutive tool-only messages, so the prompt asks for batches
  // with no commentary inside them — otherwise every call is a lone card and
  // there is no disclosure to flicker. The sentence *between* the batches is
  // the other half: it is what ends a run and hands the group to history.
  const PROMPT =
    'Do this in three batches. Inside a batch, make the calls back to back with no commentary at all between them; ' +
    'between batches, write exactly one short sentence. ' +
    'Batch 1: run `ls`, then `pwd`, then `date`, then `wc -l README.md`. ' +
    'Batch 2: read package.json, read README.md, then search the repo for "export" and for "import". ' +
    'Batch 3: run `ls -la`, then `echo one`, then `echo two`, then `echo three`. ' +
    'Then finish with two sentences about what you found. Use no other tools. ' +
    // The chat keeps every turn this probe has ever sent, and the report slices
    // the transcript at the prompt it finds — so an identical prompt makes the
    // slice start at the FIRST run and the shape spans every run since.
    `(run ${Date.now()})`;
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
    await app.getState().setChatOptions(chatId, { permissionMode: 'bypassPermissions' });
    await sleep(300);

    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const m = { long: [], maxGap: 0, over32: 0, over50: 0, frames: 0, busyMs: 0 };
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        m.long.push({ at: Math.round(e.startTime - t0), ms: Math.round(e.duration) });
    });
    po.observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    let running = true;
    const frame = (now) => {
      const gap = now - last;
      last = now;
      m.frames++;
      if (gap > m.maxGap) m.maxGap = Math.round(gap);
      if (gap > 32) m.over32++;
      if (gap > 50) m.over50++;
      m.busyMs += Math.max(0, gap - 17);
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // An activity row is a Collapsible.Trigger inside the transcript. Its label
    // is the first 44 characters of its own text, which is stable enough to
    // name the row across a remount and is all the report needs.
    const surface = () => document.querySelector('[data-chat-surface="' + chatId + '"]');
    const labelOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 44);
    // `TurnHeader` is an `[aria-expanded]` button too, and it is NOT an activity
    // row: its flip is the turn folding, which is the one fold that is meant to
    // happen. Counted as a row it would land in `toggles` as a false positive.
    const isHeader = (el) => el.hasAttribute('data-turn-header');
    // What the transcript looks like right now: the turn headers and their
    // state, and every disclosure the surface holds.
    //
    // `rows` is deliberately NOT only activity rows — the changes card, the
    // undo control and the composer's own pickers are `[aria-expanded]` too, so
    // a populated list is not a failure. The test is the absence of a *group
    // summary* from it: a settled turn folds its work away, so no "Ran 4
    // commands" may appear here.
    const snapshot = () => {
      const root = surface();
      if (!root) return null;
      return {
        at: at(),
        headers: [...root.querySelectorAll('[data-turn-header]')].map((el) => ({
          label: labelOf(el),
          expanded: el.getAttribute('aria-expanded') === 'true'
        })),
        rows: [...root.querySelectorAll('[aria-expanded]')]
          .filter((el) => !isHeader(el))
          .map((el) => ({ label: labelOf(el), open: el.getAttribute('data-panel-open') !== null }))
      };
    };

    const toggles = [];
    // Identity, so a flip on a surviving element is told from a replacement.
    const known = new Map(); // element -> { label, open }

    const scan = () => {
      const root = surface();
      if (!root) return;
      for (const el of root.querySelectorAll('[aria-expanded]')) {
        if (isHeader(el)) continue;
        const open =
          el.getAttribute('data-panel-open') !== null || el.getAttribute('aria-expanded') === 'true';
        const label = labelOf(el);
        const seen = known.get(el);
        if (seen) {
          if (seen.open !== open) {
            toggles.push({ at: at(), label: seen.label, to: open ? 'open' : 'shut' });
            seen.open = open;
          }
          seen.label = label;
        } else {
          known.set(el, { label, open });
        }
      }
    };

    // **Is a step's arrival actually visible?** Counting animations is not
    // enough — the first answer here played `enter` on a row inside a clipping
    // panel, so the animation ran in full while the row was cropped out of
    // sight and the reader reported no animation at all. So sample the
    // *computed* style the moment an animation is first seen: an opacity below
    // 1, or a filter carrying a blur, is the frame the reader can see.
    const seenAnims = new WeakSet();
    const played = [];
    const animPoll = setInterval(() => {
      for (const a of document.getAnimations()) {
        if (seenAnims.has(a)) continue;
        const name = a.animationName;
        if (name !== 'enter' && name !== 'step-in') continue;
        seenAnims.add(a);
        const el = a.effect && a.effect.target;
        if (!(el instanceof HTMLElement)) continue;
        const trigger = el.matches('[aria-expanded]') ? el : el.querySelector('[aria-expanded]');
        if (!trigger || isHeader(trigger)) continue;
        const cs = getComputedStyle(el);
        played.push({
          at: at(),
          name,
          label: labelOf(trigger),
          // Mid-animation, so both should be short of their resting values.
          opacity: Number(cs.opacity).toFixed(2),
          filter: cs.filter,
          ms: Math.round(Number(a.effect.getTiming().duration) || 0),
          // A row is a group member when the group's panel is its ancestor.
          inPanel: !!el.closest('[data-panel-open]')
        });
      }
    }, 30);
    const mo = new MutationObserver(scan);
    // Attributes for the flips, childList for the rebuilds.
    const armed = surface();
    if (armed) {
      mo.observe(armed, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-panel-open', 'aria-expanded']
      });
    }
    // The observer only fires on change; a poll catches a row that was added
    // and removed between two microtask checkpoints.
    const poll = setInterval(scan, 120);
    scan();

    const status = () => app.getState().statuses[chatId] ?? 'idle';
    void app.getState().sendMessage(chatId, PROMPT, []);
    let waited = 0;
    while (status() === 'idle' && waited < 20000) {
      await sleep(100);
      waited += 100;
    }
    const started = performance.now();
    while (status() !== 'idle' && performance.now() - started < 210000) await sleep(200);
    const idleAt = at();
    const settled = [];
    await sleep(1500);
    scan();
    settled.push(snapshot());
    await sleep(3000);
    scan();
    settled.push(snapshot());
    running = false;
    po.disconnect();
    clearInterval(poll);
    clearInterval(animPoll);
    mo.disconnect();

    const msgs = app.getState().messages;
    const turn = msgs.slice(msgs.findIndex((x) => x.role === 'user' && x.text === PROMPT));
    const shape = turn
      .map((x) =>
        x.role === 'assistant'
          ? x.parts
              .filter(Boolean)
              .map((p) => (p.type === 'tool' ? p.name : p.type + (p.text ? '' : '(blank)')))
              .join('+')
          : x.role
      )
      .join(' | ');
    // A fold the reader did not ask for is a `shut` on a row that is still the
    // turn's work, so report the shuts separately from the opens.
    const shuts = toggles.filter((t) => t.to === 'shut');
    return {
      chat: CHAT,
      status: status(),
      turnMs: idleAt,
      shape,
      toggles: toggles.length,
      shuts: shuts.length,
      toggleLog: toggles,
      settled,
      // Every animation an activity row played, with the style it had while
      // playing. A `step-in` on an `inPanel` row is a step arriving visibly; an
      // `enter` on a group summary would be the promotion rebuild.
      played,
      stepIns: played.filter((p) => p.name === 'step-in').length,
      invisible: played.filter((p) => Number(p.opacity) > 0.95 && p.filter === 'none').length,
      groupEntrances: played.filter(
        (p) => p.name === 'enter' && /^(Ran|Read|Wrote|Searched|Edited|Found|Listed)/.test(p.label)
      ).length,
      frames: m.frames,
      maxGap: m.maxGap,
      over32: m.over32,
      over50: m.over50,
      busyMs: Math.round(m.busyMs),
      long: m.long
    };
  })();
})()

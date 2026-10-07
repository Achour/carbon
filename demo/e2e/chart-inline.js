// An inline-chart probe: pumps synthetic `chart_render` calls through the real
// `applyEvent` reducer and reads back what the transcript draws — a native
// chart under its call, surviving the turn's fold, with a legend only when
// there is more than one series, a table view, and a later chart leaving the
// earlier one exactly as it was.
//
// The calls are synthetic on purpose: what is under test is the render path,
// not what a model felt like plotting. Nothing is saved — a chart lives only in
// its call — so there is nothing to clean up afterwards.
//
//   ./demo/shoot.sh /tmp/chart-inline 12000 demo/e2e/chart-inline.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const TURN = 'probe-chart-user';

  const EDITS = {
    kind: 'bar',
    title: 'Edits per file, last 60 days',
    description: 'Commits touching each file',
    x: 'file',
    data: [
      { file: 'store.ts', edits: 45, tests: 12 },
      { file: 'ChatView.tsx', edits: 31, tests: 9 },
      { file: 'ToolCard.tsx', edits: 27, tests: 6 },
      { file: 'claude.ts', edits: 22, tests: 14 },
      { file: 'chartSpec.ts', edits: 12, tests: 8 }
    ],
    series: [{ key: 'edits', label: 'Edits' }, { key: 'tests', label: 'Test edits' }],
    stats: [
      { label: 'files changed', value: '1,296' },
      { label: 'edits', value: '3,310' },
      { label: 'of lines are tests', value: '50%' }
    ],
    footer: 'store.ts takes the most churn by a wide margin.'
  };
  const TREND = {
    kind: 'area',
    title: 'Turns per day',
    x: 'day',
    data: ['Sep 22', 'Sep 23', 'Sep 24', 'Sep 25', 'Sep 26', 'Sep 27', 'Sep 28'].map((day, i) => ({ day, turns: 40 + i * 9 + (i % 2) * 12 })),
    series: [{ key: 'turns', label: 'Turns' }]
  };

  const call = (chatId, msgId, name, input) =>
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: {
        id: msgId,
        role: 'assistant',
        ts: Date.now(),
        parts: [{ type: 'tool', toolUseId: `${msgId}-t`, name, input, status: 'running', startedAt: Date.now() }]
      }
    });
  const settle = (chatId, msgId, output) =>
    app.getState().applyEvent({
      type: 'tool-update',
      chatId,
      messageId: msgId,
      toolUseId: `${msgId}-t`,
      patch: { status: 'success', output }
    });
  const charts = () => [...document.querySelectorAll('[data-chart-render]')];
  const titled = (t) => charts().find((c) => c.textContent.includes(t));
  const rows = () =>
    [...document.querySelectorAll('[data-chatview] *')]
      .filter((e) => !e.children.length && (e.textContent || '').trim())
      .map((e) => (e.textContent || '').trim());

  return (async () => {
    const meta = app.getState().chats[0];
    if (meta) await app.getState().openChat(meta.id);
    await sleep(1500);
    const chatId = app.getState().activeId;
    check('a chat is open', !!chatId, chatId || 'none');
    if (!chatId) return log.join('\n');
    check('no chart is drawn before the probe draws one', charts().length === 0, `${charts().length}`);

    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: { id: TURN, role: 'user', ts: Date.now(), text: 'Which files churn the most?' }
    });
    await sleep(300);

    // 1. A running call draws nothing yet: its input is still streaming.
    call(chatId, 'probe-c', 'mcp__carbon__chart_render', EDITS);
    await sleep(400);
    check('a running call draws no chart', charts().length === 0, `${charts().length}`);

    // 2. Landed, then answered. The chat is idle, so the turn is settled and
    //    folded: the chart survives the fold, as a screenshot does.
    settle(chatId, 'probe-c', `Drew "${EDITS.title}" in the conversation.`);
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: { id: 'probe-answer', role: 'assistant', ts: Date.now(), parts: [{ type: 'text', text: '`store.ts` churns the most, and a quarter of its edits are tests.' }] }
    });
    await sleep(2000);
    check('the folded turn keeps the chart', charts().length === 1, `${charts().length}`);
    const bars = titled('Edits per file');
    check('it is drawn natively, not in a frame', !!bars?.querySelector('svg.recharts-surface') && !bars?.querySelector('iframe'));
    const rects = bars?.querySelectorAll('.recharts-bar-rectangle path, .recharts-rectangle') ?? [];
    check('one bar per row per series', rects.length === EDITS.data.length * EDITS.series.length, `${rects.length}`);
    const widest = Math.max(...[...rects].map((r) => r.getBoundingClientRect().width));
    check('bars stay thin (≤ 24px)', widest > 0 && widest <= 24.5, `${widest.toFixed(1)}px`);
    check('two series carry a legend', !!bars?.querySelector('.recharts-legend-wrapper') && bars.textContent.includes('Test edits'));
    check('the headline stats are drawn', ['1,296', '3,310', '50%'].every((v) => bars?.textContent.includes(v)));
    check('nothing animates on mount', document.getAnimations().filter((a) => bars?.contains(a.effect?.target)).length === 0);
    const answer = [...document.querySelectorAll('[data-chatview] p')].find((p) => p.textContent.includes('churns the most'));
    check(
      'the chart sits above the answer',
      !!answer && !!bars && (bars.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );

    // 3. The table view: the numbers without hovering.
    [...bars.querySelectorAll('button')].find((b) => b.textContent === 'Table')?.click();
    await sleep(300);
    const cells = [...bars.querySelectorAll('td')].map((td) => td.textContent);
    check('the table view lists every value', cells.includes('store.ts') && cells.includes('45') && cells.includes('14'), cells.slice(0, 6).join(','));
    [...bars.querySelectorAll('button')].find((b) => b.textContent === 'Chart')?.click();
    await sleep(300);

    // 4. Unfolded, the row is back — named for what it is — and the chart is
    //    still drawn once.
    app.getState().toggleTurnExpanded(TURN);
    await sleep(800);
    check('unfolded, the row reads as a chart', rows().includes('Chart') && rows().some((t) => t.includes('Edits per file')));
    check('and the chart is drawn once', charts().length === 1, `${charts().length}`);
    app.getState().toggleTurnExpanded(TURN);
    await sleep(500);

    // 5. Grok wraps the call in `use_tool` with an empty result. One series:
    //    the title names it, so there is no legend.
    call(chatId, 'probe-g', 'use_tool', { tool_name: 'carbon__chart_render', tool_input: TREND });
    settle(chatId, 'probe-g', '');
    await sleep(1500);
    const area = titled('Turns per day');
    check("a Grok call draws its own chart", !!area?.querySelector('.recharts-area'));
    check('one series carries no legend', !!area && !area.querySelector('.recharts-legend-wrapper'));

    // 6. A later turn draws the chart again, changed. The earlier chart is
    //    exactly what it was — nothing is shared between the two calls.
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: { id: 'probe-chart-user-2', role: 'user', ts: Date.now(), text: 'Just the last 30 days, horizontal.' }
    });
    app.getState().applyEvent({ type: 'status', chatId, status: 'streaming' });
    await sleep(300);
    const recent = { ...EDITS, title: 'Edits per file, last 30 days', horizontal: true, stats: [], series: [EDITS.series[0]], data: EDITS.data.map((r) => ({ ...r, edits: Math.round(r.edits / 2) })) };
    call(chatId, 'probe-c2', 'mcp__carbon__chart_render', recent);
    settle(chatId, 'probe-c2', `Drew "${recent.title}" in the conversation.`);
    await sleep(1500);
    check('the earlier turn keeps its chart', !!titled('last 60 days'));
    check('the new turn draws its own', !!titled('last 30 days')?.querySelector('.recharts-bar'));
    const bubble = [...document.querySelectorAll('[data-chatview] *')].find((e) => !e.children.length && e.textContent.trim() === 'Just the last 30 days, horizontal.');
    check(
      'and it is drawn under the new turn',
      !!bubble && !!titled('last 30 days') && (bubble.compareDocumentPosition(titled('last 30 days')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
    app.getState().applyEvent({ type: 'status', chatId, status: 'idle' });
    await sleep(800);
    check('settled, all three charts stand', charts().length === 3, `${charts().length}`);

    bars?.scrollIntoView({ block: 'start' });
    return log.join('\n');
  })();
})()

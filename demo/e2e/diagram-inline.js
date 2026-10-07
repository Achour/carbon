// An inline-diagram probe: pumps synthetic `diagram_render` calls through the
// real `applyEvent` reducer and checks what the transcript draws — the graph
// laid out under its call, surviving the turn's fold, no two boxes on top of
// one another, every edge drawn and labelled, groups around their members —
// then captures it in dark and in light (the profile's own theme is written
// back at once, so the demo profile wakes in the mode it had).
//
//   ./demo/shoot.sh /tmp/diagram 10000,13000,16000,19000 demo/e2e/diagram-inline.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const TURN = 'probe-diagram-user';

  const AUTOFILL = {
    title: 'Where each value goes after a reference is picked',
    description: 'Watchdata autofill',
    nodes: [
      { id: 'pick', label: 'Seller picks a reference', tone: 'accent' },
      { id: 'write', label: 'Write brand, family, reference now', detail: 'form state, before any fetch' },
      { id: 'fetch', label: 'Fetch watch data', detail: 'GET /watches/{brand}/{reference}', group: 'api' },
      { id: 'null', label: 'Return null', detail: 'network error, timeout, 401 or no data', tone: 'danger', group: 'api' },
      { id: 'map', label: 'Map each field to our keys', group: 'api' },
      { id: 'keep', label: 'Keep what the seller typed', tone: 'muted' },
      { id: 'fill', label: 'Fill empty fields only', detail: 'movement, case, dial, year' },
      { id: 'done', label: 'Form ready to review', tone: 'success' }
    ],
    edges: [
      { from: 'pick', to: 'write' },
      { from: 'write', to: 'fetch' },
      { from: 'fetch', to: 'null', label: 'failed', dashed: true },
      { from: 'fetch', to: 'map', label: 'data returned' },
      { from: 'null', to: 'keep' },
      { from: 'map', to: 'fill' },
      { from: 'keep', to: 'done' },
      { from: 'fill', to: 'done' }
    ],
    groups: [{ id: 'api', label: 'watchdata.ts' }],
    footer: 'A failed lookup never blocks the form — it just leaves the fields to the seller.'
  };
  const REQUEST = {
    title: 'A send, end to end',
    direction: 'right',
    nodes: [
      { id: 'composer', label: 'Composer', group: 'renderer' },
      { id: 'store', label: 'store.sendMessage', group: 'renderer' },
      { id: 'ipc', label: 'chat:send', detail: 'IPC', group: 'main' },
      { id: 'session', label: 'ChatManager', group: 'main', tone: 'accent' },
      { id: 'cli', label: 'Provider CLI', tone: 'muted' }
    ],
    edges: [
      { from: 'composer', to: 'store' },
      { from: 'store', to: 'ipc' },
      { from: 'ipc', to: 'session' },
      { from: 'session', to: 'cli', label: 'stdin' },
      { from: 'cli', to: 'session', label: 'events', dashed: true }
    ],
    groups: [{ id: 'renderer', label: 'Renderer' }, { id: 'main', label: 'Main process' }]
  };

  const call = (chatId, msgId, input, status) =>
    app.getState().applyEvent({
      type: 'message',
      chatId,
      message: { id: msgId, role: 'assistant', ts: Date.now(), parts: [{ type: 'tool', toolUseId: `${msgId}-t`, name: 'mcp__carbon__diagram_render', input, status, startedAt: Date.now(), ...(status === 'success' ? { output: `Drew "${input.title}" in the conversation.` } : {}) }] }
    });
  const diagrams = () => [...document.querySelectorAll('[data-diagram-render]')];
  const titled = (t) => diagrams().find((d) => d.getAttribute('aria-label') === t);
  const overlaps = (els) => {
    const r = els.map((e) => e.getBoundingClientRect());
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++)
        if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1 && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) return true;
    return false;
  };
  // A node box is an absolutely-positioned bordered div holding the label.
  const boxes = (d) => [...d.querySelectorAll('.absolute.rounded-lg.border')];

  return (async () => {
    const original = localStorage.getItem('themeMode');
    const meta = app.getState().chats.find((c) => /Nimbus landing/.test(c.title || '')) ?? app.getState().chats[0];
    await app.getState().openChat(meta.id);
    await sleep(1200);
    const chatId = app.getState().activeId;
    app.getState().setThemeMode('dark');
    check('no diagram is drawn before the probe draws one', diagrams().length === 0);
    app.getState().applyEvent({ type: 'message', chatId, message: { id: TURN, role: 'user', ts: Date.now(), text: 'How does Watchdata autofill work? Show me in the chat.' } });
    await sleep(200);

    call(chatId, 'probe-d', AUTOFILL, 'running');
    await sleep(400);
    check('a running call draws nothing yet', diagrams().length === 0);
    call(chatId, 'probe-d', AUTOFILL, 'success');
    app.getState().applyEvent({ type: 'message', chatId, message: { id: 'probe-d-answer', role: 'assistant', ts: Date.now(), parts: [{ type: 'text', text: 'The brand, family and reference land at once; the fetch only ever fills what is still empty.' }] } });
    await sleep(2000);

    const flow = titled(AUTOFILL.title);
    check('the folded turn keeps the diagram', diagrams().length === 1 && !!flow);
    const nodeBoxes = flow ? boxes(flow) : [];
    check('one box per node', nodeBoxes.length === AUTOFILL.nodes.length, `${nodeBoxes.length}`);
    check('no two boxes overlap', !overlaps(nodeBoxes));
    check('one arrow per edge', flow?.querySelectorAll('svg path[marker-end]').length === AUTOFILL.edges.length);
    check('edge labels are drawn', ['failed', 'data returned'].every((l) => flow?.textContent.includes(l)));
    check('a dashed edge is dashed', flow?.querySelectorAll('svg path[stroke-dasharray]').length === 1);
    const group = flow?.querySelector('.rounded-xl');
    const inGroup = ['Fetch watch data', 'Return null', 'Map each field to our keys'].map((t) => nodeBoxes.find((b) => b.textContent.includes(t))?.getBoundingClientRect());
    const g = group?.getBoundingClientRect();
    check('the group surrounds its members', !!g && inGroup.every((r) => r && r.left >= g.left && r.right <= g.right && r.top >= g.top && r.bottom <= g.bottom));
    const scroller = flow?.querySelector('.overflow-x-auto');
    check('it fits the column without scrolling', !!scroller && scroller.scrollWidth <= scroller.clientWidth + 1, `${scroller?.scrollWidth} / ${scroller?.clientWidth}`);
    // The same graph in words, for a screen reader: every step with its
    // detail and state, and every arrow with its condition.
    const words = flow?.querySelector('.sr-only')?.textContent ?? '';
    check(
      'a screen reader gets the whole graph, not just the title',
      words.includes('Return null: network error, timeout, 401 or no data (failure), in watchdata.ts') && words.includes('Fetch watch data to Return null, failed (dashed)'),
      words.slice(0, 90)
    );
    check('the drawing itself is hidden from it', flow?.querySelector('.overflow-x-auto')?.getAttribute('aria-hidden') === 'true');
    const answer = [...document.querySelectorAll('[data-chatview] p')].find((p) => p.textContent.includes('fills what is still empty'));
    check('the diagram sits above the answer', !!answer && !!flow && (flow.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

    app.getState().toggleTurnExpanded(TURN);
    await sleep(700);
    const rowText = [...document.querySelectorAll('[data-chatview] *')].filter((e) => !e.children.length).map((e) => e.textContent.trim());
    check('unfolded, the row reads as a diagram', rowText.includes('Diagram'));
    check('and the diagram is drawn once', diagrams().length === 1);
    app.getState().toggleTurnExpanded(TURN);
    await sleep(400);

    // A left-to-right flow across two groups, through Grok's wrapping.
    app.getState().applyEvent({ type: 'message', chatId, message: { id: 'probe-g', role: 'assistant', ts: Date.now(), parts: [{ type: 'tool', toolUseId: 'probe-g-t', name: 'use_tool', input: { tool_name: 'carbon__diagram_render', tool_input: REQUEST }, status: 'success', output: '' }] } });
    await sleep(1500);
    const req = titled(REQUEST.title);
    check("a Grok call draws its own diagram", !!req);
    const reqBoxes = req ? boxes(req) : [];
    // Left to right where the column holds it, turned downward where it does
    // not — either way the steps advance along one axis, in order.
    const at4 = ['Composer', 'store.sendMessage', 'chat:send', 'ChatManager'].map((t) => reqBoxes.find((b) => b.textContent.includes(t))?.getBoundingClientRect());
    const across = at4.every((r, i) => r && (i === 0 || r.left > at4[i - 1].left));
    const down = at4.every((r, i) => r && (i === 0 || r.top > at4[i - 1].top));
    check('a right-running flow advances in order, across or (when narrow) down', across || down, across ? 'across' : down ? 'down' : 'neither');
    const reqScroller = req?.querySelector('.overflow-x-auto');
    check('and fits the column without scrolling', !!reqScroller && reqScroller.scrollWidth <= reqScroller.clientWidth + 1, `${reqScroller?.scrollWidth} / ${reqScroller?.clientWidth}`);
    check('two groups are drawn', req?.querySelectorAll('.rounded-xl').length === 2);
    check('no two boxes overlap there either', !overlaps(reqBoxes));

    // A graph dagre's compound pass cannot place (dense, every node grouped —
    // it returns NaN): the fallback draws no group boxes and captions each
    // node with its group instead.
    const ALL = {
      title: 'All grouped',
      nodes: [...Array(40)].map((_, i) => ({ id: `n${i}`, label: `Step ${i}`, group: `g${i % 8}` })),
      edges: [...Array(80)].map((_, i) => ({ from: `n${i % 40}`, to: `n${(i * 7 + 3) % 40}` })),
      groups: [...Array(8)].map((_, i) => ({ id: `g${i}`, label: `Group ${i}` }))
    };
    app.getState().applyEvent({ type: 'message', chatId, message: { id: 'probe-all', role: 'assistant', ts: Date.now(), parts: [{ type: 'tool', toolUseId: 'probe-all-t', name: 'mcp__carbon__diagram_render', input: ALL, status: 'success', output: 'Drew "All grouped".' }] } });
    await sleep(1500);
    const all = titled('All grouped');
    const allBoxes = all ? boxes(all) : [];
    const captioned = allBoxes.filter((b) => /^Group \d/.test(b.firstElementChild?.textContent ?? ''));
    log.push(`INFO all-grouped: ${all?.querySelectorAll('.rounded-xl').length} group boxes, ${captioned.length}/${allBoxes.length} captioned`);
    check('an all-grouped graph draws every node, without overlap', allBoxes.length === 40 && !overlaps(allBoxes));
    check('it fell back: no group boxes, a caption on every node', all?.querySelectorAll('.rounded-xl').length === 0 && captioned.length === 40);

    const at = async (ms) => { while (performance.now() < ms) await sleep(100); };
    await at(8500); all?.scrollIntoView({ block: 'start' });
    await at(11500); req?.scrollIntoView({ block: 'center' });
    await at(14500); app.getState().setThemeMode('light'); flow?.scrollIntoView({ block: 'start' });
    if (original === null) localStorage.removeItem('themeMode');
    else localStorage.setItem('themeMode', original);
    await at(17500); req?.scrollIntoView({ block: 'center' });
    return log.join('\n');
  })();
})()

// A thread probe, and the shots that go with it: opens a chat, grows it to four
// columns, pumps Claude-shaped turns through the *real* `applyEvent` reducer
// into them, and checks what the feature rests on — that four transcripts share
// one store without touching each other, and that focus, expansion, the closed
// list and the floating panel each do what they say.
//
// The events are synthetic on purpose. What is being tested is the reducer's
// routing and the thread's wiring, and a real turn would make that depend on a
// provider CLI being installed and on whatever the model felt like saying.
//
// It creates and deletes chats, so run it against a copy of the profile:
//
//   ./demo/shoot.sh /tmp/threads 24000,28000,32000,36000,40000,50000 demo/e2e/threads.js
//
// Shots, in order: three chats in columns with one waiting on a prompt; four in
// a grid; one expanded to the full width; the panel floating over
// the columns; the panel pinned beside them.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Capture delays count from page load; this script starts about a second in.
  const loadedAt = Date.now() - 1000;
  const until = (ms) => sleep(Math.max(0, ms - (Date.now() - loadedAt)));
  // The store parks stream events while the window is hidden, and a probe window
  // behind the user's own is exactly that.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) =>
    log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const S = () => app.getState();

  let seq = 0;
  const user = (chatId, text) =>
    S().applyEvent({ type: 'message', chatId, message: { id: `u-${chatId}-${++seq}`, role: 'user', ts: Date.now(), text } });
  const turn = (chatId, text, tools = []) => {
    const id = `a-${chatId}-${++seq}`;
    const parts = [
      ...tools.map((t, i) => ({ type: 'tool', toolUseId: `${id}-t${i}`, name: t.name, input: t.input, status: 'done', output: 'ok', startedAt: Date.now() })),
      { type: 'text', text: '' }
    ];
    S().applyEvent({ type: 'message', chatId, message: { id, role: 'assistant', ts: Date.now(), parts } });
    for (const word of text.split(' ')) {
      S().applyEvent({ type: 'part-delta', chatId, messageId: id, partIndex: parts.length - 1, delta: word + ' ' });
    }
    return id;
  };
  const status = (chatId, value) => S().applyEvent({ type: 'status', chatId, status: value });
  const retitle = (chatId, patch) =>
    app.setState((st) => ({ chats: st.chats.map((c) => (c.id === chatId ? { ...c, ...patch } : c)) }));

  // No two buttons in a composer's bar may overlap — the failure a narrow
  // column produced before the chips learned to drop their labels.
  const composerOverlaps = () => {
    const bad = [];
    for (const bar of document.querySelectorAll('[data-chat-surface] [data-composer-bar]')) {
      const boxes = [...bar.querySelectorAll('button')]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0)
        .sort((a, b) => a.left - b.left);
      for (let i = 1; i < boxes.length; i++) {
        if (boxes[i].left < boxes[i - 1].right - 1) bad.push(Math.round(boxes[i - 1].right - boxes[i].left));
      }
    }
    return bad;
  };

  return (async () => {
    // A backgrounded window paints late, and a capture is then one step stale.
    await window.api.focusWindow();
    // --- A thread starts as one chat ---
    await S().openChat('demo-nimbus-landing');
    await sleep(1500);
    const mainId = S().activeId;
    check('a chat is open', mainId === 'demo-nimbus-landing', mainId || 'none');
    check('it starts as one column', S().sideColumns.length === 0 && !document.querySelector('[data-thread-column]'));
    check('keys belong to it', S().focusedChatId === mainId, S().focusedChatId);
    check('a single chat never collapses its composer', !document.querySelector('[data-composer][data-collapsed]'));
    if (!S().panelOpen) S().togglePanel();
    await sleep(500);
    check('a single chat gets the docked panel',
      !!document.querySelector('[data-right-panel]') && !document.querySelector('[data-right-panel][data-floating]'));
    check('...with no pin to float it', !document.querySelector('[aria-label="Pin panel beside the chats"], [aria-label="Float panel over the chats"]'));
    S().togglePanel();
    await sleep(300);

    // --- Growing it ---
    await S().addThreadChat();
    await sleep(900);
    const c2 = S().sideColumns[0];
    check('adding a chat opens a column', !!c2 && !!S().sideChats[c2], JSON.stringify(S().sideColumns));
    check('...and focuses it', S().focusedChatId === c2, S().focusedChatId);
    const meta2 = S().chats.find((c) => c.id === c2);
    check('it is a side chat of this thread', meta2?.sideOf === mainId && !!meta2?.ephemeral);
    check("it runs in the thread's folder", meta2?.cwd === S().chats.find((c) => c.id === mainId)?.cwd);
    check('the caret moved into its composer',
      document.activeElement?.closest?.('[data-chat-surface]')?.getAttribute('data-chat-surface') === c2);
    check('both columns are drawn', document.querySelectorAll('[data-thread-column]').length === 2);

    await S().addThreadChat();
    await S().addThreadChat();
    await sleep(900);
    const [, c3, c4] = [null, ...S().sideColumns.slice(1)];
    check('a thread holds four', S().sideColumns.length === 3, `${1 + S().sideColumns.length} chats`);
    const before = S().chats.length;
    await S().addThreadChat();
    await sleep(500);
    check('a fifth is refused', S().sideColumns.length === 3 && S().chats.length === before);

    // --- Four transcripts, one store ---
    const mainRef = S().messages;
    const c3Ref = S().sideChats[c3].messages;
    user(c2, 'Review the hero section against the brand guide');
    turn(c2, 'The hero uses the right type scale; the CTA contrast is 3.9:1, under the 4.5:1 the guide asks for.');
    await sleep(600);
    check("a column's turn lands in its own slot", S().sideChats[c2].messages.length === 2);
    check('the first column is untouched (same reference)', S().messages === mainRef);
    check('another column is untouched (same reference)', S().sideChats[c3].messages === c3Ref);
    const c2Ref = S().sideChats[c2].messages;
    turn(mainId, 'Pricing grid is wired to the new plan data.');
    await sleep(500);
    check("the first column's turn stays out of the side slots", S().sideChats[c2].messages === c2Ref);

    // --- Per-chat docks and rosters ---
    check('the task store is keyed by chat', typeof window.__tasks.getState().byChat === 'object');
    check('the agent store is keyed by chat', typeof window.__agents.getState().byChat === 'object');

    // --- Focus and unread ---
    S().focusChat(c3);
    status(c2, 'streaming');
    status(c2, 'idle');
    await sleep(300);
    check('a column that finishes unseen is marked', !!S().unreadChats[c2]);
    S().focusChat(c2);
    check('focusing it clears the mark', !S().unreadChats[c2] && S().focusedChatId === c2);

    // --- Layout ---
    await sleep(400);
    const grid = () => !!document.querySelector('[data-thread-column]')?.parentElement?.classList.contains('grid');
    check('four chats default to a grid', grid());
    check('the folder, branch and changes show once, in the thread header',
      document.querySelectorAll('[data-context-strip]').length === 1 &&
        !document.querySelector('[data-thread-column] [data-context-strip]'),
      `${document.querySelectorAll('[data-context-strip]').length} strip(s)`);

    // --- Composers nobody is writing in fold to their input line ---
    const surface = (id) => document.querySelector(`[data-chat-surface="${id}"] [data-composer]`);
    const collapsed = (id) => surface(id)?.hasAttribute('data-collapsed');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(300);
    // A composer holding unsent text stays open, so only the empty ones count.
    const empty = (id) => !surface(id)?.querySelector('[data-composer-input]')?.value;
    const idle = [mainId, c2, c3, c4].filter(empty);
    check('with several chats, idle composers are collapsed',
      idle.length >= 3 && idle.every(collapsed), idle.map(collapsed).join(','));
    // A pointer event, not `focus()`: a probe window in the background gets no
    // focus events, and a click is what the user does anyway.
    surface(c3)?.querySelector('[data-composer-input]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(300);
    check('focusing one expands it, and only it', !collapsed(c3) && collapsed(c2));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(300);
    check('clicking elsewhere folds it again', collapsed(c3));
    // Folded, the pickers share the input's line rather than a tray below it.
    {
      const frame = surface(c4);
      const input = frame?.querySelector('[data-composer-input]')?.getBoundingClientRect();
      const bar = frame?.querySelector('[data-composer-bar]')?.getBoundingClientRect();
      check('folded, the model and mode sit on the input line',
        !!input && !!bar && Math.abs((input.top + input.bottom) / 2 - (bar.top + bar.bottom) / 2) < 4 &&
          !!frame?.querySelector('[data-composer-bar]')?.textContent?.match(/access|Ask|Plan|Auto/i),
        input && bar ? `input mid ${Math.round((input.top + input.bottom) / 2)} bar mid ${Math.round((bar.top + bar.bottom) / 2)}` : 'missing');
    }
    S().setThreadLayout('columns');
    await sleep(400);
    check('the layout toggle puts them in columns', !grid());
    S().setThreadLayout('grid');
    await sleep(300);

    // --- Expansion keeps every column mounted ---
    S().toggleExpandedChat(c3);
    await sleep(500);
    check('expanding hides the other columns',
      [...document.querySelectorAll('[data-thread-column]')].filter((e) => e.offsetParent !== null).length === 1);
    check('...without unmounting their transcripts', document.querySelectorAll('[data-chat-surface]').length === 4);
    check('an expanded column carries the strip above its own composer',
      !!document.querySelector(`[data-thread-column="${c3}"] [data-context-strip]`) &&
        document.querySelectorAll('[data-context-strip]').length === 1);
    S().toggleExpandedChat(c3);
    await sleep(300);
    check('toggling again restores the thread', S().expandedChatId === null);

    // --- Closing keeps the conversation; reopening brings it back ---
    await S().closeSideChat(c2);
    await sleep(600);
    check('closing a used chat removes its column', !S().sideColumns.includes(c2) && !S().sideChats[c2]);
    check('...and keeps the conversation', S().chats.some((c) => c.id === c2 && c.sideOf === mainId));
    const ghostRef = S().messages;
    turn(c2, 'This should land nowhere on screen.');
    await sleep(300);
    check('a closed column streams into no transcript', S().messages === ghostRef && !S().sideChats[c2]);
    await S().reopenSideChat(c2);
    await sleep(1200);
    check('reopening restores the column', S().sideColumns.includes(c2) && !!S().sideChats[c2]);
    // Closing from the column asks first; Cancel leaves it open.
    const closeButton = () => document.querySelector(`[data-thread-column="${c4}"] button[aria-label^="Close chat"]`);
    const dialogButton = (label) =>
      [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === label);
    closeButton()?.click();
    await sleep(500);
    check('closing a column asks first',
      !!dialogButton('Close chat') && S().sideColumns.includes(c4),
      document.querySelector('[role="dialog"]')?.textContent?.slice(0, 80) || 'no dialog');
    dialogButton('Cancel')?.click();
    await sleep(500);
    check('...and Cancel keeps it open', S().sideColumns.includes(c4) && !document.querySelector('[role="dialog"]'));
    closeButton()?.click();
    await sleep(500);
    dialogButton('Close chat')?.click();
    await sleep(800);
    check('confirming closes it — an untouched chat is discarded', !S().chats.some((c) => c.id === c4));
    // --- A chat dragged in from the sidebar joins the thread ---
    const mainCwd = S().chats.find((c) => c.id === mainId)?.cwd;
    const sidebarChat = async (title) => {
      const meta = await window.api.createChat({ cwd: mainCwd });
      app.setState((st) => ({ chats: [{ ...meta, title }, ...st.chats] }));
      await sleep(500);
      const row = [...document.querySelectorAll('[data-sidebar] [draggable="true"]')]
        .find((el) => el.textContent?.includes(title));
      return { id: meta.id, row };
    };
    const threadRoot = () => document.querySelector('[data-chatview]');
    const dragOverThread = (dt) => {
      const r = threadRoot().getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      threadRoot().dispatchEvent(new DragEvent('dragover', at));
      return at;
    };
    const joiner = await sidebarChat('Pricing canvas draft');
    check('a sidebar chat row can be dragged', !!joiner.row);
    {
      const dt = new DataTransfer();
      joiner.row?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const at = dragOverThread(dt);
      await sleep(300);
      check('dragging it over the thread offers to add it',
        !!threadRoot().textContent?.includes('to this thread'));
      threadRoot().dispatchEvent(new DragEvent('drop', at));
      joiner.row?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      await sleep(1500);
    }
    const c4b = joiner.id;
    check('dropping it makes it a column of the thread',
      S().sideColumns.includes(c4b) && S().chats.find((c) => c.id === c4b)?.sideOf === mainId,
      JSON.stringify(S().sideColumns));
    check('...and it leaves the sidebar', ![...document.querySelectorAll('[data-sidebar] *')]
      .some((el) => el.childElementCount === 0 && el.textContent === 'Pricing canvas draft'));
    check('...and the move is written to disk',
      (await window.api.listSideChats()).some((c) => c.id === c4b && c.sideOf === mainId));
    {
      const extra = await sidebarChat('One too many');
      const dt = new DataTransfer();
      extra.row?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dragOverThread(dt);
      await sleep(300);
      check('a full thread refuses a fifth chat, and says so',
        !!threadRoot().textContent?.includes('already has 4 chats'));
      extra.row?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      await sleep(200);
      check('...and the notice clears when the drag ends', !threadRoot().textContent?.includes('already has 4 chats'));
      await S().deleteChat(extra.id);
    }

    // --- Columns reorder by dragging a header onto another column ---
    {
      const dt = new DataTransfer();
      document.querySelector(`[data-thread-column="${c4b}"] > [draggable="true"]`)
        ?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const target = document.querySelector(`[data-thread-column="${mainId}"]`);
      const r = target.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 8, clientY: r.top + r.height / 2 };
      target.dispatchEvent(new DragEvent('dragover', at));
      target.dispatchEvent(new DragEvent('drop', at));
      await sleep(400);
      const first = document.querySelector('[data-thread-column]')?.getAttribute('data-thread-column');
      check('dropping a column on the left of the first moves it first', first === c4b, first);
      check('...the pills follow', document.querySelector('[role="tablist"] [role="tab"]')?.getAttribute('aria-label')?.startsWith('Chat 1: Pricing canvas draft'));
      check('...and the order is remembered', JSON.parse(localStorage.getItem('threadOrder') || '{}')[mainId]?.[0] === c4b);
      // Back to the default order, so the shots below stay as they were.
      app.setState({ threadOrder: {} });
      localStorage.removeItem('threadOrder');
      await sleep(300);
    }

    // --- A column dragged onto the sidebar leaves the thread ---
    {
      const aside = document.querySelector('[data-sidebar]');
      const ar = aside.getBoundingClientRect();
      const over = (dt) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: ar.left + ar.width / 2, clientY: ar.top + ar.height / 2 });
      const dragHeader = (id) => {
        const dt = new DataTransfer();
        const handle = document.querySelector(`[data-thread-column="${id}"] > [draggable="true"]`);
        handle?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        return { dt, handle };
      };
      // The thread's own chat cannot leave: the sidebar does not offer itself.
      {
        const { dt, handle } = dragHeader(mainId);
        aside.dispatchEvent(new DragEvent('dragover', over(dt)));
        await sleep(250);
        check("the thread's own chat is not offered a way out", !aside.textContent?.includes('to its own chat'));
        handle?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      }
      const { dt, handle } = dragHeader(c4b);
      aside.dispatchEvent(new DragEvent('dragover', over(dt)));
      await sleep(250);
      check('dragging a column over the sidebar offers to make it its own chat', !!aside.textContent?.includes('to its own chat'));
      aside.dispatchEvent(new DragEvent('drop', over(dt)));
      handle?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      await sleep(1200);
      const left = S().chats.find((c) => c.id === c4b);
      check('dropping it takes it out of the thread',
        !S().sideColumns.includes(c4b) && !left?.sideOf && !left?.ephemeral, JSON.stringify(S().sideColumns));
      check('...back into the sidebar', [...document.querySelectorAll('[data-sidebar] *')]
        .some((el) => el.childElementCount === 0 && el.textContent === 'Pricing canvas draft'));
      check('...and the change is written to disk', (await window.api.listChats()).some((c) => c.id === c4b));
      // And back in, for the shots.
      await S().joinThread(c4b);
      await sleep(1200);
      check('it can join the thread again', S().sideColumns.includes(c4b));
    }

    // --- A thread is stashed, persisted and restored with its chat ---
    const stored = JSON.parse(localStorage.getItem('threadColumns') || '{}');
    check('open columns are written through to storage', (stored[mainId] || []).length === 3, JSON.stringify(stored[mainId]));
    await S().openChat('demo-nimbus-sparkline');
    await sleep(1200);
    check('another chat does not show them', S().sideColumns.length === 0);
    check('...they are stashed under their thread', (S().sideColumnsByChat[mainId] || []).length === 3);
    check('the sidebar row counts its chats', [...document.querySelectorAll('[data-sidebar] *')].some((e) => e.textContent === '4' && e.querySelector('svg')));
    await S().openChat(c3);
    await sleep(1500);
    check('opening a side chat opens its thread', S().activeId === mainId);
    check('...with that column focused', S().focusedChatId === c3, S().focusedChatId);

    // --- Screenshot states -------------------------------------------------
    // Titles and models for the columns, so the shots read as a real thread.
    retitle(c3, { title: 'Review the uncommitted changes', provider: 'codex', model: 'gpt-5.5' });
    retitle(c2, { title: 'Hero contrast pass' });
    retitle(c4b, { title: 'Build the pricing canvas', provider: 'grok', model: 'grok-4.6' });
    user(c3, 'Review the uncommitted changes before I commit');
    turn(c3, 'I read the diff against main. The pricing grid change is sound, but `PlanCard` still hardcodes the currency symbol, so the EUR plans render with a dollar sign.', [
      { name: 'Bash', input: { command: 'git diff --stat' } },
      { name: 'Read', input: { file_path: 'src/components/PlanCard.tsx' } }
    ]);
    user(c4b, 'Sketch the pricing page as a canvas first');
    turn(c4b, 'Here is the layout: three plan cards, the annual toggle above them, and the FAQ folded below. I need the dev server to preview it.');
    S().applyEvent({
      type: 'permission-request',
      chatId: c4b,
      request: { id: 'probe-perm', chatId: c4b, toolUseId: 'probe-perm-t', toolName: 'Bash', input: { command: 'npm run dev -- --port 5173' }, hasSuggestions: false }
    });
    status(c4b, 'waiting-permission');
    status(mainId, 'streaming');
    // Shot 1: three chats in columns — close the fourth for it.
    const shotFour = c4b;
    if (S().panelOpen) S().togglePanel();
    S().setThreadLayout('columns');
    app.setState({ sideColumns: [c3, shotFour] });
    S().focusChat(c3);
    await until(24700);

    // Shot 2: four chats in a grid.
    app.setState({ sideColumns: [c3, shotFour, c2] });
    app.setState({ threadLayout: null });
    await until(28700);

    // Shot 3: one expanded.
    S().toggleExpandedChat(c3);
    await until(32700);

    // Shot 4: the panel floating over the columns.
    S().toggleExpandedChat(c3);
    if (!S().panelFloating) S().togglePanelFloating();
    const colsBefore = document.querySelector('[data-thread-column]')?.parentElement?.getBoundingClientRect().width;
    if (!S().panelOpen) S().togglePanel();
    void S().reviewChanges();
    await sleep(800);
    const colsAfter = document.querySelector('[data-thread-column]')?.parentElement?.getBoundingClientRect().width;
    check('a floating panel does not reflow the columns', colsBefore === colsAfter, `${colsBefore} -> ${colsAfter}`);
    check('...and is drawn over them', !!document.querySelector('[data-right-panel][data-floating]'));
    {
      const aside = document.querySelector('[data-right-panel][data-floating]');
      const a = aside?.getBoundingClientRect();
      const p = aside?.parentElement?.getBoundingClientRect();
      check('...at full height, flush to the right edge',
        !!a && !!p && a.top === p.top && a.bottom === p.bottom && Math.round(a.right) === Math.round(p.right),
        a && p ? `panel ${a.top}-${a.bottom} right ${a.right}; pane ${p.top}-${p.bottom} right ${p.right}` : 'no panel');
    }
    await until(36700);

    // Shot 5: pinned beside them.
    S().togglePanelFloating();
    await sleep(800);
    const colsPinned = document.querySelector('[data-thread-column]')?.parentElement?.getBoundingClientRect().width;
    check('pinning docks it beside the columns', colsPinned < colsBefore, `${colsBefore} -> ${colsPinned}`);
    check('...leaving two columns of room', colsPinned >= 679, `${colsPinned}px`);
    check('no composer chips overlap in the narrow columns', composerOverlaps().length === 0, JSON.stringify(composerOverlaps()));
    await until(40700);

    // Leave the profile's panel preference as the app ships it.
    if (!S().panelFloating) S().togglePanelFloating();

    // --- An expanded column gets the docked panel ---
    if (!S().panelOpen) S().togglePanel();
    S().toggleExpandedChat(c3);
    await sleep(500);
    check('expanding a column docks the open panel',
      S().panelOpen && !document.querySelector('[data-right-panel][data-floating]'));
    check('...with no pin to float it', !document.querySelector('[aria-label="Pin panel beside the chats"], [aria-label="Float panel over the chats"]'));
    S().toggleExpandedChat(c3);
    await sleep(500);
    check('restoring the thread floats it again', !!document.querySelector('[data-right-panel][data-floating]'));

    // --- Esc steps back: the floating panel first, then the expansion ---
    document.body.focus();
    const esc = () =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    esc();
    await sleep(300);
    check('Esc closes the floating panel', !S().panelOpen);
    S().toggleExpandedChat(c3);
    S().togglePanel();
    await sleep(300);
    esc();
    await sleep(300);
    check('...and beside an expanded column it restores the thread, leaving the docked panel open',
      S().expandedChatId === null && S().panelOpen);
    return { log };
  })();
})()

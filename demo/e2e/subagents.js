// Native sub-agents as pages: a chat asks its own provider to spawn two
// sub-agents, the transcript draws them as one group card, and a row opens one
// in place of the chat — "Chat › agent" in the header, the prompt, its stream
// and the "Runs on its own / Back to chat" footer. Back by the footer, by
// Escape, and in again from the robot menu. Flip PARENT for another provider.
//   sed 's#__REPO__#/path/to/repo#' demo/e2e/subagents.js
(() => {
  const REPO = '__REPO__';
  const PARENT = ['claude', 'claude-sonnet-5'];
  const PROMPT = 'Use your Agent/Task tool to spawn TWO sub-agents in parallel, in one message: one counts the lines of src/math.js, the other counts the lines of src/cart.js; each replies with just the number. Then tell me both numbers in one sentence.';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app;
  const S = () => app.getState();
  const until = async (pred, ms, every = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = pred();
      if (v) return v;
      await sleep(every);
    }
    return null;
  };
  const agentParts = () =>
    S().messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p && p.type === 'tool' && (p.agent || p.name === 'Task' || p.name === 'Agent')) : []));
  return (async () => {
    await window.api.focusWindow();
    await until(() => S().defaults, 20000, 200);
    const t0 = Date.now();
    await S().newChat(REPO, PROMPT, { provider: PARENT[0], model: PARENT[1], permissionMode: 'bypassPermissions' });
    const parentId = S().activeId;
    const spawned = await until(() => (agentParts().length >= 1 ? agentParts() : null), 240000);
    if (!spawned) return { error: 'no sub-agent spawned', tools: S().messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p?.type === 'tool').map((p) => p.name) : [])) };
    await sleep(1500);
    // While running: the card, then open the first agent as a page of the
    // thread — in place of the chat, with "Chat › agent" in the header.
    const groupWhileRunning = !!document.querySelector('[data-agent-group]');
    const groupEl = document.querySelector('[data-agent-group] > button');
    if (groupEl) { groupEl.click(); await sleep(600); }
    const rows = [...document.querySelectorAll('[data-agent-run]')].map((e) => e.getAttribute('data-agent-run'));
    document.querySelector('[data-agent-run]')?.click();
    await sleep(1500);
    const pane = document.querySelector('[data-agent-view]');
    const pageWhileRunning = {
      agentView: S().agentView,
      noColumn: !S().sideColumns.some((c) => c.startsWith('agent:')),
      crumb: document.querySelector('[data-agent-crumb]')?.textContent?.slice(0, 120) ?? null,
      sentBy: !!pane?.textContent.includes('Sent by another agent'),
      footer: pane?.lastElementChild?.textContent?.slice(0, 160) ?? null
    };
    await window.api.focusWindow();
    await sleep(800);
    const shotRunning = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    // Finish: parent idle with an answer.
    await until(() => (S().statuses[parentId] ?? 'idle') === 'idle' && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant', 420000, 2000);
    await sleep(2000);
    const pane2 = document.querySelector('[data-agent-view]');
    const pageDone = pane2 ? { footer: pane2.lastElementChild?.textContent?.slice(0, 160), streamChars: pane2.textContent.length } : null;
    await window.api.focusWindow();
    await sleep(800);
    const shotDone = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    // "Back to chat" returns to the chat that spawned it, with the focus.
    [...(pane2?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Back to chat'))?.click();
    await sleep(500);
    const backToChat = S().agentView === null && S().focusedChatId === parentId;
    // The robot menu lists the agents and opens one the same way. It sits in
    // the header only while the session rail is away.
    if (S().quickRail && !S().railHidden) S().toggleQuickRail();
    await sleep(300);
    const menuCount = document.querySelector('[data-subagents-menu]')?.getAttribute('data-subagents-menu') ?? null;
    const agentPills = [...document.querySelectorAll('[role="tab"]')].filter((e) => /subagent/i.test(e.getAttribute('aria-label') || '')).length;
    document.querySelector('[data-subagents-menu]')?.click();
    await sleep(700);
    const menuRows = [...document.querySelectorAll('[data-subagent-row]')].map((e) => e.getAttribute('data-subagent-row'));
    const second = menuRows[1] ?? menuRows[0];
    await window.api.focusWindow();
    await sleep(600);
    const shotMenu = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: 420 });
    if (second) document.querySelector(`[data-subagent-row="${second}"]`)?.click();
    await sleep(900);
    const openedFromMenu = second ? S().agentView?.endsWith(':' + second) ?? false : null;
    // Escape is the other way back.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    const escapeBack = S().agentView === null;
    const reply = S().messages.filter((m) => m.role === 'assistant').at(-1);
    return {
      seconds: Math.round((Date.now() - t0) / 1000),
      agents: agentParts().map((p) => ({ name: p.name, type: p.input?.subagent_type, desc: String(p.input?.description ?? p.input?.prompt ?? '').slice(0, 60), status: p.status, children: (p.children ?? []).length })),
      groupWhileRunning,
      rows: rows.length,
      pageWhileRunning,
      pageDone,
      backToChat,
      escapeBack,
      menuCount,
      agentPills,
      menuRows: menuRows.length,
      openedFromMenu,
      shotMenu,
      reply: reply ? reply.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 200) : '',
      shotRunning,
      shotDone
    };
  })();
})()

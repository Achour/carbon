// Native sub-agents as columns: a chat asks its own provider to spawn two
// sub-agents, the transcript draws them as one group card, and a row opens one
// as a column of the thread — "Subagent of …", the prompt, its stream and the
// "Runs on its own / Open parent" footer. Flip PARENT for another provider.
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
    // While running: the card, then open the first agent as a column.
    const groupWhileRunning = !!document.querySelector('[data-agent-group]');
    const groupEl = document.querySelector('[data-agent-group] > button');
    if (groupEl) { groupEl.click(); await sleep(600); }
    const rows = [...document.querySelectorAll('[data-agent-run]')].map((e) => e.getAttribute('data-agent-run'));
    document.querySelector('[data-agent-run]')?.click();
    await sleep(1500);
    const openCols = S().sideColumns.filter((c) => c.startsWith('agent:'));
    const col = document.querySelector('[data-agent-column]');
    const colWhileRunning = col ? {
      header: col.querySelector('div')?.textContent?.slice(0, 120),
      sentBy: col.textContent.includes('Sent by another agent'),
      footer: col.lastElementChild?.textContent?.slice(0, 160)
    } : null;
    await window.api.focusWindow();
    await sleep(800);
    const shotRunning = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    // Finish: parent idle with an answer.
    await until(() => (S().statuses[parentId] ?? 'idle') === 'idle' && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant', 420000, 2000);
    await sleep(2000);
    const col2 = document.querySelector('[data-agent-column]');
    const colDone = col2 ? { footer: col2.lastElementChild?.textContent?.slice(0, 160), streamChars: col2.textContent.length } : null;
    // Open parent moves focus back; closing folds it into its row.
    [...(col2?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Open parent'))?.click();
    await sleep(500);
    const focusedAfterOpenParent = S().focusedChatId === parentId;
    await window.api.focusWindow();
    await sleep(800);
    const shotDone = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    // The robot menu: agents are not pills; the dropdown lists and toggles them.
    const menuCount = document.querySelector('[data-subagents-menu]')?.getAttribute('data-subagents-menu') ?? null;
    const agentPills = [...document.querySelectorAll('[role="tab"]')].filter((e) => /subagent/i.test(e.getAttribute('aria-label') || '')).length;
    document.querySelector('[data-subagents-menu]')?.click();
    await sleep(700);
    const menuRows = [...document.querySelectorAll('[data-subagent-row]')].map((e) => e.getAttribute('data-subagent-row'));
    const second = menuRows.find((r) => !S().sideColumns.some((c) => c.endsWith(':' + r)));
    if (second) document.querySelector(`[data-subagent-row="${second}"]`)?.click();
    await sleep(900);
    const openedFromMenu = second ? S().sideColumns.some((c) => c.endsWith(':' + second)) : null;
    document.querySelector('[data-subagents-menu]')?.click();
    await sleep(700);
    await window.api.focusWindow();
    await sleep(600);
    const shotMenu = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: 420 });
    const reply = S().messages.filter((m) => m.role === 'assistant').at(-1);
    return {
      seconds: Math.round((Date.now() - t0) / 1000),
      agents: agentParts().map((p) => ({ name: p.name, type: p.input?.subagent_type, desc: String(p.input?.description ?? p.input?.prompt ?? '').slice(0, 60), status: p.status, children: (p.children ?? []).length })),
      groupWhileRunning,
      rows: rows.length,
      openCols,
      colWhileRunning,
      colDone,
      focusedAfterOpenParent,
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

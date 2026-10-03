// "kill <agent>" and "kill all": a Claude chat starts a Codex agent that is
// still working (a long sleep), the user kills it by name, then kills all.
// Asserts the agent is stopped (cancelled, no delivery turn), its column is
// closed, and its card stays in the parent to reopen it.
//   sed 's#__REPO__#/path/to/repo#' demo/e2e/delegation-kill.js
(() => {
  const REPO = '__REPO__';
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
  const kids = (p) => S().chats.filter((c) => c.delegation?.parentId === p);
  const settled = (id) =>
    (S().statuses[id] ?? 'idle') === 'idle' && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant';
  return (async () => {
    await window.api.focusWindow();
    await until(() => S().defaults, 20000, 200);
    await S().newChat(
      REPO,
      'Start a Codex agent named sleeper. Its task: run the shell command `sleep 120`, then reply "done". End your turn right after starting it.',
      { provider: 'claude', model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' }
    );
    const parentId = S().activeId;
    const agent = await until(() => kids(parentId)[0], 180000);
    if (!agent) return { error: 'no agent started' };
    await until(() => settled(parentId), 180000);
    const openBefore = S().sideColumns.includes(agent.id);
    const runningBefore = kids(parentId)[0].delegation.status;
    await S().sendMessage(parentId, `kill ${agent.delegation.name}`);
    await sleep(1500);
    await until(() => settled(parentId), 180000);
    const afterKill = kids(parentId)[0];
    const killState = {
      status: afterKill.delegation.status,
      columnOpen: S().sideColumns.includes(agent.id),
      card: !!document.querySelector(`[data-delegate="${agent.id}"]`),
      childStatus: S().statuses[agent.id] ?? 'idle'
    };
    // Reopen it from its card, then "kill all": it was not working, so it is
    // only closed again.
    document.querySelector(`[data-delegate="${agent.id}"]`)?.click();
    await sleep(1200);
    const reopened = S().sideColumns.includes(agent.id);
    await S().sendMessage(parentId, 'kill all the agents');
    await sleep(1500);
    await until(() => settled(parentId), 180000);
    const tools = S().messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p.type === 'tool').map((p) => `${p.name.replace('mcp__carbon__', '')}:${p.output?.slice(0, 90) ?? ''}`) : []));
    const deliveries = S().messages.filter((m) => m.role === 'user' && m.label).map((m) => m.label);
    await window.api.focusWindow();
    await sleep(1000);
    const shot = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    return {
      name: agent.delegation.name,
      runningBefore,
      openBefore,
      killState,
      reopened,
      closedAfterKillAll: !S().sideColumns.includes(agent.id),
      finalStatus: kids(parentId)[0].delegation.status,
      deliveries,
      tools: tools.filter((t) => t.startsWith('agents_')),
      shot
    };
  })();
})()

// A REAL delegation, end to end: a Claude chat is asked to have Codex review a
// file, calls `agents_delegate`, the Codex child opens as a column of the
// thread, runs, and its report is delivered back to the Claude chat as a turn
// of its own (a label chip). Asserts the whole lifecycle off the store, then
// captures the window. Point it at a repo, and optionally flip the direction:
//   sed 's#__REPO__#/path/to/repo#' demo/e2e/delegation.js
//   sed -e 's#__REPO__#/path#' -e "s#^  const PARENT = .*#  const PARENT = ['codex', 'codex-default'];#" \
//       -e "s#^  const CHILD = .*#  const CHILD = ['claude', 'Claude'];#" demo/e2e/delegation.js
(() => {
  const REPO = '__REPO__';
  const PARENT = ['claude', 'claude-sonnet-5'];
  const CHILD = ['codex', 'Codex'];
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
  return (async () => {
    // Parked events would make the store look truncated: keep the window shown.
    await window.api.focusWindow();
    await until(() => S().defaults, 20000, 200);
    const t0 = Date.now();
    await S().newChat(
      REPO,
      `Use the agents_delegate tool to have ${CHILD[1]} (provider "${CHILD[0]}", role "review") review src/math.js for bugs. Give it a complete brief: it should only read the file and report each bug with the line and a one-line fix, without editing anything. After delegating, end your turn immediately with one short sentence — do not wait or poll. When its report arrives, reply with a numbered list of the bugs it found.`,
      { provider: PARENT[0], model: PARENT[1], permissionMode: 'bypassPermissions' }
    );
    const parentId = S().activeId;
    const child = await until(() => S().chats.find((c) => c.delegation?.parentId === parentId), 240000);
    if (!child) {
      return { error: 'no delegated chat appeared', parentMessages: S().messages.length, statuses: S().statuses };
    }
    const columnOpened = S().sideColumns.includes(child.id);
    const badge = !!document.querySelector('[data-delegation]');
    const done = await until(() => {
      const c = S().chats.find((x) => x.id === child.id);
      return c?.delegation && c.delegation.status !== 'running' && c.delegation.deliveredAt ? c : null;
    }, 600000, 2000);
    if (!done) {
      return { error: 'delegation never finished', child: S().chats.find((x) => x.id === child.id)?.delegation };
    }
    // The delivery is a labelled user message in the parent; wait for the
    // parent's reply to it to finish.
    const delivered = await until(() => S().messages.find((m) => m.role === 'user' && m.label && / (finished|failed|was stopped|was interrupted) · /.test(m.label)), 60000);
    await until(() => (S().statuses[parentId] ?? 'idle') === 'idle' && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant', 300000, 2000);
    await sleep(2500);
    const tools = S().messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p.type === 'tool').map((p) => p.name) : []));
    const lastReply = S().messages.filter((m) => m.role === 'assistant').at(-1);
    const replyText = lastReply ? lastReply.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
    const status = await window.api.getChat(child.id);
    await window.api.focusWindow();
    await sleep(1200);
    const shot = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    return {
      seconds: Math.round((Date.now() - t0) / 1000),
      columnOpened,
      badge,
      childProvider: done.provider,
      childModel: done.model,
      childName: done.delegation.name,
      childSideOf: done.sideOf === parentId,
      childMode: done.permissionMode,
      delegation: { ...done.delegation, result: (done.delegation.result || '').slice(0, 600) },
      childMessages: status?.chat.messages.length,
      parentTools: tools,
      deliveredLabel: delivered?.label ?? null,
      deliveredTextHead: delivered?.text.slice(0, 200) ?? null,
      replyHead: replyText.slice(0, 600),
      shot
    };
  })();
})()

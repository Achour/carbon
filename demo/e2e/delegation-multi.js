// Two delegates at once, then a follow-up to ONE of them by name: a Claude chat
// starts two Codex reviewers (two columns, codex-a and codex-b), both report
// back, and then the user says "tell <the math reviewer> to …" — which must go
// to that agent's own chat through `agents_send`, not start a third one. Point
// it at a repo with src/math.js and src/cart.js:
//   sed 's#__REPO__#/path/to/repo#' demo/e2e/delegation-multi.js
(() => {
  const REPO = '__REPO__';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app;
  const S = () => app.getState();
  const until = async (pred, ms, every = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = pred();
      if (v) return v;
      await sleep(every);
    }
    return null;
  };
  const kids = (parentId) => S().chats.filter((c) => c.delegation?.parentId === parentId);
  const idle = (id) => (S().statuses[id] ?? 'idle') === 'idle';
  return (async () => {
    await window.api.focusWindow();
    await until(() => S().defaults, 20000, 200);
    const t0 = Date.now();
    await S().newChat(
      REPO,
      'Start two Codex agents with agents_delegate (provider "codex", role "review"), one per file: one reviews src/math.js, the other reviews src/cart.js. Each brief: only read that one file, report each bug with its line and a one-line fix, edit nothing. Then end your turn with one short sentence naming both agents — do not wait or poll. When their reports arrive, reply with one line per agent: its name and how many bugs it found.',
      { provider: 'claude', model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' }
    );
    const parentId = S().activeId;
    const two = await until(() => (kids(parentId).length >= 2 ? kids(parentId) : null), 240000);
    if (!two) return { error: 'two agents never appeared', kids: kids(parentId).map((k) => k.delegation) };
    const columnsAfterStart = S().sideColumns.filter((id) => two.some((k) => k.id === id)).length;
    const bothDone = await until(() => {
      const ks = kids(parentId);
      return ks.length >= 2 && ks.every((k) => k.delegation.status !== 'running' && k.delegation.deliveredAt) ? ks : null;
    }, 600000);
    if (!bothDone) return { error: 'both never reported', kids: kids(parentId).map((k) => k.delegation) };
    await until(() => idle(parentId) && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant', 300000);
    await sleep(2000);
    const math = bothDone.find((k) => /math\.js/.test(k.delegation.task));
    const cart = bothDone.find((k) => k !== math);
    if (!math || !cart) return { error: 'could not tell the two apart', tasks: bothDone.map((k) => k.delegation.task) };
    const before = { math: { ...math.delegation }, cart: { ...cart.delegation } };

    // The user steers one agent by the name in its column header.
    await S().sendMessage(
      parentId,
      `Tell ${math.delegation.name} to also write one unit test (plain assert, no framework) for the first bug it found. End your turn with one short sentence; when its answer arrives, show me the test.`
    );
    const rerun = await until(() => {
      const m = S().chats.find((c) => c.id === math.id);
      return m?.delegation.deliveredAt && m.delegation.deliveredAt > before.math.deliveredAt ? m : null;
    }, 600000);
    if (!rerun) return { error: 'follow-up never reported', math: S().chats.find((c) => c.id === math.id)?.delegation };
    await until(() => idle(parentId) && S().messages.filter((m) => m.role !== 'event').at(-1)?.role === 'assistant', 300000);
    await sleep(2500);
    const cartAfter = S().chats.find((c) => c.id === cart.id).delegation;
    const tools = S().messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p.type === 'tool').map((p) => p.name.replace('mcp__carbon__', '')) : []));
    const labels = S().messages.filter((m) => m.role === 'user' && m.label).map((m) => m.label);
    const last = S().messages.filter((m) => m.role === 'assistant').at(-1);
    const mathChat = await window.api.getChat(math.id);
    // The collapsed form: each agent is a live card in the parent's transcript,
    // and the card toggles its column — closed, then open again, then closed
    // for the shot, so it shows one agent open beside the other's card.
    const cardIds = [...document.querySelectorAll('[data-delegate]')].map((e) => e.getAttribute('data-delegate'));
    const card = () => document.querySelector(`[data-delegate="${cart.id}"]`);
    const toggles = [S().sideColumns.includes(cart.id)];
    for (let i = 0; i < 3; i++) {
      card()?.click();
      await sleep(900);
      toggles.push(S().sideColumns.includes(cart.id));
    }
    const cardText = card()?.textContent ?? null;
    await window.api.focusWindow();
    await sleep(1200);
    const shot = await window.api.previewCaptureWindow({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    return {
      seconds: Math.round((Date.now() - t0) / 1000),
      agents: kids(parentId).length,
      names: [before.math.name, before.cart.name],
      columnsAfterStart,
      badges: [...document.querySelectorAll('[data-delegation]')].map((e) => e.textContent),
      parentTools: tools,
      deliveredLabels: labels,
      mathRounds: mathChat.chat.messages.filter((m) => m.role === 'user').length,
      mathAfter: { status: rerun.delegation.status, result: (rerun.delegation.result || '').slice(0, 500) },
      cardIds,
      cardText,
      columnOpenAfterClicks: toggles,
      cartUntouched: cartAfter.deliveredAt === before.cart.deliveredAt && cartAfter.status === before.cart.status,
      replyHead: last ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 600) : '',
      shot
    };
  })();
})()

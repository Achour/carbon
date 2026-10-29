// The agent flow, checked pass/fail and shot, with fake agents and no model:
// a finished agent's outcome on its roster row, a delegate's approval docked on
// the parent's composer, ⌥↓ walking the roster from an agent's page, and — in
// a thread of several columns — an agent opening inside its own column, each
// column carrying its own agents menu, untitled columns named by model, and no
// top-bar control under a floating panel. Needs the demo's four-column thread
// (`demo-nimbus-landing` with columns open, as `threads.js` leaves it).
//
//   ./demo/shoot.sh /tmp/flow 10000,15000,21000,26000 demo/e2e/agent-flow.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadedAt = Date.now() - 1000;
  const at = (ms) => sleep(Math.max(0, ms - (Date.now() - loadedAt)));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const S = () => app.getState();
  const log = [];
  const check = (n, ok, d) => log.push(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  const inject = (chat, tag) => {
    const id = chat.id, now = Date.now();
    const task = (tid, desc, type, status, ago, dur, out) => ({
      type: 'tool', toolUseId: tid, name: 'Task', status, startedAt: now - ago,
      input: { subagent_type: type, description: desc, prompt: `${desc}. Report back briefly.` },
      agent: { startedAt: now - ago, endedAt: status === 'running' ? undefined : now - ago + dur, model: 'claude-sonnet-5' },
      children: [{ type: 'text', text: 'Working through it.' }], output: out
    });
    app.setState((s) => ({
      messages: [...s.messages,
        { id: `u-${tag}`, role: 'user', text: 'Map the pricing module, check the rate limiter, and get Codex and Grok to review.', ts: now - 400000 },
        { id: `a-${tag}`, role: 'assistant', ts: now - 390000, parts: [
          { type: 'text', text: 'Starting three agents and two reviewers.' },
          task(`${tag}-t1`, 'Map the pricing module', 'Explore', 'running', 70000, 0),
          task(`${tag}-t2`, 'Find every caller of parseToken', 'Explore', 'success', 380000, 41000, '## Callers\n\nThree callers: `auth.ts`, `session.ts` and `api/me.ts`.'),
          task(`${tag}-t3`, 'Write tests for the rate limiter', 'general-purpose', 'error', 300000, 95000, 'vitest is not installed in this repo.')
        ] }
      ],
      chats: [...s.chats,
        { id: `${tag}-d1`, title: 'x', cwd: chat.cwd, provider: 'codex', model: 'codex-default', permissionMode: 'default', sideOf: chat.sideOf ?? id, ephemeral: true, createdAt: now - 120000, updatedAt: now,
          delegation: { parentId: id, name: 'review-sol', task: 'Repo: /Users/u/nimbus. Review src/pricing.ts.', status: 'running', createdAt: now - 120000, startedAt: now - 120000 } },
        { id: `${tag}-d2`, title: 'x', cwd: chat.cwd, provider: 'grok', model: 'grok-default', permissionMode: 'default', sideOf: chat.sideOf ?? id, ephemeral: true, createdAt: now - 200000, updatedAt: now,
          delegation: { parentId: id, name: 'grok-a', task: 'Repo: /Users/u/nimbus. Research token buckets.', status: 'running', createdAt: now - 200000, startedAt: now - 200000 } },
        { id: `${tag}-d3`, title: 'x', cwd: chat.cwd, provider: 'codex', model: 'codex-default', permissionMode: 'default', sideOf: chat.sideOf ?? id, ephemeral: true, createdAt: now - 900000, updatedAt: now,
          delegation: { parentId: id, name: 'review-astra', task: 'Repo: /Users/u/nimbus. Review src/cart.ts.', status: 'completed', result: 'Two bugs: rounding happens before the discount (line 12), and a quantity of 0 reads as missing (line 21).', createdAt: now - 900000, startedAt: now - 900000, finishedAt: now - 650000, deliveredAt: now - 650000 } }
      ],
      statuses: { ...s.statuses, [`${tag}-d2`]: 'waiting-permission', [`${tag}-d1`]: 'running' },
      permissions: { ...s.permissions, [`${tag}-d2`]: [{ id: `${tag}-p1`, chatId: `${tag}-d2`, toolUseId: `${tag}-tp`, toolName: 'Bash', input: { command: 'npm test -- --run rate' }, title: 'Run the rate limiter tests' }] }
    }));
  };
  return (async () => {
    while (!S().defaults && Date.now() - loadedAt < 20000) await sleep(200);
    const single = S().chats.find((c) => !c.sideOf && !c.archivedAt && c.id !== 'demo-nimbus-landing');
    await S().openChat(single.id); await sleep(1200);
    if (S().panelOpen) S().togglePanel();
    inject(single, 'a'); await sleep(900);
    if (!S().quickRail) S().toggleQuickRail();
    S().setRailHidden(false); await sleep(500);
    const fin = [...document.querySelectorAll('[data-agent-roster] [data-delegate-row], [data-agent-roster] [data-subagent-row]')].map((e) => e.textContent);
    const tips = [...document.querySelectorAll('[data-agent-roster] [title]')].map((e) => e.getAttribute('title'));
    check('finished rows are one line, the outcome their tooltip', tips.some((t) => t.includes('Two bugs')) && tips.some((t) => t.includes('Three callers')) && !fin.some((t) => t.includes('Three callers')));
    check('the waiting delegate reads "Needs input"', fin.some((t) => t.includes('grok-a') && t.includes('Needs input')));
    check('its approval docks on the parent composer', !!document.querySelector('[data-delegate-prompt="a-d2"]'));
    check('the right panel has no Agents tab', ![...document.querySelectorAll('[data-right-panel] *')].some((e) => e.textContent === 'Agents'));
    await at(10000); // 1
    await S().openAgentView('a-d2'); await sleep(600);
    check('no arrows in the title bar', !document.querySelector('[data-agent-nav]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    await sleep(600);
    check('⌥↓ moves to the next agent', S().agentView !== 'a-d2' && !!S().agentView, S().agentView);
    await at(15000); // 2
    S().closeAgentView();
    // the four-column thread
    await S().openChat('demo-nimbus-landing'); await sleep(1500);
    if (S().panelOpen) S().togglePanel();
    inject(S().chats.find((c) => c.id === 'demo-nimbus-landing'), 'b'); await sleep(900);
    const titles = [...document.querySelectorAll('[data-thread-column] > div:first-child')].map((e) => e.textContent.slice(0, 40));
    check('several columns', S().sideColumns.length >= 2, String(S().sideColumns.length));
    check('the top bar carries no agents menu', !document.querySelector('header [data-subagents-menu]') || !!document.querySelector('[data-thread-column] [data-subagents-menu]'));
    check('the thread chat column carries its own', !!document.querySelector('[data-thread-column="demo-nimbus-landing"] [data-subagents-menu]'));
    check('untitled columns are named by model', !titles.some((t) => t.startsWith('New chat')), titles.join(' | '));
    await S().openAgentView('agent:demo-nimbus-landing:b-t1'); await sleep(700);
    check('in a thread, the agent opens inside its column', S().agentViewIn === 'demo-nimbus-landing', String(S().agentViewIn));
    check('...and the other columns stay', document.querySelectorAll('[data-thread-column]:not(.hidden)').length >= 2);
    const other = S().sideColumns[0];
    S().focusChat(other); await sleep(300);
    check('working in another column keeps it open', S().agentView === 'agent:demo-nimbus-landing:b-t1');
    await at(21000); // 3
    S().togglePanel(); await sleep(800);
    const hdr = document.querySelector('[data-chatview] > header');
    const panelLeft = document.querySelector('[data-right-panel]').getBoundingClientRect().left;
    const all = [...hdr.querySelectorAll('button')];
    const under = all.filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.right > panelLeft + 1; });
    check('with the panel open, no header control sits under it', all.length > 2 && under.length === 0, `${all.length} buttons, ${under.length} under`);
    await at(26000); // 4
    return { log };
  })();
})()

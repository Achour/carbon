// An agent-page probe, and the shots that go with it: puts a running sub-agent
// (a `Task` call with a stream) and a delegate (a side chat with a
// `delegation`) into a demo chat, then checks that every way in opens the agent
// *in place of* the chat rather than as a column, and every way out comes back.
//
// Synthetic, so it is free and says the same thing every run: what is tested is
// the store's `agentView` and the thread's wiring, not a model. The delegate's
// chat is not on disk, so its transcript is put into its slot by hand.
//
//   ./demo/shoot.sh /tmp/agents 10000,16000,22000 demo/e2e/agent-pages.js
//
// Shots, in order: the robot menu listing both agents; the sub-agent's page;
// the delegate's page.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Capture delays count from page load; this script starts about a second in.
  const loadedAt = Date.now() - 1000;
  const until = (ms) => sleep(Math.max(0, ms - (Date.now() - loadedAt)));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) =>
    log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const S = () => app.getState();
  const crumb = () => document.querySelector('[data-agent-crumb]')?.textContent ?? '';
  const esc = () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const DELEGATE = '00000000-0000-4000-8000-0000000000a1';
  const DONE = '00000000-0000-4000-8000-0000000000a2';
  const TASK = 'Review src/pricing.ts for bugs. Report each with its line and a one-line fix. Edit nothing.';

  return (async () => {
    const start = Date.now();
    while (!S().defaults && Date.now() - start < 20000) await sleep(200);
    const chat = S().chats.find((c) => !c.sideOf && !c.archivedAt);
    await S().openChat(chat.id);
    await sleep(1200);
    const id = S().activeId;
    // The robot menu is the header's only while the session rail is away.
    if (S().quickRail) S().toggleQuickRail();
    const now = Date.now();
    app.setState((s) => ({
      messages: [
        ...s.messages,
        { id: 'u-agents', role: 'user', text: 'Have an agent map the pricing module, and ask Codex to review it.', ts: now - 70000 },
        {
          id: 'a-agents',
          role: 'assistant',
          ts: now - 66000,
          parts: [
            { type: 'text', text: 'Starting an Explore agent on the pricing module, and Codex as a reviewer.' },
            {
              type: 'tool', toolUseId: 'tu-explore', name: 'Task', status: 'running', startedAt: now - 64000,
              input: { subagent_type: 'Explore', description: 'Map the pricing module', prompt: 'Read src/pricing.ts and every caller of it. Report each exported function, what calls it, and anything that looks wrong. Do not edit files.' },
              agent: { startedAt: now - 64000, model: 'claude-sonnet-5', tokens: 18400 },
              children: [
                { type: 'text', text: 'Starting with the module itself, then its callers.' },
                { type: 'tool', toolUseId: 'c1', name: 'Read', status: 'success', input: { file_path: chat.cwd + '/src/pricing.ts' }, output: 'export function price(...)' },
                { type: 'tool', toolUseId: 'c2', name: 'Grep', status: 'success', input: { pattern: "from './pricing'" }, output: 'src/App.tsx:4' },
                { type: 'text', text: '`pricing.ts` exports two functions; `App.tsx` is the only caller. Checking the rounding next.' },
                { type: 'tool', toolUseId: 'c3', name: 'Read', status: 'running', input: { file_path: chat.cwd + '/src/App.tsx' } }
              ]
            }
          ]
        }
      ],
      chats: [
        ...s.chats,
        {
          id: DELEGATE, title: TASK, cwd: chat.cwd, provider: 'codex', model: 'codex-default', permissionMode: 'default',
          sideOf: id, ephemeral: true, createdAt: now - 60000, updatedAt: now,
          delegation: { parentId: id, name: 'codex-a', role: 'review', task: TASK, status: 'running', createdAt: now - 60000, startedAt: now - 60000 }
        },
        {
          id: DONE, title: 'Research', cwd: chat.cwd, provider: 'grok', model: 'grok-default', permissionMode: 'default',
          sideOf: id, ephemeral: true, createdAt: now - 900000, updatedAt: now,
          delegation: { parentId: id, name: 'grok-a', role: 'research', task: 'Repo: /Users/u/project. Research the token bucket edge cases.', status: 'completed', createdAt: now - 900000, startedAt: now - 900000, finishedAt: now - 690000, deliveredAt: now - 690000 }
        }
      ]
    }));
    await sleep(1500);

    check('a delegate is not a column', !S().sideColumns.includes(DELEGATE));
    document.querySelector('[data-subagents-menu]')?.click();
    await sleep(700);
    check('the robot menu lists the delegate', !!document.querySelector(`[data-delegate-row="${DELEGATE}"]`));
    check('...and the sub-agent', !!document.querySelector('[data-subagent-row="tu-explore"]'));
    const rows = [...document.querySelectorAll('[data-agent-roster] [data-delegate-row], [data-agent-roster] [data-subagent-row]')];
    check('the roster is one list, no section headings', !/Working|Finished/.test(document.querySelector('[data-agent-roster]')?.textContent ?? ''));
    check('...live rows first', rows.length === 3 && rows[0].hasAttribute('data-live') && rows[1].hasAttribute('data-live') && !rows[2].hasAttribute('data-live'));
    check('...the finished one last, by name not task',
      rows[2]?.textContent.includes('grok-a') && !rows[2]?.textContent.includes('Repo:'), rows[2]?.textContent);
    await until(10000); // shot 1: the menu

    document.querySelector('[data-subagent-row="tu-explore"]')?.click();
    await sleep(800);
    const viewId = `agent:${id}:tu-explore`;
    check('a menu row opens the sub-agent as the page', S().agentView === viewId, S().agentView);
    check('...not as a column', !S().sideColumns.some((c) => c.startsWith('agent:')), JSON.stringify(S().sideColumns));
    check('...in place of the chat, which stays mounted, hidden',
      [...document.querySelectorAll('[data-chatview] .hidden')].some((el) => el.querySelector('[data-composer]')));
    check('the crumb is "chat › agent"', crumb().startsWith(chat.title || 'New chat') && crumb().includes('Map the pricing module'), crumb());
    check('the page draws the prompt and the stream', !!document.querySelector('[data-agent-view]')?.textContent.includes('Sent by another agent'));
    await until(16000); // shot 2: the sub-agent

    esc();
    await sleep(400);
    check('Escape goes back', S().agentView === null);
    check('...with the focus on the chat', S().focusedChatId === id, S().focusedChatId);

    await S().openAgentView(DELEGATE);
    await sleep(500);
    check('a delegate opens as the page', S().agentView === DELEGATE);
    check('...with a transcript slot of its own', !!S().sideChats[DELEGATE]);
    check('...and the focus', S().focusedChatId === DELEGATE);
    check('the crumb names it, never its task', crumb().includes('codex-a') && !crumb().includes('one-line fix'), crumb());
    app.setState((s) => ({
      sideChats: {
        ...s.sideChats,
        [DELEGATE]: {
          ...s.sideChats[DELEGATE],
          messages: [
            { id: 'd-u', role: 'user', text: TASK, ts: now - 60000 },
            { id: 'd-a', role: 'assistant', ts: now - 30000, parts: [{ type: 'text', text: 'Two issues in `src/pricing.ts`:\n\n1. **Line 12** rounds before applying the discount, so totals drift by a cent. Round once, at the end.\n2. **Line 21** treats a quantity of `0` as missing. Check for `undefined` instead.' }] }
          ]
        }
      }
    }));
    check('...and keeps its composer', !!document.querySelector(`[data-agent-view="${DELEGATE}"] [data-composer]`));
    await until(22000); // shot 3: the delegate

    S().focusChat(id);
    await sleep(300);
    check('focusing another chat leaves the page', S().agentView === null);
    check('...and releases the delegate\'s slot', !S().sideChats[DELEGATE]);

    await S().openAgentView(DELEGATE);
    await sleep(300);
    document.querySelector('[data-agent-crumb] button')?.click();
    await sleep(300);
    check('the chat\'s name in the crumb goes back', S().agentView === null && S().focusedChatId === id);
    return { log };
  })();
})()

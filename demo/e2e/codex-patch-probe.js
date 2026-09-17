// Does a Codex edit arrive as a diff, and does it arrive *while* it is written?
//
// Codex publishes a `file_change` item's unified patch through
// `item/fileChange/patchUpdated`, and Carbon read neither that notification nor
// the `diff` field on the item itself — so the Edit card expanded to nothing on
// that provider. This sends one real editing turn and reports, off the store
// rather than off the DOM:
//
//   `sawPartialDiff` — a diff was on the part while the call was still running,
//                      which is the progressive half. False means the
//                      notification is not arriving (or is not named what we
//                      think), even if the final card looks right.
//   `finalChanges`   — each change's path, kind, and how many lines of patch
//                      came with it.
//
//   ./demo/shoot.sh /tmp/cxpatch 150000 demo/e2e/codex-patch-probe.js
(() => {
  const CHAT = '__CHAT__';
  const PROMPT =
    'Use your patch tool to append exactly three short bullet lines to ' +
    'docs/quickstart.md summarizing that page. Change nothing else, create no ' +
    'files and run no commands. ' +
    `Then reply with one sentence. (run ${Date.now()})`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app;
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));

  return (async () => {
    const row = startsWith(CHAT)[0];
    if (!row) return { error: 'chat not found: ' + CHAT };
    (row.closest('button,[role="button"],li,a') || row).click();
    await sleep(1500);
    const chatId = app.getState().activeId;
    await app.getState().setChatOptions(chatId, { permissionMode: 'bypassPermissions' });
    await sleep(300);

    // Every edit part seen at any point in the turn, and what it carried then.
    const seen = [];
    let sawPartialDiff = false;
    const sample = () => {
      for (const m of app.getState().messages) {
        if (m.role !== 'assistant') continue;
        for (const p of m.parts) {
          if (!p || p.type !== 'tool' || p.name !== 'Edit') continue;
          const changes = Array.isArray(p.input?.changes) ? p.input.changes : [];
          const withDiff = changes.filter((c) => typeof c?.diff === 'string' && c.diff);
          if (withDiff.length && (p.status === 'running' || p.status === 'pending')) {
            sawPartialDiff = true;
          }
          seen.push({
            status: p.status,
            changes: changes.length,
            diffs: withDiff.length,
            lines: withDiff.reduce((n, c) => n + c.diff.split('\n').length, 0)
          });
        }
      }
    };
    const poll = setInterval(sample, 100);
    // A probe must never park on a prompt: bypassPermissions covers the sandbox
    // but not a tool that asks a *question*, and Codex asks one readily.
    const answered = new Set();
    const allow = setInterval(() => {
      for (const req of app.getState().permissions?.[chatId] ?? []) {
        if (answered.has(req.id)) continue;
        answered.add(req.id);
        void app.getState().respondPermission(chatId, req.id, { behavior: 'allow' });
      }
    }, 200);

    const status = () => app.getState().statuses[chatId] ?? 'idle';
    void app.getState().sendMessage(chatId, PROMPT, []);
    let waited = 0;
    while (status() === 'idle' && waited < 25000) {
      await sleep(100);
      waited += 100;
    }
    const started = performance.now();
    while (status() !== 'idle' && performance.now() - started < 140000) await sleep(200);
    await sleep(1200);
    clearInterval(poll);
    clearInterval(allow);

    const msgs = app.getState().messages;
    const edits = [];
    for (const m of msgs) {
      if (m.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (!p || p.type !== 'tool' || p.name !== 'Edit') continue;
        const changes = Array.isArray(p.input?.changes) ? p.input.changes : [];
        edits.push({
          status: p.status,
          changes: changes.map((c) => ({
            path: String(c?.path ?? ''),
            kind: String(c?.kind ?? ''),
            diffLines: typeof c?.diff === 'string' ? c.diff.split('\n').length : 0,
            head: typeof c?.diff === 'string' ? c.diff.split('\n').slice(0, 4) : []
          }))
        });
      }
    }
    return {
      chat: CHAT,
      status: status(),
      provider: app.getState().chats.find((c) => c.id === chatId)?.provider,
      editParts: edits.length,
      sawPartialDiff,
      samplesWithDiff: seen.filter((s) => s.diffs > 0).length,
      answeredPrompts: answered.size,
      finalChanges: edits
    };
  })();
})()

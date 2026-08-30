// Two shots in one launch: the Appearance settings page (six themes) and the
// plan review. The plan chat is parked on a persisted `pendingPlanReview`, so
// opening it rebuilds the permission request and opens the plan panel by the
// same path an app restart takes.
(() => {
  const log = [];
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  const exact = (t) =>
    [...document.querySelectorAll('button,[role="tab"],[role="radio"],label,div,span')]
      .filter((e) => (e.textContent || '').trim() === t)
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim() === t));
  const hit = (el, what) => {
    const t = el && (el.closest('button,[role="tab"],[role="radio"],a,li,label') || el);
    if (!t) { log.push('miss:' + what); return; }
    t.click(); log.push('ok:' + what);
  };
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { log.push('err:' + e.message); } }, ms);

  hit(document.querySelector('[aria-label="Open settings"]'), 'settings');
  at(900, () => hit(exact('Chats')[0], 'chats'));
  at(1700, () => hit(exact('Detailed')[0], 'detailed'));
  at(2400, () => hit(exact('Appearance')[0], 'appearance'));   // capture 1 @ 4000
  at(5000, () => hit(document.querySelector('[aria-label="Close settings"]'), 'close'));
  at(6000, () => hit(startsWith('Add a search index')[0], 'plan-chat'));
  at(9000, () => log.push('planVisible:' + /Search across the docs|Approve/.test(document.body.innerText)));
  return new Promise((resolve) => setTimeout(() => resolve({ log }), 11000));
})()

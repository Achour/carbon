// Three-provider model picker for the site's "01 · Three providers" image.
//
// Opened from the HOME screen (no chat selected), whose composer sits mid-window:
// anchored there the menu has room for all three groups at once. Anchored to a
// chat's composer at the foot of the window it gets 288px for 542px of content,
// and inside the New-chat dialog it is both constrained and dimmed by the modal
// overlay. Captures land ~1s after the click, before anything can steal focus.
(() => {
  const log = [];
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  const leafText = (t) =>
    [...document.querySelectorAll('div,span,li,button')].find(
      (e) => (e.textContent || '').trim().toLowerCase() === t && !e.children.length
    );
  const hit = (el, what) => {
    const t = el && (el.closest('button,[role="button"],a,li') || el);
    if (!t) { log.push('miss:' + what); return false; }
    t.click(); log.push('ok:' + what); return true;
  };
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { log.push('err:' + e.message); } }, ms);

  hit(document.querySelector('[aria-label="Open settings"]'), 'settings');
  at(900, () => hit([...document.querySelectorAll('button,[role="tab"],div,span')].find((e) => (e.textContent || '').trim() === 'Chats'), 'chats'));
  at(1700, () => hit([...document.querySelectorAll('button,[role="radio"],label,div,span')].find((e) => (e.textContent || '').trim() === 'Detailed'), 'detailed'));
  at(2500, () => hit(document.querySelector('[aria-label="Close settings"]'), 'close'));
  at(4000, () => hit(startsWith('Opus 5')[0], 'model-chip'));
  at(4900, () => {
    const g = leafText('grok');
    const c = leafText('claude code');
    log.push('grok:' + (g ? Math.round(g.getBoundingClientRect().top) : 'none') +
             ' claude:' + (c ? Math.round(c.getBoundingClientRect().top) : 'none'));
  });
  return new Promise((resolve) => setTimeout(() => resolve({ log }), 7000));
})()

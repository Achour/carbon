// The review at full window width.
//
// A diff wants width: in the three-column layout the pane is ~530 CSS px, which
// clips long lines, and wrapping instead breaks code mid-token. So the panel is
// maximized before the review is mounted into it, through the panel's own "+"
// picker ("Review changes").
//
// The ordering is habit rather than necessity — an earlier pass here blamed
// `LazyDiffBody` for not re-observing after the relayout, and that is wrong:
// maximizing changes the panel's WIDTH, and the mount margin is vertical, so a
// review open across the resize keeps exactly the bodies it should (verified at
// 40 changed files: 16 mounted before, 16 after, 26 after scrolling).
//
// Dark is set explicitly — the colour mode persists in settings.json, so a
// previous light-mode shoot would otherwise hand back a mismatched screenshot.
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
    const t = el && (el.closest('button,[role="tab"],[role="button"],a,li,label') || el);
    if (!t) { log.push('miss:' + what); return; }
    t.click(); log.push('ok:' + what);
  };
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { log.push('err:' + e.message); } }, ms);

  hit(document.querySelector('[aria-label="Open settings"]'), 'settings');
  at(700, () => hit(exact('Appearance')[0], 'appearance'));
  at(1400, () => hit(exact('Dark')[0], 'dark'));
  at(2100, () => hit(exact('Chats')[0], 'chats'));
  at(2800, () => hit(exact('Detailed')[0], 'detailed'));
  at(3500, () => hit(document.querySelector('[aria-label="Close settings"]'), 'close'));

  at(4500, () => hit(startsWith('Build the Nimbus landing')[0], 'hero-chat'));
  at(6200, () => hit(exact('Files')[0], 'files'));            // any tab, so the panel can maximize
  at(7600, () => hit(document.querySelector('[aria-label="Maximize panel"]'), 'maximize'));
  at(9000, () => hit(document.querySelector('[aria-label="Open a file or tab"]'), 'plus'));
  at(10200, () => hit(exact('Review changes')[0], 'review'));
  at(13500, () => {
    const wrap = document.querySelector('[aria-label="Do not wrap long lines"]');
    if (wrap) { hit(wrap, 'wrap-off'); } else log.push('wrap-already-off');
  });
  at(15500, () =>
    log.push(
      'code:' + /box-sizing|antialiased|border-box/.test(document.body.innerText) +
      ' maximized:' + !!document.querySelector('[aria-label="Restore panel"]')
    )
  );
  return new Promise((resolve) => setTimeout(() => resolve({ log }), 17000));
})()

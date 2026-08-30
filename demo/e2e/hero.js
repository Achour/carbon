// The hero: detailed sidebar, the finished turn, and the file editor open on the
// file the turn rewrote.
//
// The editor rather than the review: the review reads as a review at full
// width, and gets its own shot there. (This once had a second reason — the
// review toolbar sliced its primary action in half at this column width — which
// is fixed: the bar's right cluster now yields instead of overflowing.)
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
    const t = el && (el.closest('button,[role="button"],[role="tab"],a,li,label') || el);
    if (!t) { log.push('miss:' + what); return; }
    t.click(); log.push('ok:' + what);
  };
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { log.push('err:' + e.message); } }, ms);

  hit(document.querySelector('[aria-label="Open settings"]'), 'settings');
  at(900, () => hit(exact('Chats')[0], 'chats'));
  at(1700, () => hit(exact('Detailed')[0], 'detailed'));
  at(2400, () => hit(document.querySelector('[aria-label="Close settings"]'), 'close'));
  at(3400, () => hit(startsWith('Build the Nimbus landing')[0], 'hero-chat'));
  at(5400, () => hit(exact('Files')[0], 'files'));
  // The file tree is LAST in the DOM: "src" and "index.css" also appear in the
  // transcript's changed-files card, and clicking those collapses the card
  // instead of opening the folder.
  at(7000, () => hit(exact('src').pop(), 'src-folder'));
  at(8600, () => hit(exact('index.css').pop(), 'open-css'));
  // Belt and braces before the shutter: the settings overlay has been observed
  // re-appearing late in a dev run (HMR reloads the renderer, and the E2E's
  // staged clicks then race the remount), and a shot of the settings page is
  // not a hero. Closing it is idempotent when it is already closed.
  at(12500, () => {
    const close = document.querySelector('[aria-label="Close settings"]');
    if (close) { hit(close, 're-close-settings'); }
    else log.push('settings-already-closed');
  });
  at(13500, () => {
    if (!/Build the Nimbus landing page/.test(document.body.innerText)) {
      hit(startsWith('Build the Nimbus landing')[0], 're-open-chat');
    }
  });
  // CodeMirror is a lazily-loaded chunk warmed on idle, so a click that beats
  // the warm-up shows "Loading…" for a beat. Report what actually rendered.
  at(16500, () => {
    const cm = document.querySelector('.cm-content');
    log.push('cmLines:' + (cm ? cm.querySelectorAll('.cm-line').length : 0) +
             ' settingsOpen:' + !!document.querySelector('[aria-label="Close settings"]') +
             ' chat:' + /Build the Nimbus landing page/.test(document.body.innerText));
  });
  return new Promise((resolve) => setTimeout(() => resolve({ log }), 18000));
})()

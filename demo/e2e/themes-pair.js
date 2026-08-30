// The dark/light pair: the same turn-changes card and composer in both modes.
//
// Both modes are set EXPLICITLY. The colour mode persists in settings.json
// (main-process, so it survives a killed run), which means "click Light" is a
// no-op if a previous shoot already left it there — and the pair comes out as
// two identical light frames. The run ends by restoring Dark, the profile's
// normal state for every other shot.
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
  // Pin the transcript to the bottom before each frame: switching theme reflows
  // it, and a Dark/Light pair whose halves sit at different scroll offsets is
  // two different pictures rather than one picture twice.
  const toBottom = () => {
    const t = [...document.querySelectorAll('div')]
      .filter((e) => e.scrollHeight > e.clientHeight + 80 && e.clientHeight > 500)[0];
    if (!t) { log.push('miss:scroller'); return; }
    t.scrollTop = t.scrollHeight;
  };
  const setMode = (mode) => {
    hit(document.querySelector('[aria-label="Open settings"]'), 'settings:' + mode);
    setTimeout(() => hit(exact('Appearance')[0], 'appearance'), 700);
    setTimeout(() => hit(exact(mode)[0], 'mode:' + mode), 1400);
    setTimeout(() => hit(document.querySelector('[aria-label="Close settings"]'), 'close'), 2200);
  };

  setMode('Dark');
  at(3400, () => hit(startsWith('Build the Nimbus landing')[0], 'hero-chat'));
  at(5800, toBottom);
  at(6600, toBottom);   // twice: the first can land while the turn is still settling
  // capture 1 (dark) ~7200
  at(8000, () => setMode('Light'));
  at(11500, toBottom);
  at(12200, toBottom);
  // capture 2 (light) ~12800
  at(14000, () => log.push('mode-at-end-light:' + document.documentElement.classList.contains('light')));
  at(15000, () => setMode('Dark'));      // leave the profile as it was found
  return new Promise((resolve) => setTimeout(() => resolve({ log }), 18500));
})()

(() => {
  const log = [];
  const exact = (t) =>
    [...document.querySelectorAll('button,[role="tab"],[role="radio"],label,div,span')]
      .filter((e) => (e.textContent || '').trim() === t)
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim() === t));
  const startsWith = (t) =>
    [...document.querySelectorAll('button,[role="button"],li,a,div,span')]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));
  const hit = (el, what) => {
    const t = el && (el.closest('button,[role="tab"],[role="button"],a,li,label') || el);
    if (!t) { log.push('miss:' + what); return; }
    t.click(); log.push('ok:' + what);
  };
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { log.push('err:' + e.message); } }, ms);

  hit(document.querySelector('[aria-label="Open settings"]'), 'settings');
  at(2000, () => hit(document.querySelector('[aria-label="Close settings"]'), 'close'));
  at(3000, () => hit(startsWith('Build the Nimbus landing')[0], 'chat'));
  at(5000, () => hit(exact('Files')[0], 'files'));
  at(6500, () => hit(document.querySelector('[aria-label="Maximize panel"]'), 'maximize'));
  at(8000, () => hit(document.querySelector('[aria-label="Open a file or tab"]'), 'plus'));
  return new Promise((resolve) => setTimeout(() => {
    const menu = document.querySelector('[role="menu"],[role="dialog"],[role="listbox"]');
    resolve({ log, menu: menu ? menu.innerText.replace(/\s*\n+\s*/g, ' | ').slice(0, 400) : 'no-menu' });
  }, 10000));
})()

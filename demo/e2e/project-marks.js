// Project marks in the sidebar: every place a project is listed, in one run.
//
// Six frames from one launch, because the mark is one answer drawn six ways
// and a run that shot them separately could catch six different states of the
// icon cache. Density, the filter and both dialogs are driven through the
// store rather than clicked: the first two persist, so a click is a *toggle*
// against whatever the last run left, and the dialogs have keyboard shortcuts
// no screenshot can press. The run puts everything back before it resolves.
//
//   ./demo/shoot.sh /tmp/marks 6000,9500,12500,15500,18500,21500 demo/e2e/project-marks.js
(() => {
  const log = [];
  const app = window.__app;
  const S = () => app.getState();
  const at = (ms, fn) =>
    setTimeout(() => {
      try {
        fn();
      } catch (e) {
        log.push('err:' + e.message);
      }
    }, ms);

  S().setSidebarDensity('compact');
  S().setSidebarProject(null);
  log.push('compact');

  // 1 — compact, unfiltered: a mark per project row, and the Pinned section
  // above them carrying one per row (nimbus and pulse, two projects).
  at(7000, () => {
    // What main actually resolved, so a row drawing initials because the icon
    // scan found nothing is distinguishable from one drawing them because the
    // answer never arrived.
    const icons = S().projectIcons;
    log.push(
      'icons:' +
        Object.entries(icons)
          .map(([root, uri]) => root.split('/').pop() + '=' + (uri ? uri.slice(5, 22) : 'none'))
          .join(' ')
    );
    S().setSidebarDensity('detailed');
    log.push('detailed');
  });

  // 2 — detailed, unfiltered: the mark at the head of every row's meta line.
  // 3 — the filter open, a mark per row in it.
  at(10500, () => {
    const btn = document.querySelector('[aria-label="Filter by project"]');
    if (!btn) return log.push('miss:filter');
    btn.click();
    log.push('opened:filter');
  });

  // 4 — filtered to one project: the control wears its mark, and no row does.
  at(13500, () => {
    const pick = () => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const nimbus = items.find((e) => (e.textContent || '').includes('nimbus'));
      if (!nimbus) return false;
      nimbus.click();
      log.push('picked:nimbus');
      return true;
    };
    if (pick()) return;
    // The menu is dismissible, and the frame taken while it is open sometimes
    // closes it — so reopen and retry rather than reporting a miss for a
    // control that is plainly there.
    const btn = document.querySelector('[aria-label="Filter by project"]');
    if (btn) btn.click();
    setTimeout(() => {
      if (!pick()) log.push('miss:nimbus');
    }, 400);
  });

  // 5 — the ⌘N project picker: the one surface listing every project as rows.
  at(16500, () => {
    S().setSidebarProject(null);
    S().setNewChatOpen(true);
    log.push('newchat');
  });

  // 6 — chat search: every project at once, grouped by nothing.
  at(19500, () => {
    S().setNewChatOpen(false);
    S().setSearchOpen(true);
    log.push('search');
  });

  // Leave the profile as it was found: compact, unfiltered, nothing open.
  // Inside the window the shoot allows after the last frame (it kills ~2s
  // later), or the next run starts from this one's leftovers.
  at(22000, () => {
    S().setSearchOpen(false);
    S().setSidebarProject(null);
    S().setSidebarDensity('compact');
    log.push('restored');
  });

  return new Promise((resolve) => setTimeout(() => resolve({ log }), 22600));
})()

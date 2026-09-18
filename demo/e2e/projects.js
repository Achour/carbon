// Settings → Projects: the list pane, and one project's detail beside it.
//
// Opens the page at its own section rather than clicking the nav — the store
// holds which section is open precisely so something outside the component can
// name one — then selects the project that has a worktree, since the worktree
// list is the half of the pane no other surface in the app can show.
//
// Reports what each row actually resolved (icon or initials, remote, worktree
// count) so a run says whether main answered, not only whether the page drew.
//
//   ./demo/shoot.sh /tmp/projects 6500 demo/e2e/projects.js
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

  S().openSettings('projects');
  log.push('opened');

  at(2500, () => {
    const rows = [...document.querySelectorAll('button[aria-label^="Select "]')];
    log.push('rows:' + rows.map((r) => r.getAttribute('aria-label').slice(7)).join(','));
    const pulse = rows.find((r) => (r.getAttribute('aria-label') || '').includes('pulse'));
    if (pulse) {
      pulse.click();
      log.push('selected:pulse');
    } else {
      log.push('miss:pulse');
    }
  });

  at(4500, () => {
    // What main actually answered for each project — read off the store, so a
    // row that drew initials because the overview never arrived is
    // distinguishable from one that drew them because there is no icon.
    const s = S();
    for (const [root, p] of Object.entries(s.projects)) {
      log.push(
        `${root.split('/').pop()}: exists=${p.exists} repo=${p.isRepo} branch=${p.branch} ` +
          `remote=${p.remote ? p.remote.owner + '/' + p.remote.repo : p.remoteUrl || 'none'} ` +
          `icon=${p.icon ? p.icon.slice(0, 24) + '…' : 'none'} worktrees=${p.worktrees} branches=${p.branches}`
      );
    }
    // The one that was *selected*, not merely the first loaded — the list
    // auto-selects its top row, so that one's detail arrives first.
    const root = Object.keys(s.projects).find((r) => r.endsWith('/pulse'));
    const detail = root ? s.projectDetails[root] : undefined;
    if (detail) {
      log.push(
        `detail ${detail.root.split('/').pop()}: worktrees=` +
          detail.worktrees
            .map(
              (w) =>
                `${w.branch}${w.isMain ? '(main)' : ''}${w.missing ? '(missing)' : ''}` +
                `${w.managed ? '' : '(unmanaged)'}`
            )
            .join(',') +
          ` branches=${detail.branches.map((b) => b.name).join(',')} default=${detail.defaultBranch}`
      );
    } else {
      log.push('no detail loaded');
    }
  });

  return new Promise((resolve) => setTimeout(() => resolve({ log }), 8000));
})()

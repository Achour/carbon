// Archiving a chat, and Settings → Archive holding it.
//
// Shot 1 is the sidebar with two chats taken out of it; shot 2 is the page they
// went to. The script archives through the store rather than through the row's
// context menu — a menu opened by a synthetic event photographs itself over the
// list it is about — and then checks the two rules the feature stands on, which
// no screenshot can show:
//
//   - an archived chat is gone from every list the sidebar draws, and
//   - opening one restores it, so it can never be on screen with no row.
//
//   ./demo/shoot.sh /tmp/archive 5000,9500,13000 demo/e2e/archive.js
//
// The third delay exists only so the app outlives the promise below — shoot.sh
// kills two seconds after the last shot lands, and a result logged after that
// is a result nobody reads.
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

  // Rows the sidebar is actually drawing, by title.
  const rowTitles = () =>
    [...document.querySelectorAll('aside button')]
      .map((b) => b.textContent.trim())
      .filter(Boolean);

  const listed = () => S().chats.filter((c) => !c.ephemeral && c.archivedAt === undefined).length;

  const picked = S()
    .chats.filter((c) => !c.ephemeral && c.archivedAt === undefined)
    .slice(1, 3);
  log.push('before: listed=' + listed() + ' picked=' + picked.map((c) => c.title).join(' | '));

  for (const c of picked) void S().setChatArchived(c.id, true);

  at(2500, () => {
    const titles = rowTitles();
    log.push('after: listed=' + listed() + ' archived=' + S().chats.filter((c) => c.archivedAt).length);
    for (const c of picked) {
      log.push(`sidebar draws “${c.title}”: ` + titles.some((t) => t.includes(c.title)));
    }
    // A pin is a position in a list this chat has left; main drops it too.
    log.push('pins kept: ' + picked.filter((c) => S().chats.find((x) => x.id === c.id)?.pinnedAt).length);
  });

  at(6000, () => {
    S().openSettings('archive');
    log.push('opened settings:archive');
  });

  at(7500, () => {
    const rows = [...document.querySelectorAll('button[aria-label^="Delete "]')];
    log.push('archive page rows:' + rows.length);
  });

  // The rule the first two shots cannot show: opening an archived chat restores
  // it, so shot 3 is the chat back on screen with its row back in the sidebar.
  at(10500, () => {
    const target = picked[0];
    void S()
      .openChat(target.id)
      .then(() => {
        const after = S().chats.find((c) => c.id === target.id);
        log.push(
          `open restored “${target.title}”: ${after?.archivedAt === undefined} ` +
            `active=${S().activeId === target.id} listed=${listed()}`
        );
      });
  });

  return new Promise((resolve) => setTimeout(() => resolve({ log }), 12000));
})()

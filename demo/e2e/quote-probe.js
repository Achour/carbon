// The quote bar: select a passage in a reply, and ask about that passage.
//
// It drives real DOM selections against a real transcript — a `Range` over the
// rendered markdown, `pointerdown`/`pointerup` around it — because every part of
// this feature is a question about the *live* selection: whether the bar waits
// for the drag to end, what `Selection.toString()` yields across a code block's
// hover controls, and whether the chip that lands in the composer carries what
// was highlighted. None of that is reachable from a unit test.
//
//   ./demo/shoot.sh /tmp/quote 8000,14500 demo/e2e/quote-probe.js
//
// Shots: the bar over a selected passage, and the chip it leaves in the composer.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadedAt = Date.now() - 1000;
  const until = (ms) => sleep(Math.max(0, ms - (Date.now() - loadedAt)));
  // The store parks stream events while the window is hidden, and a probe window
  // behind the user's own is exactly that.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) =>
    log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const S = () => app.getState();

  const REPLY = [
    'The reconcile is bounded on purpose: it verifies the tail plus a rotating',
    'window rather than re-serializing the whole chat.',
    '',
    '```sh',
    'npm run typecheck',
    '```',
    '',
    'Quit runs one thorough pass over the dirty set.'
  ].join('\n');

  const bar = () => document.querySelector('[data-quote-bar]');
  const barButton = (label) =>
    [...(bar()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes(label));
  // The chip's tooltip is the quote itself — trimmed, which is what
  // `quoteText` does to whatever the DOM handed it.
  const chipsIn = (root) => [...(root ?? document).querySelectorAll('[title]')];
  const chipFor = (text, root) =>
    chipsIn(root ?? document.querySelector('[data-chat-surface]')).find(
      (el) => el.getAttribute('title') === text.trim()
    );

  // A drag, as the browser reports one: the bar must not appear until the
  // pointer comes back up, or it lands under the cursor mid-gesture.
  const selectIn = async (node, from, to, { release = true } = {}) => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(60);
    if (release) {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await sleep(120);
    }
    return sel.toString();
  };

  return (async () => {
    const first = S().chats.find((c) => !c.sideOf);
    await S().openChat(first.id);
    await sleep(900);

    // A reply of our own, so the probe does not depend on what the seeded
    // profile happens to say — and so it has a code fence to drag across.
    const id = `a-quote-${Date.now()}`;
    S().applyEvent({
      type: 'message',
      chatId: first.id,
      message: { id, role: 'assistant', ts: Date.now(), parts: [{ type: 'text', text: REPLY }] }
    });
    await sleep(600);

    const block = [...document.querySelectorAll('[data-chat-surface] [data-message-role="assistant"]')].pop();
    check('an assistant message carries its role', !!block);
    const para = block.querySelector('.markdown p');
    const text = para.firstChild;

    // --- The bar waits for the drag to end ---
    await selectIn(text, 4, 40, { release: false });
    check('no bar while the pointer is still down', !bar());
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await sleep(150);
    const quoted = window.getSelection().toString().trim();
    check('the bar appears when the drag ends', !!bar(), quoted);

    // --- It sits over the passage, inside the column ---
    const box = bar().getBoundingClientRect();
    const line = para.getBoundingClientRect();
    const column = document.querySelector('[data-chat-surface]').getBoundingClientRect();
    check('the bar is above the passage', box.bottom <= line.top + 2, `${box.bottom} vs ${line.top}`);
    check(
      'the bar is inside the column',
      box.left >= column.left && box.right <= column.right,
      `${box.left}-${box.right} in ${column.left}-${column.right}`
    );
    await until(9000);

    // --- Add to chat ---
    barButton('Add to chat').click();
    await sleep(300);
    check('the selection is released', window.getSelection().isCollapsed);
    check('the bar is gone', !bar());
    const chip = chipFor(quoted);
    check('the composer holds the quote', !!chip, chip?.textContent);
    check(
      'the chip is labelled with the passage',
      !!chip && quoted.startsWith(chip.textContent.replace('…', '')),
      chip?.textContent
    );

    // --- A code fence's hover controls are not part of the quote ---
    const pre = block.querySelector('pre');
    check('the reply rendered a code block', !!pre);
    const wide = document.createRange();
    wide.setStart(text, 0);
    wide.setEnd(pre, pre.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(wide);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await sleep(150);
    const across = sel.toString();
    check('a selection across a fence keeps the code', across.includes('npm run typecheck'), JSON.stringify(across.slice(-60)));
    check('...and not the block\'s copy/wrap controls', !/Copy|Wrap/.test(across));
    check('the bar follows the second selection', !!bar());

    // --- A collapsed selection dismisses it ---
    sel.removeAllRanges();
    await sleep(150);
    check('collapsing the selection hides the bar', !bar());

    // --- A prompt is quotable too, and knows it is the user's ---
    const prompt = document.querySelector('[data-chat-surface] [data-message-role="user"] .markdown p');
    check('a prompt carries its role', !!prompt);
    // The bar hides a selection that is off screen, and the transcript sits at
    // the bottom by now — so put the prompt back in view before quoting it.
    prompt.scrollIntoView({ block: 'center' });
    await sleep(200);
    const asked = (await selectIn(prompt.firstChild, 6, 30)).trim();
    check('the bar offers to quote a prompt', !!bar(), asked);
    barButton('Add to chat')?.click();
    await sleep(300);
    check('the prompt quote reaches the composer', !!chipFor(asked), asked);

    // --- ⌘L is the same action ---
    const byKey = (await selectIn(text, 4, 30)).trim();
    document.activeElement?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    check('⌘L adds the selection without the bar', !!chipFor(byKey), byKey);

    // --- Ask in side chat opens a column and hands it the quote ---
    const columnsBefore = S().sideColumns.length;
    await selectIn(text, 4, 40);
    barButton('Ask in side chat').click();
    await sleep(1500);
    const columns = S().sideColumns;
    check('a column opened', columns.length === columnsBefore + 1, `${columnsBefore} -> ${columns.length}`);
    const side = columns[columns.length - 1];
    check('the new column is focused', S().focusedChatId === side);
    const inSide = document.querySelector(`[data-chat-surface="${side}"]`);
    check('the new column is on screen', !!inSide);
    const sideChip = chipFor(quoted, inSide);
    check(
      'the side chat holds the quote',
      !!sideChip,
      `[${chipsIn(inSide).map((el) => el.getAttribute('title')?.slice(0, 20)).join(' / ')}]`
    );
    await until(14500);

    // Leave the profile as it was found. A quote chip is reference-shaped, so
    // `persistableAttachments` keeps it in the draft and `localStorage` carries
    // it into the next launch — the probe would otherwise stack its own
    // selections in the demo profile's composer, shot after shot.
    //
    // The cleanup goes through the chip's own ✕ rather than through
    // `saveChatDraft`: the composer holds text and attachments in its own state
    // and writes them back on a debounce, so a store-level write is overwritten
    // by the next tick. It matches on the quote's text, so it takes this run's
    // chips and any left by an earlier one, and nothing else in the composer.
    await S().deleteSideChat(side);
    const mine = [quoted, asked, byKey];
    for (const el of document.querySelectorAll('[data-chat-surface] [title]')) {
      if (!mine.includes(el.getAttribute('title'))) continue;
      el.parentElement?.querySelector('button')?.click();
    }
    // Past DRAFT_DEBOUNCE_MS, so the empty draft is written before the app dies.
    await sleep(1200);
    log.push(`left behind: ${chipsIn(document.querySelector('[data-chat-surface]')).filter((el) => mine.includes(el.getAttribute('title'))).length}`);
    return { log };
  })();
})()

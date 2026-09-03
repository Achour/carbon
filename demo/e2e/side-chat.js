// A side chat probe, not a shot: opens one, pumps a Claude-shaped turn through
// the *real* `applyEvent` reducer into it, and checks the thing the whole
// feature rests on — that two transcripts share one store without touching each
// other.
//
// The events are synthetic on purpose. What is being tested is the reducer's
// routing and the panel's tab wiring, and a real turn would make that depend on
// a provider CLI being installed and on whatever the model felt like saying.
//
//   ./demo/shoot.sh /tmp/side 5000,11000 demo/e2e/side-chat.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The store parks stream events while the window is hidden, and a probe window
  // behind the user's own is exactly that.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const startsWith = (t, sel = 'button,[role="button"],li,a,div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => (e.textContent || '').trim().startsWith(t))
      .filter((e) => ![...e.children].some((c) => (c.textContent || '').trim().startsWith(t)));

  const turn = (chatId, msgId, text) => {
    const st = app.getState();
    st.applyEvent({ type: 'message', chatId, message: { id: msgId, role: 'assistant', ts: Date.now(), parts: [{ type: 'text', text: '' }] } });
    st.applyEvent({ type: 'tool-update', chatId, messageId: msgId, toolUseId: `${msgId}-t`, patch: {} });
    for (const word of text.split(' ')) {
      st.applyEvent({ type: 'part-delta', chatId, messageId: msgId, partIndex: 0, delta: word + ' ' });
    }
  };

  return (async () => {
    // Open a chat in the main column first, so there are two transcripts.
    const firstChat = startsWith('Build the Nimbus landing')[0];
    if (firstChat) (firstChat.closest('button,li,a,div') || firstChat).click();
    await sleep(1500);

    const mainId = app.getState().activeId;
    check('a main chat is open', !!mainId, mainId || 'none');

    await app.getState().openSideChat();
    await sleep(1200);

    const s1 = app.getState();
    const sideId = s1.sideChatTabs[0];
    check('a side chat tab exists', !!sideId, `tabs=${JSON.stringify(s1.sideChatTabs)}`);
    check('its slot was created', !!s1.sideChats[sideId]);
    check('the panel switched to it', s1.activeTab === `side:${sideId}`, s1.activeTab);
    check('it is flagged ephemeral', !!s1.chats.find((c) => c.id === sideId)?.ephemeral);
    check('it runs in the main chat\'s folder',
      s1.chats.find((c) => c.id === sideId)?.cwd === s1.chats.find((c) => c.id === mainId)?.cwd);
    // The whole point of the `ephemeral` flag on the renderer side.
    check('the sidebar does not list it',
      !startsWith('Side chat', '[data-sidebar] *').length, 'no sidebar row');

    // --- Route a turn into the SIDE chat ---
    const mainBefore = app.getState().messages;
    const mainLenBefore = mainBefore.length;
    turn(sideId, 'side-msg-1', 'This is the side chat answering a question about the work next door.');
    await sleep(900);

    const s2 = app.getState();
    check('the side transcript grew', s2.sideChats[sideId].messages.length === 1,
      `${s2.sideChats[sideId].messages.length} message(s)`);
    // Identity, not length: a fresh array with the same contents would still
    // re-render the whole main transcript on every delta of the side chat's turn.
    check('the main transcript is untouched (same reference)', s2.messages === mainBefore,
      s2.messages === mainBefore ? 'identical' : `replaced, len ${s2.messages.length} vs ${mainLenBefore}`);

    // --- And the inverse: a main-chat turn must not reach the side slot ---
    const sideBefore = app.getState().sideChats[sideId].messages;
    turn(mainId, 'main-msg-1', 'And this one belongs to the main column.');
    await sleep(900);

    const s3 = app.getState();
    check('the main transcript grew', s3.messages.length === mainLenBefore + 1,
      `${mainLenBefore} -> ${s3.messages.length}`);
    check('the side transcript is untouched (same reference)',
      s3.sideChats[sideId].messages === sideBefore);

    // The two app-wide singletons the side variant must never publish into. The
    // side chat above ran a turn with a tool call, so an unguarded publish would
    // have stamped the dock with its id and cleared the roster.
    const taskChat = window.__tasks.getState().chatId;
    check('the task dock still belongs to the main chat', taskChat !== sideId,
      `chatId=${taskChat}`);
    check('the agent roster was not clobbered by the side chat',
      Array.isArray(window.__agents.getState().runs));

    // --- Closing keeps the conversation; reopening brings it back ---
    const closedId = sideId;
    await app.getState().closeSideChat(closedId);
    await sleep(900);
    const s4 = app.getState();
    check('closing removed the tab', !s4.sideChatTabs.includes(closedId));
    check('closing released the in-memory slot', !s4.sideChats[closedId]);
    // The whole point of the change: ✕ is a tab close, not a delete.
    check('closing KEPT the conversation', s4.chats.some((c) => c.id === closedId));
    check('it is listed as a closed side chat of this chat',
      s4.chats.some((c) => c.id === closedId && c.sideOf === mainId));

    // A closed side chat is a background chat: its events must reach neither
    // transcript, and must not resurrect a slot.
    const mainRefBefore = app.getState().messages;
    turn(closedId, 'ghost-1', 'This should land nowhere on screen.');
    await sleep(600);
    const s4b = app.getState();
    check('a closed side chat streams into neither transcript',
      s4b.messages === mainRefBefore && !s4b.sideChats[closedId]);

    await app.getState().reopenSideChat(closedId);
    await sleep(1200);
    const s4c = app.getState();
    check('reopening restores the tab', s4c.sideChatTabs.includes(closedId));
    check('reopening refetched a slot from disk', !!s4c.sideChats[closedId]);
    check('and it is the SAME conversation, not a new one',
      s4c.chats.filter((c) => c.sideOf === mainId).length === 1,
      `${s4c.chats.filter((c) => c.sideOf === mainId).length} side chat(s) of the main chat`);

    // --- An unused side chat is discarded on close, not kept as a blank row ---
    await app.getState().openSideChat();
    await sleep(900);
    const blankId = app.getState().sideChatTabs.find((x) => x !== closedId);
    await app.getState().closeSideChat(blankId);
    await sleep(900);
    check('closing an untouched side chat discards it',
      !app.getState().chats.some((c) => c.id === blankId));

    // --- Explicit delete from the list ---
    await app.getState().closeSideChat(closedId);
    await sleep(700);
    await app.getState().deleteSideChat(closedId);
    await sleep(900);
    const s4d = app.getState();
    check('deleting from the list discards it for good',
      !s4d.chats.some((c) => c.id === closedId) && !s4d.sideChats[closedId]);
    check('the main chat survived', s4d.activeId === mainId && s4d.messages.length === mainLenBefore + 1);
    // The unmount-clear in ChatView would, unguarded, empty the main chat's
    // roster the moment a side chat's tab closed.
    check("closing did not clear the main chat's agent roster",
      Array.isArray(window.__agents.getState().runs));
    check('closing did not steal the task dock',
      window.__tasks.getState().chatId !== closedId,
      `chatId=${window.__tasks.getState().chatId}`);

    // --- A side chat belongs to ONE chat ---
    // The confusion this guards against: opening a scratch conversation beside
    // chat A and then finding it standing over chat B in the same project.
    //
    // The second chat is *created here* rather than borrowed from the profile:
    // the delete-cascade check below would otherwise eat one of the seeded
    // chats every run, and this file is checked in beside the profile it drives.
    await app.getState().openSideChat();
    await sleep(900);
    const ownedId = app.getState().sideChatTabs[0];
    const mainCwd = app.getState().chats.find((c) => c.id === mainId)?.cwd;
    const scratch = await window.api.createChat({ cwd: mainCwd });
    // Put it in the store the way `newChat` would, without sending a turn.
    app.setState((st) => ({ chats: [scratch, ...st.chats] }));
    await sleep(300);

    if (ownedId) {
      await app.getState().openChat(scratch.id);
      await sleep(1200);
      const sB = app.getState();
      check('another chat in the SAME project does not show it',
        !sB.sideChatTabs.includes(ownedId),
        `strip=${JSON.stringify(sB.sideChatTabs)}`);
      check('...and it is stashed under the chat it belongs to',
        (sB.sideChatTabsByChat[mainId] ?? []).includes(ownedId),
        JSON.stringify(sB.sideChatTabsByChat));

      // --- The create round trip must not drop the tab onto another chat ---
      const racing = app.getState().openSideChat();
      await app.getState().openChat(mainId);
      await racing;
      await sleep(900);
      const sR = app.getState();
      const raced = (sR.sideChatTabsByChat[scratch.id] ?? [])[0];
      check('a side chat created across a chat switch is stashed, not shown',
        !!raced && !sR.sideChatTabs.includes(raced),
        `stash=${JSON.stringify(sR.sideChatTabsByChat[scratch.id])} strip=${JSON.stringify(sR.sideChatTabs)}`);
      check('returning to its own chat restores it', sR.sideChatTabs.includes(ownedId),
        JSON.stringify(sR.sideChatTabs));

      // --- Deleting the owning chat takes its side chats with it ---
      await app.getState().deleteChat(scratch.id);
      await sleep(1200);
      const sD = app.getState();
      check('deleting a chat deletes the side chats opened beside it',
        !!raced && !sD.sideChats[raced] && !sD.chats.some((c) => c.id === raced) &&
          !(sD.sideChatTabsByChat[scratch.id] ?? []).length,
        `slot=${!!sD.sideChats[raced]} meta=${sD.chats.some((c) => c.id === raced)}`);
      check('the scratch parent is gone too', !sD.chats.some((c) => c.id === scratch.id));

      await app.getState().closeSideChat(ownedId);
      await sleep(500);
    }

    // Leave one open for the screenshot.
    await app.getState().openSideChat();
    await sleep(600);
    const shotId = app.getState().sideChatTabs[0];
    turn(shotId, 'shot-1', 'A side chat runs beside the main conversation, in the same project, and disappears when you close the app.');
    await sleep(1200);

    return { log };
  })();
})()

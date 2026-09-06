# Drafts

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Drafts (`lib/drafts.ts`, `DraftItem`)

Text typed and not sent. `App` renders `<ChatView key={chat.id}>`, so the
composer unmounted on **every** chat switch and took whatever was in the box
with it — silently, with no undo. That is the bug; the home screen was only its
most visible case.

Two shapes, two lifetimes. A **chat draft** is text alone: the chat already
remembers its model, effort and permission mode. A **project draft** is a chat
that was never created, so it carries everything `NewChat` had picked as well —
reopening one that quietly relaunched on a different model than the chip said
when you walked away would be worse than losing it. `NewChat` is keyed by
`selectedCwd` for the same reason `ChatView` is keyed by chat id.

A project draft is deliberately **not** a `ChatMeta`. `chats:create` freezes the
provider/model pair and, for a `new` worktree target, runs `git worktree add` —
a real checkout and branch on disk. A prompt you never sent must leave neither
behind, so a draft stays pre-creation state and becomes a chat at send, where
that work already happens. It also keeps `chats` out of it: that array *is* the
sidebar order and moves only on create/delete/turn-start (`hoistChat`), and a row
that never starts a turn has no defined position in it.

- **The text lives in the composer, not the store.** Typing has to be instant, and
  routing keystrokes through zustand re-renders every subscriber. The store sees a
  400ms-debounced copy plus a flush on unmount — the flush is the write that
  matters, since the unmount *is* the chat switch. Both readers take their draft
  imperatively (`useApp.getState()` in a `useMemo`) rather than subscribing: a
  subscription in `ChatView` would re-render the whole transcript twice a second
  while you type. Keying the component is what makes an imperative read correct.
- **Discarding needs `draftDiscards`.** The sidebar can discard the draft of the
  project you are looking at, and deleting the stored copy alone is undone by the
  very next debounce, because the text is still in the box. The counter is how a
  discard reaches the composer holding it.
- **Only reference-shaped attachments persist.** Images and picked elements carry
  raw base64; `localStorage` throws at its ~5 MB quota and that throw would take
  the *text* of every other draft with it. A path survives a restart, a payload
  doesn't — text is what you can't cheaply retype. Both stay live in memory for
  the session.
- **`updatedAt` tracks the text**, which is what the Drafts section orders on;
  `patchProjectDraft` (a picker moved) deliberately leaves it alone.

The **Drafts** section sits above even Pinned — it is the one section whose
contents exist nowhere else, and there is at most one row per project, so it
costs the pins a row and never a screenful. It is scoped by the project filter
exactly as the pins are, for the same reason: a draft from another project
showing through a filtered sidebar makes the whole list a half-truth.

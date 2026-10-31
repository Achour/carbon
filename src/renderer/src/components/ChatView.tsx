import * as React from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  FileDiff,
  Folder,
  GitBranch,
  X
} from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_SHORT_LABELS, projectRoot } from '@shared/types'
import { CHAT_BLEED } from '@/lib/chatColumn'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { messagesOf, severalChatsShown, useApp } from '@/store'
import { useTaskList } from '@/taskListStore'
import { useAgents } from '@/agentsStore'
import { foldAgentRuns, reconcileAgentRuns, type AgentRunView } from '@shared/agentRuns'
import { Button } from '@/components/ui/button'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Composer } from '@/components/Composer'
import { CodexReviewMenu } from '@/components/CodexReviewDialog'
import { ContextStrip } from '@/components/ContextStrip'
import { TaskDock } from '@/components/TaskDock'
import { CodexGoalBar } from '@/components/CodexGoalBar'
import { StreamingIndicator } from '@/components/messages/Parts'
import { DelegatePrompts, PromptDock } from '@/components/PromptDock'
import { QuoteBar } from '@/components/QuoteBar'
import { TranscriptChat } from '@/components/messages/AgentRows'
import { useDelegates, useTranscript } from '@/components/Transcript'
import { TurnRail } from '@/components/TurnRail'
import { TurnBookmarks, type TurnBookmarksValue } from '@/components/messages/TurnBookmarks'
import { foldTurns, type TurnChoice } from '@/lib/turnFold'
import { bookmarkText, earlierBookmarks, railTurns, reconcileTurns, type RailTurn } from '@/lib/turnRail'
import { isDelivery } from '@shared/delivery'

const NO_PERMISSIONS: never[] = []
const NO_QUEUED: never[] = []

/**
 * Time constant of the pinned follow's glide: each frame closes
 * `1 - e^(-dt/τ)` of the distance to the bottom, so ~95% of any jump is gone
 * in 3τ. Short enough that a streamed line never sits below the fold long
 * enough to read as lag, long enough that a tool card landing doesn't lurch.
 */
const FOLLOW_TAU_MS = 80

/**
 * A terminal chat's CLI pane. Lazy for the reason the right panel's tabs are:
 * xterm is ~410 KB and most chats never draw one — and `preloadHeavyChunks`
 * already fetches this module on idle, so opening one waits on nothing.
 */
const ChatTerminal = React.lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.ChatTerminal }))
)

/**
 * One chat's transcript and composer — a column of a thread. The thread's
 * header, its ⋯ menu and their dialogs belong to `ThreadView`, which draws one
 * of these per chat.
 */
export const ChatView = React.memo(function ChatView({
  chat,
  side = false
}: {
  chat: ChatMeta
  /**
   * A **side chat** — any column but the thread's first. Its transcript lives
   * in a keyed slot rather than the store's bare fields, it never draws as a
   * terminal (only a chat the sidebar can show is one), and it leaves the
   * project strip to the first column, which already names the folder and
   * branch every column shares.
   */
  side?: boolean
}): React.JSX.Element {
  // The CLI draws this chat itself, in a pty, where the transcript and composer
  // would be. Everything else on screen is unchanged — header, ⋯ menu, right
  // panel, sidebar row — because none of it reads messages. A side chat is
  // never one: the flag is only ever set on a chat the sidebar can show.
  const terminalSurface = chat.surface === 'terminal' && !side

  // Read by id: the thread's first chat keeps the store's singular slice, every
  // other column a keyed slot (`messagesOf`). Everything else about a chat is
  // already keyed by id.
  const messages = useApp((s) => messagesOf(s, chat.id))
  // Which chat an agent row belongs to — see `TranscriptChat`. Changes only
  // with the chat, so the memoized rows below are not re-rendered per token.
  const transcriptChat = React.useMemo(
    () => ({ chatId: chat.id, provider: chat.provider }),
    [chat.id, chat.provider]
  )
  const hiddenBefore = useApp((s) =>
    chat.id === s.activeId ? s.hiddenBefore : (s.sideChats[chat.id]?.hiddenBefore ?? 0)
  )
  // With several chats on screen, a composer nobody is writing in folds to its
  // input line — see `Composer`'s `collapsible`.
  const collapsible = useApp(severalChatsShown)
  // The branch's actions act on the thread, whose own chat carries the
  // worktree — this one, unless it is a column expanded in it.
  const threadId = chat.sideOf ?? chat.id
  const loadingOlder = useApp((s) =>
    chat.id === s.activeId ? s.loadingOlder : !!s.sideChats[chat.id]?.loadingOlder
  )
  const loadOlderMessages = useApp((s) => s.loadOlderMessages)
  const status = useApp((s) => s.statuses[chat.id] ?? 'idle')
  // Fall back to a stable constant — a fresh `[]` per render makes zustand's
  // snapshot comparison always fail and loops React into a crash.
  const lockedElsewhere = useApp((s) => !!s.lockedChats[chat.id])
  const permissions = useApp((s) => s.permissions[chat.id] ?? NO_PERMISSIONS)
  const queued = useApp((s) => s.queued[chat.id] ?? NO_QUEUED)
  const removeQueued = useApp((s) => s.removeQueued)
  const sendQueuedNow = useApp((s) => s.sendQueuedNow)
  const git = useApp((s) => s.git)
  const commands = useApp((s) => s.commands)
  const openPlanPanel = useApp((s) => s.openPlanPanel)
  const reviewChanges = useApp((s) => s.reviewChanges)
  const runGitAction = useApp((s) => s.runGitAction)
  const worktreeNotice = useApp((s) =>
    s.worktreeNotice?.chatId === chat.id ? s.worktreeNotice.kind : null
  )
  const dismissWorktreeNotice = useApp((s) => s.dismissWorktreeNotice)
  const sendMessage = useApp((s) => s.sendMessage)
  const startCodexReview = useApp((s) => s.startCodexReview)
  const interrupt = useApp((s) => s.interrupt)
  const setChatOptions = useApp((s) => s.setChatOptions)
  const saveChatDraft = useApp((s) => s.saveChatDraft)
  // Read imperatively, not subscribed: the composer writes a debounced copy back
  // a couple of times a second while you type, and a subscription here would
  // re-render the whole transcript on every one of them. `App` keys this
  // component by chat id, so a mount *is* a chat switch — which is the only
  // moment the draft needs reading.
  const initialDraft = React.useMemo(() => useApp.getState().chatDrafts[chat.id], [chat.id])
  const modelEfforts = useApp((s) => s.defaults?.modelEfforts)
  const modelServiceTiers = useApp((s) => s.defaults?.modelServiceTiers)
  // A cross-provider pick is only armed until the next send; the composer
  // previews its provider (efforts, placeholder, labels) while the chat itself
  // stays on the current backend.
  const composerProvider =
    chat.pendingModel !== undefined ? (chat.pendingProvider ?? chat.provider) : chat.provider
  // Which settled turns are showing their work. A gesture, not a stream: this
  // changes on a click and nowhere else, so subscribing the transcript to it
  // costs nothing between clicks — and it has to be read here rather than in
  // the header, since folding is decided while the node array is built.
  const turnChoices = useApp((s) => s.turnChoices)
  const chooseTurn = useApp((s) => s.chooseTurn)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  /** The scroller's positioned ancestor — what the quote bar is placed inside. */
  const viewRef = React.useRef<HTMLDivElement>(null)
  /** The reading column inside the scroller — what the follow observer measures. */
  const columnRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  /**
   * Distance from the BOTTOM of the scroller, captured just before older
   * messages are prepended. Anchoring on the bottom rather than on scrollTop is
   * what keeps the message under the cursor still: prepending changes
   * scrollHeight, and the gap below the viewport is the part that doesn't move.
   *
   * Set when the fetch starts, as the mark that one is in flight, and
   * **re-read in the render that prepends** (below): the fetch is triggered by
   * scrolling, so the reader is usually still moving when it resolves, and an
   * anchor from the request would snap them back to where they were when it
   * was asked for.
   */
  const bottomAnchor = React.useRef<number | null>(null)
  /**
   * The message at the top of the viewport and where it sat, taken with the
   * render-time snapshot. Preferred over `bottomAnchor` when it survives the
   * commit: a prepend can change content *below* the reader too — a checklist
   * row fills in once its TaskCreate loads — and holding the row being read is
   * what absorbs both.
   */
  const rowAnchor = React.useRef<{ el: Element; top: number } | null>(null)
  const [showJump, setShowJump] = React.useState(false)
  const [reviewOpen, setReviewOpen] = React.useState(false)

  const busy = status !== 'idle'

  /**
   * The follow loop's frame, or 0 when it is parked. One loop at a time: a
   * resize that lands while it runs only has to keep it alive, since every
   * frame re-reads where the bottom is.
   */
  const followFrame = React.useRef(0)
  /** `scrollTop` at the last scroll event — what "moved up" is measured from. */
  const lastTop = React.useRef(0)

  const setPinned = React.useCallback((pinned: boolean): void => {
    if (pinned === pinnedRef.current) return
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }, [])

  /** Snap to the bottom with no animation — a chat switch, a window resize. */
  const jumpToBottom = React.useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    cancelAnimationFrame(followFrame.current)
    followFrame.current = 0
    el.scrollTop = el.scrollHeight
  }, [])

  /**
   * Glide to the bottom, and keep gliding for as long as it keeps moving.
   *
   * Each frame closes a fixed *fraction* of what is left (frame-rate
   * independent, τ = FOLLOW_TAU_MS), so a line of streamed text eases in over a
   * few frames and a tool card that lands 400px tall catches up just as
   * smoothly, instead of the transcript lurching by its height. The position is
   * re-read every frame rather than carried in the loop, so a wheel tick the
   * reader makes in between is never written over — and the loop stops the
   * moment they unpin.
   */
  const followBottom = React.useCallback((): void => {
    if (followFrame.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      jumpToBottom()
      return
    }
    let last = performance.now()
    const step = (now: number): void => {
      const el = scrollRef.current
      if (!el || !pinnedRef.current) {
        followFrame.current = 0
        return
      }
      const dt = Math.min(now - last, 64)
      last = now
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop
      if (gap <= 0.5) {
        followFrame.current = 0
        return
      }
      // At least a pixel a frame, or the tail of the ease crawls through
      // sub-pixel steps the scroller rounds away.
      const move = Math.max(1, gap * (1 - Math.exp(-dt / FOLLOW_TAU_MS)))
      el.scrollTop = Math.min(el.scrollTop + move, el.scrollHeight - el.clientHeight)
      lastTop.current = el.scrollTop
      followFrame.current = requestAnimationFrame(step)
    }
    followFrame.current = requestAnimationFrame(step)
  }, [jumpToBottom])

  React.useEffect(() => () => cancelAnimationFrame(followFrame.current), [])

  /**
   * The pin is the reader's *intent*, not the scroller's position.
   *
   * It used to be recomputed from position on every scroll event — 90px from
   * the bottom or closer — and that included the events the follow itself
   * produced. A scroll event lands a frame after the `scrollTo` that caused it,
   * so when a tool card or a code block mounted in that frame the handler
   * measured the *new* height against the *old* position, read "scrolled away",
   * and the follow was off for the rest of the turn with nobody having touched
   * anything. Now only a move *up* unpins, and only reaching the bottom pins:
   * the follow only ever moves down, so it can never unpin itself, however far
   * behind the column it is when its event lands.
   *
   * "Moved up" is checked before the threshold, or a small nudge up inside it
   * would leave the reader pinned and the next resize would yank them back.
   * The `gap > 2` guard excludes the moves up nobody made: content shrinking
   * under a scroller at the bottom clamps it, and so does Chromium's scroll
   * anchoring when something above collapses — both leave it at the bottom.
   *
   * Fires per scroll event — dozens a second on a wheel — so the state write
   * happens only on a transition (`setPinned`); the pin itself is a ref and free.
   */
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    maybeLoadEarlier()
    const top = el.scrollTop
    const gap = el.scrollHeight - top - el.clientHeight
    if (top < lastTop.current - 1 && gap > 2) setPinned(false)
    else if (gap < 90) setPinned(true)
    lastTop.current = top
  }

  // A wheel tick up is intent before it is a position: the follow can move the
  // scroller further down in the same frame than a small tick moved it up, and
  // then no scroll event ever shows the reader leaving. Only while the column
  // overflows — in a window too short to scroll there is nowhere to leave to,
  // and unpinning there would stop the follow the moment it starts to.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // A tick over a nested scroller that can still take it — a tool's output,
    // a long code block — scrolls that box, not the transcript, so it is not
    // the reader leaving.
    const consumedInside = (target: EventTarget | null): boolean => {
      for (let n = target instanceof Element ? target : null; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) {
          const { overflowY } = getComputedStyle(n)
          if (overflowY === 'auto' || overflowY === 'scroll') return true
        }
      }
      return false
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY >= 0 || el.scrollHeight <= el.clientHeight + 1) return
      if (!consumedInside(e.target)) setPinned(false)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPinned])

  // Follow the stream while the reader is pinned to the bottom.
  //
  // This keys on the column's *height*, not on the store. A store-keyed effect
  // (`[messages, permissions, status]`) was the first version, and it missed
  // most of what actually moves the bottom edge: `useStreamText` reveals words
  // on animation frames *between* deltas, releases the held last word 400ms
  // after the final one with no store change at all, images decode late, a
  // code block's rows land one at a time, and a collapsible animates its height
  // over 200ms. Each of those grew the column under a scroller that was still
  // parked at the previous height, so the reply's last line sat just below the
  // fold — a lag that read as the stream stuttering. A ResizeObserver fires
  // after layout for every one of them and kicks the glide; `pinnedRef` guards
  // it, and `maybeLoadEarlier` only prepends under an unpinned reader (or into
  // a window too short to scroll), so a prepend never snaps the reader down.
  // The scroller itself is observed too, so a window resize while pinned keeps
  // the bottom rather than the top — snapped, since a resize is the reader's
  // own gesture and a glide after it reads as lag.
  React.useEffect(() => {
    const scroller = scrollRef.current
    const column = columnRef.current
    if (!scroller || !column) return
    const observer = new ResizeObserver((entries) => {
      if (!pinnedRef.current) return
      if (entries.some((e) => e.target === scroller)) jumpToBottom()
      else followBottom()
    })
    observer.observe(column)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [followBottom, jumpToBottom])

  // The floating composer's height, as the room the transcript leaves under
  // its last line. Written straight to the view's style rather than through
  // state: it changes on every fold and every dock, and the column's own
  // observer above already keeps a pinned reader on the bottom when it does.
  const composerRef = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const el = composerRef.current
    const view = viewRef.current
    if (!el || !view) return
    const apply = (): void => view.style.setProperty('--composer-h', `${el.offsetHeight}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Jump to the bottom when switching chats.
  React.useEffect(() => {
    pinnedRef.current = true
    // The scroll handler writes state only on a transition, so the pin and
    // the control have to be reset together here rather than by the scroll
    // event that follows.
    setShowJump(false)
    bottomAnchor.current = null
    requestAnimationFrame(() => {
      jumpToBottom()
      lastTop.current = scrollRef.current?.scrollTop ?? 0
    })
  }, [chat.id, jumpToBottom])

  /**
   * Fold or unfold a turn, animated, with the row you clicked held still.
   *
   * **A view transition rather than a height animation**, because there is
   * nothing here whose height could animate: a fold is *omission from a flat
   * keyed array* (see `renderMessages`), so the nodes that leave have no shared
   * parent, and giving them one is precisely what `useHistoryNodes` forbids —
   * every settled row in the turn would remount the moment the turn ended.
   * Chromium snapshots the viewport, so the cost is bounded by what is on
   * screen rather than by the length of the transcript.
   *
   * The scroll correction is not optional and has to run *inside* the
   * transition callback, before the new state is captured. Folding removes
   * height above the answer; without it the transcript slides out from under
   * the pointer by however much work the turn did, which on a long turn throws
   * the reader somewhere else entirely. Anchoring on the header — the thing
   * that was clicked — rather than on the bottom of the scroller is what makes
   * the gesture read as a disclosure: the row stays put and the content below
   * it moves.
   */
  const onToggleTurn = React.useCallback(
    (userMessageId: string, choice: TurnChoice): void => {
      const el = scrollRef.current
      const header = el?.querySelector<HTMLElement>(
        `[data-turn-header="${CSS.escape(userMessageId)}"]`
      )
      const before = header?.getBoundingClientRect().top ?? null
      const apply = (): void => {
        // Synchronous, so the measurement below sees the folded DOM: React
        // would otherwise batch this past the end of the callback and the
        // transition would capture the state it started from.
        flushSync(() => chooseTurn(userMessageId, choice))
        if (el && header && before !== null && header.isConnected) {
          el.scrollTop += header.getBoundingClientRect().top - before
        }
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced || typeof document.startViewTransition !== 'function') {
        apply()
        return
      }
      document.startViewTransition(apply)
    },
    [chooseTurn]
  )

  /**
   * Fetch the next older window once the reader comes within a screen of the
   * top — early enough that a steady scroll up never reaches the edge. There is
   * no control to press: the history simply continues.
   *
   * Two states load. Scrolled up (unpinned) near the top is the ordinary case.
   * A window too short to scroll is the other: it can never produce the scroll
   * that would ask for more, so it fills until it overflows. A pinned reader of
   * a chat that does overflow is left alone, which is what keeps opening a chat
   * from fetching history nobody scrolled towards — the scroller sits at 0 for
   * a frame before `jumpToBottom` moves it.
   *
   * Called from the scroll handler and again whenever a load settles, because a
   * restore that lands near the top fires no scroll of its own if `scrollTop`
   * happens not to change.
   */
  const maybeLoadEarlier = (): void => {
    const el = scrollRef.current
    if (!el || hiddenBefore <= 0 || loadingOlder || bottomAnchor.current !== null) return
    const overflows = el.scrollHeight > el.clientHeight
    const nearTop = el.scrollTop < Math.max(600, el.clientHeight)
    if (overflows ? !pinnedRef.current && nearTop : true) {
      bottomAnchor.current = el.scrollHeight - el.scrollTop
      void loadOlderMessages(chat.id)
    }
  }

  // `getSnapshotBeforeUpdate`, spelled for a function component: the render
  // that carries the prepend runs before its commit touches the DOM, so this is
  // the last moment the old layout can be measured — later than any scroll
  // event, which can trail a wheel tick by a frame. The store's update is
  // synchronous (`useSyncExternalStore`), so no scroll lands in between.
  const lastHidden = React.useRef(hiddenBefore)
  if (lastHidden.current !== hiddenBefore) {
    lastHidden.current = hiddenBefore
    const el = scrollRef.current
    const column = columnRef.current
    if (el && bottomAnchor.current !== null) {
      bottomAnchor.current = el.scrollHeight - el.scrollTop
      const box = el.getBoundingClientRect()
      let row = document.elementFromPoint(box.left + box.width / 2, box.top + 24)
      while (row && row.parentElement !== column) row = row.parentElement
      rowAnchor.current = row ? { el: row, top: row.getBoundingClientRect().top } : null
    }
  }

  // Restore the reading position after a prepend, before the browser paints.
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = bottomAnchor.current
    const row = rowAnchor.current
    rowAnchor.current = null
    if (!el || anchor === null) return
    bottomAnchor.current = null
    if (row?.el.isConnected) el.scrollTop += row.el.getBoundingClientRect().top - row.top
    else el.scrollTop = el.scrollHeight - anchor
  }, [hiddenBefore])

  // A load that came back empty or stale moved no `hiddenBefore`, so the
  // restore above never consumed its anchor; drop it, then look again in case
  // the reader is still at the top (or the window still doesn't fill).
  React.useEffect(() => {
    if (loadingOlder) return
    bottomAnchor.current = null
    maybeLoadEarlier()
  }, [loadingOlder, hiddenBefore, messages.length === 0])

  const openPlan = React.useCallback(
    (plan: string, requestId: string | null) => {
      openPlanPanel({ chatId: chat.id, plan, requestId })
    },
    [openPlanPanel, chat.id]
  )
  const pendingPlanId = permissions.find((r) => r.toolName === 'ExitPlanMode')?.id ?? null
  const reviewPendingPlan = React.useCallback(
    (plan: string) => openPlan(plan, pendingPlanId),
    [openPlan, pendingPlanId]
  )
  const { nodes, showActivity, activityLabel, showActivityLabel, tasks, awaitingWake } = useTranscript({
    chat,
    messages,
    busy,
    permissions,
    turnChoices,
    onToggleTurn,
    onOpenPlan: openPlan
  })

  // Sub-agent runs are folded out of the same window, for the panel and the
  // rail rather than for the transcript — which is why the result goes
  // to `agentsStore` instead of down through props. `reconcileAgentRuns` keeps
  // an unmoved list at its old identity so neither subscriber re-renders on a
  // token that changed nothing about any agent.
  const agentRunsRef = React.useRef<AgentRunView[]>([])
  const agentRuns = React.useMemo(() => {
    const next = reconcileAgentRuns(agentRunsRef.current, foldAgentRuns(messages))
    agentRunsRef.current = next
    return next
  }, [messages])
  const setAgentRuns = useAgents((s) => s.setRuns)
  const clearAgentRuns = useAgents((s) => s.clearRuns)
  React.useEffect(() => {
    setAgentRuns(chat.id, agentRuns)
  }, [chat.id, agentRuns, setAgentRuns])
  // Cleared on unmount, in an effect of its own so it fires *only* then: folded
  // into the publish above it would empty the entry between every two updates
  // and flicker the roster's rows on each one. The store outlives this
  // component — without this, leaving a thread, or closing a column, would
  // leave that chat's agents standing in the rail and the robot menu.
  React.useEffect(() => () => clearAgentRuns(chat.id), [chat.id, clearAgentRuns])

  // Published to its own store so the dock — and only the dock — re-renders
  // when a task moves; see `taskListStore`. Kept out of the history render path,
  // and keyed by chat, because every column of a thread has its own dock.
  const setTasks = useTaskList((s) => s.setTasks)
  const clearTasks = useTaskList((s) => s.clearTasks)
  React.useEffect(() => {
    setTasks(chat.id, tasks)
  }, [chat.id, tasks, setTasks])
  React.useEffect(() => () => clearTasks(chat.id), [chat.id, clearTasks])

  // The turn rail's index of the loaded window. Rebuilt per delta like
  // everything fed from `messages`, and reconciled so only the live turn's
  // tick sees a new object.
  // The rail reads delegates and a due wake the way the transcript does, or
  // its live tick disagrees with the turn header.
  const delegates = useDelegates(chat.id)
  const railRef = React.useRef<RailTurn[]>([])
  const turns = React.useMemo(() => {
    const next = reconcileTurns(railRef.current, railTurns(messages, foldTurns(messages, { continues: isDelivery, delegates }), busy || awaitingWake, isDelivery))
    railRef.current = next
    return next
  }, [messages, busy, awaitingWake, delegates])
  const setChatBookmark = useApp((s) => s.setChatBookmark)
  const marked = React.useMemo(
    () => new Set((chat.bookmarks ?? []).map((b) => b.id)),
    [chat.bookmarks]
  )
  const earlier = React.useMemo(
    () => earlierBookmarks(chat.bookmarks, turns, hiddenBefore),
    [chat.bookmarks, turns, hiddenBefore]
  )
  const toggleBookmark = React.useCallback(
    (messageId: string, prompt: string | null) =>
      void setChatBookmark(chat.id, messageId, prompt === null ? null : bookmarkText(prompt)),
    [setChatBookmark, chat.id]
  )
  const bookmarks = React.useMemo<TurnBookmarksValue>(
    () => ({
      marked,
      toggle: (messageId, prompt) =>
        toggleBookmark(messageId, marked.has(messageId) ? null : prompt)
    }),
    [marked, toggleBookmark]
  )

  /**
   * Go to a turn from the rail: its prompt at the top of the view, with room
   * above it. Unpinned first — a glide toward the bottom still running would
   * otherwise pull the reader straight back down. False when the prompt is not
   * on the page (not loaded yet).
   */
  const navigateToTurn = React.useCallback(
    (id: string): boolean => {
      const el = scrollRef.current
      const target = el?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`)
      if (!el || !target) return false
      setPinned(false)
      cancelAnimationFrame(followFrame.current)
      followFrame.current = 0
      const top =
        target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' })
      return true
    },
    [setPinned]
  )

  /**
   * Load older history from the rail: one window for the "earlier" mark, or
   * window after window until a bookmarked turn is on the page. Each load goes
   * through the same anchor the scroll-triggered one sets, so the reader's
   * place holds while history is prepended above it, and the loop ends the
   * moment a load moves nothing (the start of the chat, or a view that left).
   */
  const revealEarlier = React.useCallback(
    async (id: string | null): Promise<void> => {
      const surface = (): { hidden: number; loading: boolean } => {
        const s = useApp.getState()
        return chat.id === s.activeId
          ? { hidden: s.hiddenBefore, loading: s.loadingOlder }
          : {
              hidden: s.sideChats[chat.id]?.hiddenBefore ?? 0,
              loading: !!s.sideChats[chat.id]?.loadingOlder
            }
      }
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
      for (let i = 0; i < 500; i++) {
        if (id && navigateToTurn(id)) return
        const { hidden, loading } = surface()
        if (hidden <= 0) return
        if (loading) {
          await frame()
          continue
        }
        const el = scrollRef.current
        if (!el) return
        setPinned(false)
        bottomAnchor.current = el.scrollHeight - el.scrollTop
        await loadOlderMessages(chat.id)
        await frame()
        await frame()
        if (surface().hidden === hidden || !id) return
      }
    },
    [chat.id, loadOlderMessages, navigateToTurn, setPinned]
  )

  return (
    <TranscriptChat.Provider value={transcriptChat}>
    <TurnBookmarks.Provider value={bookmarks}>
    <div
      // `data-chat-surface` is the "which chat is this" marker: it is how a
      // permission keypress finds the transcript it happened in (see
      // `PromptDock`). The frosted wash (`data-chatview`) is the thread's, one
      // level up, so the columns share one material.
      data-chat-surface={chat.id}
      className="relative flex h-full min-w-0 flex-1 flex-col"
    >
      {/* userData is shared between the dev and packaged builds on purpose, so
          the same chat can be open twice. The other instance owns the write
          lock; this one still works, it just is not persisting. */}
      {lockedElsewhere && (
        <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-200/90">
          This chat is open in another Carbon instance, which owns it. Changes made here
          are <span className="font-medium">not being saved</span>. Close it there, then reopen this chat.
        </div>
      )}

      {/* What a fresh worktree cannot say for itself. Without these, the agent's
          first "command not found" — or its first look at an empty folder —
          reads as a bug in the project rather than a fact about the checkout. */}
      {worktreeNotice && (
        <div className="flex items-start gap-2 border-b border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {worktreeNotice === 'empty-base' ? (
              <>
                This worktree is empty: a worktree checks out{' '}
                <em>committed</em> work, and nothing in{' '}
                <span className="text-foreground">{basename(chat.worktree?.repoRoot ?? '')}</span>{' '}
                has been committed yet. Commit the project on This Mac first, or let the agent build
                here and merge it back.
              </>
            ) : (
              <>
                This worktree is a fresh checkout with no dependencies installed — the project has
                no <code className="font-mono text-[11px] text-foreground">.karbun/setup.sh</code>.
                Add one (or run your install command in a terminal tab) if the agent needs them.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={dismissWorktreeNotice}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {terminalSurface ? (
        <>
          <React.Suspense fallback={<div className="min-h-0 flex-1" />}>
            <ChatTerminal chat={chat} />
          </React.Suspense>
          {/* The one thing the pane below cannot say for itself. A terminal chat
              has no turn, so it has no TurnChangesCard and no idle moment to
              draw one — this is where "what has changed here" lives, and the
              route to the stacked diff. */}
          <div className="shrink-0 px-4 pt-2">
            <ContextStrip
              cwd={chat.cwd}
              project={projectRoot(chat)}
              git={git}
              onReviewChanges={() => void reviewChanges()}
              onUpdateFromDefault={() => void runGitAction('update-from-main')}
              threadId={threadId}
            />
          </div>
        </>
      ) : (
        <>
      {/* Messages */}
      {/* `scrollbar-gutter: stable` so the column does not step sideways the
          moment a chat grows long enough to scroll — and so the gutter the
          composer reserves below (`--scrollbar-width`) is always the right one. */}
      {/* The jump button is anchored to the scroller, not the view: a fixed
          offset from the view's bottom put it wherever the composer stack
          happened to end — over the context strip, or over the last line of
          the prompt above it once a queued row or a taller composer moved
          the stack. */}
      <div ref={viewRef} className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div ref={columnRef} className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {/* A new column opens on an empty pane, which on its own reads as a
                conversation that failed to load — so it says, in one line,
                what it is and where it runs. */}
            {side && messages.length === 0 && hiddenBefore === 0 && (
              <div className="px-1 py-10 text-center text-xs text-muted-foreground">
                New chat in {basename(chat.cwd)}
              </div>
            )}
            {/* The slot is held for as long as anything is left to load and
                the spinner only fills it, so its appearing never nudges the
                text the reader is on; it goes away in the same commit as the
                last prepend, which the bottom-anchored restore absorbs. */}
            {hiddenBefore > 0 && (
              <div className="-mb-2 flex h-4 items-center text-muted-foreground" aria-live="polite">
                {loadingOlder && <DotSpinner aria-label="Loading earlier messages" />}
              </div>
            )}
            {/* One array, deliberately: written as `{historyNodes}{liveNode}`
                the two are separate children and the array is its own implicit
                fragment, which puts the live node in a different parent again. */}
            {nodes}
            {/* `-mt-2`: the label is a 28px row of its own, so the column's
                full gap on top of it set it a paragraph-and-a-half below the
                step it follows. */}
            {showActivity && (
              <div className="-mt-2 min-h-7">
                <StreamingIndicator label={activityLabel} visible={showActivityLabel} />
              </div>
            )}
            <div className="h-[calc(var(--composer-h,0px)+0.5rem)] shrink-0" />
          </div>
        </div>

        {/* Select a passage in a reply and ask about it. It sits in the
            scroller's frame rather than in the scroller, so it can be placed
            against the passage without scrolling away from it. */}
        <QuoteBar chatId={chat.id} scrollRef={scrollRef} containerRef={viewRef} />

        {/* The conversation's outline, in the view's left gutter. In the view
            rather than the scroller, like the quote bar, so it stays put while
            the transcript moves under it. */}
        <TurnRail
          turns={turns}
          marked={marked}
          earlier={earlier}
          hiddenBefore={hiddenBefore}
          scrollRef={scrollRef}
          onNavigate={navigateToTurn}
          onRevealEarlier={(id) => void revealEarlier(id)}
          onToggleBookmark={toggleBookmark}
        />

        {/* Jump to bottom */}
        {showJump && (
          <div className="pointer-events-none absolute right-0 bottom-[calc(var(--composer-h,0px)+0.75rem)] left-0 z-30 flex justify-center pr-[var(--scrollbar-width)]">
            <Button
              size="icon-sm"
              variant="secondary"
              className="pointer-events-auto rounded-full shadow-lg"
              onClick={() => {
                // Pin first and let the follow carry it: a native smooth
                // scroll freezes its target at the click, so it lands short
                // of a column that is still growing.
                setPinned(true)
                followBottom()
              }}
              aria-label="Scroll to bottom"
            >
              <ArrowDown />
            </Button>
          </div>
        )}

        {/* Composer — floating over the transcript's foot, which scrolls under
            it: `--composer-h` (measured below) is the room the column, the jump
            button and the turn rail leave for it.

            The padding sits *inside* `max-w-3xl`, exactly as it does on the
            transcript above — spelled the other way round it made `max-w-3xl`
            mean the box in one place and the text column in the other, so the
            composer ran 48px wider than the reply it answers. `pr` is the
            scrollbar the scroller reserves and this element does not, without
            which the two columns are centered 6px apart. */}
        <div
          ref={composerRef}
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 z-20 pr-[var(--scrollbar-width)]',
            // Solid only below the frame, and clear from its lower edge up, so
            // the transcript runs under the whole box.
            'bg-[linear-gradient(to_top,var(--background)_0,var(--background)_10px,transparent_20px)] pb-5'
          )}
        >
          <div className="mx-auto max-w-3xl px-6">
            {/* One bleed for the whole stack: the pill rows are framed objects
                like the composer, and they read as one column only while their
                borders share an edge. */}
            <div className={cn(CHAT_BLEED, 'pointer-events-auto')}>
              {queued.length > 0 && (
                <div className="mb-2 space-y-1.5">
                  {queued.map((q) => (
                    <div
                      key={q.id}
                      className="flex animate-enter items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground"
                    >
                      <Clock className="size-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {q.text || q.attachments?.map((a) => a.name).join(', ')}
                      </span>
                      <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
                        queued
                      </span>
                      <button
                        type="button"
                        onClick={() => void sendQueuedNow(chat.id, q.id)}
                        aria-label="Send now"
                        title="Send now — interrupts the current turn"
                        className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ArrowUp className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeQueued(chat.id, q.id)}
                        aria-label="Remove queued message"
                        className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Composer
                // Everything that belongs to the input rides the composer's own
                // box rather than sitting above it, so the stack reads as one
                // object however the border moves.
                //
                // Order is by what is waiting on whom, and the prompts come last
                // because last is *adjacent to the textarea*: the checklist and
                // the goal bar grow and collapse on their own, and above the
                // prompt their movement never pushes the question you have to
                // answer away from the keys that answer it.
                //
                // Every column carries its own: the goal bar, the checklist and
                // the prompts are all keyed by chat id.
                header={
                  <>
                    {chat.provider === 'codex' && (
                      <CodexGoalBar chatId={chat.id} threadId={chat.sessionId} working={busy} />
                    )}
                    <TaskDock chatId={chat.id} />
                    <CodexReviewMenu
                      open={reviewOpen}
                      onOpenChange={setReviewOpen}
                      cwd={chat.cwd}
                      currentBranch={git?.branch}
                      defaultBranch={git?.defaultBranch}
                      onStart={(target) => startCodexReview(chat.id, target)}
                    />
                    <PromptDock
                      chatId={chat.id}
                      provider={chat.provider}
                      requests={permissions}
                      onReviewPlan={reviewPendingPlan}
                    />
                    <DelegatePrompts parentId={chat.id} />
                    </>
                }
                // Returned, not voided: the composer needs the promise so a failed
                // send restores the draft instead of discarding it.
                onSend={(text, attachments) => {
                  if (
                    composerProvider === 'codex' &&
                    text.trim().toLowerCase() === '/review' &&
                    attachments.length === 0
                  ) {
                    setReviewOpen(true)
                    return Promise.resolve()
                  }
                  return sendMessage(chat.id, text, attachments)
                }}
                draft={initialDraft}
                onDraftChange={(next) => saveChatDraft(chat.id, next)}
                collapsible={collapsible}
                floating
                // Only the thread's own chat takes the caret on mount. Every
                // column mounts at once when a thread opens, and each grabbing it
                // left focus — and with it the thread's focused chat — on the
                // last column. A column added or jumped to is handed the caret
                // explicitly (`focusComposer`).
                autoFocus={!side}
                streaming={busy}
                onStop={() => void interrupt(chat.id)}
                // A cross-provider pick is only armed until the next send; the
                // composer previews it (chip, efforts, placeholder) while the chat
                // itself stays on its current backend.
                model={chat.pendingModel ?? chat.model ?? ''}
                onModelChange={(model, modelProvider) =>
                  void setChatOptions(chat.id, { model, modelProvider })
                }
                effort={chat.effort ?? ''}
                onEffortChange={(effort, opts) => void setChatOptions(chat.id, { effort, ...opts })}
                modelEfforts={modelEfforts}
                modelServiceTiers={modelServiceTiers}
                serviceTier={chat.serviceTier ?? 'standard'}
                onServiceTierChange={(serviceTier, opts) =>
                  void setChatOptions(chat.id, { serviceTier, ...opts })
                }
                permissionMode={chat.permissionMode}
                onPermissionModeChange={(permissionMode) =>
                  void setChatOptions(chat.id, { permissionMode })
                }
                contextTokens={chat.contextTokens}
                contextWindow={chat.contextWindow}
                provider={composerProvider}
                chatId={chat.id}
                cwd={chat.cwd}
                commands={commands}
                // Busy-gated so a note left behind by a crash can never stick.
                switchingNote={busy ? chat.switchingNote : undefined}
                placeholder={
                  composerProvider === 'claude'
                    ? undefined
                    : `Ask ${PROVIDER_SHORT_LABELS[composerProvider]} anything…`
                }
              />
            </div>
          </div>
        </div>
      </div>
        </>
      )}

    </div>
    </TurnBookmarks.Provider>
    </TranscriptChat.Provider>
  )
})

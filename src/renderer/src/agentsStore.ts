import { create } from 'zustand'
import { agentTotals, type AgentRunView, type AgentTotals } from '@shared/agentRuns'
import { omit } from '@/lib/utils'

/**
 * Sub-agent runs of the chats on screen, kept deliberately OUTSIDE the message-history
 * render path — the same arrangement, for the same reason, as `taskListStore`.
 *
 * Agent vitals churn harder than anything else in a turn: a token total lands
 * per API call, per agent, and three agents working at once push several updates
 * a second. The Agents panel and the activity bar want every one of them; the
 * transcript wants none — so the fold is published here and those two subscribe,
 * rather than being threaded through props across the cached history nodes,
 * where it would re-render every row in the conversation on each tick.
 *
 * It holds the runs of every chat on screen, keyed by chat id. A thread draws
 * up to four transcripts side by side, each with its own activity bar, so a
 * single slot would have the bars trade rosters as each column streamed — the
 * reason the side variant used to publish nothing at all. Each `ChatView`
 * publishes its own entry and removes it on unmount.
 */
interface ChatAgents {
  runs: AgentRunView[]
  totals: AgentTotals
}

interface AgentsStore {
  byChat: Record<string, ChatAgents>
  setRuns: (chatId: string, runs: AgentRunView[]) => void
  clearRuns: (chatId: string) => void
  /**
   * The chat whose roster the panel is showing. A thread has one panel and up
   * to four rosters, so the panel has to be told which one — set by whatever
   * opened it (a card, an activity bar, a background job), and resolved against
   * the focused chat when it names nothing with runs (`rosterChat`).
   */
  chatId: string | null
  /**
   * The run the panel is reading, or null for the roster.
   *
   * An agent's stream used to unfold *inside* its transcript card, which is
   * where it could not go: the card's body is the agent's whole conversation —
   * narration, tables, a report — and one of them measured 13,816px in a chat
   * column with four siblings doing the same thing. So the card became the way
   * *in* and this is where the work is read, master-detail inside the panel
   * that already holds the roster.
   *
   * Nothing keeps it in step with `runs`. A chat switch, an eviction or a
   * window that no longer reaches back that far leaves this naming a run the
   * panel cannot find, and `findAgentPart` answering nothing *is* the rule:
   * the panel falls back to the roster.
   */
  selectedId: string | null
  /** Point the panel at `chatId`'s roster, reading `id`'s stream when one is named. */
  selectAgent: (id: string | null, chatId?: string | null) => void
}

const EMPTY_TOTALS: AgentTotals = { running: 0, total: 0, tokens: 0 }
export const NO_AGENTS: ChatAgents = { runs: [], totals: EMPTY_TOTALS }

/**
 * The chat the Agents panel shows: the one it was pointed at while that chat
 * still has runs, else the focused chat, else the first chat on screen that has
 * any. Returns a primitive, so it is safe as a selector.
 */
export function rosterChat(s: Pick<AgentsStore, 'byChat' | 'chatId'>, focused: string | null): string | null {
  const has = (id: string | null): id is string => !!id && (s.byChat[id]?.runs.length ?? 0) > 0
  if (has(s.chatId)) return s.chatId
  if (has(focused)) return focused
  for (const id of Object.keys(s.byChat)) if (has(id)) return id
  return s.chatId ?? focused
}

/** Some chat on screen has spawned an agent — the Agents tab exists. */
export function anyRuns(s: Pick<AgentsStore, 'byChat'>): boolean {
  for (const id in s.byChat) if (s.byChat[id].runs.length > 0) return true
  return false
}

/** Some chat on screen has an agent working. */
export function anyRunning(s: Pick<AgentsStore, 'byChat'>): boolean {
  for (const id in s.byChat) if (s.byChat[id].totals.running > 0) return true
  return false
}

/** The chat whose runs include `runId`, if any chat on screen has it. */
export function chatOfRun(s: Pick<AgentsStore, 'byChat'>, runId: string): string | null {
  for (const [id, entry] of Object.entries(s.byChat)) {
    if (entry.runs.some((r) => r.id === runId)) return id
  }
  return null
}

export const useAgents = create<AgentsStore>((set) => ({
  byChat: {},
  setRuns: (chatId, runs) =>
    set((s) => {
      const prev = s.byChat[chatId]
      if (prev?.runs === runs) return s
      if (runs.length === 0 && (!prev || prev.runs.length === 0)) return s
      return { byChat: { ...s.byChat, [chatId]: { runs, totals: agentTotals(runs) } } }
    }),
  clearRuns: (chatId) => set((s) => (chatId in s.byChat ? { byChat: omit(s.byChat, [chatId]) } : s)),
  chatId: null,
  selectedId: null,
  selectAgent: (id, chatId) =>
    set((s) => {
      const nextChat = chatId === undefined ? s.chatId : chatId
      return s.selectedId === id && s.chatId === nextChat ? s : { selectedId: id, chatId: nextChat }
    })
}))

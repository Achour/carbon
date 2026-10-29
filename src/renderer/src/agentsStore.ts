import { create } from 'zustand'
import { agentTotals, type AgentRunView, type AgentTotals } from '@shared/agentRuns'
import { omit } from '@/lib/utils'

/**
 * Sub-agent runs of the chats on screen, kept deliberately OUTSIDE the message-history
 * render path — the same arrangement, for the same reason, as `taskListStore`.
 *
 * Agent vitals churn harder than anything else in a turn: a token total lands
 * per API call, per agent, and three agents working at once push several updates
 * a second. The session rail and the robot menu want every one of them; the
 * transcript wants none — so the fold is published here and those subscribe,
 * rather than being threaded through props across the cached history nodes,
 * where it would re-render every row in the conversation on each tick.
 *
 * It holds the runs of every chat on screen, keyed by chat id. A thread draws
 * up to four transcripts side by side, each publishing its own runs, so a
 * single slot would have the columns trade rosters as each one streamed — the
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
}

const EMPTY_TOTALS: AgentTotals = { running: 0, total: 0, tokens: 0 }
export const NO_AGENTS: ChatAgents = { runs: [], totals: EMPTY_TOTALS }

export const useAgents = create<AgentsStore>((set) => ({
  byChat: {},
  setRuns: (chatId, runs) =>
    set((s) => {
      const prev = s.byChat[chatId]
      if (prev?.runs === runs) return s
      if (runs.length === 0 && (!prev || prev.runs.length === 0)) return s
      return { byChat: { ...s.byChat, [chatId]: { runs, totals: agentTotals(runs) } } }
    }),
  clearRuns: (chatId) => set((s) => (chatId in s.byChat ? { byChat: omit(s.byChat, [chatId]) } : s))
}))

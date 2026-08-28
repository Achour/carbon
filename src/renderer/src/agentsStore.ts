import { create } from 'zustand'
import { agentTotals, type AgentRunView, type AgentTotals } from '@shared/agentRuns'

/**
 * The active chat's sub-agent runs, kept deliberately OUTSIDE the message-history
 * render path — the same arrangement, for the same reason, as `taskListStore`.
 *
 * Agent vitals churn harder than anything else in a turn: a token total lands
 * per API call, per agent, and three agents working at once push several updates
 * a second. The Agents panel and the activity bar want every one of them; the
 * transcript wants none — so the fold is published here and those two subscribe,
 * rather than being threaded through props across the `MessageHistory` memo
 * boundary where it would re-render every row in the conversation on each tick.
 *
 * It holds one chat's runs (the active one), because that is the only chat whose
 * messages the renderer has. Switching chats republishes.
 */
interface AgentsStore {
  runs: AgentRunView[]
  totals: AgentTotals
  setRuns: (runs: AgentRunView[]) => void
  /**
   * The run a panel click just asked to see, and a counter beside it.
   *
   * Scrolling the transcript to an agent's card is only half the answer — the
   * card is collapsed, so the reader arrives at a header. The card opens itself
   * when this names it. The counter is what makes a *second* click on the same
   * row work: the id alone has not changed, so nothing would re-fire after the
   * user collapsed the card again.
   */
  focusId: string | null
  focusTick: number
  focusAgent: (id: string) => void
}

const EMPTY_TOTALS: AgentTotals = { running: 0, total: 0, tokens: 0 }

export const useAgents = create<AgentsStore>((set) => ({
  runs: [],
  totals: EMPTY_TOTALS,
  // A chat with no agents publishes the same empty array on every message, so
  // the no-op guard is the common case rather than an optimization for a rare
  // one: without it every streamed token would notify the panel's subscribers.
  setRuns: (runs) =>
    set((s) => {
      if (s.runs === runs || (s.runs.length === 0 && runs.length === 0)) return s
      return { runs, totals: agentTotals(runs) }
    }),
  focusId: null,
  focusTick: 0,
  focusAgent: (id) => set((s) => ({ focusId: id, focusTick: s.focusTick + 1 }))
}))

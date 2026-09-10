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
 * rather than being threaded through props across the cached history nodes,
 * where it would re-render every row in the conversation on each tick.
 *
 * It holds one chat's runs (the active one), because that is the only chat whose
 * messages the renderer has. Switching chats republishes.
 */
interface AgentsStore {
  runs: AgentRunView[]
  totals: AgentTotals
  setRuns: (runs: AgentRunView[]) => void
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
  selectAgent: (id: string | null) => void
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
  selectedId: null,
  selectAgent: (id) => set((s) => (s.selectedId === id ? s : { selectedId: id }))
}))

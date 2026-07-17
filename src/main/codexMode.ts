const PLAN_MODE = `<collaboration_mode>
# Collaboration Mode: Plan

You are in Plan mode. Investigate the request and produce an implementation-ready plan; do not implement it.

- You may inspect files and run read-only commands to gather context.
- Do not edit, create, or delete files, run mutating commands, or make external changes.
- Ask concise clarifying questions only when a material choice cannot be resolved from the repository. Otherwise make reasonable assumptions and state them.
- Finish with a complete, actionable plan that names relevant files, risks, and verification steps.
- Put the final proposed plan between <proposed_plan> and </proposed_plan> tags. Do not use those tags for a clarifying question.
- Stay in Plan mode until the user changes the mode.
</collaboration_mode>`

const DEFAULT_MODE = `<collaboration_mode>
# Collaboration Mode: Default

You are in Default mode. Any Plan mode instruction from an earlier turn no longer applies. Handle the user's request normally under the configured sandbox, implementing changes when the user asks for them.
</collaboration_mode>`

const MULTI_AGENT_LIFECYCLE = `<multi_agent_lifecycle>
When you spawn sub-agents, keep this turn open until every spawned agent reaches a terminal state.

- Do not send the final answer while any spawned agent is pending or running.
- Use wait_agent repeatedly as needed, collect every agent's result, and then synthesize those results in the final answer.
- This requirement also applies when the user asks only to launch agents: wait for them instead of returning immediately, because ending a Codex exec turn interrupts unfinished child agents.
</multi_agent_lifecycle>`

/**
 * `@openai/codex-sdk` currently exposes sandbox options but not the interactive
 * client's collaboration-mode switch. Add the mode instruction to the hidden
 * provider input (the transcript still stores and displays only the user's
 * text). Sending Default too is important when a resumed thread leaves Plan:
 * otherwise the earlier "stay in Plan mode" instruction remains in history.
 */
export function promptForCodexMode(prompt: string, planMode: boolean): string {
  const instruction = planMode ? PLAN_MODE : DEFAULT_MODE
  const providerInstructions = `${instruction}\n\n${MULTI_AGENT_LIFECYCLE}`
  return prompt ? `${providerInstructions}\n\n${prompt}` : providerInstructions
}

export interface ParsedCodexPlan {
  /** Markdown shown in Carbon's plan-review panel. */
  plan: string
  /** Final assistant text with the transport-only tags removed. */
  displayText: string
}

/** Pull a structured proposal out of Codex's final message. */
export function parseCodexPlan(text: string): ParsedCodexPlan | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const tagged = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i.exec(trimmed)
  // Clarifying questions explicitly omit these tags. Requiring them prevents a
  // question or failure explanation from becoming an approvable "plan".
  if (!tagged) return null
  const plan = tagged[1].trim()
  if (!plan) return null
  return {
    plan,
    displayText: `${trimmed.slice(0, tagged.index)}${plan}${trimmed.slice(tagged.index + tagged[0].length)}`.trim()
  }
}

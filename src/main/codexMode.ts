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

/**
 * `@openai/codex-sdk` currently exposes sandbox options but not the interactive
 * client's collaboration-mode switch. Add the mode instruction to the hidden
 * provider input (the transcript still stores and displays only the user's
 * text). Sending Default too is important when a resumed thread leaves Plan:
 * otherwise the earlier "stay in Plan mode" instruction remains in history.
 */
export function promptForCodexMode(prompt: string, planMode: boolean): string {
  const instruction = planMode ? PLAN_MODE : DEFAULT_MODE
  return prompt ? `${instruction}\n\n${prompt}` : instruction
}

export interface ParsedCodexPlan {
  /** Markdown shown in Karbun's plan-review panel. */
  plan: string
  /** Final assistant text with the transport-only tags removed. */
  displayText: string
}

/**
 * Pull the structured proposal out of Codex's final message. The whole message
 * is a deliberate fallback for models that omit the tags: a completed Plan-mode
 * turn should still reach review instead of silently becoming ordinary prose.
 */
export function parseCodexPlan(text: string): ParsedCodexPlan | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const tagged = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i.exec(trimmed)
  if (!tagged) return { plan: trimmed, displayText: trimmed }
  const plan = tagged[1].trim()
  if (!plan) return null
  return {
    plan,
    displayText: `${trimmed.slice(0, tagged.index)}${plan}${trimmed.slice(tagged.index + tagged[0].length)}`.trim()
  }
}

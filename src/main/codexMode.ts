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

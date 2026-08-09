/**
 * The two prompts that carry a plan review's outcome back into the conversation.
 *
 * Deliberately copied in shape from Codex's rather than imported from it: the
 * two provider modules are peers with no dependency between them, and the wording
 * is the kind of thing that gets tuned per backend. Kept here, pure, so the exact
 * strings are pinned by a test.
 */

/** Approval: leave plan mode and build it. */
export function buildApprovedPlanPrompt(plan: string): string {
  return `The user approved the following plan. Implement it completely now.\n\n<approved_plan>\n${plan}\n</approved_plan>`
}

/**
 * Rejection with notes: stay in plan mode and propose again.
 *
 * The previous plan rides along because the revision turn runs on the same
 * session but the feedback only makes sense against what it is feedback *on*.
 */
export function buildPlanFeedbackPrompt(plan: string, feedback: string): string {
  const notes = feedback.trim() || 'Revise the plan and propose it again.'
  return `The user requested changes to the proposed plan. Stay in plan mode and produce a revised proposal.\n\n<previous_plan>\n${plan}\n</previous_plan>\n\n<plan_feedback>\n${notes}\n</plan_feedback>`
}

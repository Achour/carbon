import type { CanvasRef, SelectionRef } from '@shared/types'

/**
 * A fence long enough to survive the snippet's own backticks.
 *
 * Source files contain fenced blocks — every CLAUDE.md, every README, every
 * docstring with an example — and a three-backtick fence around one of them
 * ends at *their* first fence, spilling the rest of the selection into the
 * prompt as prose. CommonMark's rule is that a fence is closed only by a run at
 * least as long, so outrunning the longest run inside is the fix.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Lines picked in the file viewer, as prompt text.
 *
 * Both halves are load-bearing: the fenced snippet is what lets the model
 * answer "what does this do" without a Read call, and the `path:start-end`
 * heading is what it edits against once the answer is "change it" — a snippet
 * with no address is unactionable, and an address whose lines have since moved
 * is worse than none.
 */
export function describeSelection(sel: SelectionRef): string {
  const where = sel.rel || sel.path
  const range =
    sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}-${sel.endLine}`
  const note = sel.truncated ? ', truncated — read the file for the rest' : ''
  const fence = fenceFor(sel.text)
  return [
    `Selected code from ${where} (${range}${note}):`,
    `${fence}${sel.language ?? ''}`,
    sel.text,
    fence
  ].join('\n')
}

/**
 * A canvas attached to a prompt, as prompt text.
 *
 * Shared by all three providers for the reason `describeSelection` is: the
 * three adapters build their prompts in three different places, and a canvas
 * that read one way on Claude and another on Grok would be exactly the silent
 * provider asymmetry this codebase keeps ruling out.
 *
 * The id sentence is the load-bearing half. Every provider has the same
 * `canvas` MCP server, so naming the id makes "add a column to that" a
 * *revision* of this document on all three — without it the model has no handle
 * and writes a second canvas with the same title, which is the failure the
 * `write` tool's own result text already guards against.
 */
export function describeCanvas(ref: CanvasRef): string {
  const fence = fenceFor(ref.text)
  const note = ref.truncated
    ? ' — truncated; call the canvas `read` tool with this id for the rest'
    : ''
  return [
    `Attached canvas "${ref.title}" (id: ${ref.id}${note}).`,
    'It is a saved HTML document shown beside this chat, not a file in the project.',
    'Its readable content follows. To revise it, call the canvas `read` tool with' +
      ` id ${ref.id} for the full HTML, then \`write\` with the same id.`,
    `${fence}`,
    ref.text,
    fence
  ].join('\n')
}

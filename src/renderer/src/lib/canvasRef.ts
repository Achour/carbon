/**
 * Recognizing a canvas write across the three providers.
 *
 * All three call the same MCP tool, and two of them say so. **Grok defers MCP
 * tools behind its own `use_tool`**, so the call arrives wrapped: the card is
 * named `use_tool`, the real tool name and arguments sit in the input, and the
 * result text is empty. A renderer matching on `mcp__canvas__write` alone
 * therefore drew a Grok canvas as an unnamed `use_tool` row with no way into the
 * document it had just written — the provider asymmetry that has no symptom
 * until someone looks.
 *
 * Dependency-free so `node --test` runs `test/canvasRef.test.ts` against the
 * `.ts` directly.
 */

/** Just enough of `ToolPart` to recognize the call. */
export interface CanvasCallLike {
  name: string
  input?: unknown
  output?: string
}

/** A canvas the turn wrote: its id when the provider kept one, and its title. */
export interface CanvasRef {
  id?: string
  title?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** The id shape both result scrapes anchor on. */
const CANVAS_ID = '[0-9a-fA-F-]{36}'

/**
 * The `(id: …)` a canvas write answers with.
 *
 * Scraped out of the result prose rather than read off a field, which is
 * `Artifact`'s trick in the same file: the tool answers in a sentence, so this
 * is written to yield nothing rather than to trust a shape.
 */
export function canvasIdFromOutput(output: string | undefined): string | undefined {
  return new RegExp(`\\(id: (${CANVAS_ID})\\)`).exec(output ?? '')?.[1]
}

/**
 * The title a canvas mutation answers with.
 *
 * `write` is told its title by the model, so it needs no scrape; `edit` is
 * not — the whole point of that tool is that it does not re-send the document
 * or its metadata — so the result prose is the only place the title appears.
 * Read out of the same sentence as the id, off the same id pattern, so the two
 * cannot stop agreeing about what a result looks like.
 */
export function canvasTitleFromOutput(output: string | undefined): string | undefined {
  return new RegExp(`canvas "([^"]*)" \\(id: ${CANVAS_ID}\\)`).exec(output ?? '')?.[1] || undefined
}

/**
 * The calls that produce a canvas — an edit is as much a way in as a write.
 * One list, so the direct names and Grok's namespaced spellings cannot come to
 * disagree about which verbs count.
 */
const CANVAS_VERBS = ['write', 'edit'] as const
const CANVAS_MUTATORS = new Set(CANVAS_VERBS.map((verb) => `mcp__canvas__${verb}`))
const GROK_MUTATOR = new RegExp(`canvas__(?:${CANVAS_VERBS.join('|')})$`)

/** The canvas a call wrote, or null if it is not a canvas mutation at all. */
export function canvasWrite(part: CanvasCallLike): CanvasRef | null {
  const input = record(part.input)
  // Grok defers MCP tools behind `use_tool`: the real name and arguments sit in
  // the input. A suffix match rather than equality because the CLI namespaces
  // the tool (`canvas__write`) and has spelled it more than one way.
  const wrapped = part.name === 'use_tool' && GROK_MUTATOR.test(String(input.tool_name ?? ''))
  if (!wrapped && !CANVAS_MUTATORS.has(part.name)) return null
  const args = wrapped ? record(input.tool_input) : input
  return {
    // An edit always names its canvas in its input, so the row has somewhere to
    // go while the call is still running; a create only learns the id from the
    // result, which is why the scrape stays the fallback rather than the other
    // way round.
    id: str(args.id) ?? canvasIdFromOutput(part.output),
    title: str(args.title) ?? canvasTitleFromOutput(part.output)
  }
}

/** The first canvas a run wrote, so a collapsed group still has a way in. */
export function canvasInRun(parts: CanvasCallLike[]): CanvasRef | null {
  for (const part of parts) {
    const written = canvasWrite(part)
    if (written) return written
  }
  return null
}

/**
 * The id to open, given what the call left behind and the project's own list.
 *
 * The id is exact when the provider kept it; a Grok call leaves only a title,
 * and the list is newest-first, so two canvases sharing one resolve to the one
 * just written.
 */
export function resolveCanvasId(
  ref: CanvasRef,
  canvases: readonly { id: string; title: string }[]
): string | undefined {
  if (ref.id) return ref.id
  if (!ref.title) return undefined
  return canvases.find((c) => c.title === ref.title)?.id
}

/**
 * The name to show for a canvas a call names only by id.
 *
 * `resolveCanvasId`'s mirror, and here for the same reason: recognizing and
 * resolving are this module's job, and it is the half `node --test` can reach.
 * An edit carries an id and no title, so without this the row reads a bare
 * "Open canvas" for as long as the call runs.
 */
export function resolveCanvasTitle(
  ref: CanvasRef,
  canvases: readonly { id: string; title: string }[]
): string | undefined {
  if (ref.title) return ref.title
  if (!ref.id) return undefined
  return canvases.find((c) => c.id === ref.id)?.title
}

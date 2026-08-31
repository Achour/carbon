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

/**
 * The `(id: …)` a canvas write answers with.
 *
 * Scraped out of the result prose rather than read off a field, which is
 * `Artifact`'s trick in the same file: the tool answers in a sentence, so this
 * is written to yield nothing rather than to trust a shape.
 */
export function canvasIdFromOutput(output: string | undefined): string | undefined {
  return /\(id: ([0-9a-fA-F-]{36})\)/.exec(output ?? '')?.[1]
}

/** The canvas a call wrote, or null if it is not a canvas write at all. */
export function canvasWrite(part: CanvasCallLike): CanvasRef | null {
  const input = record(part.input)
  if (part.name === 'mcp__canvas__write') {
    return { id: canvasIdFromOutput(part.output), title: str(input.title) }
  }
  // Grok's wrapper. The suffix match rather than equality because the CLI
  // namespaces the tool (`canvas__write`) and has spelled it more than one way.
  if (part.name === 'use_tool' && /canvas__write$/.test(String(input.tool_name ?? ''))) {
    const args = record(input.tool_input)
    return { id: str(args.id) ?? canvasIdFromOutput(part.output), title: str(args.title) }
  }
  return null
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

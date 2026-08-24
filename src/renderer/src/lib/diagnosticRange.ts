/**
 * Where to draw a *zero-length* diagnostic — the shape Lezer uses for a token
 * it expected and did not find.
 *
 * A zero-width range renders no squiggle at all, so it has to be widened onto a
 * real character, and it must stay on its own line: borrowing the newline that
 * ends the line puts the mark on the line below and underlines nothing visible
 * anyway. Returns null for an empty line, which genuinely has nothing to draw
 * under — the diagnostic is still counted and still listed in the panel with
 * its line number.
 *
 * Dependency-free on purpose (`test/diagnosticRange.test.ts` runs this `.ts`
 * directly under `node --test`), which is also why it takes line bounds as
 * numbers: the caller reads them with `doc.lineAt`, O(log n) on CodeMirror's
 * rope, rather than this reaching for the document as a string.
 */
export function widenPoint(
  pos: number,
  lineFrom: number,
  lineTo: number
): { from: number; to: number } | null {
  if (lineTo === lineFrom) return null
  return pos < lineTo ? { from: pos, to: pos + 1 } : { from: pos - 1, to: pos }
}

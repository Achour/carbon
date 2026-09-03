/**
 * Canonical form used to compare a parsed Markdown href with a raw inline-image
 * destination. React Markdown may hand the former to us URI-encoded even when
 * the source used an angle-bracket destination containing spaces.
 */
export function normalizeMarkdownImageTarget(value: string): string {
  const target = value.trim()
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/**
 * Local image links are normally upgraded to inline images by `Markdown`. When
 * the response already has `![alt](same-path)`, remember that destination so a
 * following ordinary file link stays a link instead of drawing a second copy.
 *
 * This intentionally covers inline image syntax only. Reference definitions
 * already take the whole-document parse path and are uncommon in generated
 * local-file responses; treating arbitrary code-looking text as a definition
 * here would create more false positives than it prevents.
 */
export function explicitMarkdownImageTargets(text: string): ReadonlySet<string> {
  const targets = new Set<string>()
  const image = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g
  for (const match of text.matchAll(image)) {
    const target = match[1] ?? match[2]
    if (target) targets.add(normalizeMarkdownImageTarget(target))
  }
  return targets
}

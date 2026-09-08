/**
 * A Markdown link destination that names a file in the project, or null.
 *
 * Claude names a file in inline code (`counter.ts`), which `InlineCode` in
 * `Markdown.tsx` already resolves and opens. **Codex names it as a link** —
 * `[counter.ts](/Users/me/orbit/counter.ts:1)`, an absolute path with a
 * `:line` suffix — and an ordinary link is exactly what it became: an
 * `<a target="_blank">`, handed to Electron's window-open handler, which
 * ignores anything that isn't `http(s)`. So the same reference the user can
 * click under Claude was a dead one under Codex.
 *
 * This is the one place that turns such a destination back into a path. The
 * remaining resolution — does this file exist, is a bare basename unique in
 * the project — is shared with the inline-code path and stays in the component.
 */

/** A real URL scheme (`https:`, `mailto:`, `vscode:`) — someone else's link. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** Editor-style `:line` / `:line:col` suffix, the way every CLI cites one. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/
/** The last segment carries an extension — the same bar inline code sets. */
const NAMES_A_FILE = /(^|\/)[^/]+\.[A-Za-z0-9]{1,8}$/

/**
 * A destination React Markdown's own sanitizer would blank, and shouldn't.
 *
 * `defaultUrlTransform` reads everything before the first colon as a scheme
 * unless a `/`, `?` or `#` comes first — so `src/a.ts:12` survives and a
 * root-level `counter.ts:12` is replaced with `''` before any renderer sees it.
 * This is the *only* shape added back: a filename with an extension and a line
 * number, no slash. No unknown scheme is ever let through — `javascript:alert`
 * carries no `.ext` before its colon and no digits after it.
 */
const BARE_FILE_LINE = /^[\w.@$-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?$/

export function isBareFileLineRef(url: string): boolean {
  return BARE_FILE_LINE.test(url.trim())
}

export function fileLinkPath(href: string): string | null {
  let value = href.trim()
  if (!value || value.startsWith('#')) return null
  if (/^file:\/\//i.test(value)) {
    value = value.slice('file://'.length)
    // `file://host/path` names another machine; only `file:///path` is local.
    if (!value.startsWith('/')) return null
  }
  // The suffix comes off *before* the scheme test, because a bare
  // `counter.ts:1` otherwise reads as the scheme `counter.ts`.
  const path = value.replace(LINE_SUFFIX, '')
  if (SCHEME.test(path)) return null
  // `mdast-util-to-hast` normalizes every href, so a path with a space arrives
  // percent-encoded.
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Not valid encoding — take the destination as written.
  }
  const clean = decoded.replace(/^\.\//, '')
  if (!clean || !NAMES_A_FILE.test(clean)) return null
  return clean
}

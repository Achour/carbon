/**
 * Repository-name rules for the publish dialog. Pure & dependency-free (no `@`
 * aliases) so `node --test` can run it directly, the same arrangement
 * `codeSelection.ts` and `drafts.ts` keep.
 */

/**
 * Coerce typed text into a name GitHub will accept: letters, digits, `.`, `-`
 * and `_`. Applied as you type rather than validated on submit, because the
 * alternative is learning the rules from a 422 after the dialog has already
 * committed your files — the failure would land *after* the local half of a
 * publish, which is the one ordering `publishRepo` is built to avoid.
 *
 * A leading dot is deliberately kept (`.github` is a real repository name); a
 * name of nothing but dots is not, since GitHub rejects `.` and `..` outright.
 * `.git` is stripped from the end for the same reason — GitHub refuses it, and
 * a folder called `thing.git` is otherwise a dead end with no explanation.
 */
export function sanitizeRepoName(name: string): string {
  const out = name
    .trim()
    .replace(/\s+/g, '-')
    // Everything GitHub disallows collapses to the separator it does allow.
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 100)
    .replace(/\.git$/i, '')
  return /^\.+$/.test(out) ? '' : out
}

/**
 * The folder's own name, as the suggested repository name.
 *
 * This one *does* trim a trailing separator that sanitizing leaves behind
 * (`my app (v2)` → `my-app-v2`), which `sanitizeRepoName` deliberately does
 * not: it runs on every keystroke, and eating the dash the moment you type it
 * makes a hyphenated name impossible to type. A suggestion is written once and
 * has no such problem.
 */
export function defaultRepoName(path: string): string {
  // Not `@/lib/format`'s basename: this file stays import-free so it is testable
  // without a bundler. Trailing separators are stripped first so a path handed
  // over as `/a/b/` still answers `b`.
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return sanitizeRepoName(parts[parts.length - 1] ?? '').replace(/[-.]+$/, '')
}

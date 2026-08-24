/**
 * Branch naming, shared by main (which creates the branch) and the renderer
 * (which shows you the name before you commit to it). It lives here rather than
 * in `worktree.ts` because those two have to agree exactly: a picker that
 * previews `Fix login` while git makes `fix-login` is showing you a name that
 * won't exist, and the draft would persist the un-coerced one.
 *
 * Dependency-free, so `node --test` runs it directly (`test/worktree.test.ts`).
 */

/**
 * Coerce a user-supplied name into something `git branch` accepts: no spaces,
 * no ref-illegal characters, no leading/trailing punctuation. Returns '' when
 * nothing usable survives, so callers can fall back to a generated name.
 */
export function sanitizeBranch(name: string): string {
  return name
    .toLowerCase()
    // Also collapses leading/trailing whitespace into dashes the final trim strips.
    .replace(/[\s_]+/g, '-')
    // Anything git refuses in a ref name, plus the shell-hostile set.
    .replace(/[~^:?*[\]\\@{}!'"`$()<>|;&#]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    // Trimmed after the slice — slicing can itself expose a trailing separator.
    .replace(/^[-./]+|[-./]+$/g, '')
}

const B36 = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** The dated stem every generated name shares, e.g. `karbun/jul19`. */
function stem(now: Date): string {
  return `karbun/${MONTHS[now.getMonth()]}${now.getDate()}`
}

/** Auto branch name, e.g. `karbun/jul19-k3xq`. Deterministic under injection. */
export function defaultBranchName(now: Date = new Date(), rand: () => number = Math.random): string {
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += B36[Math.floor(rand() * B36.length)] ?? '0'
  return `${stem(now)}-${suffix}`
}

/**
 * What the picker shows for "name it for me". The random half is elided rather
 * than rolled here: main generates the real one at creation, and a preview that
 * named a specific branch would be a promise the retry-on-collision path can't
 * keep.
 */
export function generatedBranchHint(now: Date = new Date()): string {
  return `${stem(now)}-…`
}

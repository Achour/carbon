/**
 * The one color per git status letter, shared by the review panel's status
 * column and the file tree's decoration. Two definitions would drift, and a
 * file that is amber in one list and green in the other is worse than no color
 * at all — the point of the tint is that it means the same thing everywhere.
 *
 * Fixed palette hues rather than theme tokens: `--warning` / `--success` mean
 * *state* and are already spoken for by the composer and the git header, and
 * these five need to stay told apart from each other rather than match chrome.
 */
export const GIT_STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-500',
  T: 'text-amber-500',
  A: 'text-emerald-500',
  '?': 'text-emerald-500',
  D: 'text-red-500',
  R: 'text-sky-500',
  C: 'text-sky-500',
  U: 'text-orange-500'
}

/**
 * A pull request's diff arrives as one unified patch (`gh pr diff`), and the
 * Code tab draws it the way the review view draws a working tree: one sticky
 * header and one `DiffTable` per file. This cuts the patch at each
 * `diff --git` and reads off what a header needs.
 *
 * Dependency-free so `node --test` runs it directly (test/prDiff.test.ts).
 */

export interface PatchFile {
  /** The file's path after the change; for a deletion, the path it had. */
  path: string
  /** Set on a rename or copy — the path before it. */
  oldPath?: string
  status: 'A' | 'D' | 'M' | 'R'
  additions: number
  deletions: number
  /** Binary files carry no hunks, so they are named and not drawn. */
  binary: boolean
  /** This file's slice of the patch, `diff --git` line included. */
  text: string
}

/** `a/x b/y` → the two paths. Paths with spaces are why this is not a split. */
function headerPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  if (!m) return null
  // `a/foo b/foo` for an unrenamed file: the halves are equal, so if the line
  // is ambiguous (a space in the name) the midpoint is the answer.
  const rest = line.slice('diff --git '.length)
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    const p = rest.slice(2, half)
    return [p, p]
  }
  return [m[1], m[2]]
}

export function splitPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = patch.split('\n')
  let start = -1
  const flush = (end: number): void => {
    if (start < 0) return
    const chunk = lines.slice(start, end)
    const paths = headerPaths(chunk[0]) ?? ['', '']
    let oldPath = paths[0]
    let path = paths[1]
    let status: PatchFile['status'] = 'M'
    let additions = 0
    let deletions = 0
    let binary = false
    let inHunk = false
    for (const line of chunk.slice(1)) {
      if (inHunk) {
        if (line.startsWith('+')) additions++
        else if (line.startsWith('-')) deletions++
        continue
      }
      if (line.startsWith('@@')) inHunk = true
      else if (line.startsWith('new file mode')) status = 'A'
      else if (line.startsWith('deleted file mode')) status = 'D'
      else if (line.startsWith('rename from ')) {
        status = 'R'
        oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length)
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true
    }
    // A later `@@` inside a hunk is still a hunk header, not a deletion — but
    // it starts with neither `+` nor `-`, so the counters above never see it.
    const text = chunk.join('\n')
    files.push({
      path,
      oldPath: status === 'R' && oldPath !== path ? oldPath : undefined,
      status,
      additions,
      deletions,
      binary,
      text: text.endsWith('\n') ? text : `${text}\n`
    })
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) {
      flush(i)
      start = i
    }
  }
  // A trailing newline leaves one empty string at the end; it belongs to no file.
  flush(lines[lines.length - 1] === '' ? lines.length - 1 : lines.length)
  return files
}

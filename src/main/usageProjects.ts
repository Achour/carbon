import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Which project a session log belongs to, for the Usage page's project split.
 *
 * Every log records the folder its session ran in, and that folder is not the
 * project: a session started in `src/` is the repository's, and one run in a
 * worktree is the repository's too — a worktree is a branch you are working
 * on, not a second project, and splitting them would scatter one project's
 * spend across as many rows as it has had branches. So a folder resolves to the
 * root of the repository that owns it.
 *
 * **Worktrees are mostly gone by the time anyone asks.** They are made for a
 * task and removed after it, so the `.git` pointer that names the owning
 * repository usually no longer exists. Those are placed by path instead, against
 * the roots that *did* resolve: Claude Code nests its own at
 * `<repo>/.claude/worktrees/`, and every other tool (Carbon's
 * `~/.karbun/worktrees/<repo>-<hash>/`, Codex's, T3 Code's) puts the repo's
 * name in a segment after a `worktrees` directory. Anything that matches
 * nothing stays its own folder rather than being guessed into a project.
 *
 * Pure apart from `resolveProjects`' filesystem reads, and dependency-free
 * (`node:*` only) so `node --test` runs it directly.
 */

/**
 * The repository root owning `cwd`, or null when there is none to find.
 *
 * Walks up, but never past `home`: a home directory under version control
 * (dotfiles) would otherwise claim every non-repo folder beneath it.
 */
async function gitRoot(cwd: string, home: string): Promise<string | null> {
  let dir = cwd
  for (;;) {
    const dotgit = join(dir, '.git')
    try {
      const info = await stat(dotgit)
      if (info.isDirectory()) return dir
      if (info.isFile()) {
        // A linked worktree's `.git` is a pointer: `gitdir: <repo>/.git/worktrees/<name>`.
        const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotgit, 'utf8'))
        const gitdir = match ? resolve(dir, match[1].trim()) : ''
        const at = gitdir.indexOf(`${sep}.git${sep}worktrees${sep}`)
        return at > 0 ? gitdir.slice(0, at) : dir
      }
    } catch {
      // No `.git` here; keep climbing.
    }
    const up = dirname(dir)
    if (up === dir || dir === home) return null
    dir = up
  }
}

/** Carbon's worktree directory suffix: the first 8 hex of the repo path's SHA-256. */
function repoHash(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 8)
}

/**
 * Place a folder that no longer resolves on disk, by its path alone.
 * Returns `cwd` unchanged when nothing claims it.
 */
export function foldWorktreePath(cwd: string, roots: readonly string[]): string {
  const nested = cwd.indexOf(`${sep}.claude${sep}worktrees${sep}`)
  if (nested > 0) return cwd.slice(0, nested)

  const parts = cwd.split(sep)
  const at = parts.lastIndexOf('worktrees')
  if (at === -1) return cwd
  const after = parts.slice(at + 1)
  for (const segment of after) {
    // `<repo>-<hash>` names exactly one root; prefer it over a bare name match,
    // which two same-named repositories would share.
    const hashed = /^(.+)-([0-9a-f]{8})$/.exec(segment)
    if (hashed) {
      const root = roots.find((r) => basename(r) === hashed[1] && repoHash(r) === hashed[2])
      if (root) return root
    }
    const named = roots.filter((r) => basename(r) === (hashed ? hashed[1] : segment))
    if (named.length === 1) return named[0]
  }
  return cwd
}

/** Answers survive the process: a folder's owner does not change between scans. */
const memo = new Map<string, string>()

/**
 * Every distinct folder in `cwds`, mapped to its project root.
 *
 * Two passes, because the second needs the first: folders that still exist
 * resolve through git, and the roots they produce are what a vanished
 * worktree's path is matched against.
 */
export async function resolveProjects(
  cwds: Iterable<string>,
  home: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const missing: string[] = []
  await Promise.all(
    [...new Set(cwds)].map(async (cwd) => {
      const known = memo.get(cwd)
      if (known !== undefined) return void out.set(cwd, known)
      let exists = false
      try {
        exists = (await stat(cwd)).isDirectory()
      } catch {
        // Gone — a removed worktree, usually.
      }
      if (!exists) return void missing.push(cwd)
      const root = (await gitRoot(cwd, home)) ?? cwd
      memo.set(cwd, root)
      out.set(cwd, root)
    })
  )
  const roots = [...new Set(out.values())]
  for (const cwd of missing) {
    // Not memoized: a later scan may know the root this one could not place.
    out.set(cwd, foldWorktreePath(cwd, roots))
  }
  return out
}

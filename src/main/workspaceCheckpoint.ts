import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { RewindResult, TurnFileChange } from '@shared/types'

const execFileP = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

export interface WorkspaceTree {
  root: string
  tree: string
}

export interface WorkspaceCheckpoint {
  before: WorkspaceTree
  after: WorkspaceTree
}

async function gitText(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = GIT_ENV
): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 100 * 1024 * 1024
  })
  return String(stdout)
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: 100 * 1024 * 1024
  })
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

/**
 * Snapshot the complete non-ignored working tree through a temporary Git index.
 * The user's real index, branch, and working files are never changed.
 */
export async function captureWorkspaceTree(cwd: string): Promise<WorkspaceTree | null> {
  let root: string
  try {
    root = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }

  const index = join(tmpdir(), `karbun-checkpoint-${randomUUID()}.index`)
  const env = { ...GIT_ENV, GIT_INDEX_FILE: index }
  try {
    try {
      await gitText(root, ['read-tree', 'HEAD'], env)
    } catch {
      await gitText(root, ['read-tree', '--empty'], env)
    }
    await gitText(root, ['add', '-A', '--', '.'], env)
    const tree = (await gitText(root, ['write-tree'], env)).trim()
    return tree ? { root, tree } : null
  } catch {
    return null
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
    await rm(`${index}.lock`, { force: true }).catch(() => undefined)
  }
}

async function changedPaths(checkpoint: WorkspaceCheckpoint): Promise<string[]> {
  const out = await gitBuffer(checkpoint.before.root, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    checkpoint.before.tree,
    checkpoint.after.tree
  ])
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

async function checkpointStats(checkpoint: WorkspaceCheckpoint): Promise<RewindResult> {
  const summary = await summarizeWorkspaceCheckpoint(checkpoint)
  const filesChanged = summary.map((file) => file.path)
  const insertions = summary.reduce((sum, file) => sum + file.additions, 0)
  const deletions = summary.reduce((sum, file) => sum + file.deletions, 0)
  return { canRewind: filesChanged.length > 0, filesChanged, insertions, deletions }
}

/** Exact per-file line totals between the before/after trees. */
export async function summarizeWorkspaceCheckpoint(
  checkpoint: WorkspaceCheckpoint
): Promise<TurnFileChange[]> {
  const paths = await changedPaths(checkpoint)
  const numstat = await gitText(checkpoint.before.root, [
    'diff',
    '--numstat',
    '--no-renames',
    checkpoint.before.tree,
    checkpoint.after.tree
  ])
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstat.split('\n')) {
    if (!line) continue
    const [adds, removes, ...pathParts] = line.split('\t')
    stats.set(pathParts.join('\t'), {
      additions: Number(adds) || 0,
      deletions: Number(removes) || 0
    })
  }
  return paths.map((path) => ({ path, ...(stats.get(path) ?? { additions: 0, deletions: 0 }) }))
}

interface TreeEntry {
  mode: string
  type: string
  oid: string
}

async function treeEntry(tree: WorkspaceTree, path: string): Promise<TreeEntry | null> {
  const raw = await gitBuffer(tree.root, ['ls-tree', '-z', tree.tree, '--', path])
  const header = raw.toString('utf8').split('\t', 1)[0]
  if (!header) return null
  const [mode, type, oid] = header.split(' ')
  return mode && type && oid ? { mode, type, oid } : null
}

function safePath(root: string, path: string): string {
  const abs = resolve(root, path)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Unsafe checkpoint path: ${path}`)
  return abs
}

async function removeLeaf(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`Cannot safely replace directory: ${path}`)
    }
    await rm(path, { force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
}

async function restorePaths(tree: WorkspaceTree, paths: string[]): Promise<void> {
  for (const rel of paths) {
    const abs = safePath(tree.root, rel)
    const entry = await treeEntry(tree, rel)
    await removeLeaf(abs)
    if (!entry) continue // the file did not exist in this snapshot
    if (entry.type !== 'blob') throw new Error(`Unsupported checkpoint entry: ${rel}`)
    const data = await gitBuffer(tree.root, ['cat-file', 'blob', entry.oid])
    await mkdir(dirname(abs), { recursive: true })
    if (entry.mode === '120000') {
      await symlink(data.toString('utf8'), abs)
    } else {
      await writeFile(abs, data)
      await chmod(abs, entry.mode.endsWith('755') ? 0o755 : 0o644)
    }
  }
}

/** Preview or safely undo one turn. Any later workspace change blocks the undo. */
export async function rewindWorkspaceCheckpoint(
  cwd: string,
  checkpoint: WorkspaceCheckpoint,
  dryRun: boolean
): Promise<RewindResult> {
  const preview = await checkpointStats(checkpoint)
  if (!preview.canRewind) return preview

  const current = await captureWorkspaceTree(cwd)
  if (!current || current.root !== checkpoint.after.root || current.tree !== checkpoint.after.tree) {
    return {
      ...preview,
      canRewind: false,
      error: 'The workspace changed after this turn. Review the newer changes before undoing it.'
    }
  }
  if (dryRun) return preview

  const paths = preview.filesChanged ?? []
  try {
    await restorePaths(checkpoint.before, paths)
    const restored = await captureWorkspaceTree(cwd)
    if (!restored || restored.tree !== checkpoint.before.tree) {
      throw new Error('The restored workspace did not match the checkpoint.')
    }
    return preview
  } catch (error) {
    // Best-effort rollback to the exact post-turn tree if restoration failed.
    await restorePaths(checkpoint.after, paths).catch(() => undefined)
    return { canRewind: false, error: error instanceof Error ? error.message : String(error) }
  }
}

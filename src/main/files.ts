import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { FileContent, FileEntry, FsCreateResult, FileWriteResult } from '@shared/types'

// The old 512 KB cap paid for highlight.js highlighting the whole blob eagerly.
// CodeMirror renders and parses by viewport, so the cost is now roughly the read
// itself and a file this size opens instantly — the cap is only here so a stray
// multi-megabyte log can't be pulled through IPC as one string.
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
// Images are inlined as data URIs and can legitimately be larger than a text
// file (e.g. a generated PNG), so give them a higher ceiling.
const MAX_IMAGE_BYTES = 24 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'xml',
  '.xml': 'xml',
  '.svelte': 'xml',
  '.vue': 'xml',
  '.md': 'markdown',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.zsh': 'bash',
  '.bash': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile'
}

// Hidden from the file tree, matching Cursor/VS Code's default files.exclude.
const TREE_HIDDEN = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db'])

// Which of a folder's entries `.gitignore` rules match, so the tree can dim
// `node_modules`, `dist` and a build's `*.tsbuildinfo` the way Cursor and VS
// Code do — otherwise generated output reads exactly like source. One
// `check-ignore` per listing rather than one `status --ignored` per project:
// the tree loads a folder at a time, and this answers for exactly that folder,
// from inside it, so no repo root has to be known. Bare names on stdin, NUL
// separated so a name with a newline cannot split. Exit 1 means nothing
// matched and 128 means not a repository — both are answers, not failures, and
// the listing waits at most IGNORE_PROBE_MS on this and never fails for it: a
// folder with no git on PATH still has files to show.
const IGNORE_PROBE_MS = 2000

function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    const done = new Set<string>()
    let out = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const name of out.split('\0')) if (name) done.add(name)
      resolve(done)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['-C', dir, 'check-ignore', '--stdin', '-z'], {
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      resolve(done)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, IGNORE_PROBE_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', finish)
    child.on('close', finish)
    child.stdin?.on('error', () => {})
    child.stdin?.end(names.join('\0') + '\0')
  })
}

export async function listDir(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const shown = entries.filter(
    (e) => (e.isDirectory() || e.isFile()) && !TREE_HIDDEN.has(e.name)
  )
  const ignored = await gitIgnored(
    dir,
    shown.map((e) => e.name)
  )
  return shown
    .map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      kind: e.isDirectory() ? ('dir' as const) : ('file' as const),
      ...(ignored.has(e.name) ? { ignored: true } : {})
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
}

export async function readFileContent(path: string): Promise<FileContent> {
  try {
    const info = await stat(path)
    const ext = extname(path).toLowerCase()

    if (IMAGE_MIME[ext]) {
      if (info.size > MAX_IMAGE_BYTES) return { kind: 'too-large', size: info.size }
      const data = await readFile(path)
      return { kind: 'image', dataUri: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}` }
    }

    if (info.size > MAX_FILE_BYTES) return { kind: 'too-large', size: info.size }

    const data = await readFile(path)
    // Null byte in the head is a good-enough binary sniff.
    if (data.subarray(0, 8192).includes(0)) return { kind: 'binary', size: info.size }

    const truncated = data.length > MAX_TEXT_BYTES
    return {
      kind: 'text',
      content: data.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
      language: LANGUAGE_BY_EXT[ext],
      truncated,
      mtimeMs: info.mtimeMs
    }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function statPath(path: string): Promise<'file' | 'dir' | null> {
  try {
    const s = await stat(path)
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/**
 * Write an edited buffer back.
 *
 * `expectedMtimeMs` is the mtime the buffer was read at. The agent edits the
 * same files the user has open — Carbon's own problem, not one a normal editor
 * has — so a save whose base has moved is *refused* rather than allowed to win.
 * `null` forces (the user chose Overwrite at the conflict prompt).
 *
 * The mtime comparison is `!==` rather than `>`: a checkout or a revert can move
 * mtime backwards, and that is still someone else's write.
 */
export async function writeFileContent(
  path: string,
  content: string,
  expectedMtimeMs: number | null
): Promise<FileWriteResult> {
  try {
    if (expectedMtimeMs !== null) {
      const before = await stat(path).catch(() => null)
      // A file that vanished is not a conflict — recreating it is what the user
      // asked for. Only a *different* file on disk is.
      if (before && before.mtimeMs !== expectedMtimeMs) {
        return { ok: false, reason: 'conflict', mtimeMs: before.mtimeMs }
      }
    }
    await writeFile(path, content, 'utf8')
    const after = await stat(path)
    return { ok: true, mtimeMs: after.mtimeMs }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * mtimes for a set of paths, `null` where the file is gone. This is what lets
 * the post-turn refresh re-read only the files that actually changed instead of
 * pulling every open tab's body back through IPC on every turn boundary.
 */
export async function statFiles(paths: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  await Promise.all(
    paths.map(async (p) => {
      out[p] = await stat(p).then(
        (s) => s.mtimeMs,
        () => null
      )
    })
  )
  return out
}

/**
 * Create an empty file or a folder under `parent`.
 *
 * `name` may carry slashes, so `lib/util.ts` creates the folders on the way —
 * that is what the inline input in the tree is for, and it saves making three
 * folders by hand to put one file in. The trade is that the name has to be
 * checked rather than trusted: a leading `/` would escape to the filesystem
 * root and `..` would climb out of the project, and neither is something the
 * tree should be able to do.
 */
/**
 * Validate a user-typed name against a parent folder and resolve it to a path.
 *
 * Shared by create and rename because both take a free-text name from the tree
 * and both must refuse the same things. A leading `/` escapes to the filesystem
 * root and `..` climbs out of the project, so the name is *checked* rather than
 * trusted — and then the resolved path is compared against the parent, which is
 * what actually proves it stayed inside rather than merely looking like it did.
 */
function resolveChildPath(
  parent: string,
  name: string
): { ok: true; path: string; name: string } | { ok: false; message: string } {
  const trimmed = name.trim().replace(/\/+$/, '')
  if (!trimmed) return { ok: false, message: 'Name cannot be empty.' }
  if (trimmed.startsWith('/')) return { ok: false, message: 'Name cannot start with “/”.' }
  if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
    return { ok: false, message: 'Name cannot contain “.” or “..” segments.' }
  }
  const target = join(parent, trimmed)
  if (!resolve(target).startsWith(resolve(parent) + sep)) {
    return { ok: false, message: 'Name must stay inside the folder.' }
  }
  return { ok: true, path: target, name: trimmed }
}

/**
 * Rename — or move, since a name with slashes in it is a move. The old path is
 * gone either way, so this is the one tree operation that is *not* undoable
 * through the Trash; it is undone by renaming back.
 */
export async function renamePath(path: string, name: string): Promise<FsCreateResult> {
  const parent = dirname(path)
  const resolved = resolveChildPath(parent, name)
  if (!resolved.ok) return resolved
  if (resolved.path === path) return { ok: true, path }
  try {
    // Case-only renames on a case-insensitive filesystem (`Foo.ts` → `foo.ts`)
    // land on a path that "exists" — itself — so the existence check has to
    // exclude that case or the rename every macOS user tries first is refused.
    if (await stat(resolved.path).then(() => true, () => false)) {
      if (resolved.path.toLowerCase() !== path.toLowerCase()) {
        return { ok: false, message: `“${resolved.name}” already exists.` }
      }
    }
    await mkdir(dirname(resolved.path), { recursive: true })
    await rename(path, resolved.path)
    return { ok: true, path: resolved.path }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function createPath(
  parent: string,
  name: string,
  kind: 'file' | 'dir'
): Promise<FsCreateResult> {
  const resolved = resolveChildPath(parent, name)
  if (!resolved.ok) return resolved
  const target = resolved.path
  const trimmed = resolved.name

  try {
    if (await stat(target).then(() => true, () => false)) {
      return { ok: false, message: `“${trimmed}” already exists.` }
    }
    if (kind === 'dir') {
      await mkdir(target, { recursive: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      // 'wx' fails rather than truncating, so a file that appeared between the
      // check above and this line is never silently emptied.
      await writeFile(target, '', { flag: 'wx' })
    }
    return { ok: true, path: target }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message }
  }
}

// ---- Project file search (@-mentions) ----

const WALK_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'Pods',
  'DerivedData'
])
const WALK_MAX_FILES = 20_000
const WALK_MAX_DEPTH = 10
const WALK_TTL_MS = 15_000

const walkCache = new Map<string, { ts: number; rels: string[] }>()
const walkInflight = new Map<string, Promise<string[]>>()

async function walkProject(root: string): Promise<string[]> {
  const cached = walkCache.get(root)
  if (cached && Date.now() - cached.ts < WALK_TTL_MS) return cached.rels
  const inflight = walkInflight.get(root)
  if (inflight) return inflight
  const scan = scanProject(root)
  walkInflight.set(root, scan)
  try {
    return await scan
  } finally {
    if (walkInflight.get(root) === scan) walkInflight.delete(root)
  }
}

async function scanProject(root: string): Promise<string[]> {
  const rels: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && rels.length < WALK_MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < WALK_MAX_DEPTH && !WALK_IGNORE.has(e.name) && !e.name.startsWith('.')) {
          queue.push({ dir: join(dir, e.name), depth: depth + 1 })
        }
      } else if (e.isFile()) {
        // relative() is robust to a trailing slash on `root` (slicing by length
        // would drop the first char of every path when one is present).
        rels.push(relative(root, join(dir, e.name)))
        if (rels.length >= WALK_MAX_FILES) break
      }
    }
  }
  walkCache.set(root, { ts: Date.now(), rels })
  return rels
}

/** Ranked fuzzy match of project files for composer @-mentions. */
export async function searchFiles(
  root: string,
  query: string,
  limit = 20
): Promise<{ rel: string; path: string }[]> {
  const rels = await walkProject(root)
  const q = query.toLowerCase()
  const scored: Array<{ rel: string; score: number }> = []
  for (const rel of rels) {
    const relLower = rel.toLowerCase()
    const base = relLower.slice(relLower.lastIndexOf('/') + 1)
    let score: number
    if (!q) score = 3
    else if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (relLower.includes(q)) score = 2
    else continue
    scored.push({ rel, score })
  }
  scored.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length)
  return scored.slice(0, limit).map(({ rel }) => ({ rel, path: join(root, rel) }))
}

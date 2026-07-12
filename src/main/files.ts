import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { FileContent, FileEntry } from '@shared/types'

const MAX_TEXT_BYTES = 512 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024

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

export async function listDir(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => (e.isDirectory() || e.isFile()) && !TREE_HIDDEN.has(e.name))
    .map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      kind: e.isDirectory() ? ('dir' as const) : ('file' as const)
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
      if (info.size > MAX_FILE_BYTES) return { kind: 'too-large', size: info.size }
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
      truncated
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

async function walkProject(root: string): Promise<string[]> {
  const cached = walkCache.get(root)
  if (cached && Date.now() - cached.ts < WALK_TTL_MS) return cached.rels
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
        const abs = join(dir, e.name)
        rels.push(abs.slice(root.length + 1))
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

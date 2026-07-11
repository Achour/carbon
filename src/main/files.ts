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

export async function listDir(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
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

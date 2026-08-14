import hljs from 'highlight.js'

// Mirrors src/main/files.ts LANGUAGE_BY_EXT — highlight.js language per extension.
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

/**
 * Pull a file path out of a fenced-code info string.
 *
 * Grok (and Claude Code) cite existing files as `startLine:endLine:filepath`
 * instead of a language tag:
 *
 *     ```896:905:src/renderer/src/components/Composer.tsx
 *
 * A bare path (`src/foo.ts`, `Composer.tsx`) is the same idea without a range.
 * Language tags (`tsx`, `mermaid`, `json`) are not paths and return undefined.
 */
export function pathFromFenceInfo(info: string): string | undefined {
  const raw = info.trim()
  if (!raw) return undefined

  // startLine:endLine:filepath — the path may contain colons (Windows drives).
  const cited = /^(\d+):(\d+):(\S.*)$/.exec(raw)
  if (cited) return cited[3]

  if (raw.includes('/') || raw.includes('\\')) return raw

  // Basename with an extension (`Composer.tsx`). `tsx` / `json` have no dot.
  if (/^[\w.@$+-]+\.[A-Za-z0-9]{1,8}$/.test(raw)) return raw

  return undefined
}

/** The highlight.js language for a file path, or undefined if unsupported. */
export function languageForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const lang = LANGUAGE_BY_EXT[path.slice(dot).toLowerCase()]
  return lang && hljs.getLanguage(lang) ? lang : undefined
}

/**
 * Language to highlight a fenced block with. A real language tag (`tsx`,
 * `bash`) is kept; a file citation is mapped through `languageForPath`.
 * `undefined` means leave the info string alone (`mermaid`, unknown tags).
 */
export function languageFromFenceInfo(info: string | null | undefined): string | undefined {
  const raw = info?.trim()
  if (!raw) return undefined
  if (hljs.getLanguage(raw)) return raw
  const path = pathFromFenceInfo(raw)
  return path ? languageForPath(path) : undefined
}

/** Remap `startLine:endLine:path` (and bare-path) fences to a highlight.js language. */
export function remarkHighlightLang() {
  return (tree: unknown): void => {
    visitCode(tree, (node) => {
      const mapped = languageFromFenceInfo(node.lang)
      if (mapped) node.lang = mapped
    })
  }
}

function visitCode(node: unknown, visit: (node: { lang?: string | null }) => void): void {
  if (!node || typeof node !== 'object') return
  const n = node as { type?: string; lang?: string | null; children?: unknown[] }
  if (n.type === 'code') visit(n)
  if (!n.children) return
  for (const child of n.children) visitCode(child, visit)
}

/** Highlight one line to hljs HTML. Per-line, so multi-line constructs lose some
 *  context, but spans always close within the line (safe for a diff). */
export function highlightLine(text: string, language: string): string {
  try {
    return hljs.highlight(text, { language }).value
  } catch {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

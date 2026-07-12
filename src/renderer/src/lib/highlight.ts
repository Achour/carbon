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

/** The highlight.js language for a file path, or undefined if unsupported. */
export function languageForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const lang = LANGUAGE_BY_EXT[path.slice(dot).toLowerCase()]
  return lang && hljs.getLanguage(lang) ? lang : undefined
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

import hljs from 'highlight.js/lib/core'
import { common } from 'lowlight'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import type { LanguageFn } from 'highlight.js'

/**
 * The grammars both highlighters get, and the reason there is a list at all.
 *
 * `import hljs from 'highlight.js'` registers all ~190 languages — 1,034 KB of
 * the renderer's startup chunk, parsed and evaluated before first paint by
 * every session, including the overwhelming majority that never open a Zephir
 * or Mercury fence. It bought nothing even in principle: the *finished*
 * markdown in a message is highlighted by `rehype-highlight`, which defaults to
 * lowlight's `common` set, so the extra 150-odd languages could only ever
 * appear on the two surfaces that call `highlightCode` directly — a streaming
 * fence and the diff view — and would then *lose* their colour the moment the
 * turn ended and the full-text parse replaced them. The larger set was an
 * inconsistency, not a feature.
 *
 * So the set is declared once, here, and fed to both: `hljs` below, and
 * `rehype-highlight`'s `languages` option in `Markdown.tsx`. Same reason
 * `--syn-*` is one palette for the two highlighters rather than two that agree
 * by coincidence — a fence that is one colour while it streams and another
 * once it lands is exactly what one shared definition prevents.
 *
 * `dockerfile` is the one addition: `LANGUAGE_BY_EXT` maps `.dockerfile` and
 * lowlight's common set does not carry it. Everything else that map names is
 * already in `common`, and `registerLanguage` pulls each grammar's own aliases
 * in with it (`ts`, `js`, `sh`, `yml`, `py`, `rs`), so fence tags keep working.
 */
export const HLJS_LANGUAGES: Record<string, LanguageFn> = { ...common, dockerfile }

for (const [name, grammar] of Object.entries(HLJS_LANGUAGES)) {
  hljs.registerLanguage(name, grammar)
}

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
 * The fence's tag — its first whitespace-delimited word.
 *
 * Two surfaces ask what a fence is, from two different strings: the markdown
 * path sees mdast's `lang`, which is already just this word, while the
 * streaming path sees the info string whole (` ```ts title=foo.ts `). Deciding
 * it separately in each is how they come to disagree, so both go through here.
 */
export function fenceTag(info: string | null | undefined): string {
  return info?.trim().split(/\s+/)[0] ?? ''
}

/** A fence that renders as a diagram rather than as code. */
export function isMermaidFence(info: string | null | undefined): boolean {
  return fenceTag(info) === 'mermaid'
}

/**
 * Language to highlight a fenced block with. A real language tag (`tsx`,
 * `bash`) is kept; a file citation is mapped through `languageForPath`.
 * `undefined` means leave the info string alone (`mermaid`, unknown tags).
 *
 * The whole string is tried before the tag alone, because a citation may carry
 * spaces (`896:905:src/my file.ts`) and splitting first would lose the path —
 * which is also why mdast's `lang`, split on whitespace before it ever gets
 * here, is the lossier of the two inputs rather than the canonical one.
 */
export function languageFromFenceInfo(info: string | null | undefined): string | undefined {
  const raw = info?.trim()
  if (!raw) return undefined
  if (hljs.getLanguage(raw)) return raw
  const tag = fenceTag(raw)
  if (tag !== raw && hljs.getLanguage(tag)) return tag
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Highlight text to hljs HTML, falling back to escaped text when the language
 * is absent or unregistered — deliberately never to hljs's auto-detection,
 * which on the *prefix* of a streaming block guesses a different language every
 * few commits and repaints the whole thing.
 *
 * How much text to pass is the caller's decision and the only one that matters:
 * hljs carries state across lines, so a whole block colors what follows a block
 * comment or an unterminated string correctly, while a line on its own is
 * independent of its neighbours — which is what lets the diff view treat a row
 * as a row.
 */
export function highlightCode(text: string, language: string | undefined): string {
  if (language) {
    try {
      return hljs.highlight(text, { language }).value
    } catch {
      // An unregistered language: fall through to plain escaped text.
    }
  }
  return escapeHtml(text)
}

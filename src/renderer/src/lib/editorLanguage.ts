import { LanguageDescription, LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

// Language modes are code — the full set is several megabytes of parsers, and a
// user who only ever opens TypeScript should never pay for Haskell. Every
// descriptor in @codemirror/language-data is a lazy `import()`, so the cost of
// a language is paid the first time a file of that language is opened and never
// again. That is also why this cannot be synchronous: `load()` returns a
// promise, and the editor mounts with no highlighting for one frame.

const loaded = new Map<string, LanguageSupport>()
const inflight = new Map<string, Promise<LanguageSupport | null>>()

/**
 * hljs language name (what `FileContent.language` carries, set in main/files.ts)
 * → the @codemirror/language-data name, where the two disagree. Names that match
 * are resolved by `LanguageDescription.matchLanguageName` and are not listed.
 */
const ALIAS: Record<string, string> = {
  xml: 'html',
  ini: 'toml',
  csharp: 'c#',
  bash: 'shell'
}

function describe(filename: string | undefined, language: string | undefined): LanguageDescription | null {
  // Filename first: it distinguishes .tsx from .ts and .jsx from .js, which the
  // coarse hljs name ("typescript" for both) cannot.
  if (filename) {
    const byName = LanguageDescription.matchFilename(languages, filename)
    if (byName) return byName
  }
  if (language) {
    const name = ALIAS[language] ?? language
    const byLang = LanguageDescription.matchLanguageName(languages, name, true)
    if (byLang) return byLang
  }
  return null
}

/** Already-resolved support for this file, if its mode has been loaded before. */
export function loadedLanguage(
  filename: string | undefined,
  language: string | undefined
): LanguageSupport | null {
  const desc = describe(filename, language)
  return desc ? (loaded.get(desc.name) ?? null) : null
}

/**
 * Resolve (and cache) the mode for a file. Returns null for a file type with no
 * CodeMirror grammar — plain text is a perfectly good answer, and much better
 * than blocking the open.
 */
export async function loadLanguage(
  filename: string | undefined,
  language: string | undefined
): Promise<LanguageSupport | null> {
  const desc = describe(filename, language)
  if (!desc) return null
  const cached = loaded.get(desc.name)
  if (cached) return cached
  const pending = inflight.get(desc.name)
  if (pending) return pending
  const task = desc
    .load()
    .then((support) => {
      loaded.set(desc.name, support)
      return support
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(desc.name)
    })
  inflight.set(desc.name, task)
  return task
}

/**
 * The language id an LSP server is keyed and started by — LSP's own
 * `languageId` vocabulary, which is neither hljs's nor language-data's.
 * Derived from the extension because that is what the servers themselves key on.
 *
 * This is the third extension table in the app, after `LANGUAGE_BY_EXT` in
 * `main/files.ts` and its mirror in `lib/highlight.ts`. It stays separate
 * because the *values* genuinely differ — LSP distinguishes `typescriptreact`
 * from `typescript`, which the hljs vocabulary collapses, and that distinction
 * goes on the wire in `didOpen`. Adding a language means touching all three.
 */
export function lspLanguageId(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.tsx':
      return 'typescriptreact'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.jsx':
      return 'javascriptreact'
    case '.py':
      return 'python'
    case '.rs':
      return 'rust'
    case '.go':
      return 'go'
    case '.rb':
      return 'ruby'
    case '.json':
      return 'json'
    default:
      return null
  }
}
